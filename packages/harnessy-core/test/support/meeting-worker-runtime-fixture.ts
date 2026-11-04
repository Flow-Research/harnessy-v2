import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";

import type { JarvisMeetingPublicationConfig } from "../../src/jarvis/config-model.ts";
import {
	canonicalMeetingPublicationSmokeJson,
	MEETING_PUBLICATION_WORKER_AUDIENCE,
	MEETING_PUBLICATION_WORKER_OPERATIONS,
	type MeetingPublicationSmokeArtifactAnchors,
	type MeetingPublicationSmokeProviderArtifactAnchors,
	type MeetingPublicationSmokeRuntimeObservation,
	type MeetingPublicationWorkerNotifierBinding,
	type MeetingPublicationWorkerRuntimeInput,
	meetingPublicationWorkerSignatureBytes,
	sha256MeetingPublicationSmokeBytes,
} from "../../src/jarvis/meeting-publication/operational-input.ts";
import {
	MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL,
	type MeetingPublicationSmokeRuntimeSystem,
	MeetingPublicationSmokeRuntimeSystemReference,
} from "../../src/jarvis/meeting-publication/operational-runtime.ts";

interface MeetingPublicationWorkerAuthorizationFixtureOptions {
	readonly privateRoot: string;
	readonly config: JarvisMeetingPublicationConfig;
	readonly credentialDirectory: string;
	readonly engineStatePath: string;
	readonly installationRoot: string;
	readonly artifactAnchors: MeetingPublicationSmokeArtifactAnchors;
	readonly maxItems?: number;
	readonly notifier?: MeetingPublicationWorkerNotifierBinding;
	readonly now?: number;
}

const canonicalBytes = (value: unknown) => `${canonicalMeetingPublicationSmokeJson(value)}\n`;
const boundFile = (path: string) => {
	const canonical = realpathSync(path);
	const stat = lstatSync(canonical, { bigint: true });
	return {
		path: canonical,
		device: stat.dev.toString(),
		inode: stat.ino.toString(),
		sha256: sha256MeetingPublicationSmokeBytes(readFileSync(canonical)),
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
			else throw new Error("The worker artifact fixture cannot contain links or special files.");
		}
	};
	visit(root);
	return paths.sort().map(boundFile);
};
const writePrivate = (path: string, value: string | Uint8Array) => {
	writeFileSync(path, value, { mode: 0o600 });
	chmodSync(path, 0o600);
};

