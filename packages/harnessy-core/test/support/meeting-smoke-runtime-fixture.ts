import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";

import type { JarvisMeetingPublicationConfig } from "../../src/jarvis/config-model.ts";
import {
	canonicalMeetingPublicationSmokeJson,
	MEETING_PUBLICATION_SMOKE_AUDIENCE,
	MEETING_PUBLICATION_SMOKE_OPERATIONS,
	type MeetingPublicationSmokeArtifactAnchors,
	type MeetingPublicationSmokeProviderArtifactAnchors,
	type MeetingPublicationSmokeRuntimeInput,
	type MeetingPublicationSmokeRuntimeObservation,
	meetingPublicationSmokeSignatureBytes,
	sha256MeetingPublicationSmokeBytes,
} from "../../src/jarvis/meeting-publication/operational-input.ts";
import {
	MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL,
	type MeetingPublicationSmokeRuntimeSystem,
	MeetingPublicationSmokeRuntimeSystemReference,
} from "../../src/jarvis/meeting-publication/operational-runtime.ts";

export interface MeetingPublicationSmokeAuthorizationFixtureOptions {
	readonly privateRoot: string;
	readonly config: JarvisMeetingPublicationConfig;
	readonly item: { readonly itemId: string; readonly sourceHash: string };
	readonly credentialDirectory: string;
	readonly engineStatePath: string;
	readonly installationRoot: string;
	readonly artifactAnchors: MeetingPublicationSmokeArtifactAnchors;
	readonly transport: {
		readonly googleDriveBaseUrl: string;
		readonly googleDocsBaseUrl: string;
		readonly discordBaseUrl: string;
	};
	readonly now?: number;
}

const canonicalBytes = (value: unknown) => `${canonicalMeetingPublicationSmokeJson(value)}\n`;

const boundFile = (path: string) => {
	const stat = lstatSync(path, { bigint: true });
	return {
		path: realpathSync(path),
		device: stat.dev.toString(),
		inode: stat.ino.toString(),
		sha256: sha256MeetingPublicationSmokeBytes(readFileSync(path)),
	};
};

const hashedFile = (path: string) => ({
	path: realpathSync(path),
	sha256: sha256MeetingPublicationSmokeBytes(readFileSync(path)),
});

const artifactFiles = (root: string) => {
	const paths: Array<string> = [];
	const visit = (directory: string) => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) paths.push(realpathSync(path));
			else throw new Error("The isolated artifact fixture cannot contain links or special files.");
		}
	};
	visit(root);
	return paths.sort().map(boundFile);
};

const writePrivate = (path: string, value: string | Uint8Array) => {
	writeFileSync(path, value, { mode: 0o600 });
	chmodSync(path, 0o600);
};

/**
 * Isolated signing/lease fixture. It uses real Ed25519 and SQLite, but its
 * injected writer observer is not evidence for the production OS observer.
 */
