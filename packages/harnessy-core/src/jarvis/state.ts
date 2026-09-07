import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parseDocument } from "yaml";

import type { HarnessError } from "../errors.ts";
import { JarvisLegacyConfigInput } from "./config.ts";
import type { JarvisPaths } from "./paths.ts";

export const JarvisStateStoreStatus = Schema.Literals(["absent", "readable", "partial", "invalid"]);
export type JarvisStateStoreStatus = typeof JarvisStateStoreStatus.Type;
export const JarvisStateOverallReadiness = Schema.Literals(["safe-to-import", "needs-review", "blocked"]);
export type JarvisStateOverallReadiness = typeof JarvisStateOverallReadiness.Type;
export const JarvisStateIssueCode = Schema.Literals([
	"STATE_MISSING_DEFAULTED",
	"STATE_MISSING_EMPTY",
	"STATE_MISSING_OPTIONAL",
	"STATE_GLOBAL_FALLBACK",
	"STATE_MALFORMED",
	"STATE_ENTRY_SKIPPED",
	"STATE_ENTRY_QUARANTINED",
	"STATE_SYMLINK_REJECTED",
	"STATE_PATH_ESCAPE_REJECTED",
	"STATE_FILE_TOO_LARGE",
	"STATE_DIRECTORY_LIMIT_REACHED",
	"STATE_TOTAL_BYTES_LIMIT_REACHED",
	"STATE_PARTIAL_READ",
	"STATE_IO_UNAVAILABLE",
]);
export type JarvisStateIssueCode = typeof JarvisStateIssueCode.Type;

export class JarvisStateIssue extends Schema.Class<JarvisStateIssue>("JarvisStateIssue")({
	code: JarvisStateIssueCode,
	storeId: Schema.String,
}) {}

export class JarvisStateStoreResult extends Schema.Class<JarvisStateStoreResult>("JarvisStateStoreResult")({
	storeId: Schema.String,
	status: JarvisStateStoreStatus,
	format: Schema.String,
	version: Schema.Int,
	entriesRead: Schema.Int,
	entriesSkipped: Schema.Int,
	bytesRead: Schema.Int,
	issues: Schema.Array(JarvisStateIssue),
}) {}

export class JarvisStateReadinessCounts extends Schema.Class<JarvisStateReadinessCounts>("JarvisStateReadinessCounts")({
	absent: Schema.Int,
	readable: Schema.Int,
	partial: Schema.Int,
	invalid: Schema.Int,
}) {}

export class JarvisStateReadiness extends Schema.Class<JarvisStateReadiness>("JarvisStateReadiness")({
	overall: JarvisStateOverallReadiness,
	counts: JarvisStateReadinessCounts,
	stores: Schema.Array(JarvisStateStoreResult),
}) {}

export class JarvisStateReadLimits extends Context.Service<
	JarvisStateReadLimits,
	{
		readonly maxFileBytes: number;
		readonly maxEntriesPerStore: number;
		readonly maxBytesPerStore: number;
	}
>()("@harnessy/core/JarvisStateReadLimits") {
	static readonly defaultLayer = Layer.succeed(
		JarvisStateReadLimits,
		JarvisStateReadLimits.of({
			maxFileBytes: 1024 * 1024,
			maxEntriesPerStore: 256,
			maxBytesPerStore: 8 * 1024 * 1024,
		}),
	);

	static testLayer(limits: Partial<JarvisStateReadLimits["Service"]>) {
		return Layer.succeed(
			JarvisStateReadLimits,
			JarvisStateReadLimits.of({
				maxFileBytes: limits.maxFileBytes ?? 1024 * 1024,
				maxEntriesPerStore: limits.maxEntriesPerStore ?? 256,
				maxBytesPerStore: limits.maxBytesPerStore ?? 8 * 1024 * 1024,
			}),
		);
	}
}

