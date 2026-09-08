import { createHash, createPublicKey, verify } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

import { Schema } from "effect";
import * as Result from "effect/Result";

import { JarvisMeetingPublicationConfig } from "../config-model.ts";

export const MEETING_PUBLICATION_SMOKE_AUDIENCE = "harnessy.meeting-publication.smoke.v1" as const;
export const MEETING_PUBLICATION_REVIEW_AUDIENCE = "harnessy.meeting-publication.review.v1" as const;
export const MEETING_PUBLICATION_WORKER_AUDIENCE = "harnessy.meeting-publication.worker.v1" as const;
export const MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE = "harnessy.meeting-publication.full-review.v1" as const;
export const MEETING_PUBLICATION_REVIEW_OPERATIONS = [
	"store_open",
	"store_migrate",
	"store_upsert",
	"store_approve",
	"store_reject",
	"store_archive",
	"review_serve",
] as const;
export const MEETING_PUBLICATION_SMOKE_OPERATIONS = [
	"store_open",
	"store_migrate",
	"service_worker",
	"store_claim",
	"provider_google",
	"store_checkpoint",
	"provider_discord",
	"store_failure",
	"store_publish",
] as const;
export const MEETING_PUBLICATION_WORKER_OPERATIONS = [
	"store_open",
	"store_migrate",
	"service_worker",
	"store_archive",
	"store_upsert",
	"provider_notification",
	"store_notification",
	"store_claim",
	"provider_google",
	"store_checkpoint",
	"provider_discord",
	"store_failure",
	"store_publish",
] as const;
export const MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS = [
	...MEETING_PUBLICATION_WORKER_OPERATIONS,
	"source_update",
	"store_approve",
	"store_reject",
	"review_serve",
] as const;

const V1_DARWIN_SCHEDULER_LABELS = [
	"tech.flowresearch.jarvis.meeting-review",
	"com.flow-harness.project.flow-meeting-publication-worker",
] as const;
const V1_LINUX_CRONTAB_MARKERS = [
	"# flow-harness: project/flow-meeting-publication-worker",
	"jarvis meeting publish worker",
] as const;
const V1_PROCESS_MARKERS = ["jarvis meeting publish worker", "jarvis meeting review serve"] as const;
const ARTIFACT_ANCHOR_ROLES = ["core", "host", "sdk", "dependencies"] as const;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 50_000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ITEM_ID_PATTERN = /^[a-f0-9]{24}$/u;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const MeetingPublicationSmokeRuntimeErrorCode = Schema.Literals([
	"unsupported_platform",
	"unsafe_input",
	"invalid_input",
	"invalid_signature",
	"expired_authorization",
	"binding_mismatch",
	"artifact_drift",
	"evidence_drift",
	"state_drift",
	"replay_unavailable",
	"replayed",
	"lease_unavailable",
	"revoked",
	"writer_present",
	"provider_setup_failed",
	"publication_failed",
	"worker_failed",
	"review_failed",
]);
export type MeetingPublicationSmokeRuntimeErrorCode = typeof MeetingPublicationSmokeRuntimeErrorCode.Type;

export class MeetingPublicationSmokeRuntimeError extends Schema.TaggedErrorClass<MeetingPublicationSmokeRuntimeError>()(
	"MeetingPublicationSmokeRuntimeError",
	{ code: MeetingPublicationSmokeRuntimeErrorCode },
) {}

export interface MeetingPublicationSmokeRuntimeInput {
	readonly authorizationPath: string;
	/** Independently pinned by the private host; never derived from the authorization. */
	readonly trustedKeyring: {
		readonly path: string;
		readonly device: string;
		readonly inode: string;
		readonly sha256: string;
	};
}

export interface MeetingPublicationSmokeProviderBinding {
	readonly tenantId: string;
	readonly subjectId: string;
	readonly credentialDirectory: string;
	/** Exact persistent Engine SQLite file; the connection must already exist. */
	readonly engineStatePath: string;
	readonly sourcePath: string;
	readonly statePath: string;
	readonly item: { readonly itemId: string; readonly sourceHash: string };
	readonly google: {
		readonly owner: "org" | "user";
		readonly connection: string;
		readonly authTemplate: "google-drive-file" | "google-drive-file-test-token";
		readonly ownerEmail: string;
		readonly folderPath: string;
	};
	readonly discord: {
		readonly owner: "org" | "user";
		readonly connection: string;
		readonly authTemplate: "discord-bot";
		readonly channelId: string;
	};
	readonly transport:
		| { readonly mode: "production" }
		| {
				readonly mode: "loopback";
				readonly googleDriveBaseUrl: string;
				readonly googleDocsBaseUrl: string;
				readonly discordBaseUrl: string;
		  };
}

export type MeetingPublicationWorkerNotifierBinding =
	| { readonly kind: "unavailable" }
	| {
			readonly kind: "terminal-notifier" | "osascript";
			readonly executable: {
				readonly path: string;
				readonly device: string;
				readonly inode: string;
				readonly sha256: string;
			};
			readonly reviewOpen?: {
				readonly executable: {
					readonly path: string;
					readonly device: string;
					readonly inode: string;
					readonly sha256: string;
				};
				readonly statePath: string;
			};
	  };

export interface MeetingPublicationWorkerProviderBinding extends Omit<MeetingPublicationSmokeProviderBinding, "item"> {
	readonly notifier: MeetingPublicationWorkerNotifierBinding;
}

export interface MeetingPublicationSmokeArtifactAnchors {
	readonly core: string;
	readonly host: string;
	readonly sdk: string;
	readonly dependencies: string;
}

export interface MeetingPublicationSmokeProviderArtifactAnchors {
	readonly host: string;
	readonly sdk: string;
	readonly dependencies: string;
}