export const createMeetingPublicationSmokeAuthorizationFixture = (
	options: MeetingPublicationSmokeAuthorizationFixtureOptions,
) => {
	if (!isAbsolute(options.privateRoot) || !isAbsolute(options.installationRoot)) {
		throw new Error("The isolated smoke fixture requires absolute roots.");
	}
	if (
		options.config.statePath === null ||
		options.config.googleOwnerEmail === null ||
		options.config.googleDriveFolder === null ||
		options.config.discordChannelId === null
	) {
		throw new Error("The isolated smoke fixture requires a complete enabled publication config.");
	}
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error("The isolated smoke fixture only models the supported runtime platforms.");
	}
	const effectiveUid = process.geteuid?.();
	if (effectiveUid === undefined) throw new Error("The isolated smoke fixture requires an effective uid.");
	chmodSync(options.privateRoot, 0o700);
	const now = options.now ?? Date.now();
	const uid = BigInt(effectiveUid);
	const platform = process.platform;
	const observation: MeetingPublicationSmokeRuntimeObservation = {
		now,
		monotonic: process.hrtime.bigint(),
		platform,
		architecture: arch(),
		hostname: hostname(),
		uid,
		bootId: `fixture-${randomBytes(16).toString("hex")}`,
		executablePath: realpathSync(process.execPath),
	};
	const replayPath = join(options.privateRoot, "replay.sqlite3");
	const replayInstanceId = randomBytes(32).toString("hex");
	const replay = new DatabaseSync(replayPath, { allowExtension: false });
	try {
		replay.exec(MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL);
		replay
			.prepare("INSERT INTO runtime_metadata (singleton,instance_id,revocation_sequence) VALUES (1,?,0)")
			.run(replayInstanceId);
	} finally {
		replay.close();
	}
	chmodSync(replayPath, 0o600);

	const cutoverEvidencePath = join(options.privateRoot, "cutover-evidence.json");
	const rollbackPlanPath = join(options.privateRoot, "rollback-plan.json");
	writePrivate(cutoverEvidencePath, canonicalBytes({ kind: "fixture-cutover-evidence", accepted: true }));
	writePrivate(rollbackPlanPath, canonicalBytes({ kind: "fixture-rollback-plan", restores: "v1" }));

	const artifactManifestPath = join(options.privateRoot, "artifact-manifest.json");
	const writeArtifactManifest = () => {
		const manifest = {
			kind: "harnessy.runtime-artifact-manifest",
			schemaVersion: 1,
			root: realpathSync(options.installationRoot),
			anchors: [
				{ role: "core", path: realpathSync(options.artifactAnchors.core) },
				{ role: "host", path: realpathSync(options.artifactAnchors.host) },
				{ role: "sdk", path: realpathSync(options.artifactAnchors.sdk) },
				{ role: "dependencies", path: realpathSync(options.artifactAnchors.dependencies) },
			],
			files: artifactFiles(realpathSync(options.installationRoot)),
		};
		writePrivate(artifactManifestPath, canonicalBytes(manifest));
	};
	writeArtifactManifest();

	const replayIdentity = {
		path: realpathSync(replayPath),
		device: lstatSync(replayPath, { bigint: true }).dev.toString(),
		inode: lstatSync(replayPath, { bigint: true }).ino.toString(),
		instanceId: replayInstanceId,
	};
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const issuer = "fixture-owner";
	const keyId = `fixture-${randomBytes(12).toString("hex")}`;
	const trustPath = join(options.privateRoot, "trusted-keyring.json");
	const trust = {
		kind: "harnessy.meeting-publication.smoke-trust",
		schemaVersion: 1,
		audience: MEETING_PUBLICATION_SMOKE_AUDIENCE,
		keys: [
			{
				issuer,
				keyId,
				publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
				publicKeySha256: sha256MeetingPublicationSmokeBytes(publicKey.export({ type: "spki", format: "der" })),
			},
		],
		replay: replayIdentity,
	};
	writePrivate(trustPath, canonicalBytes(trust));

	const authorizationPath = join(options.privateRoot, "authorization.json");
	const stateDatabasePath = join(options.config.statePath, "meeting-publication.sqlite3");
	const payload = {
		kind: "harnessy.meeting-publication.smoke-authorization",
		schemaVersion: 1,
		authorizationId: `smoke-${randomBytes(12).toString("hex")}`,
		nonce: randomBytes(32).toString("hex"),
		issuer,
		keyId,
		audience: MEETING_PUBLICATION_SMOKE_AUDIENCE,
		issuedAt: new Date(now - 1_000).toISOString(),
		notBefore: new Date(now - 1_000).toISOString(),
		expiresAt: new Date(now + 5 * 60_000).toISOString(),
		operations: [...MEETING_PUBLICATION_SMOKE_OPERATIONS],
		subject: { tenantId: "fixture-tenant", subjectId: "fixture-subject" },
		config: options.config,
		item: { ...options.item },
		credentials: {
			directory: realpathSync(options.credentialDirectory),
			engineState: boundFile(options.engineStatePath),
		},
		google: {
			owner: "user" as const,
			connection: "fixture-google",
			authTemplate: "google-drive-file-test-token" as const,
			ownerEmail: options.config.googleOwnerEmail,
			folderPath: options.config.googleDriveFolder,
		},
		discord: {
			owner: "user" as const,
			connection: "fixture-discord",
			authTemplate: "discord-bot" as const,
			channelId: options.config.discordChannelId,
		},
		transport: { mode: "loopback" as const, ...options.transport },
		runtime: {
			platform: observation.platform,
			architecture: observation.architecture,
			hostname: observation.hostname,
			uid: observation.uid.toString(),
			bootId: observation.bootId,
			executablePath: observation.executablePath,
			executableSha256: sha256MeetingPublicationSmokeBytes(readFileSync(observation.executablePath)),
		},
		replay: replayIdentity,
		revocationSequence: 0,
		stateDatabase: boundFile(stateDatabasePath),
		artifactManifest: hashedFile(artifactManifestPath),
		cutoverEvidence: hashedFile(cutoverEvidencePath),
		rollbackPlan: hashedFile(rollbackPlanPath),
		oneWriter: {
			kind: "known-v1-writers-v1" as const,
			darwinSchedulerLabels: [
				"tech.flowresearch.jarvis.meeting-review",
				"com.flow-harness.project.flow-meeting-publication-worker",
			],
			linuxCrontabMarkers: [
				"# flow-harness: project/flow-meeting-publication-worker",
				"jarvis meeting publish worker",
			],
			processMarkers: ["jarvis meeting publish worker", "jarvis meeting review serve"],
		},
	};
	const writeAuthorization = () => {
		const envelopeSignature = sign(null, meetingPublicationSmokeSignatureBytes(payload), privateKey).toString(
			"base64url",
		);
		writePrivate(
			authorizationPath,
			canonicalBytes({
				payload,
				signature: envelopeSignature,
			}),
		);
	};
	writeAuthorization();

	let writersPresent = false;
	let observationStep = 0n;
	let observationOffsetMillis = 0;
	const system: MeetingPublicationSmokeRuntimeSystem = {
		observe: () => {
			const step = observationStep;
			observationStep += 1_000_000n;
			return {
				...observation,
				now: observation.now + observationOffsetMillis + Number(step / 1_000_000n),
				monotonic: observation.monotonic + BigInt(observationOffsetMillis) * 1_000_000n + step,
			};
		},
		proveNoKnownV1Writers: () => {
			if (writersPresent) throw new Error("A fixture writer is present.");
		},
	};
	const keyring = boundFile(trustPath);
	const input: MeetingPublicationSmokeRuntimeInput = {
		authorizationPath,
		trustedKeyring: keyring,
	};
	const providerArtifactAnchors: MeetingPublicationSmokeProviderArtifactAnchors = {
		host: options.artifactAnchors.host,
		sdk: options.artifactAnchors.sdk,
		dependencies: options.artifactAnchors.dependencies,
	};

	return {
		input,
		payload,
		providerArtifactAnchors,
		observation,
		system,
		replayPath,
		authorizationPath,
		trustPath,
		artifactManifestPath,
		setWritersPresent: (value: boolean) => {
			writersPresent = value;
		},
		advanceTimeBy: (milliseconds: number) => {
			observationOffsetMillis += milliseconds;
		},
		resign: (mutate?: (draft: typeof payload) => void) => {
			mutate?.(payload);
			writeAuthorization();
		},
		rebindEngineStateAndResign: (path: string) => {
			payload.credentials.engineState = boundFile(path);
			writeAuthorization();
		},
		rebindStateDatabaseAndResign: () => {
			payload.stateDatabase = boundFile(stateDatabasePath);
			writeAuthorization();
		},
		rebuildArtifactAndResign: () => {
			writeArtifactManifest();
			payload.artifactManifest = hashedFile(artifactManifestPath);
			writeAuthorization();
		},
		corruptSignature: () => {
			writePrivate(authorizationPath, canonicalBytes({ payload, signature: "A".repeat(86) }));
		},
		withSystem: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, system)),
	};
};
