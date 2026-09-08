import { isUtf8 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	type Dirent,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import type { JarvisMeetingPublicationConfig } from "../config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	type MeetingPublicationWriteAuthorityError,
	MeetingPublicationWriteBinding,
	resolveMeetingPublicationWriteBinding,
} from "./authority.ts";
import { authorizeMeetingPublicationWrite } from "./authority-check.ts";
import {
	type MeetingPublicationExclusionCode,
	MeetingPublicationNote,
	MeetingPublicationSourceError,
} from "./models.ts";

interface DiscoveryResult {
	readonly notes: ReadonlyArray<MeetingPublicationNote>;
	readonly filesSeen: number;
	readonly exclusions: Readonly<Record<string, number>>;
	readonly excludedPaths: ReadonlyArray<string>;
}

interface MeetingPublicationSourceOptions {
	/** A deterministic race-test seam invoked after descriptor read and before path revalidation. */
	readonly beforeStabilityCheck?: (path: string) => void;
	/** A deterministic race-test seam invoked under the writer lock before the final validation and rename. */
	readonly beforeFinalValidation?: (path: string, candidatePath: string) => void;
}

interface MeetingPublicationNoteUpdate {
	readonly path: string;
	readonly markdown: string;
	readonly expectedItemId: string;
	readonly expectedSourceHash: string;
}

export type MeetingPublicationSourceUpdateFailure =
	| MeetingPublicationSourceError
	| MeetingPublicationWriteAuthorityError;

export const MEETING_PUBLICATION_NOTE_MAX_LENGTH = 50_000;

const titlePattern = /^#\s+(.+?)\s*$/;
const sectionPattern = /^##\s+(.+?)\s*$/;
const headingPattern = /^#{1,6}\s+(.+?)\s*$/;
const metadataPattern = /^\s*[-*]\s+([^:]+):\s*(.*?)\s*$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

const dateOrdinal = (value: string): number | null => {
	if (!isoDatePattern.test(value)) return null;
	const millis = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value ? millis : null;
};

const parseMarkdown = (markdown: string) => {
	let title = "Untitled Meeting";
	let current = "";
	const metadata = new Map<string, string>();
	const sections = new Map<string, Array<string>>();
	const headings: Array<string> = [];
	for (const line of markdown.split(/\r?\n/)) {
		const headingMatch = headingPattern.exec(line);
		if (headingMatch?.[1] !== undefined) headings.push(headingMatch[1].trim().toLowerCase());
		const titleMatch = titlePattern.exec(line);
		if (title === "Untitled Meeting" && titleMatch?.[1] !== undefined) {
			title = titleMatch[1].trim();
			continue;
		}
		const sectionMatch = sectionPattern.exec(line);
		if (sectionMatch?.[1] !== undefined) {
			current = sectionMatch[1].trim().toLowerCase();
			sections.set(current, []);
			continue;
		}
		if (current === "metadata") {
			const metadataMatch = metadataPattern.exec(line);
			if (metadataMatch?.[1] !== undefined && metadataMatch[2] !== undefined) {
				metadata.set(metadataMatch[1].trim().toLowerCase(), metadataMatch[2].trim());
			}
		}
		if (current.length > 0) sections.get(current)?.push(line);
	}
	return {
		title,
		metadata,
		headings,
		sections: new Map([...sections].map(([name, lines]) => [name, lines.join("\n").trim()])),
	};
};

const within = (root: string, candidate: string) => {
	const value = relative(root, candidate);
	return value !== ".." && !value.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(value);
};

const readDescriptor = (descriptor: number, size: bigint) => {
	const bytes = Buffer.alloc(Number(size));
	let offset = 0;
	while (offset < bytes.length) {
		const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
		if (count === 0) break;
		offset += count;
	}
	return { bytes, offset } as const;
};