export interface MeetingPublicationSmokeRuntimeObservation {
	readonly now: number;
	readonly monotonic: bigint;
	readonly platform: "darwin" | "linux";
	readonly architecture: string;
	readonly hostname: string;
	readonly uid: bigint;
	readonly bootId: string;
	readonly executablePath: string;
}

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(SHA256_PATTERN)));
const ItemId = Schema.String.pipe(Schema.check(Schema.isPattern(ITEM_ID_PATTERN)));
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const FileIdentity = Schema.Struct({ path: Schema.String, device: Schema.String, inode: Schema.String });
const BoundFile = Schema.Struct({ ...FileIdentity.fields, sha256: Sha256 });
const ReplayIdentity = Schema.Struct({ ...FileIdentity.fields, instanceId: Sha256 });
const ProviderOwner = Schema.Literals(["org", "user"]);
const GoogleBinding = Schema.Struct({
	owner: ProviderOwner,
	connection: Schema.String,
	authTemplate: Schema.Literals(["google-drive-file", "google-drive-file-test-token"]),
	ownerEmail: Schema.String,
	folderPath: Schema.String,
});
const DiscordBinding = Schema.Struct({
	owner: ProviderOwner,
	connection: Schema.String,
	authTemplate: Schema.Literal("discord-bot"),
	channelId: Schema.String,
});
const ProductionTransport = Schema.Struct({ mode: Schema.Literal("production") });
const LoopbackTransport = Schema.Struct({
	mode: Schema.Literal("loopback"),
	googleDriveBaseUrl: Schema.String,
	googleDocsBaseUrl: Schema.String,
	discordBaseUrl: Schema.String,
});
const Transport = Schema.Union([ProductionTransport, LoopbackTransport]);
const ArtifactManifest = Schema.Struct({
	kind: Schema.Literal("harnessy.runtime-artifact-manifest"),
	schemaVersion: Schema.Literal(1),
	root: Schema.String,
	anchors: Schema.Array(Schema.Struct({ role: Schema.Literals(ARTIFACT_ANCHOR_ROLES), path: Schema.String })),
	files: Schema.Array(BoundFile),
});
const TrustDocument = Schema.Struct({
	kind: Schema.Literal("harnessy.meeting-publication.smoke-trust"),
	schemaVersion: Schema.Literal(1),
	audience: Schema.Literal(MEETING_PUBLICATION_SMOKE_AUDIENCE),
	keys: Schema.Array(
		Schema.Struct({
			issuer: Schema.String,
			keyId: Schema.String,
			publicKeyPem: Schema.String,
			publicKeySha256: Sha256,
		}),
	),
	replay: ReplayIdentity,
});
const AuthorizationPayload = Schema.Struct({
	kind: Schema.Literal("harnessy.meeting-publication.smoke-authorization"),
	schemaVersion: Schema.Literal(1),
	authorizationId: Schema.String,
	nonce: Sha256,
	issuer: Schema.String,
	keyId: Schema.String,
	audience: Schema.Literal(MEETING_PUBLICATION_SMOKE_AUDIENCE),
	issuedAt: Schema.String,
	notBefore: Schema.String,
	expiresAt: Schema.String,
	operations: Schema.Array(Schema.String),
	subject: Schema.Struct({ tenantId: Schema.String, subjectId: Schema.String }),
	config: JarvisMeetingPublicationConfig,
	item: Schema.Struct({ itemId: ItemId, sourceHash: Sha256 }),
	credentials: Schema.Struct({ directory: Schema.String, engineState: BoundFile }),
	google: GoogleBinding,
	discord: DiscordBinding,
	transport: Transport,
	runtime: Schema.Struct({
		platform: Schema.Literals(["darwin", "linux"]),
		architecture: Schema.String,
		hostname: Schema.String,
		uid: Schema.String,
		bootId: Schema.String,
		executablePath: Schema.String,
		executableSha256: Sha256,
	}),
	replay: ReplayIdentity,
	revocationSequence: NonNegativeInt,
	stateDatabase: BoundFile,
	artifactManifest: Schema.Struct({ path: Schema.String, sha256: Sha256 }),
	cutoverEvidence: Schema.Struct({ path: Schema.String, sha256: Sha256 }),
	rollbackPlan: Schema.Struct({ path: Schema.String, sha256: Sha256 }),
	oneWriter: Schema.Struct({
		kind: Schema.Literal("known-v1-writers-v1"),
		darwinSchedulerLabels: Schema.Array(Schema.String),
		linuxCrontabMarkers: Schema.Array(Schema.String),
		processMarkers: Schema.Array(Schema.String),
	}),
});
const AuthorizationEnvelope = Schema.Struct({ payload: AuthorizationPayload, signature: Schema.String });

const WorkerTrustDocument = Schema.Struct({
	...TrustDocument.fields,
	kind: Schema.Literal("harnessy.meeting-publication.worker-trust"),
	audience: Schema.Literal(MEETING_PUBLICATION_WORKER_AUDIENCE),
});
const WorkerNotifier = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unavailable") }),
	Schema.Struct({
		kind: Schema.Literals(["terminal-notifier", "osascript"]),
		executable: BoundFile,
		reviewOpen: Schema.optional(Schema.Struct({ executable: BoundFile, statePath: Schema.String })),
	}),
]);
const WorkerAuthorizationPayload = Schema.Struct({
	kind: Schema.Literal("harnessy.meeting-publication.worker-authorization"),
	schemaVersion: Schema.Literal(1),
	authorizationId: Schema.String,
	nonce: Sha256,
	issuer: Schema.String,
	keyId: Schema.String,
	audience: Schema.Literal(MEETING_PUBLICATION_WORKER_AUDIENCE),
	issuedAt: Schema.String,
	notBefore: Schema.String,
	expiresAt: Schema.String,
	operations: Schema.Array(Schema.String),
	maxItems: Schema.Int,
	subject: AuthorizationPayload.fields.subject,
	config: JarvisMeetingPublicationConfig,
	credentials: AuthorizationPayload.fields.credentials,
	google: GoogleBinding,
	discord: DiscordBinding,
	notifier: WorkerNotifier,
	transport: Transport,
	runtime: AuthorizationPayload.fields.runtime,
	replay: ReplayIdentity,
	revocationSequence: NonNegativeInt,
	stateDatabase: BoundFile,
	artifactManifest: AuthorizationPayload.fields.artifactManifest,
	cutoverEvidence: AuthorizationPayload.fields.cutoverEvidence,
	rollbackPlan: AuthorizationPayload.fields.rollbackPlan,
	oneWriter: AuthorizationPayload.fields.oneWriter,
});
const WorkerAuthorizationEnvelope = Schema.Struct({
	payload: WorkerAuthorizationPayload,
	signature: Schema.String,
});

const FullReviewTrustDocument = Schema.Struct({
	...TrustDocument.fields,
	kind: Schema.Literal("harnessy.meeting-publication.full-review-trust"),
	audience: Schema.Literal(MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE),
});
const FullReviewAuthorizationPayload = Schema.Struct({
	...WorkerAuthorizationPayload.fields,
	kind: Schema.Literal("harnessy.meeting-publication.full-review-authorization"),
	audience: Schema.Literal(MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE),
	/** Explicitly opts into the long-running V2 owner; omitted means the bounded manual session. */
	runtimeMode: Schema.optional(Schema.Literals(["bounded", "long_running"])),
});
const FullReviewAuthorizationEnvelope = Schema.Struct({
	payload: FullReviewAuthorizationPayload,
	signature: Schema.String,
});

const ReviewTrustDocument = Schema.Struct({
	...TrustDocument.fields,
	kind: Schema.Literal("harnessy.meeting-publication.review-trust"),
	audience: Schema.Literal(MEETING_PUBLICATION_REVIEW_AUDIENCE),
});
const ReviewConfig = Schema.Struct({
	project: JarvisMeetingPublicationConfig.fields.project,
	sourcePath: Schema.String,
	statePath: Schema.String,
	backfillDays: JarvisMeetingPublicationConfig.fields.backfillDays,
	cutoverDate: JarvisMeetingPublicationConfig.fields.cutoverDate,
	maxFileBytes: JarvisMeetingPublicationConfig.fields.maxFileBytes,
	maxFiles: JarvisMeetingPublicationConfig.fields.maxFiles,
	reviewHost: JarvisMeetingPublicationConfig.fields.reviewHost,
	reviewPort: JarvisMeetingPublicationConfig.fields.reviewPort,
	reviewSessionSeconds: JarvisMeetingPublicationConfig.fields.reviewSessionSeconds,
	reviewMaxSessions: JarvisMeetingPublicationConfig.fields.reviewMaxSessions,
	reviewMaxBodyBytes: JarvisMeetingPublicationConfig.fields.reviewMaxBodyBytes,
});
const ReviewAuthorizationPayload = Schema.Struct({
	kind: Schema.Literal("harnessy.meeting-publication.review-authorization"),
	schemaVersion: Schema.Literal(1),
	authorizationId: Schema.String,
	nonce: Sha256,
	issuer: Schema.String,
	keyId: Schema.String,
	audience: Schema.Literal(MEETING_PUBLICATION_REVIEW_AUDIENCE),
	issuedAt: Schema.String,
	notBefore: Schema.String,
	expiresAt: Schema.String,
	operations: Schema.Array(Schema.String),
	config: ReviewConfig,
	runtime: AuthorizationPayload.fields.runtime,
	replay: ReplayIdentity,
	revocationSequence: NonNegativeInt,
	artifactManifest: AuthorizationPayload.fields.artifactManifest,
	/** Owner-attested V1 state location. A shared state directory may be inspected; V1-owned files are never opened. */
	v1StatePath: Schema.String,
	sourceDirectory: FileIdentity,
	stateDirectory: FileIdentity,
	stateDatabase: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("absent"), path: Schema.String }),
		Schema.Struct({ kind: Schema.Literal("existing"), ...BoundFile.fields }),
	]),
});
const ReviewAuthorizationEnvelope = Schema.Struct({ payload: ReviewAuthorizationPayload, signature: Schema.String });

