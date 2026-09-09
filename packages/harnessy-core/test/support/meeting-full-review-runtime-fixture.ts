import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";

import type { JarvisMeetingPublicationConfig } from "../../src/jarvis/config-model.ts";
import {
	canonicalMeetingPublicationSmokeJson,
	MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE,
	MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS,
	MEETING_PUBLICATION_WORKER_AUDIENCE,
	MEETING_PUBLICATION_WORKER_OPERATIONS,
	type MeetingPublicationFullReviewRuntimeInput,
	type MeetingPublicationSmokeArtifactAnchors,
	type MeetingPublicationSmokeProviderArtifactAnchors,
	type MeetingPublicationSmokeRuntimeObservation,
	type MeetingPublicationWorkerNotifierBinding,
	type MeetingPublicationWorkerRuntimeInput,
	meetingPublicationFullReviewSignatureBytes,
	meetingPublicationWorkerSignatureBytes,
	sha256MeetingPublicationSmokeBytes,
} from "../../src/jarvis/meeting-publication/operational-input.ts";
import {
	MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL,
	type MeetingPublicationSmokeRuntimeSystem,
	MeetingPublicationSmokeRuntimeSystemReference,
} from "../../src/jarvis/meeting-publication/operational-runtime.ts";

interface MeetingPublicationFullReviewAuthorizationFixtureOptions {
	readonly privateRoot: string;
	readonly config: JarvisMeetingPublicationConfig;
	readonly credentialDirectory: string;
	readonly engineStatePath: string;
	readonly installationRoot: string;
	readonly artifactAnchors: MeetingPublicationSmokeArtifactAnchors;
	readonly maxItems?: number;
	readonly notifier?: MeetingPublicationWorkerNotifierBinding;
	readonly runtimeMode?: "bounded" | "long_running";
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
			else throw new Error("The full-review artifact fixture cannot contain links or special files.");
		}
	};
	visit(root);
	return paths.sort().map(boundFile);
};
const writePrivate = (path: string, value: string | Uint8Array) => {
	writeFileSync(path, value, { mode: 0o600 });
	chmodSync(path, 0o600);
};