const safeRead = (
	root: string,
	path: string,
	maxFileBytes: number,
	options: MeetingPublicationSourceOptions,
): Effect.Effect<string, MeetingPublicationSourceError> =>
	Effect.try({
		try: () => {
			const rootReal = realpathSync(root);
			const pathReal = realpathSync(path);
			if (!within(rootReal, pathReal) || lstatSync(path).isSymbolicLink()) {
				throw new MeetingPublicationSourceError({ code: "path_boundary" });
			}
			const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const before = fstatSync(descriptor, { bigint: true });
				if (!before.isFile()) throw new MeetingPublicationSourceError({ code: "path_boundary" });
				if (before.size > BigInt(maxFileBytes)) throw new MeetingPublicationSourceError({ code: "oversize" });
				const { bytes, offset } = readDescriptor(descriptor, before.size);
				options.beforeStabilityCheck?.(path);
				const after = fstatSync(descriptor, { bigint: true });
				const current = statSync(path, { bigint: true });
				if (
					offset !== bytes.length ||
					before.dev !== after.dev ||
					before.ino !== after.ino ||
					before.size !== after.size ||
					before.mtimeNs !== after.mtimeNs ||
					current.dev !== after.dev ||
					current.ino !== after.ino ||
					current.size !== after.size ||
					current.mtimeNs !== after.mtimeNs
				) {
					throw new MeetingPublicationSourceError({ code: "race_detected" });
				}
				if (!isUtf8(bytes)) throw new MeetingPublicationSourceError({ code: "invalid_utf8" });
				return bytes.toString("utf8");
			} finally {
				closeSync(descriptor);
			}
		},
		catch: (cause) =>
			cause instanceof MeetingPublicationSourceError
				? cause
				: new MeetingPublicationSourceError({ code: "read_error" }),
	});

const parseNoteContent = Effect.fn("MeetingPublicationSource.parseNoteContent")(function* (
	root: string,
	path: string,
	markdown: string,
	config: JarvisMeetingPublicationConfig,
	purpose: "publication" | "archived-import" = "publication",
) {
	const parsed = parseMarkdown(markdown);
	const project = parsed.metadata.get("project")?.trim().toLowerCase() ?? "";
	if (project.length === 0 || project !== config.project?.toLowerCase()) {
		yield* new MeetingPublicationSourceError({ code: "project_boundary" });
	}
	const meetingDate = parsed.metadata.get("date")?.trim() ?? "";
	if (dateOrdinal(meetingDate) === null) yield* new MeetingPublicationSourceError({ code: "invalid_date" });
	const summary = parsed.sections.get("executive summary")?.trim() ?? "";
	if (summary.length === 0 && purpose === "publication") {
		yield* new MeetingPublicationSourceError({ code: "missing_summary" });
	}
	if (parsed.headings.some((heading) => heading.includes("transcript"))) {
		yield* new MeetingPublicationSourceError({ code: "transcript_section" });
	}
	const relativePath = relative(root, path).replaceAll("\\", "/");
	const fingerprint = parsed.metadata.get("fingerprint")?.trim() || relativePath;
	return new MeetingPublicationNote({
		itemId: createHash("sha256").update(`${project}:${fingerprint}`).digest("hex").slice(0, 24),
		path,
		relativePath,
		title: parsed.title,
		meetingDate,
		project,
		sourceHash: createHash("sha256").update(markdown).digest("hex"),
		summary,
		markdown,
	});
});

const parseNote = Effect.fn("MeetingPublicationSource.parseNote")(function* (
	root: string,
	path: string,
	config: JarvisMeetingPublicationConfig,
	options: MeetingPublicationSourceOptions,
) {
	const markdown = yield* safeRead(root, path, config.maxFileBytes, options);
	return yield* parseNoteContent(root, path, markdown, config);
});

/** @internal Offline archive reconciliation only; never establishes publication eligibility. */
export const readArchivedMeetingPublicationNoteForImport = Effect.fn("readArchivedMeetingPublicationNoteForImport")(
	function* (root: string, path: string, config: JarvisMeetingPublicationConfig) {
		const markdown = yield* safeRead(root, path, config.maxFileBytes, {});
		const note = yield* parseNoteContent(root, path, markdown, config, "archived-import");
		return { itemId: note.itemId, sourceHash: note.sourceHash, project: note.project, meetingDate: note.meetingDate };
	},
);