type SmokeAuthorizationPayload = typeof AuthorizationPayload.Type;
type SmokeTrustDocument = typeof TrustDocument.Type;
type ArtifactManifest = typeof ArtifactManifest.Type;
type WorkerAuthorizationPayload = typeof WorkerAuthorizationPayload.Type;
type FullReviewAuthorizationPayload = typeof FullReviewAuthorizationPayload.Type;

export interface VerifiedMeetingPublicationSmokeInput {
	readonly kind: "smoke";
	readonly authorization: SmokeAuthorizationPayload;
	readonly authorizationDigest: string;
	readonly config: JarvisMeetingPublicationConfig;
	readonly providerBinding: MeetingPublicationSmokeProviderBinding;
	readonly replayPath: string;
	readonly replayIdentity: SmokeTrustDocument["replay"];
	readonly initialRevocationSequence: number;
	readonly immutableFiles: ReadonlyArray<{
		readonly path: string;
		readonly sha256: string;
		readonly role: "private" | "artifact";
		readonly maximumBytes: number;
	}>;
	readonly artifactManifest: ArtifactManifest;
	readonly startedAt: number;
	readonly startedMonotonic: bigint;
}

export interface VerifiedMeetingPublicationReviewInput
	extends Omit<VerifiedMeetingPublicationSmokeInput, "kind" | "authorization" | "providerBinding"> {
	readonly kind: "review";
	readonly authorization: typeof ReviewAuthorizationPayload.Type;
}
export interface VerifiedMeetingPublicationWorkerInput
	extends Omit<VerifiedMeetingPublicationSmokeInput, "kind" | "authorization" | "providerBinding"> {
	readonly kind: "worker";
	readonly authorization: WorkerAuthorizationPayload;
	readonly providerBinding: MeetingPublicationWorkerProviderBinding;
}
export interface VerifiedMeetingPublicationFullReviewInput
	extends Omit<VerifiedMeetingPublicationWorkerInput, "kind" | "authorization"> {
	readonly kind: "full_review";
	readonly authorization: FullReviewAuthorizationPayload;
}
export type VerifiedMeetingPublicationRuntimeInput =
	| VerifiedMeetingPublicationSmokeInput
	| VerifiedMeetingPublicationReviewInput
	| VerifiedMeetingPublicationWorkerInput
	| VerifiedMeetingPublicationFullReviewInput;
export type MeetingPublicationReviewRuntimeInput = MeetingPublicationSmokeRuntimeInput;
export type MeetingPublicationWorkerRuntimeInput = MeetingPublicationSmokeRuntimeInput;
export type MeetingPublicationFullReviewRuntimeInput = MeetingPublicationSmokeRuntimeInput;
export interface MeetingPublicationReviewArtifactAnchors {
	readonly host: string;
	readonly dependencies: string;
}

type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };

const fail = (code: MeetingPublicationSmokeRuntimeErrorCode): never => {
	throw new MeetingPublicationSmokeRuntimeError({ code });
};

const asJsonValue = (value: unknown): JsonValue => {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(asJsonValue);
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, entry]) => [key, asJsonValue(entry)]),
		);
	}
	return fail("invalid_input");
};

export const canonicalMeetingPublicationSmokeJson = (value: unknown) => JSON.stringify(asJsonValue(value));
export const sha256MeetingPublicationSmokeBytes = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
export const meetingPublicationSmokeSignatureBytes = (payload: unknown) =>
	Buffer.from(`${MEETING_PUBLICATION_SMOKE_AUDIENCE}\0${canonicalMeetingPublicationSmokeJson(payload)}`, "utf8");
export const meetingPublicationWorkerSignatureBytes = (payload: unknown) =>
	Buffer.from(`${MEETING_PUBLICATION_WORKER_AUDIENCE}\0${canonicalMeetingPublicationSmokeJson(payload)}`, "utf8");
export const meetingPublicationFullReviewSignatureBytes = (payload: unknown) =>
	Buffer.from(`${MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE}\0${canonicalMeetingPublicationSmokeJson(payload)}`, "utf8");

const decode = <A>(schema: Schema.Decoder<A>, value: unknown): A => {
	const decoded = Result.try({
		try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value),
		catch: () => undefined,
	});
	return Result.isSuccess(decoded) ? decoded.success : fail("invalid_input");
};

const exactValues = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
	actual.length === expected.length && actual.every((value, index) => value === expected[index]);
const safeText = (value: string, maximum = 256) =>
	value.length > 0 &&
	value.length <= maximum &&
	!Array.from(value).some((character) => {
		const point = character.codePointAt(0) ?? 0;
		return point <= 0x1f || point === 0x7f;
	});
const safeId = (value: string) => safeText(value) && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value);
const absolutePath = (value: string) =>
	value.length > 0 &&
	value.length <= 4_096 &&
	isAbsolute(value) &&
	resolve(value) === value &&
	parse(value).root !== value &&
	!Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f);