type MissingBehavior = "defaults" | "empty" | "none" | "global-fallback";
type MalformedBehavior = "error" | "empty" | "not-applicable" | "skip-entry" | "quarantine-or-skip";
type StoreFormat =
	| "yaml"
	| "json"
	| "text"
	| "markdown"
	| "json-directory"
	| "yaml-markdown-json-directory"
	| "markdown-directory";
interface StoreSpec {
	readonly id: string;
	readonly format: StoreFormat;
	readonly missing: MissingBehavior;
	readonly malformed: MalformedBehavior;
	readonly target: (paths: JarvisPaths, path: Path.Path) => ScanTarget;
	readonly validator?: Schema.Decoder<unknown>;
}
interface FileTarget {
	readonly kind: "file";
	readonly path: string;
}
interface DirectoryTarget {
	readonly kind: "directory";
	readonly path: string;
	readonly maxDepth: number;
	readonly matches: (relative: string) => boolean;
	readonly fallbackPath?: string;
}
type ScanTarget = FileTarget | DirectoryTarget;
interface StableRead {
	readonly issue: JarvisStateIssueCode | null;
	readonly bytes: number;
	readonly data: Uint8Array | null;
}

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isNonEmpty()));
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const JsonUnknown = Schema.fromJsonString(Schema.Unknown);
const SelectedSpace = Schema.Struct({ selected_space_id: Schema.optional(Schema.String) });
const PendingSuggestions = Schema.Struct({
	generated_at: NonEmptyString,
	space_id: NonEmptyString,
	suggestions: Schema.Array(Schema.Struct({ id: NonEmptyString, status: NonEmptyString })),
});
const JournalIndex = Schema.Struct({ entries: Schema.Array(Schema.Struct({ id: NonEmptyString })) });
const DeepDives = Schema.Struct({
	entry_id: NonEmptyString,
	deep_dives: Schema.Array(Schema.Struct({ id: NonEmptyString })),
});
const SchedulePlan = Schema.Struct({
	version: Schema.Int,
	plan_id: NonEmptyString,
	blocks: Schema.Array(UnknownRecord),
});
const PlanApply = Schema.Struct({ version: Schema.Int, plan_id: NonEmptyString, results: Schema.Array(UnknownRecord) });
const PresetRegistry = Schema.Struct({
	version: Schema.Int,
	presets: Schema.Array(Schema.Struct({ name: NonEmptyString })),
});
const FetchedContent = Schema.Struct({ item: UnknownRecord, fetch_status: NonEmptyString, fetched_at: NonEmptyString });
const PrioritizationResult = Schema.Struct({
	source: UnknownRecord,
	items: Schema.Array(Schema.Unknown),
	generated_at: NonEmptyString,
});
const WikiDomain = Schema.Struct({
	domain: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))),
	title: NonEmptyString,
});
const WhatsAppThread = Schema.Struct({
	thread_id: NonEmptyString,
	account: NonEmptyString,
	messages: Schema.Array(UnknownRecord),
});

const ext = (extension: string) => (relative: string) => relative.endsWith(extension);
const relativeSegments = (relative: string) => relative.replaceAll("\\", "/").split("/");
const isInboxEntry = (kind: "fathom" | "whatsapp", relative: string) => {
	const parts = relativeSegments(relative);
	const buckets = new Set(["pending", "processed", "invalid"]);
	return kind === "fathom"
		? parts.length === 6 &&
				parts[1] === "meeting-inbox" &&
				parts[2] === "fathom" &&
				buckets.has(parts[4]) &&
				parts[5].endsWith(".json")
		: parts.length === 6 &&
				parts[1] === "whatsapp" &&
				parts[3] === "inbox" &&
				buckets.has(parts[4]) &&
				parts[5].endsWith(".json");
};
const isThreadEntry = (extension: ".json" | ".md", relative: string) => {
	const parts = relativeSegments(relative);
	return parts.length === 5 && parts[1] === "whatsapp" && parts[3] === "threads" && parts[4].endsWith(extension);
};