/** Real signing and replay state with an injected, inert OS writer observer. */
export const createMeetingPublicationWorkerAuthorizationFixture = (
	options: MeetingPublicationWorkerAuthorizationFixtureOptions,
) => {
	if (
		options.config.statePath === null ||
		options.config.googleOwnerEmail === null ||
		options.config.googleDriveFolder === null ||
		options.config.discordChannelId === null
	)
		throw new Error("The worker fixture requires a complete publication config.");
	const effectiveUid = process.geteuid?.();
	if (effectiveUid === undefined || (process.platform !== "darwin" && process.platform !== "linux"))
		throw new Error("The worker fixture requires a supported POSIX platform.");
	chmodSync(options.privateRoot, 0o700);
	const now = options.now ?? Date.now();
	const observation: MeetingPublicationSmokeRuntimeObservation = {
		now,
		monotonic: process.hrtime.bigint(),
		platform: process.platform,
		architecture: arch(),
		hostname: hostname(),
		uid: BigInt(effectiveUid),
		bootId: `fixture-${randomBytes(16).toString("hex")}`,
		executablePath: realpathSync(process.execPath),
	};
	const replayPath = join(options.privateRoot, "worker-replay.sqlite3");
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
		writePrivate(
			artifactManifestPath,
			canonicalBytes({
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
			}),
		);
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
	const trustPath = join(options.privateRoot, "worker-trusted-keyring.json");
	writePrivate(
		trustPath,
		canonicalBytes({
			kind: "harnessy.meeting-publication.worker-trust",
			schemaVersion: 1,
			audience: MEETING_PUBLICATION_WORKER_AUDIENCE,
			keys: [
				{
					issuer,
					keyId,
					publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
					publicKeySha256: sha256MeetingPublicationSmokeBytes(publicKey.export({ type: "spki", format: "der" })),
				},
			],
			replay: replayIdentity,
		}),
	);

	const authorizationPath = join(options.privateRoot, "worker-authorization.json");
	const payload = {
		kind: "harnessy.meeting-publication.worker-authorization",
		schemaVersion: 1,
		authorizationId: `worker-${randomBytes(12).toString("hex")}`,
		nonce: randomBytes(32).toString("hex"),
		issuer,
		keyId,
		audience: MEETING_PUBLICATION_WORKER_AUDIENCE,
		issuedAt: new Date(now - 1_000).toISOString(),
		notBefore: new Date(now - 1_000).toISOString(),
		expiresAt: new Date(now + 5 * 60_000).toISOString(),
		operations: [...MEETING_PUBLICATION_WORKER_OPERATIONS],
		maxItems: options.maxItems ?? 1,
		subject: { tenantId: "fixture-tenant", subjectId: "fixture-subject" },
		config: options.config,
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
		notifier: options.notifier ?? ({ kind: "unavailable" } as const),
		transport: {
			mode: "loopback" as const,
			googleDriveBaseUrl: "http://127.0.0.1:19081",
			googleDocsBaseUrl: "http://127.0.0.1:19082",
			discordBaseUrl: "http://127.0.0.1:19083",
		},
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
		stateDatabase: boundFile(join(options.config.statePath, "meeting-publication.sqlite3")),
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
			processMarkers: [
				"jarvis meeting publish worker",
				"jarvis meeting publish review serve",
				"jarvis meeting review serve",
			],
		},
	};
	const writeAuthorization = () => {
		writePrivate(
			authorizationPath,
			canonicalBytes({
				payload,
				signature: sign(null, meetingPublicationWorkerSignatureBytes(payload), privateKey).toString("base64url"),
			}),
		);
	};
	writeAuthorization();

	let writersPresent = false;
	let observationStep = 0n;
	let observationOffsetMillis = 0;
	const observationHooks = new Map<number, () => void>();
	let observationCount = 0;
	const system: MeetingPublicationSmokeRuntimeSystem = {
		observe: () => {
			observationCount += 1;
			observationHooks.get(observationCount)?.();
			observationHooks.delete(observationCount);
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
	const input: MeetingPublicationWorkerRuntimeInput = {
		authorizationPath,
		trustedKeyring: boundFile(trustPath),
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
		replayPath,
		authorizationPath,
		setWritersPresent: (value: boolean) => {
			writersPresent = value;
		},
		advanceTimeBy: (milliseconds: number) => {
			observationOffsetMillis += milliseconds;
		},
		beforeObservation: (count: number, effect: () => void) => {
			observationHooks.set(count, effect);
		},
		resign: (mutate?: (draft: typeof payload) => void) => {
			mutate?.(payload);
			writeAuthorization();
		},
		rebindStateDatabaseAndResign: () => {
			payload.stateDatabase = boundFile(join(options.config.statePath ?? "", "meeting-publication.sqlite3"));
			writeAuthorization();
		},
		mutateArtifactManifestAndResign: (
			mutate: (manifest: {
				anchors: Array<{ readonly role: string; readonly path: string }>;
				files: Array<ReturnType<typeof boundFile>>;
			}) => void,
		) => {
			const manifest = JSON.parse(readFileSync(artifactManifestPath, "utf8")) as {
				anchors: Array<{ readonly role: string; readonly path: string }>;
				files: Array<ReturnType<typeof boundFile>>;
			};
			mutate(manifest);
			writePrivate(artifactManifestPath, canonicalBytes(manifest));
			payload.artifactManifest = hashedFile(artifactManifestPath);
			writeAuthorization();
		},
		withSystem: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, system)),
	};
};