const parseInstant = (value: string) => {
	const milliseconds = Date.parse(value);
	return ISO_INSTANT_PATTERN.test(value) &&
		Number.isFinite(milliseconds) &&
		new Date(milliseconds).toISOString() === value
		? milliseconds
		: fail("invalid_input");
};
const loopbackOrigin = (value: string) => {
	if (!URL.canParse(value)) return false;
	const parsed = new URL(value);
	return (
		parsed.protocol === "http:" &&
		(parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") &&
		parsed.username === "" &&
		parsed.password === "" &&
		parsed.pathname === "/" &&
		parsed.search === "" &&
		parsed.hash === "" &&
		parsed.origin === value
	);
};

const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.uid === right.uid &&
	left.gid === right.gid &&
	left.mode === right.mode;
const sameFile = (left: BigIntStats, right: BigIntStats) =>
	sameIdentity(left, right) &&
	left.nlink === right.nlink &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs &&
	left.ctimeNs === right.ctimeNs;
const directoryChain = (path: string, uid: bigint) => {
	const paths = [path];
	for (let parent = dirname(path); parent !== paths[0]; parent = dirname(parent)) paths.unshift(parent);
	const entries: Array<readonly [string, BigIntStats]> = [];
	let sharedParent = false;
	for (const current of paths) {
		const stat = lstatSync(current, { bigint: true });
		const mode = stat.mode & 0o7777n;
		const shared = current !== path && stat.uid === 0n && mode === 0o1777n;
		if (
			!stat.isDirectory() ||
			realpathSync(current) !== current ||
			(stat.uid !== uid && stat.uid !== 0n) ||
			(sharedParent && stat.uid !== uid) ||
			(!shared && (mode & 0o7022n) !== 0n)
		)
			fail("unsafe_input");
		entries.push([current, stat]);
		sharedParent = shared;
	}
	return entries;
};

/** @internal Shared read-only filesystem binding check; grants no write authority. */
export const meetingPublicationDirectoryChain = directoryChain;

export const readStableMeetingPublicationSmokeFile = (
	path: string,
	uid: bigint,
	role: "private" | "artifact",
	maximumBytes = MAX_INPUT_BYTES,
) => {
	const result = Result.try({
		try: () => {
			if (!absolutePath(path)) fail("unsafe_input");
			const parents = directoryChain(dirname(path), uid);
			const before = lstatSync(path, { bigint: true });
			const mode = before.mode & 0o7777n;
			if (
				!before.isFile() ||
				before.nlink !== 1n ||
				realpathSync(path) !== path ||
				(before.uid !== uid && (role === "private" || before.uid !== 0n)) ||
				(mode & 0o7022n) !== 0n ||
				(mode & 0o400n) === 0n ||
				(role === "private" && mode !== 0o400n && mode !== 0o600n) ||
				before.size > BigInt(maximumBytes)
			)
				fail("unsafe_input");
			const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				if (!sameFile(before, fstatSync(descriptor, { bigint: true }))) fail("unsafe_input");
				const bytes = Buffer.alloc(Number(before.size) + 1);
				let length = 0;
				while (length < bytes.length) {
					const count = readSync(descriptor, bytes, length, bytes.length - length, null);
					if (count === 0) break;
					length += count;
				}
				if (
					BigInt(length) !== before.size ||
					!sameFile(before, fstatSync(descriptor, { bigint: true })) ||
					!sameFile(before, lstatSync(path, { bigint: true })) ||
					realpathSync(path) !== path
				)
					fail("unsafe_input");
				for (const [parent, stat] of parents) {
					if (!sameIdentity(stat, lstatSync(parent, { bigint: true })) || realpathSync(parent) !== parent)
						fail("unsafe_input");
				}
				return {
					bytes: bytes.subarray(0, length),
					stat: before,
					identity: { path, device: before.dev.toString(), inode: before.ino.toString() },
				} as const;
			} finally {
				closeSync(descriptor);
			}
		},
		catch: (cause) => cause,
	});
	if (Result.isSuccess(result)) return result.success;
	if (result.failure instanceof MeetingPublicationSmokeRuntimeError) throw result.failure;
	return fail("unsafe_input");
};

const decodeUtf8 = (bytes: Uint8Array) => {
	const decoded = Result.try({
		try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
		catch: () => undefined,
	});
	return Result.isSuccess(decoded) ? decoded.success : fail("invalid_input");
};
const readCanonical = <A>(path: string, uid: bigint, role: "private" | "artifact", schema: Schema.Decoder<A>) => {
	const file = readStableMeetingPublicationSmokeFile(path, uid, role);
	const text = decodeUtf8(file.bytes);
	const parsed = Result.try({ try: () => JSON.parse(text) as unknown, catch: () => undefined });
	const raw = Result.isSuccess(parsed) ? parsed.success : fail("invalid_input");
	if (`${canonicalMeetingPublicationSmokeJson(raw)}\n` !== text) fail("invalid_input");
	return { ...file, value: decode(schema, raw) } as const;
};
const identityMatches = (actual: { path: string; device: string; inode: string }, expected: typeof FileIdentity.Type) =>
	actual.path === expected.path && actual.device === expected.device && actual.inode === expected.inode;
const checkedFile = (
	entry: { readonly path: string; readonly sha256: string },
	uid: bigint,
	role: "private" | "artifact",
	maximum = MAX_INPUT_BYTES,
) => {
	const file = readStableMeetingPublicationSmokeFile(entry.path, uid, role, maximum);
	return { file, matches: sha256MeetingPublicationSmokeBytes(file.bytes) === entry.sha256 } as const;
};
const validateIdentity = (identity: typeof FileIdentity.Type) =>
	absolutePath(identity.path) && /^\d+$/u.test(identity.device) && /^\d+$/u.test(identity.inode);
const assertPrivateDirectory = (path: string, uid: bigint) => {
	directoryChain(path, uid);
	const stat = lstatSync(path, { bigint: true });
	if (stat.uid !== uid || (stat.mode & 0o7777n) !== 0o700n) fail("unsafe_input");
};
const assertSourceDirectory = (path: string, uid: bigint) => {
	directoryChain(path, uid);
	const stat = lstatSync(path, { bigint: true });
	if (stat.uid !== uid || (stat.mode & 0o500n) !== 0o500n) fail("unsafe_input");
	return stat;
};

const validateTrust = (trust: Pick<SmokeTrustDocument, "keys" | "replay">) => {
	if (trust.keys.length < 1 || trust.keys.length > 32 || !validateIdentity(trust.replay)) fail("invalid_input");
	const ids = new Set<string>();
	for (const entry of trust.keys) {
		if (!safeId(entry.issuer) || !safeId(entry.keyId) || ids.has(entry.keyId) || entry.publicKeyPem.length > 4_096)
			fail("invalid_input");
		ids.add(entry.keyId);
		const parsed = Result.try({
			try: () => {
				const key = createPublicKey(entry.publicKeyPem);
				if (
					key.asymmetricKeyType !== "ed25519" ||
					sha256MeetingPublicationSmokeBytes(key.export({ type: "spki", format: "der" }) as Buffer) !==
						entry.publicKeySha256
				)
					fail("invalid_input");
			},
			catch: (cause) => cause,
		});
		if (Result.isFailure(parsed)) {
			if (parsed.failure instanceof MeetingPublicationSmokeRuntimeError) throw parsed.failure;
			fail("invalid_input");
		}
	}
};

const validateProviderPayload = (
	payload: SmokeAuthorizationPayload | WorkerAuthorizationPayload | FullReviewAuthorizationPayload,
	operations: ReadonlyArray<string>,
) => {
	if (
		!safeId(payload.authorizationId) ||
		!safeId(payload.issuer) ||
		!safeId(payload.keyId) ||
		!exactValues(payload.operations, operations) ||
		!safeId(payload.subject.tenantId) ||
		!safeId(payload.subject.subjectId) ||
		!absolutePath(payload.credentials.directory) ||
		!validateIdentity(payload.credentials.engineState) ||
		!safeId(payload.google.connection) ||
		!safeText(payload.google.ownerEmail, 320) ||
		!safeText(payload.google.folderPath, 2_048) ||
		!safeId(payload.discord.connection) ||
		!/^\d{1,32}$/u.test(payload.discord.channelId) ||
		!validateIdentity(payload.replay) ||
		!validateIdentity(payload.stateDatabase) ||
		!absolutePath(payload.artifactManifest.path) ||
		!absolutePath(payload.cutoverEvidence.path) ||
		!absolutePath(payload.rollbackPlan.path) ||
		!absolutePath(payload.runtime.executablePath) ||
		!/^\d+$/u.test(payload.runtime.uid) ||
		!safeText(payload.runtime.bootId, 512) ||
		!exactValues(payload.oneWriter.darwinSchedulerLabels, V1_DARWIN_SCHEDULER_LABELS) ||
		!exactValues(payload.oneWriter.linuxCrontabMarkers, V1_LINUX_CRONTAB_MARKERS) ||
		!exactValues(payload.oneWriter.processMarkers, V1_PROCESS_MARKERS)
	)
		fail("invalid_input");
	if (payload.transport.mode === "loopback") {
		if (
			payload.google.authTemplate !== "google-drive-file-test-token" ||
			!loopbackOrigin(payload.transport.googleDriveBaseUrl) ||
			!loopbackOrigin(payload.transport.googleDocsBaseUrl) ||
			!loopbackOrigin(payload.transport.discordBaseUrl)
		)
			fail("invalid_input");
	} else if (payload.google.authTemplate !== "google-drive-file") fail("invalid_input");
	parseInstant(payload.issuedAt);
	parseInstant(payload.notBefore);
	parseInstant(payload.expiresAt);
};