const storeSpecs: ReadonlyArray<StoreSpec> = [
	{
		id: "legacy-config-yaml-v1",
		format: "yaml",
		missing: "defaults",
		malformed: "error",
		target: (p) => ({ kind: "file", path: p.legacyGlobalConfigFile }),
		validator: JarvisLegacyConfigInput,
	},
	{
		id: "selected-space-json-v1",
		format: "json",
		missing: "empty",
		malformed: "empty",
		target: (p, x) => ({ kind: "file", path: x.join(p.legacyGlobalRoot, "config.json") }),
		validator: SelectedSpace,
	},
	{
		id: "pending-suggestions-json-v1",
		format: "json",
		missing: "empty",
		malformed: "empty",
		target: (p, x) => ({ kind: "file", path: x.join(p.legacyGlobalRoot, "pending.json") }),
		validator: PendingSuggestions,
	},
	{
		id: "journal-index-json-v1",
		format: "json",
		missing: "empty",
		malformed: "empty",
		target: (p, x) => ({ kind: "file", path: x.join(p.legacyGlobalRoot, "journal", "entries.json") }),
		validator: JournalIndex,
	},
	{
		id: "journal-deep-dives-json-v1",
		format: "json-directory",
		missing: "empty",
		malformed: "empty",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "journal", "deep_dives"),
			maxDepth: 1,
			matches: ext(".json"),
		}),
		validator: DeepDives,
	},
	{
		id: "journal-draft-text-v1",
		format: "text",
		missing: "empty",
		malformed: "not-applicable",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "journal", "drafts"),
			maxDepth: 1,
			matches: ext(".txt"),
		}),
	},
	{
		id: "schedule-plan-json-v1",
		format: "json-directory",
		missing: "none",
		malformed: "error",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "plans"),
			maxDepth: 1,
			matches: (r) => r.endsWith(".json") && !r.endsWith(".apply.json"),
		}),
		validator: SchedulePlan,
	},
	{
		id: "plan-apply-json-v1",
		format: "json-directory",
		missing: "none",
		malformed: "error",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "plans"),
			maxDepth: 1,
			matches: ext(".apply.json"),
		}),
		validator: PlanApply,
	},
	{
		id: "weekly-plan-markdown-v1",
		format: "markdown-directory",
		missing: "none",
		malformed: "not-applicable",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "plans"),
			maxDepth: 1,
			matches: ext(".md"),
		}),
	},
	{
		id: "sync-presets-yaml-v1",
		format: "yaml",
		missing: "empty",
		malformed: "error",
		target: (p, x) => ({ kind: "file", path: x.join(p.legacyGlobalRoot, "sync", "presets.yaml") }),
		validator: PresetRegistry,
	},
	{
		id: "sync-state-json-v1",
		format: "json-directory",
		missing: "none",
		malformed: "error",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "sync", "state"),
			maxDepth: 1,
			matches: ext(".json"),
		}),
		validator: UnknownRecord,
	},
	{
		id: "fathom-poll-state-json-v1",
		format: "json",
		missing: "empty",
		malformed: "empty",
		target: (p, x) => ({ kind: "file", path: x.join(p.legacyGlobalRoot, "state", "fathom", "poll-state.json") }),
		validator: UnknownRecord,
	},
	{
		id: "reading-list-url-cache-v1",
		format: "json-directory",
		missing: "empty",
		malformed: "skip-entry",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "cache", "reading-list", "urls"),
			maxDepth: 1,
			matches: ext(".json"),
		}),
		validator: FetchedContent,
	},
	{
		id: "reading-list-result-cache-v1",
		format: "json-directory",
		missing: "empty",
		malformed: "skip-entry",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "cache", "reading-list", "results"),
			maxDepth: 1,
			matches: ext(".json"),
		}),
		validator: PrioritizationResult,
	},
	{
		id: "wiki-domain-v1",
		format: "yaml-markdown-json-directory",
		missing: "none",
		malformed: "error",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyGlobalRoot, "wikis"),
			maxDepth: 5,
			matches: (r) => [".yaml", ".yml", ".json", ".md", ".markdown"].some((extension) => r.endsWith(extension)),
		}),
		validator: WikiDomain,
	},
	{
		id: "project-context-v1",
		format: "markdown-directory",
		missing: "global-fallback",
		malformed: "not-applicable",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyProjectRoot, "context"),
			fallbackPath: x.join(p.legacyGlobalRoot, "context"),
			maxDepth: 1,
			matches: ext(".md"),
		}),
	},
	{
		id: "fathom-inbox-json-v1",
		format: "json-directory",
		missing: "empty",
		malformed: "quarantine-or-skip",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyProjectRoot, "context", "private"),
			maxDepth: 8,
			matches: (r) => isInboxEntry("fathom", r),
		}),
		validator: UnknownRecord,
	},
	{
		id: "whatsapp-inbox-json-v1",
		format: "json-directory",
		missing: "empty",
		malformed: "quarantine-or-skip",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyProjectRoot, "context", "private"),
			maxDepth: 9,
			matches: (r) => isInboxEntry("whatsapp", r),
		}),
		validator: UnknownRecord,
	},
	{
		id: "whatsapp-thread-json-v1",
		format: "json-directory",
		missing: "none",
		malformed: "skip-entry",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyProjectRoot, "context", "private"),
			maxDepth: 8,
			matches: (r) => isThreadEntry(".json", r),
		}),
		validator: WhatsAppThread,
	},
	{
		id: "whatsapp-thread-markdown-v1",
		format: "markdown-directory",
		missing: "none",
		malformed: "not-applicable",
		target: (p, x) => ({
			kind: "directory",
			path: x.join(p.legacyProjectRoot, "context", "private"),
			maxDepth: 8,
			matches: (r) => isThreadEntry(".md", r),
		}),
	},
];