/** Real full-review signing and replay state with an injected, inert OS writer observer. */
export const createMeetingPublicationFullReviewAuthorizationFixture = (
	options: MeetingPublicationFullReviewAuthorizationFixtureOptions,
) => {
	if (
		options.config.statePath === null ||
		options.config.googleOwnerEmail === null ||
		options.config.googleDriveFolder === null ||
		options.config.discordChannelId === null
	)
		throw new Error("The full-review fixture requires a complete publication config.");
	const statePath = options.config.statePath;
	const effectiveUid = process.geteuid?.();
	if (effectiveUid === undefined || (process.platform !== "darwin" && process.platform !== "linux")) {
		throw new Error("The full-review fixture requires a supported POSIX platform.");
	}
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
	const replayPath = join(options.privateRoot, "full-review-replay.sqlite3");
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

	const replayIdentity = {
		path: realpathSync(replayPath),
		device: lstatSync(replayPath, { bigint: true }).dev.toString(),
		inode: lstatSync(replayPath, { bigint: true }).ino.toString(),
		instanceId: replayInstanceId,
	};
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const issuer = "fixture-owner";
	const keyId = `fixture-${randomBytes(12).toString("hex")}`;
	const trustKey = {
		issuer,
		keyId,
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
		publicKeySha256: sha256MeetingPublicationSmokeBytes(publicKey.export({ type: "spki", format: "der" })),
	};
	const runtime = {
		platform: observation.platform,
		architecture: observation.architecture,
		hostname: observation.hostname,
		uid: observation.uid.toString(),
		bootId: observation.bootId,
		executablePath: observation.executablePath,
		executableSha256: sha256MeetingPublicationSmokeBytes(readFileSync(observation.executablePath)),
	};
	const commonPayload = () => ({
		schemaVersion: 1 as const,
		authorizationId: `full-review-${randomBytes(12).toString("hex")}`,
		nonce: randomBytes(32).toString("hex"),
		issuer,
		keyId,
		issuedAt: new Date(now - 1_000).toISOString(),
		notBefore: new Date(now - 1_000).toISOString(),
		expiresAt: new Date(now + 5 * 60_000).toISOString(),
		maxItems: options.maxItems ?? 1,
		...(options.runtimeMode === undefined ? {} : { runtimeMode: options.runtimeMode }),
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
		runtime,
		replay: replayIdentity,
		revocationSequence: 0,
		stateDatabase: boundFile(join(statePath, "meeting-publication.sqlite3")),
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
	});

	const trustPath = join(options.privateRoot, "full-review-trusted-keyring.json");
	writePrivate(
		trustPath,
		canonicalBytes({
			kind: "harnessy.meeting-publication.full-review-trust",
			schemaVersion: 1,
			audience: MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE,
			keys: [trustKey],
			replay: replayIdentity,
		}),
	);
	const authorizationPath = join(options.privateRoot, "full-review-authorization.json");
	const payload = {
		...commonPayload(),
		kind: "harnessy.meeting-publication.full-review-authorization" as const,
		audience: MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE,
		operations: [...MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS],
	};
	const writeAuthorization = () => {
		writePrivate(
			authorizationPath,
			canonicalBytes({
				payload,
				signature: sign(null, meetingPublicationFullReviewSignatureBytes(payload), privateKey).toString(
					"base64url",
				),
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
	const input: MeetingPublicationFullReviewRuntimeInput = {
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
		resign: (mutate?: (draft: typeof payload) => void) => {
			mutate?.(payload);
			writeAuthorization();
		},
		setWritersPresent: (value: boolean) => {
			writersPresent = value;
		},
		advanceTimeBy: (milliseconds: number) => {
			observationOffsetMillis += milliseconds;
		},
		revoke: () => {
			const database = new DatabaseSync(replayPath, { allowExtension: false });
			try {
				database.exec("BEGIN IMMEDIATE;");
				database
					.prepare(
						"INSERT INTO revocations (sequence,subject_type,subject_id,created_at) VALUES (1,'authorization',?,?)",
					)
					.run(payload.authorizationId, new Date().toISOString());
				database.exec("UPDATE runtime_metadata SET revocation_sequence=1 WHERE singleton=1; COMMIT;");
			} finally {
				database.close();
			}
		},
		createCompetingWorkerInput: (): MeetingPublicationWorkerRuntimeInput => {
			const workerTrustPath = join(options.privateRoot, `worker-trust-${randomBytes(6).toString("hex")}.json`);
			writePrivate(
				workerTrustPath,
				canonicalBytes({
					kind: "harnessy.meeting-publication.worker-trust",
					schemaVersion: 1,
					audience: MEETING_PUBLICATION_WORKER_AUDIENCE,
					keys: [trustKey],
					replay: replayIdentity,
				}),
			);
			const workerPayload = {
				...commonPayload(),
				kind: "harnessy.meeting-publication.worker-authorization" as const,
				authorizationId: `worker-${randomBytes(12).toString("hex")}`,
				nonce: randomBytes(32).toString("hex"),
				audience: MEETING_PUBLICATION_WORKER_AUDIENCE,
				operations: [...MEETING_PUBLICATION_WORKER_OPERATIONS],
			};
			const workerAuthorizationPath = join(
				options.privateRoot,
				`worker-authorization-${randomBytes(6).toString("hex")}.json`,
			);
			writePrivate(
				workerAuthorizationPath,
				canonicalBytes({
					payload: workerPayload,
					signature: sign(null, meetingPublicationWorkerSignatureBytes(workerPayload), privateKey).toString(
						"base64url",
					),
				}),
			);
			return { authorizationPath: workerAuthorizationPath, trustedKeyring: boundFile(workerTrustPath) };
		},
		withSystem: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, system)),
	};
};