const validatePayload = (payload: SmokeAuthorizationPayload) =>
	validateProviderPayload(payload, MEETING_PUBLICATION_SMOKE_OPERATIONS);

const validateWorkerPayload = (
	payload: WorkerAuthorizationPayload | FullReviewAuthorizationPayload,
	operations: ReadonlyArray<string>,
) => {
	validateProviderPayload(payload, operations);
	if (
		!Number.isSafeInteger(payload.maxItems) ||
		payload.maxItems < 1 ||
		payload.maxItems > 100 ||
		(payload.notifier.kind !== "unavailable" &&
			(!validateIdentity(payload.notifier.executable) ||
				(payload.notifier.reviewOpen !== undefined &&
					(!validateIdentity(payload.notifier.reviewOpen.executable) ||
						!absolutePath(payload.notifier.reviewOpen.statePath) ||
						payload.notifier.reviewOpen.statePath !== payload.config.statePath))))
	)
		fail("invalid_input");
};

const enumerateRoot = (root: string, uid: bigint) => {
	if (!absolutePath(root)) fail("artifact_drift");
	directoryChain(root, uid);
	const files: Array<string> = [];
	const visit = (directory: string) => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stat = lstatSync(path, { bigint: true });
			if (stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o0022n) !== 0n)
				fail("artifact_drift");
			if (stat.isDirectory()) visit(path);
			else if (stat.isFile()) files.push(path);
			else fail("artifact_drift");
			if (files.length > MAX_ARTIFACT_FILES) fail("artifact_drift");
		}
	};
	visit(root);
	return files;
};
const within = (root: string, path: string) => {
	const value = relative(root, path);
	return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
};
const validateArtifactInventory = (
	manifest: ArtifactManifest,
	uid: bigint,
	kind: "smoke" | "review" | "worker" | "full_review" = "smoke",
) => {
	if (
		!absolutePath(manifest.root) ||
		!exactValues(
			manifest.anchors.map((anchor) => anchor.role),
			kind === "review" ? ["core", "host", "dependencies"] : ARTIFACT_ANCHOR_ROLES,
		)
	)
		fail("artifact_drift");
	const actual = enumerateRoot(manifest.root, uid).sort();
	const declared = manifest.files.map((file) => file.path);
	if (
		new Set(declared).size !== declared.length ||
		!exactValues(declared, [...declared].sort()) ||
		!exactValues(declared, actual)
	)
		fail("artifact_drift");
	const anchors = manifest.anchors.map((anchor) => anchor.path);
	if (
		new Set(anchors).size !== anchors.length ||
		anchors.some((anchor) => !within(manifest.root, anchor) || !declared.includes(anchor))
	)
		fail("artifact_drift");
	let totalBytes = 0;
	for (const file of manifest.files) {
		const checked = checkedFile(file, uid, "artifact", MAX_ARTIFACT_BYTES);
		totalBytes += checked.file.bytes.length;
		if (totalBytes > MAX_ARTIFACT_BYTES || !checked.matches) fail("artifact_drift");
	}
	const coreAnchor = realpathSync(fileURLToPath(import.meta.url));
	if (manifest.anchors[0]?.role !== "core" || manifest.anchors[0].path !== coreAnchor) fail("artifact_drift");
};

const readSignedAuthorization = <
	P extends { readonly issuer: string; readonly keyId: string },
	T extends Pick<SmokeTrustDocument, "keys" | "replay">,
>(
	input: MeetingPublicationSmokeRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
	trustSchema: Schema.Decoder<T>,
	envelopeSchema: Schema.Decoder<{ readonly payload: P; readonly signature: string }>,
	audience: string,
) => {
	if (!validateIdentity(input.trustedKeyring)) fail("unsafe_input");
	const trustFile = readCanonical(input.trustedKeyring.path, observation.uid, "private", trustSchema);
	if (
		!identityMatches(trustFile.identity, input.trustedKeyring) ||
		sha256MeetingPublicationSmokeBytes(trustFile.bytes) !== input.trustedKeyring.sha256
	)
		fail("invalid_signature");
	const envelopeFile = readCanonical(input.authorizationPath, observation.uid, "private", envelopeSchema);
	const trust = trustFile.value;
	const envelope = envelopeFile.value;
	const payload = envelope.payload;
	validateTrust(trust);
	const key =
		trust.keys.find((entry) => entry.keyId === payload.keyId && entry.issuer === payload.issuer) ??
		fail("invalid_signature");
	if (!/^[A-Za-z0-9_-]{80,128}$/u.test(envelope.signature)) fail("invalid_signature");
	const verifiedSignature = Result.try({
		try: () => {
			if (
				!verify(
					null,
					Buffer.from(`${audience}\0${canonicalMeetingPublicationSmokeJson(payload)}`, "utf8"),
					createPublicKey(key.publicKeyPem),
					Buffer.from(envelope.signature, "base64url"),
				)
			)
				fail("invalid_signature");
		},
		catch: (cause) => cause,
	});
	if (Result.isFailure(verifiedSignature)) {
		if (verifiedSignature.failure instanceof MeetingPublicationSmokeRuntimeError) throw verifiedSignature.failure;
		fail("invalid_signature");
	}
	return { payload, trust, envelopeFile };
};