const missingIssue = (spec: StoreSpec): JarvisStateIssueCode =>
	spec.missing === "defaults"
		? "STATE_MISSING_DEFAULTED"
		: spec.missing === "empty"
			? "STATE_MISSING_EMPTY"
			: spec.missing === "global-fallback"
				? "STATE_GLOBAL_FALLBACK"
				: "STATE_MISSING_OPTIONAL";

const malformedIssue = (spec: StoreSpec): JarvisStateIssueCode =>
	spec.malformed === "skip-entry"
		? "STATE_ENTRY_SKIPPED"
		: spec.malformed === "quarantine-or-skip"
			? "STATE_ENTRY_QUARANTINED"
			: "STATE_MALFORMED";

/** Corruption-safe, bounded, read-only inspection for all versioned Jarvis v1 state stores. */
export class JarvisStateReader extends Context.Service<
	JarvisStateReader,
	{ readonly inspect: (paths: JarvisPaths) => Effect.Effect<JarvisStateReadiness, HarnessError> }
>()("@harnessy/core/JarvisStateReader") {
	static readonly layer = Layer.effect(
		JarvisStateReader,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const limits = yield* JarvisStateReadLimits;

			const isSymlink = (candidate: string) =>
				fs.readLink(candidate).pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				);
			const hasSymlinkPath = Effect.fn("JarvisStateReader.hasSymlinkPath")(function* (
				candidate: string,
				boundary: string,
			) {
				let current = path.resolve(candidate);
				const resolvedBoundary = path.resolve(boundary);
				const relative = path.relative(resolvedBoundary, current);
				if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
				while (true) {
					if (yield* isSymlink(current)) return true;
					if (current === resolvedBoundary) return false;
					const parent = path.dirname(current);
					if (parent === current) return true;
					current = parent;
				}
			});

			const closeHandle = (handle: FileHandle) =>
				Effect.tryPromise(() => handle.close()).pipe(Effect.catch(() => Effect.void));
			const readHandle = (handle: FileHandle, remainingBytes: number): Effect.Effect<StableRead, unknown> =>
				Effect.tryPromise(() => handle.stat()).pipe(
					Effect.flatMap((info): Effect.Effect<StableRead, unknown> => {
						if (!info.isFile()) return Effect.succeed({ issue: "STATE_IO_UNAVAILABLE", bytes: 0, data: null });
						if (info.size > limits.maxFileBytes)
							return Effect.succeed({ issue: "STATE_FILE_TOO_LARGE", bytes: 0, data: null });
						if (info.size > remainingBytes)
							return Effect.succeed({ issue: "STATE_TOTAL_BYTES_LIMIT_REACHED", bytes: 0, data: null });
						return Effect.tryPromise(() => handle.readFile()).pipe(
							Effect.map((data) =>
								data.byteLength === info.size
									? { issue: null, bytes: data.byteLength, data }
									: { issue: "STATE_PARTIAL_READ" as const, bytes: data.byteLength, data: null },
							),
						);
					}),
				);
			const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
			const walkNoFollow = (
				directory: FileHandle,
				components: ReadonlyArray<string>,
				index: number,
				remainingBytes: number,
			): Effect.Effect<StableRead, unknown> => {
				const component = components[index];
				if (component === undefined) return Effect.succeed({ issue: "STATE_IO_UNAVAILABLE", bytes: 0, data: null });
				const candidate = `${descriptorRoot}/${directory.fd}/${component}`;
				const final = index === components.length - 1;
				return Effect.acquireUseRelease(
					Effect.tryPromise(() =>
						open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | (final ? 0 : constants.O_DIRECTORY)),
					),
					(handle) =>
						final
							? readHandle(handle, remainingBytes)
							: walkNoFollow(handle, components, index + 1, remainingBytes),
					closeHandle,
				);
			};
			const stableNoFollowRead = (candidate: string, remainingBytes: number) => {
				if (process.platform === "win32") {
					// Node exposes no Windows openat/NtCreateFile relative-handle primitive; fail closed instead of racing junctions.
					return Effect.succeed({ issue: "STATE_IO_UNAVAILABLE" as const, bytes: 0, data: null });
				}
				if (process.platform !== "linux") {
					// macOS does not expose Linux-style /proc/self/fd traversal. The caller has already checked every
					// component beneath the trusted boundary and resolved containment; O_NOFOLLOW closes the final-link case.
					return Effect.acquireUseRelease(
						Effect.tryPromise(() => open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW)),
						(handle) => readHandle(handle, remainingBytes),
						closeHandle,
					).pipe(
						Effect.catch(() => Effect.succeed({ issue: "STATE_IO_UNAVAILABLE" as const, bytes: 0, data: null })),
					);
				}
				const components: Array<string> = [];
				let current = path.resolve(candidate);
				while (true) {
					const parent = path.dirname(current);
					if (parent === current) break;
					components.unshift(path.basename(current));
					current = parent;
				}
				return Effect.acquireUseRelease(
					Effect.tryPromise(() =>
						open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY),
					),
					(handle) => walkNoFollow(handle, components, 0, remainingBytes),
					closeHandle,
				).pipe(
					Effect.catch(() => Effect.succeed({ issue: "STATE_IO_UNAVAILABLE" as const, bytes: 0, data: null })),
				);
			};

			const readBounded = Effect.fn("JarvisStateReader.readBounded")(function* (
				root: string,
				candidate: string,
				remainingBytes: number,
			) {
				if (yield* hasSymlinkPath(candidate, root))
					return { issue: "STATE_SYMLINK_REJECTED" as const, bytes: 0, raw: null };
				const rootReal = yield* fs.realPath(root).pipe(Effect.catch(() => Effect.succeed(undefined)));
				const candidateReal = yield* fs.realPath(candidate).pipe(Effect.catch(() => Effect.succeed(undefined)));
				if (rootReal === undefined || candidateReal === undefined)
					return { issue: "STATE_IO_UNAVAILABLE" as const, bytes: 0, raw: null };
				const relative = path.relative(rootReal, candidateReal);
				if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
					return { issue: "STATE_PATH_ESCAPE_REJECTED" as const, bytes: 0, raw: null };
				const stable: StableRead = yield* stableNoFollowRead(candidateReal, remainingBytes);
				if (stable.issue !== null || stable.data === null)
					return { issue: stable.issue, bytes: stable.bytes, raw: null };
				const raw = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(stable.data)).pipe(
					Effect.catch(() => Effect.succeed(null)),
				);
				return raw === null
					? { issue: "STATE_MALFORMED" as const, bytes: stable.bytes, raw: null }
					: { issue: null, bytes: stable.bytes, raw };
			});

			const validate = Effect.fn("JarvisStateReader.validate")(function* (
				spec: StoreSpec,
				candidate: string,
				raw: string,
			) {
				if (spec.format === "text" || spec.format === "markdown" || spec.format === "markdown-directory")
					return true;
				if (
					spec.format === "yaml-markdown-json-directory" &&
					(candidate.endsWith(".md") || candidate.endsWith(".markdown"))
				)
					return true;
				if (raw.trim().length === 0) return false;
				if (spec.format === "yaml-markdown-json-directory" && candidate.endsWith(".json")) {
					return yield* Schema.decodeUnknownEffect(JsonUnknown)(raw).pipe(
						Effect.as(true),
						Effect.catch(() => Effect.succeed(false)),
					);
				}
				if (spec.format === "yaml" || spec.format === "yaml-markdown-json-directory") {
					const document = parseDocument(raw);
					if (document.errors.length > 0) return false;
					const decoded = yield* Effect.try(() => document.toJS() as unknown).pipe(
						Effect.catch(() => Effect.succeed(undefined)),
					);
					if (decoded === undefined) return false;
					const validator =
						spec.format === "yaml-markdown-json-directory" && !candidate.endsWith("schema.yaml")
							? undefined
							: spec.validator;
					if (validator === undefined) return true;
					return yield* Schema.decodeUnknownEffect(validator)(decoded).pipe(
						Effect.as(true),
						Effect.catch(() => Effect.succeed(false)),
					);
				}
				if (spec.validator === undefined)
					return yield* Schema.decodeUnknownEffect(JsonUnknown)(raw).pipe(
						Effect.as(true),
						Effect.catch(() => Effect.succeed(false)),
					);
				return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(spec.validator))(raw).pipe(
					Effect.as(true),
					Effect.catch(() => Effect.succeed(false)),
				);
			});

			const absent = (spec: StoreSpec, fallback = false) =>
				new JarvisStateStoreResult({
					storeId: spec.id,
					status: fallback ? "readable" : "absent",
					format: spec.format,
					version: 1,
					entriesRead: 0,
					entriesSkipped: 0,
					bytesRead: 0,
					issues: [
						new JarvisStateIssue({
							code: fallback ? "STATE_GLOBAL_FALLBACK" : missingIssue(spec),
							storeId: spec.id,
						}),
					],
				});
			const ioUnavailable = (spec: StoreSpec) =>
				new JarvisStateStoreResult({
					storeId: spec.id,
					status: "invalid",
					format: spec.format,
					version: 1,
					entriesRead: 0,
					entriesSkipped: 0,
					bytesRead: 0,
					issues: [new JarvisStateIssue({ code: "STATE_IO_UNAVAILABLE", storeId: spec.id })],
				});

			const inspectFiles = Effect.fn("JarvisStateReader.inspectFiles")(function* (
				spec: StoreSpec,
				root: string,
				candidates: ReadonlyArray<string>,
			) {
				let entriesRead = 0;
				let entriesSkipped = 0;
				let bytesRead = 0;
				const issues: Array<JarvisStateIssue> = [];
				for (const candidate of candidates) {
					if (entriesRead + entriesSkipped >= limits.maxEntriesPerStore) {
						issues.push(new JarvisStateIssue({ code: "STATE_DIRECTORY_LIMIT_REACHED", storeId: spec.id }));
						break;
					}
					const read = yield* readBounded(root, candidate, limits.maxBytesPerStore - bytesRead);
					bytesRead += read.bytes;
					if (read.issue !== null || read.raw === null || !(yield* validate(spec, candidate, read.raw))) {
						entriesSkipped += 1;
						issues.push(new JarvisStateIssue({ code: read.issue ?? malformedIssue(spec), storeId: spec.id }));
					} else entriesRead += 1;
				}
				const hardFailure = issues.some((issue) =>
					[
						"STATE_SYMLINK_REJECTED",
						"STATE_PATH_ESCAPE_REJECTED",
						"STATE_FILE_TOO_LARGE",
						"STATE_IO_UNAVAILABLE",
						"STATE_PARTIAL_READ",
					].includes(issue.code),
				);
				const status: JarvisStateStoreStatus =
					issues.length === 0
						? "readable"
						: hardFailure || (spec.malformed === "error" && entriesSkipped > 0)
							? "invalid"
							: "partial";
				return new JarvisStateStoreResult({
					storeId: spec.id,
					status,
					format: spec.format,
					version: 1,
					entriesRead,
					entriesSkipped,
					bytesRead,
					issues,
				});
			});

			const listFiles = Effect.fn("JarvisStateReader.listFiles")(function* (target: DirectoryTarget) {
				const found: Array<string> = [];
				if (yield* hasSymlinkPath(target.path, target.path))
					return { files: found, symlink: true, bounded: false, io: false };
				const rootInfo = yield* fs.stat(target.path).pipe(Effect.catch(() => Effect.succeed(undefined)));
				if (rootInfo?.type !== "Directory") return { files: found, symlink: false, bounded: false, io: true };
				const pending: Array<{ dir: string; depth: number }> = [{ dir: target.path, depth: 0 }];
				let visited = 0;
				let bounded = false;
				while (pending.length > 0 && !bounded) {
					const current = pending.shift();
					if (current === undefined) break;
					if (yield* hasSymlinkPath(current.dir, target.path))
						return { files: found, symlink: true, bounded: false, io: false };
					const entries = yield* fs.readDirectory(current.dir).pipe(Effect.catch(() => Effect.succeed(undefined)));
					if (entries === undefined) return { files: found, symlink: false, bounded: false, io: true };
					for (const entry of [...entries].sort()) {
						visited += 1;
						if (visited > limits.maxEntriesPerStore) {
							bounded = true;
							break;
						}
						const child = path.join(current.dir, entry);
						if (yield* hasSymlinkPath(child, target.path))
							return { files: found, symlink: true, bounded: false, io: false };
						const info = yield* fs.stat(child).pipe(Effect.catch(() => Effect.succeed(undefined)));
						if (info === undefined) return { files: found, symlink: false, bounded: false, io: true };
						if (info.type === "Directory" && current.depth < target.maxDepth)
							pending.push({ dir: child, depth: current.depth + 1 });
						else if (info.type === "File") {
							const relative = path.relative(target.path, child).replaceAll("\\", "/");
							if (target.matches(relative)) found.push(child);
						}
					}
				}
				return { files: found.sort(), symlink: false, bounded, io: false };
			});

			const inspectStore = Effect.fn("JarvisStateReader.inspectStore")(function* (
				spec: StoreSpec,
				paths: JarvisPaths,
			) {
				const target = spec.target(paths, path);
				if (target.kind === "file") {
					const present = yield* fs.exists(target.path).pipe(Effect.catch(() => Effect.succeed(undefined)));
					if (present === undefined) return ioUnavailable(spec);
					if (!present) return absent(spec);
					return yield* inspectFiles(spec, path.dirname(target.path), [target.path]);
				}
				let directoryPath = target.path;
				let fallback = false;
				const present = yield* fs.exists(directoryPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
				if (present === undefined) return ioUnavailable(spec);
				if (!present) {
					const fallbackPresent =
						target.fallbackPath === undefined
							? false
							: yield* fs.exists(target.fallbackPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
					if (fallbackPresent === undefined) return ioUnavailable(spec);
					if (target.fallbackPath !== undefined && fallbackPresent) {
						directoryPath = target.fallbackPath;
						fallback = true;
					} else return absent(spec);
				}
				let listed = yield* listFiles({ ...target, path: directoryPath });
				if (
					!listed.symlink &&
					!listed.io &&
					!listed.bounded &&
					listed.files.length === 0 &&
					!fallback &&
					target.fallbackPath !== undefined
				) {
					const fallbackPresent = yield* fs
						.exists(target.fallbackPath)
						.pipe(Effect.catch(() => Effect.succeed(undefined)));
					if (fallbackPresent === undefined) return ioUnavailable(spec);
					if (fallbackPresent) {
						directoryPath = target.fallbackPath;
						fallback = true;
						listed = yield* listFiles({ ...target, path: directoryPath });
					}
				}
				if (listed.symlink) {
					return new JarvisStateStoreResult({
						storeId: spec.id,
						status: "invalid",
						format: spec.format,
						version: 1,
						entriesRead: 0,
						entriesSkipped: 0,
						bytesRead: 0,
						issues: [new JarvisStateIssue({ code: "STATE_SYMLINK_REJECTED", storeId: spec.id })],
					});
				}
				if (listed.io) {
					return new JarvisStateStoreResult({
						storeId: spec.id,
						status: "invalid",
						format: spec.format,
						version: 1,
						entriesRead: 0,
						entriesSkipped: 0,
						bytesRead: 0,
						issues: [new JarvisStateIssue({ code: "STATE_IO_UNAVAILABLE", storeId: spec.id })],
					});
				}
				if (listed.files.length === 0 && !listed.bounded) return absent(spec, fallback);
				const inspected = yield* inspectFiles(spec, directoryPath, listed.files);
				const extraIssues = [
					...(fallback
						? [new JarvisStateIssue({ code: "STATE_GLOBAL_FALLBACK" as const, storeId: spec.id })]
						: []),
					...(listed.bounded
						? [new JarvisStateIssue({ code: "STATE_DIRECTORY_LIMIT_REACHED" as const, storeId: spec.id })]
						: []),
				];
				return extraIssues.length > 0
					? new JarvisStateStoreResult({
							...inspected,
							status: inspected.status === "invalid" ? "invalid" : listed.bounded ? "partial" : inspected.status,
							issues: [...extraIssues, ...inspected.issues],
						})
					: inspected;
			});

			const inspect = Effect.fn("JarvisStateReader.inspect")(function* (paths: JarvisPaths) {
				const stores = yield* Effect.forEach(storeSpecs, (spec) => inspectStore(spec, paths), { concurrency: 1 });
				const counts = new JarvisStateReadinessCounts({
					absent: stores.filter((store) => store.status === "absent").length,
					readable: stores.filter((store) => store.status === "readable").length,
					partial: stores.filter((store) => store.status === "partial").length,
					invalid: stores.filter((store) => store.status === "invalid").length,
				});
				const overall: JarvisStateOverallReadiness =
					counts.invalid > 0 ? "blocked" : counts.partial > 0 ? "needs-review" : "safe-to-import";
				return new JarvisStateReadiness({ overall, counts, stores });
			});

			return { inspect };
		}),
	);

	static readonly liveLayer = JarvisStateReader.layer.pipe(Layer.provide(JarvisStateReadLimits.defaultLayer));
}