const normalizeNoteUpdate = Effect.fn("MeetingPublicationSource.normalizeNoteUpdate")(function* (markdown: string) {
	const normalized = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
	if (normalized.length === 0) yield* new MeetingPublicationSourceError({ code: "empty_note" });
	if (Array.from(normalized).length > MEETING_PUBLICATION_NOTE_MAX_LENGTH) {
		yield* new MeetingPublicationSourceError({ code: "note_too_long" });
	}
	return `${normalized}\n`;
});

const syncDirectoryBestEffort = (path: string) => {
	const opened = Result.try({ try: () => openSync(path, constants.O_RDONLY), catch: () => undefined });
	if (Result.isFailure(opened) || opened.success === undefined) return;
	void Result.try({ try: () => fsyncSync(opened.success), catch: () => undefined });
	void Result.try({ try: () => closeSync(opened.success), catch: () => undefined });
};

/**
 * Serializes cooperative Harnessy writers with an owner-only sidecar lock, then
 * performs a no-gap same-directory rename. Node has no portable conditional
 * replace primitive, so a non-cooperating writer can still race the final
 * validation and rename; the adjacent revalidation narrows but cannot remove it.
 */
const replaceNoteContent = (
	root: string,
	path: string,
	markdown: string,
	expectedSourceHash: string,
	maxFileBytes: number,
	options: MeetingPublicationSourceOptions,
): Effect.Effect<void, MeetingPublicationSourceError> =>
	Effect.try({
		try: () => {
			const requestedRoot = resolve(root);
			const requestedPath = resolve(path);
			const rootInfo = lstatSync(requestedRoot);
			if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
				throw new MeetingPublicationSourceError({ code: "path_boundary" });
			}
			const pathInfo = lstatSync(requestedPath);
			if (pathInfo.isSymbolicLink()) throw new MeetingPublicationSourceError({ code: "symlink" });
			const rootReal = realpathSync(requestedRoot);
			const pathReal = realpathSync(requestedPath);
			if (!within(rootReal, pathReal)) throw new MeetingPublicationSourceError({ code: "path_boundary" });

			const directory = dirname(pathReal);
			const lockPath = resolve(
				directory,
				`.harnessy-note-${createHash("sha256").update(pathReal).digest("hex").slice(0, 24)}.lock`,
			);
			if (dirname(lockPath) !== directory) throw new MeetingPublicationSourceError({ code: "path_boundary" });
			let lockDescriptor: number | null = null;
			let lockIdentity: { readonly dev: bigint; readonly ino: bigint } | null = null;
			let descriptor: number | null = null;
			let temporary: string | null = null;
			let temporaryDescriptor: number | null = null;
			let temporaryIdentity: { readonly dev: bigint; readonly ino: bigint } | null = null;
			try {
				// An existing lock fails closed. Remove a stale lock manually only after
				// confirming that no V2 editor process still owns the recorded PID.
				const lockResult = Result.try({
					try: () =>
						openSync(
							lockPath,
							constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
							0o600,
						),
					catch: (cause) => cause,
				});
				if (Result.isFailure(lockResult)) {
					const lockState = Result.try({ try: () => lstatSync(lockPath), catch: () => null });
					if (!Result.isFailure(lockState) && lockState.success?.isSymbolicLink()) {
						throw new MeetingPublicationSourceError({ code: "symlink" });
					}
					const code =
						typeof lockResult.failure === "object" && lockResult.failure !== null && "code" in lockResult.failure
							? lockResult.failure.code
							: null;
					throw new MeetingPublicationSourceError({ code: code === "EEXIST" ? "race_detected" : "write_error" });
				}
				lockDescriptor = lockResult.success;
				const createdLock = fstatSync(lockDescriptor, { bigint: true });
				lockIdentity = { dev: createdLock.dev, ino: createdLock.ino };
				if (process.platform !== "win32") fchmodSync(lockDescriptor, 0o600);
				const heldLock = fstatSync(lockDescriptor, { bigint: true });
				const linkedLock = lstatSync(lockPath, { bigint: true });
				if (
					!heldLock.isFile() ||
					linkedLock.isSymbolicLink() ||
					heldLock.dev !== linkedLock.dev ||
					heldLock.ino !== linkedLock.ino ||
					(process.platform !== "win32" && (heldLock.mode & 0o777n) !== 0o600n)
				) {
					throw new MeetingPublicationSourceError({ code: "race_detected" });
				}
				writeFileSync(lockDescriptor, `${process.pid}\n`, "utf8");
				fsyncSync(lockDescriptor);

				descriptor = openSync(pathReal, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				const before = fstatSync(descriptor, { bigint: true });
				if (!before.isFile()) throw new MeetingPublicationSourceError({ code: "path_boundary" });
				if (before.size > BigInt(maxFileBytes)) throw new MeetingPublicationSourceError({ code: "oversize" });
				const initial = readDescriptor(descriptor, before.size);
				if (initial.offset !== initial.bytes.length || !isUtf8(initial.bytes)) {
					throw new MeetingPublicationSourceError({
						code: initial.offset === initial.bytes.length ? "invalid_utf8" : "race_detected",
					});
				}
				if (createHash("sha256").update(initial.bytes).digest("hex") !== expectedSourceHash) {
					throw new MeetingPublicationSourceError({ code: "race_detected" });
				}
				if (Buffer.byteLength(markdown, "utf8") > maxFileBytes) {
					throw new MeetingPublicationSourceError({ code: "oversize" });
				}
				const candidateSourceHash = createHash("sha256").update(markdown).digest("hex");
				if (candidateSourceHash === expectedSourceHash) return;

				temporary = resolve(directory, `.${basename(pathReal)}.${randomBytes(12).toString("hex")}.tmp`);
				temporaryDescriptor = openSync(
					temporary,
					constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
					Number(before.mode & 0o7777n),
				);
				const createdCandidate = fstatSync(temporaryDescriptor, { bigint: true });
				temporaryIdentity = { dev: createdCandidate.dev, ino: createdCandidate.ino };
				writeFileSync(temporaryDescriptor, markdown, "utf8");
				if (process.platform !== "win32") fchmodSync(temporaryDescriptor, Number(before.mode & 0o7777n));
				fsyncSync(temporaryDescriptor);

				options.beforeFinalValidation?.(pathReal, temporary);
				const after = fstatSync(descriptor, { bigint: true });
				const finalLock = lstatSync(lockPath, { bigint: true });
				const currentLink = lstatSync(pathReal, { bigint: true });
				const current = statSync(pathReal, { bigint: true });
				const finalRead = readDescriptor(descriptor, after.size);
				const candidateLink = lstatSync(temporary, { bigint: true });
				const candidate = fstatSync(temporaryDescriptor, { bigint: true });
				const candidateRead = readDescriptor(temporaryDescriptor, candidate.size);
				if (
					finalLock.isSymbolicLink() ||
					finalLock.dev !== heldLock.dev ||
					finalLock.ino !== heldLock.ino ||
					currentLink.isSymbolicLink() ||
					!after.isFile() ||
					before.dev !== after.dev ||
					before.ino !== after.ino ||
					before.size !== after.size ||
					before.mtimeNs !== after.mtimeNs ||
					before.ctimeNs !== after.ctimeNs ||
					before.mode !== after.mode ||
					current.dev !== after.dev ||
					current.ino !== after.ino ||
					current.size !== after.size ||
					current.mtimeNs !== after.mtimeNs ||
					current.ctimeNs !== after.ctimeNs ||
					current.mode !== after.mode ||
					finalRead.offset !== finalRead.bytes.length ||
					createHash("sha256").update(finalRead.bytes).digest("hex") !== expectedSourceHash ||
					candidateLink.isSymbolicLink() ||
					!candidateLink.isFile() ||
					!candidate.isFile() ||
					candidate.dev !== temporaryIdentity.dev ||
					candidate.ino !== temporaryIdentity.ino ||
					candidateLink.dev !== candidate.dev ||
					candidateLink.ino !== candidate.ino ||
					candidateLink.size !== candidate.size ||
					candidateLink.mode !== candidate.mode ||
					candidate.size !== BigInt(Buffer.byteLength(markdown, "utf8")) ||
					(process.platform !== "win32" && (candidate.mode & 0o7777n) !== (before.mode & 0o7777n)) ||
					candidateRead.offset !== candidateRead.bytes.length ||
					createHash("sha256").update(candidateRead.bytes).digest("hex") !== candidateSourceHash
				) {
					throw new MeetingPublicationSourceError({ code: "race_detected" });
				}
				renameSync(temporary, pathReal);
				temporary = null;
				syncDirectoryBestEffort(directory);
			} finally {
				if (descriptor !== null) closeSync(descriptor);
				if (temporary !== null) {
					const candidatePath = temporary;
					const linkedCandidate = Result.try({
						try: () => lstatSync(candidatePath, { bigint: true }),
						catch: () => null,
					});
					if (
						!Result.isFailure(linkedCandidate) &&
						linkedCandidate.success !== null &&
						(linkedCandidate.success.isSymbolicLink() ||
							(temporaryIdentity !== null &&
								linkedCandidate.success.dev === temporaryIdentity.dev &&
								linkedCandidate.success.ino === temporaryIdentity.ino))
					) {
						unlinkSync(candidatePath);
					}
				}
				if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
				if (lockDescriptor !== null && lockIdentity !== null) {
					const linkedLock = Result.try({
						try: () => lstatSync(lockPath, { bigint: true }),
						catch: () => null,
					});
					if (
						!Result.isFailure(linkedLock) &&
						linkedLock.success !== null &&
						!linkedLock.success.isSymbolicLink() &&
						linkedLock.success.dev === lockIdentity.dev &&
						linkedLock.success.ino === lockIdentity.ino
					) {
						unlinkSync(lockPath);
					}
				}
				if (lockDescriptor !== null) closeSync(lockDescriptor);
			}
		},
		catch: (cause) =>
			cause instanceof MeetingPublicationSourceError
				? cause
				: new MeetingPublicationSourceError({ code: "write_error" }),
	});

