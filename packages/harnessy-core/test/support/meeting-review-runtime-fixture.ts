import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { arch, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";

import type { JarvisMeetingPublicationConfig } from "../../src/jarvis/config-model.ts";
import {
	canonicalMeetingPublicationSmokeJson,
	MEETING_PUBLICATION_REVIEW_AUDIENCE,
	MEETING_PUBLICATION_REVIEW_OPERATIONS,
	MEETING_PUBLICATION_SMOKE_AUDIENCE,
	type MeetingPublicationReviewArtifactAnchors,
	type MeetingPublicationReviewRuntimeInput,
	type MeetingPublicationSmokeRuntimeObservation,
	sha256MeetingPublicationSmokeBytes,
} from "../../src/jarvis/meeting-publication/operational-input.ts";
import {
	MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL,
	type MeetingPublicationSmokeRuntimeSystem,
	MeetingPublicationSmokeRuntimeSystemReference,
} from "../../src/jarvis/meeting-publication/operational-runtime.ts";

export interface MeetingPublicationReviewAuthorizationFixtureOptions {
	readonly privateRoot: string;
	readonly config: JarvisMeetingPublicationConfig;
	readonly v1StatePath: string;
	readonly installationRoot: string;
	readonly artifactAnchors: MeetingPublicationReviewArtifactAnchors & { readonly core: string };
	readonly now?: number;
}

const canonicalBytes = (value: unknown) => `${canonicalMeetingPublicationSmokeJson(value)}\n`;

const fileIdentity = (path: string) => {
	const stat = lstatSync(path, { bigint: true });
	return { path: realpathSync(path), device: stat.dev.toString(), inode: stat.ino.toString() };
};

const boundFile = (path: string) => ({
	...fileIdentity(path),
	sha256: sha256MeetingPublicationSmokeBytes(readFileSync(path)),
});

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
			else throw new Error("The isolated review artifact cannot contain links or special files.");
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
 * Real Ed25519 and SQLite fixture for the signed review runtime. Its injected
 * system proves mechanism only and is not evidence for a production observer.
 */
export const createMeetingPublicationReviewAuthorizationFixture = (
	options: MeetingPublicationReviewAuthorizationFixtureOptions,
) => {
	if (
		!isAbsolute(options.privateRoot) ||
		!isAbsolute(options.installationRoot) ||
		!isAbsolute(options.v1StatePath) ||
		options.config.sourcePath === null ||
		options.config.statePath === null
	) {
		throw new Error("The isolated review fixture requires absolute, explicit roots.");
	}
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error("The isolated review fixture only models supported runtime platforms.");
	}
	const effectiveUid = process.geteuid?.();
	if (effectiveUid === undefined) throw new Error("The isolated review fixture requires an effective uid.");
	chmodSync(options.privateRoot, 0o700);

	const now = options.now ?? Date.now();
	const observation: MeetingPublicationSmokeRuntimeObservation = {
		now,
		monotonic: process.hrtime.bigint(),
		platform: process.platform,
		architecture: arch(),
		hostname: hostname(),
		uid: BigInt(effectiveUid),
		bootId: `review-fixture-${randomBytes(16).toString("hex")}`,
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
					{ role: "dependencies", path: realpathSync(options.artifactAnchors.dependencies) },
				],
				files: artifactFiles(realpathSync(options.installationRoot)),
			}),
		);
	};
	writeArtifactManifest();

	const replayIdentity = { ...fileIdentity(replayPath), instanceId: replayInstanceId };
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const issuer = "review-fixture-owner";
	const keyId = `review-fixture-${randomBytes(12).toString("hex")}`;
	const trustPath = join(options.privateRoot, "trusted-keyring.json");
	const trust = {
		kind: "harnessy.meeting-publication.review-trust",
		schemaVersion: 1,
		audience: MEETING_PUBLICATION_REVIEW_AUDIENCE,
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
	const stateDatabase = () =>
		existsSync(stateDatabasePath)
			? ({ kind: "existing" as const, ...boundFile(stateDatabasePath) } as const)
			: ({ kind: "absent" as const, path: resolve(stateDatabasePath) } as const);
	const payload = {
		kind: "harnessy.meeting-publication.review-authorization",
		schemaVersion: 1,
		authorizationId: `review-${randomBytes(12).toString("hex")}`,
		nonce: randomBytes(32).toString("hex"),
		issuer,
		keyId,
		audience: MEETING_PUBLICATION_REVIEW_AUDIENCE,
		issuedAt: new Date(now - 1_000).toISOString(),
		notBefore: new Date(now - 1_000).toISOString(),
		expiresAt: new Date(now + 5 * 60_000).toISOString(),
		operations: [...MEETING_PUBLICATION_REVIEW_OPERATIONS],
		config: {
			project: options.config.project,
			sourcePath: realpathSync(options.config.sourcePath),
			statePath: realpathSync(options.config.statePath),
			backfillDays: options.config.backfillDays,
			cutoverDate: options.config.cutoverDate,
			maxFileBytes: options.config.maxFileBytes,
			maxFiles: options.config.maxFiles,
			reviewHost: options.config.reviewHost,
			reviewPort: options.config.reviewPort,
			reviewSessionSeconds: options.config.reviewSessionSeconds,
			reviewMaxSessions: options.config.reviewMaxSessions,
			reviewMaxBodyBytes: options.config.reviewMaxBodyBytes,
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
		artifactManifest: hashedFile(artifactManifestPath),
		v1StatePath: resolve(options.v1StatePath),
		sourceDirectory: fileIdentity(options.config.sourcePath),
		stateDirectory: fileIdentity(options.config.statePath),
		stateDatabase: stateDatabase(),
	};
	const writeSignedAuthorization = (value: unknown, audience: string) => {
		const signature = sign(
			null,
			Buffer.from(`${audience}\0${canonicalMeetingPublicationSmokeJson(value)}`, "utf8"),
			privateKey,
		).toString("base64url");
		writePrivate(authorizationPath, canonicalBytes({ payload: value, signature }));
	};
	const writeAuthorization = () => writeSignedAuthorization(payload, MEETING_PUBLICATION_REVIEW_AUDIENCE);
	writeAuthorization();

	let observationOffsetMillis = 0;
	let observationStep = 0n;
	let writerProofs = 0;
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
			writerProofs += 1;
			throw new Error("Review runtime must not inspect or require V1 writer absence.");
		},
	};
	const input: MeetingPublicationReviewRuntimeInput = {
		authorizationPath,
		trustedKeyring: boundFile(trustPath),
	};

	return {
		input,
		payload,
		observation,
		system,
		replayPath,
		authorizationPath,
		trustPath,
		artifactManifestPath,
		artifactAnchors: options.artifactAnchors,
		getWriterProofs: () => writerProofs,
		advanceTimeBy: (milliseconds: number) => {
			observationOffsetMillis += milliseconds;
		},
		resign: (mutate?: (draft: typeof payload) => void) => {
			mutate?.(payload);
			writeAuthorization();
		},
		rebindStateDatabaseAndResign: () => {
			payload.stateDatabase = stateDatabase();
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
		writeCrossDomainAuthorization: () => {
			writeSignedAuthorization(
				{ ...payload, audience: MEETING_PUBLICATION_SMOKE_AUDIENCE },
				MEETING_PUBLICATION_SMOKE_AUDIENCE,
			);
		},
		revoke: () => {
			const database = new DatabaseSync(replayPath, { allowExtension: false, timeout: 1_000 });
			try {
				database.exec("BEGIN IMMEDIATE;");
				database
					.prepare(
						"INSERT INTO revocations (sequence,subject_type,subject_id,created_at) VALUES (1,'authorization',?,?)",
					)
					.run(payload.authorizationId, new Date(system.observe().now).toISOString());
				database.prepare("UPDATE runtime_metadata SET revocation_sequence=1 WHERE singleton=1").run();
				database.exec("COMMIT;");
			} finally {
				database.close();
			}
		},
		withSystem: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			effect.pipe(Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, system)),
	};
};