export const verifyMeetingPublicationSmokeInput = (
	input: MeetingPublicationSmokeRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
): VerifiedMeetingPublicationSmokeInput => {
	const { payload, trust, envelopeFile } = readSignedAuthorization(
		input,
		observation,
		TrustDocument,
		AuthorizationEnvelope,
		MEETING_PUBLICATION_SMOKE_AUDIENCE,
	);
	validatePayload(payload);
	const issuedAt = parseInstant(payload.issuedAt);
	const notBefore = parseInstant(payload.notBefore);
	const expiresAt = parseInstant(payload.expiresAt);
	if (
		issuedAt > notBefore ||
		notBefore > expiresAt ||
		expiresAt - issuedAt > 15 * 60_000 ||
		observation.now < notBefore ||
		observation.now >= expiresAt
	)
		fail("expired_authorization");
	const replay = readStableMeetingPublicationSmokeFile(
		trust.replay.path,
		observation.uid,
		"private",
		MAX_ARTIFACT_BYTES,
	);
	if (
		payload.runtime.platform !== observation.platform ||
		payload.runtime.architecture !== observation.architecture ||
		payload.runtime.hostname !== observation.hostname ||
		payload.runtime.uid !== observation.uid.toString() ||
		payload.runtime.bootId !== observation.bootId ||
		payload.runtime.executablePath !== observation.executablePath ||
		!identityMatches(replay.identity, trust.replay) ||
		!identityMatches(payload.replay, trust.replay) ||
		payload.replay.instanceId !== trust.replay.instanceId
	)
		fail("binding_mismatch");
	const config = payload.config;
	const sourcePath = config.sourcePath ?? fail("binding_mismatch");
	const statePath = config.statePath ?? fail("binding_mismatch");
	if (
		!config.enabled ||
		!absolutePath(sourcePath) ||
		!absolutePath(statePath) ||
		config.googleOwnerEmail !== payload.google.ownerEmail ||
		config.googleDriveFolder !== payload.google.folderPath ||
		config.discordChannelId !== payload.discord.channelId ||
		payload.stateDatabase.path !== join(statePath, "meeting-publication.sqlite3")
	)
		fail("binding_mismatch");
	assertSourceDirectory(sourcePath, observation.uid);
	if (
		!checkedFile(
			{ path: observation.executablePath, sha256: payload.runtime.executableSha256 },
			observation.uid,
			"artifact",
			MAX_EXECUTABLE_BYTES,
		).matches
	)
		fail("artifact_drift");
	const state = checkedFile(payload.stateDatabase, observation.uid, "private", MAX_ARTIFACT_BYTES);
	if (!state.matches || !identityMatches(state.file.identity, payload.stateDatabase)) fail("state_drift");
	const engineState = checkedFile(payload.credentials.engineState, observation.uid, "private", MAX_ARTIFACT_BYTES);
	if (!engineState.matches || !identityMatches(engineState.file.identity, payload.credentials.engineState))
		fail("binding_mismatch");
	assertPrivateDirectory(payload.credentials.directory, observation.uid);
	const manifestFile = checkedFile(payload.artifactManifest, observation.uid, "artifact", MAX_MANIFEST_BYTES);
	if (!manifestFile.matches) fail("artifact_drift");
	const manifestText = decodeUtf8(manifestFile.file.bytes);
	const parsedManifest = Result.try({
		try: () => JSON.parse(manifestText) as unknown,
		catch: () => undefined,
	});
	const manifestRaw = Result.isSuccess(parsedManifest) ? parsedManifest.success : fail("artifact_drift");
	if (`${canonicalMeetingPublicationSmokeJson(manifestRaw)}\n` !== manifestText) fail("artifact_drift");
	const artifactManifest = decode(ArtifactManifest, manifestRaw);
	validateArtifactInventory(artifactManifest, observation.uid);
	for (const privatePath of [
		input.authorizationPath,
		input.trustedKeyring.path,
		payload.replay.path,
		payload.stateDatabase.path,
		payload.credentials.directory,
		payload.credentials.engineState.path,
		payload.artifactManifest.path,
		payload.cutoverEvidence.path,
		payload.rollbackPlan.path,
		sourcePath,
		statePath,
	]) {
		if (within(artifactManifest.root, privatePath) || within(privatePath, artifactManifest.root))
			fail("binding_mismatch");
	}
	for (const evidence of [payload.cutoverEvidence, payload.rollbackPlan]) {
		if (!checkedFile(evidence, observation.uid, "private").matches) fail("evidence_drift");
	}
	const providerBinding: MeetingPublicationSmokeProviderBinding = Object.freeze({
		tenantId: payload.subject.tenantId,
		subjectId: payload.subject.subjectId,
		credentialDirectory: payload.credentials.directory,
		engineStatePath: payload.credentials.engineState.path,
		sourcePath,
		statePath,
		item: Object.freeze({ ...payload.item }),
		google: Object.freeze({ ...payload.google }),
		discord: Object.freeze({ ...payload.discord }),
		transport: Object.freeze({ ...payload.transport }),
	});
	return Object.freeze({
		kind: "smoke" as const,
		authorization: payload,
		authorizationDigest: sha256MeetingPublicationSmokeBytes(meetingPublicationSmokeSignatureBytes(payload)),
		config,
		providerBinding,
		replayPath: trust.replay.path,
		replayIdentity: trust.replay,
		initialRevocationSequence: payload.revocationSequence,
		artifactManifest,
		immutableFiles: Object.freeze([
			{
				path: observation.executablePath,
				sha256: payload.runtime.executableSha256,
				role: "artifact" as const,
				maximumBytes: MAX_EXECUTABLE_BYTES,
			},
			{
				path: input.trustedKeyring.path,
				sha256: input.trustedKeyring.sha256,
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: input.authorizationPath,
				sha256: sha256MeetingPublicationSmokeBytes(envelopeFile.bytes),
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: payload.artifactManifest.path,
				sha256: payload.artifactManifest.sha256,
				role: "artifact" as const,
				maximumBytes: MAX_MANIFEST_BYTES,
			},
			{
				path: payload.cutoverEvidence.path,
				sha256: payload.cutoverEvidence.sha256,
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: payload.rollbackPlan.path,
				sha256: payload.rollbackPlan.sha256,
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
		]),
		startedAt: observation.now,
		startedMonotonic: observation.monotonic,
	});
};

type WorkerLikeAuthorizationPayload = WorkerAuthorizationPayload | FullReviewAuthorizationPayload;
type VerifiedWorkerLikeInput<K extends "worker" | "full_review", P extends WorkerLikeAuthorizationPayload> = Omit<
	VerifiedMeetingPublicationWorkerInput,
	"kind" | "authorization"
> & {
	readonly kind: K;
	readonly authorization: P;
};

const verifyMeetingPublicationWorkerLikeInput = <
	K extends "worker" | "full_review",
	P extends WorkerLikeAuthorizationPayload,
>(
	input: MeetingPublicationWorkerRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
	payload: P,
	trust: Pick<SmokeTrustDocument, "replay">,
	envelopeBytes: Uint8Array,
	kind: K,
	audience: string,
): VerifiedWorkerLikeInput<K, P> => {
	const issuedAt = parseInstant(payload.issuedAt);
	const notBefore = parseInstant(payload.notBefore);
	const expiresAt = parseInstant(payload.expiresAt);
	if (
		issuedAt > notBefore ||
		notBefore > expiresAt ||
		expiresAt - issuedAt >
			(payload.kind === "harnessy.meeting-publication.full-review-authorization" &&
			payload.runtimeMode === "long_running"
				? 24 * 60 * 60_000
				: 15 * 60_000) ||
		observation.now < notBefore ||
		observation.now >= expiresAt
	)
		fail("expired_authorization");
	const replay = readStableMeetingPublicationSmokeFile(
		trust.replay.path,
		observation.uid,
		"private",
		MAX_ARTIFACT_BYTES,
	);
	if (
		payload.runtime.platform !== observation.platform ||
		payload.runtime.architecture !== observation.architecture ||
		payload.runtime.hostname !== observation.hostname ||
		payload.runtime.uid !== observation.uid.toString() ||
		payload.runtime.bootId !== observation.bootId ||
		payload.runtime.executablePath !== observation.executablePath ||
		!identityMatches(replay.identity, trust.replay) ||
		!identityMatches(payload.replay, trust.replay) ||
		payload.replay.instanceId !== trust.replay.instanceId
	)
		fail("binding_mismatch");
	const config = payload.config;
	const sourcePath = config.sourcePath ?? fail("binding_mismatch");
	const statePath = config.statePath ?? fail("binding_mismatch");
	if (
		!config.enabled ||
		!absolutePath(sourcePath) ||
		!absolutePath(statePath) ||
		config.googleOwnerEmail !== payload.google.ownerEmail ||
		config.googleDriveFolder !== payload.google.folderPath ||
		config.discordChannelId !== payload.discord.channelId ||
		payload.stateDatabase.path !== join(statePath, "meeting-publication.sqlite3")
	)
		fail("binding_mismatch");
	assertSourceDirectory(sourcePath, observation.uid);
	if (
		payload.kind === "harnessy.meeting-publication.full-review-authorization" &&
		payload.runtimeMode === "long_running" &&
		config.reviewPort === 0
	)
		fail("binding_mismatch");
	if (
		!checkedFile(
			{ path: observation.executablePath, sha256: payload.runtime.executableSha256 },
			observation.uid,
			"artifact",
			MAX_EXECUTABLE_BYTES,
		).matches
	)
		fail("artifact_drift");
	const state = checkedFile(payload.stateDatabase, observation.uid, "private", MAX_ARTIFACT_BYTES);
	if (!state.matches || !identityMatches(state.file.identity, payload.stateDatabase)) fail("state_drift");
	const engineState = checkedFile(payload.credentials.engineState, observation.uid, "private", MAX_ARTIFACT_BYTES);
	if (!engineState.matches || !identityMatches(engineState.file.identity, payload.credentials.engineState))
		fail("binding_mismatch");
	assertPrivateDirectory(payload.credentials.directory, observation.uid);
	if (payload.notifier.kind !== "unavailable") {
		const executable = checkedFile(payload.notifier.executable, observation.uid, "artifact", MAX_EXECUTABLE_BYTES);
		if (
			!executable.matches ||
			!identityMatches(executable.file.identity, payload.notifier.executable) ||
			(executable.file.stat.mode & 0o111n) === 0n
		)
			fail("artifact_drift");
		if (payload.notifier.reviewOpen !== undefined) {
			const launcher = checkedFile(
				payload.notifier.reviewOpen.executable,
				observation.uid,
				"artifact",
				MAX_EXECUTABLE_BYTES,
			);
			if (
				!launcher.matches ||
				!identityMatches(launcher.file.identity, payload.notifier.reviewOpen.executable) ||
				(launcher.file.stat.mode & 0o111n) === 0n
			)
				fail("artifact_drift");
		}
	}
	const manifestFile = checkedFile(payload.artifactManifest, observation.uid, "artifact", MAX_MANIFEST_BYTES);
	if (!manifestFile.matches) fail("artifact_drift");
	const manifestText = decodeUtf8(manifestFile.file.bytes);
	const parsedManifest = Result.try({
		try: () => JSON.parse(manifestText) as unknown,
		catch: () => undefined,
	});
	const manifestRaw = Result.isSuccess(parsedManifest) ? parsedManifest.success : fail("artifact_drift");
	if (`${canonicalMeetingPublicationSmokeJson(manifestRaw)}\n` !== manifestText) fail("artifact_drift");
	const artifactManifest = decode(ArtifactManifest, manifestRaw);
	validateArtifactInventory(artifactManifest, observation.uid);
	for (const privatePath of [
		input.authorizationPath,
		input.trustedKeyring.path,
		payload.replay.path,
		payload.stateDatabase.path,
		payload.credentials.directory,
		payload.credentials.engineState.path,
		payload.artifactManifest.path,
		payload.cutoverEvidence.path,
		payload.rollbackPlan.path,
		sourcePath,
		statePath,
	]) {
		if (within(artifactManifest.root, privatePath) || within(privatePath, artifactManifest.root))
			fail("binding_mismatch");
	}
	if (payload.notifier.kind !== "unavailable") {
		const executablePath = payload.notifier.executable.path;
		if ([sourcePath, statePath, payload.credentials.directory].some((path) => within(path, executablePath)))
			fail("binding_mismatch");
	}
	for (const evidence of [payload.cutoverEvidence, payload.rollbackPlan]) {
		if (!checkedFile(evidence, observation.uid, "private").matches) fail("evidence_drift");
	}
	const providerBinding: MeetingPublicationWorkerProviderBinding = Object.freeze({
		tenantId: payload.subject.tenantId,
		subjectId: payload.subject.subjectId,
		credentialDirectory: payload.credentials.directory,
		engineStatePath: payload.credentials.engineState.path,
		sourcePath,
		statePath,
		google: Object.freeze({ ...payload.google }),
		discord: Object.freeze({ ...payload.discord }),
		notifier:
			payload.notifier.kind === "unavailable"
				? Object.freeze({ kind: "unavailable" as const })
				: Object.freeze({
						kind: payload.notifier.kind,
						executable: Object.freeze({ ...payload.notifier.executable }),
					}),
		transport: Object.freeze({ ...payload.transport }),
	});
	return Object.freeze({
		kind,
		authorization: payload,
		authorizationDigest: sha256MeetingPublicationSmokeBytes(
			Buffer.from(`${audience}\0${canonicalMeetingPublicationSmokeJson(payload)}`, "utf8"),
		),
		config,
		providerBinding,
		replayPath: trust.replay.path,
		replayIdentity: trust.replay,
		initialRevocationSequence: payload.revocationSequence,
		artifactManifest,
		immutableFiles: Object.freeze([
			{
				path: observation.executablePath,
				sha256: payload.runtime.executableSha256,
				role: "artifact" as const,
				maximumBytes: MAX_EXECUTABLE_BYTES,
			},
			{
				path: input.trustedKeyring.path,
				sha256: input.trustedKeyring.sha256,
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: input.authorizationPath,
				sha256: sha256MeetingPublicationSmokeBytes(envelopeBytes),
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: payload.artifactManifest.path,
				sha256: payload.artifactManifest.sha256,
				role: "artifact" as const,
				maximumBytes: MAX_MANIFEST_BYTES,
			},
			{
				path: payload.cutoverEvidence.path,
				sha256: payload.cutoverEvidence.sha256,
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: payload.rollbackPlan.path,
				sha256: payload.rollbackPlan.sha256,
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
		]),
		startedAt: observation.now,
		startedMonotonic: observation.monotonic,
	});
};

export const verifyMeetingPublicationWorkerInput = (
	input: MeetingPublicationWorkerRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
): VerifiedMeetingPublicationWorkerInput => {
	const { payload, trust, envelopeFile } = readSignedAuthorization(
		input,
		observation,
		WorkerTrustDocument,
		WorkerAuthorizationEnvelope,
		MEETING_PUBLICATION_WORKER_AUDIENCE,
	);
	validateWorkerPayload(payload, MEETING_PUBLICATION_WORKER_OPERATIONS);
	return verifyMeetingPublicationWorkerLikeInput(
		input,
		observation,
		payload,
		trust,
		envelopeFile.bytes,
		"worker",
		MEETING_PUBLICATION_WORKER_AUDIENCE,
	);
};

export const verifyMeetingPublicationFullReviewInput = (
	input: MeetingPublicationFullReviewRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
): VerifiedMeetingPublicationFullReviewInput => {
	const { payload, trust, envelopeFile } = readSignedAuthorization(
		input,
		observation,
		FullReviewTrustDocument,
		FullReviewAuthorizationEnvelope,
		MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE,
	);
	validateWorkerPayload(payload, MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS);
	return verifyMeetingPublicationWorkerLikeInput(
		input,
		observation,
		payload,
		trust,
		envelopeFile.bytes,
		"full_review",
		MEETING_PUBLICATION_FULL_REVIEW_AUDIENCE,
	);
};

/** State-only authorization never loads credentials or observes V1 processes. */
export const verifyMeetingPublicationReviewInput = (
	input: MeetingPublicationReviewRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
): VerifiedMeetingPublicationReviewInput => {
	const { payload, trust, envelopeFile } = readSignedAuthorization(
		input,
		observation,
		ReviewTrustDocument,
		ReviewAuthorizationEnvelope,
		MEETING_PUBLICATION_REVIEW_AUDIENCE,
	);
	if (
		!safeId(payload.authorizationId) ||
		!safeId(payload.issuer) ||
		!safeId(payload.keyId) ||
		!exactValues(payload.operations, MEETING_PUBLICATION_REVIEW_OPERATIONS) ||
		!validateIdentity(payload.sourceDirectory) ||
		!validateIdentity(payload.stateDirectory) ||
		!validateIdentity(payload.replay) ||
		!absolutePath(payload.v1StatePath) ||
		!absolutePath(payload.runtime.executablePath) ||
		!/^\d+$/u.test(payload.runtime.uid) ||
		!safeText(payload.runtime.bootId, 512) ||
		!absolutePath(payload.artifactManifest.path)
	)
		fail("invalid_input");
	const issuedAt = parseInstant(payload.issuedAt);
	const notBefore = parseInstant(payload.notBefore);
	const expiresAt = parseInstant(payload.expiresAt);
	if (
		issuedAt > notBefore ||
		notBefore > expiresAt ||
		expiresAt - issuedAt > 15 * 60_000 ||
		observation.now < notBefore ||
		observation.now >= expiresAt
	)
		fail("expired_authorization");
	const replay = readStableMeetingPublicationSmokeFile(
		trust.replay.path,
		observation.uid,
		"private",
		MAX_ARTIFACT_BYTES,
	);
	if (
		payload.runtime.platform !== observation.platform ||
		payload.runtime.architecture !== observation.architecture ||
		payload.runtime.hostname !== observation.hostname ||
		payload.runtime.uid !== observation.uid.toString() ||
		payload.runtime.bootId !== observation.bootId ||
		payload.runtime.executablePath !== observation.executablePath ||
		!identityMatches(replay.identity, trust.replay) ||
		!identityMatches(payload.replay, trust.replay) ||
		payload.replay.instanceId !== trust.replay.instanceId
	)
		fail("binding_mismatch");
	const config = new JarvisMeetingPublicationConfig({
		...payload.config,
		enabled: false,
		leaseSeconds: 300,
		reminderSeconds: 3600,
		googleOwnerEmail: null,
		googleDriveFolder: null,
		discordChannelId: null,
	});
	const sourcePath = payload.config.sourcePath;
	const statePath = payload.config.statePath;
	if (
		!absolutePath(sourcePath) ||
		!absolutePath(statePath) ||
		payload.sourceDirectory.path !== sourcePath ||
		payload.stateDirectory.path !== statePath ||
		payload.stateDatabase.path !== join(statePath, "meeting-publication.sqlite3") ||
		within(sourcePath, statePath) ||
		within(statePath, sourcePath) ||
		within(sourcePath, payload.v1StatePath) ||
		within(payload.v1StatePath, sourcePath) ||
		(payload.v1StatePath !== statePath &&
			(within(payload.v1StatePath, statePath) || within(statePath, payload.v1StatePath)))
	)
		fail("binding_mismatch");
	assertMeetingPublicationReviewDirectoriesCurrent(payload, observation.uid);
	if (payload.stateDatabase.kind === "absent") {
		if (existsSync(payload.stateDatabase.path)) fail("state_drift");
	} else {
		if (!validateIdentity(payload.stateDatabase)) fail("invalid_input");
		const state = checkedFile(payload.stateDatabase, observation.uid, "private", MAX_ARTIFACT_BYTES);
		if (!state.matches || !identityMatches(state.file.identity, payload.stateDatabase)) fail("state_drift");
	}
	if (
		!checkedFile(
			{ path: observation.executablePath, sha256: payload.runtime.executableSha256 },
			observation.uid,
			"artifact",
			MAX_EXECUTABLE_BYTES,
		).matches
	)
		fail("artifact_drift");
	const manifestFile = checkedFile(payload.artifactManifest, observation.uid, "artifact", MAX_MANIFEST_BYTES);
	if (!manifestFile.matches) fail("artifact_drift");
	const text = decodeUtf8(manifestFile.file.bytes);
	const parsed = Result.try({ try: () => JSON.parse(text) as unknown, catch: () => undefined });
	if (Result.isFailure(parsed)) return fail("artifact_drift");
	if (`${canonicalMeetingPublicationSmokeJson(parsed.success)}\n` !== text) fail("artifact_drift");
	const artifactManifest = decode(ArtifactManifest, parsed.success);
	validateArtifactInventory(artifactManifest, observation.uid, "review");
	for (const path of [
		sourcePath,
		statePath,
		payload.v1StatePath,
		input.authorizationPath,
		input.trustedKeyring.path,
		payload.replay.path,
		payload.artifactManifest.path,
	]) {
		if (within(artifactManifest.root, path) || within(path, artifactManifest.root)) fail("binding_mismatch");
	}
	// Control files must not become source input, queue state, or one another.
	const controls = [
		input.authorizationPath,
		input.trustedKeyring.path,
		payload.replay.path,
		payload.artifactManifest.path,
	];
	if (
		new Set(controls).size !== controls.length ||
		controls.some((path) => within(sourcePath, path) || within(statePath, path) || within(payload.v1StatePath, path))
	)
		fail("binding_mismatch");
	return Object.freeze({
		kind: "review" as const,
		authorization: payload,
		authorizationDigest: sha256MeetingPublicationSmokeBytes(
			`${MEETING_PUBLICATION_REVIEW_AUDIENCE}\0${canonicalMeetingPublicationSmokeJson(payload)}`,
		),
		config,
		replayPath: trust.replay.path,
		replayIdentity: trust.replay,
		initialRevocationSequence: payload.revocationSequence,
		artifactManifest,
		immutableFiles: [
			{
				path: observation.executablePath,
				sha256: payload.runtime.executableSha256,
				role: "artifact" as const,
				maximumBytes: MAX_EXECUTABLE_BYTES,
			},
			{
				path: input.trustedKeyring.path,
				sha256: input.trustedKeyring.sha256,
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: input.authorizationPath,
				sha256: sha256MeetingPublicationSmokeBytes(envelopeFile.bytes),
				role: "private" as const,
				maximumBytes: MAX_INPUT_BYTES,
			},
			{
				path: payload.artifactManifest.path,
				sha256: payload.artifactManifest.sha256,
				role: "artifact" as const,
				maximumBytes: MAX_MANIFEST_BYTES,
			},
		],
		startedAt: observation.now,
		startedMonotonic: observation.monotonic,
	});
};

/** @internal Recheck both signed directory identities without opening V1 state. */
export const assertMeetingPublicationReviewDirectoriesCurrent = (
	payload: typeof ReviewAuthorizationPayload.Type,
	uid: bigint,
) => {
	const source = assertSourceDirectory(payload.sourceDirectory.path, uid);
	if (
		source.dev.toString() !== payload.sourceDirectory.device ||
		source.ino.toString() !== payload.sourceDirectory.inode
	)
		fail("state_drift");
	directoryChain(payload.stateDirectory.path, uid);
	const state = lstatSync(payload.stateDirectory.path, { bigint: true });
	if (
		state.uid !== uid ||
		state.dev.toString() !== payload.stateDirectory.device ||
		state.ino.toString() !== payload.stateDirectory.inode
	)
		fail("state_drift");
	assertPrivateDirectory(payload.stateDirectory.path, uid);
};

/** @internal Rechecks the exact signed runtime inventory before every write grant use. */
export const assertMeetingPublicationSmokeArtifactInventoryCurrent = (
	verified: VerifiedMeetingPublicationRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
) => validateArtifactInventory(verified.artifactManifest, observation.uid, verified.kind);

/** @internal Exact signed anchors expected from the acquired provider implementation. */
export const meetingPublicationSmokeArtifactAnchors = (
	verified:
		| VerifiedMeetingPublicationSmokeInput
		| VerifiedMeetingPublicationWorkerInput
		| VerifiedMeetingPublicationFullReviewInput,
): MeetingPublicationSmokeArtifactAnchors =>
	Object.freeze(
		Object.fromEntries(
			verified.artifactManifest.anchors.map((anchor) => [anchor.role, anchor.path]),
		) as unknown as MeetingPublicationSmokeArtifactAnchors,
	);