const cutoffDate = (nowMillis: number, config: JarvisMeetingPublicationConfig, sinceDays?: number) => {
	const rolling = new Date(nowMillis);
	rolling.setUTCHours(0, 0, 0, 0);
	rolling.setUTCDate(rolling.getUTCDate() - (sinceDays ?? config.backfillDays));
	const rollingDate = rolling.toISOString().slice(0, 10);
	return config.cutoverDate !== null && config.cutoverDate > rollingDate ? config.cutoverDate : rollingDate;
};

/** Race-aware canonical note discovery rooted at an explicit configured directory. */
export class MeetingPublicationSource extends Context.Service<
	MeetingPublicationSource,
	{
		readonly discover: (nowMillis: number, sinceDays?: number) => Effect.Effect<DiscoveryResult>;
		readonly read: (path: string) => Effect.Effect<MeetingPublicationNote, MeetingPublicationSourceError>;
		readonly update: (
			request: MeetingPublicationNoteUpdate,
		) => Effect.Effect<MeetingPublicationNote, MeetingPublicationSourceUpdateFailure>;
	}
>()("@harnessy/core/MeetingPublicationSource") {
	static layer(config: JarvisMeetingPublicationConfig, options: MeetingPublicationSourceOptions = {}) {
		return Layer.effect(
			MeetingPublicationSource,
			Effect.gen(function* () {
				const authority = yield* MeetingPublicationWriteAuthority;
				return MeetingPublicationSource.of({
					discover: Effect.fn("MeetingPublicationSource.discover")(function* (
						nowMillis: number,
						sinceDays?: number,
					) {
						const root = config.sourcePath === null ? "" : resolve(config.sourcePath);
						const exclusions: Record<string, number> = {};
						const excludedPaths: Array<string> = [];
						const add = (code: MeetingPublicationExclusionCode, path?: string) => {
							exclusions[code] = (exclusions[code] ?? 0) + 1;
							if (path !== undefined) excludedPaths.push(path);
						};
						if (root.length === 0) {
							add("missing_source_root");
							return { notes: [], filesSeen: 0, exclusions, excludedPaths };
						}
						const rootResult = yield* Effect.try({
							try: () => lstatSync(root),
							catch: () => new MeetingPublicationSourceError({ code: "missing_source_root" }),
						}).pipe(Effect.result);
						if (Result.isFailure(rootResult)) {
							add("missing_source_root");
							return { notes: [], filesSeen: 0, exclusions, excludedPaths };
						}
						const rootInfo = rootResult.success;
						if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
							add("path_boundary");
							return { notes: [], filesSeen: 0, exclusions, excludedPaths };
						}
						const pending = [root];
						const paths: Array<string> = [];
						let filesSeen = 0;
						while (pending.length > 0) {
							const directory = pending.shift();
							if (directory === undefined) break;
							const entriesResult = yield* Effect.try({
								try: () =>
									readdirSync(directory, { withFileTypes: true, encoding: "utf8" }) as Array<Dirent<string>>,
								catch: () => new MeetingPublicationSourceError({ code: "read_error" }),
							}).pipe(Effect.result);
							if (Result.isFailure(entriesResult)) {
								add("read_error");
								continue;
							}
							const entries = entriesResult.success;
							for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
								const child = resolve(directory, entry.name);
								if (entry.isSymbolicLink()) {
									add("symlink", child);
									continue;
								}
								if (entry.isDirectory()) pending.push(child);
								else if (entry.isFile() && basename(child).endsWith(".md")) {
									filesSeen += 1;
									if (filesSeen > config.maxFiles) {
										add("file_limit");
										pending.length = 0;
										break;
									}
									paths.push(child);
								}
							}
						}
						const notes: Array<MeetingPublicationNote> = [];
						const floor = cutoffDate(nowMillis, config, sinceDays);
						for (const path of paths.sort()) {
							const parsed = yield* parseNote(root, path, config, options).pipe(Effect.result);
							if (Result.isFailure(parsed)) {
								add(parsed.failure.code, path);
								continue;
							}
							if (parsed.success.meetingDate < floor) {
								add("before_cutoff", path);
								continue;
							}
							notes.push(parsed.success);
						}
						notes.sort(
							(left, right) =>
								left.meetingDate.localeCompare(right.meetingDate) ||
								left.title.localeCompare(right.title) ||
								left.relativePath.localeCompare(right.relativePath),
						);
						return { notes, filesSeen, exclusions, excludedPaths };
					}),
					read: Effect.fn("MeetingPublicationSource.read")(function* (path: string) {
						const root = config.sourcePath;
						if (root === null) return yield* new MeetingPublicationSourceError({ code: "missing_source_root" });
						return yield* parseNote(resolve(root), resolve(path), config, options);
					}),
					update: Effect.fn("MeetingPublicationSource.update")(function* (request: MeetingPublicationNoteUpdate) {
						const baseBinding = yield* resolveMeetingPublicationWriteBinding(config, "source_update");
						const binding = new MeetingPublicationWriteBinding({
							...baseBinding,
							item: { itemId: request.expectedItemId, sourceHash: request.expectedSourceHash },
						});
						yield* authorizeMeetingPublicationWrite(authority, "source_update", binding);
						const root = config.sourcePath;
						if (root === null) return yield* new MeetingPublicationSourceError({ code: "missing_source_root" });
						const normalized = yield* normalizeNoteUpdate(request.markdown);
						const note = yield* parseNoteContent(resolve(root), resolve(request.path), normalized, config);
						if (note.itemId !== request.expectedItemId) {
							return yield* new MeetingPublicationSourceError({ code: "identity_change" });
						}
						yield* replaceNoteContent(
							root,
							request.path,
							normalized,
							request.expectedSourceHash,
							config.maxFileBytes,
							options,
						);
						return note;
					}),
				});
			}),
		);
	}
}
