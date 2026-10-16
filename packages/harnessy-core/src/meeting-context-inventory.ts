/**
 * Read-only, exhaustive meeting inventory over explicitly selected context roots
 * (gap-closure H-06). It reads Fathom inbox envelopes and legacy notes in place,
 * never writes, moves or deletes a file, never calls a provider and never follows
 * a symbolic link. Paging is explicit: a bounded page reports `incomplete` with a
 * continuation cursor instead of truncating silently.
 */
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

import * as Result from "effect/Result";

import {
	contextRef,
	type IndexedSource,
	lstatContextPath,
	MAX_CONTEXT_ARTIFACT_BYTES,
	MEETING_CONTEXT_SCHEMA_VERSION,
	MeetingContextError,
	meetingSourceKey,
	normalizeFathomTranscript,
	providerSummaryText,
	readContextArtifact,
	sha256Hex,
	transcriptPreview,
	validateByteLimit,
	validateSourceScope,
} from "./meeting-context.ts";

export const DEFAULT_INVENTORY_PAGE_SIZE = 500;
export const MAX_INVENTORY_PAGE_SIZE = 5_000;
const ACCOUNT_LABEL = /^[A-Za-z0-9_-]+$/u;
const BUCKETS = ["invalid", "pending", "processed"] as const;

export type InventoryRootKind = "fathom-inbox" | "legacy-notes";

export interface InventoryRoot {
	readonly kind: InventoryRootKind;
	/** Context-root-relative directory. */
	readonly path: string;
}

/** Explicit binding from a local credential label to a stable source scope. */
export interface AccountScopeMapping {
	readonly provider: "fathom";
	readonly accountLabel: string;
	readonly scope: string;
}

export type InventoryDisposition =
	| "indexed"
	| "unresolved"
	| "legacy"
	| "invalid"
	| "unreadable"
	| "unsupported"
	| "oversize"
	| "rejected-link";

export interface LegacyNoteEvidence {
	readonly sourceRef: string | null;
	readonly objectId: string | null;
	readonly fingerprint: string | null;
}

export interface InventoryEntry {
	readonly ref: string;
	readonly rootKind: InventoryRootKind;
	readonly account: string | null;
	readonly bucket: (typeof BUCKETS)[number] | null;
	readonly disposition: InventoryDisposition;
	readonly bytes: number | null;
	readonly sha256: string | null;
	readonly source: IndexedSource | null;
	readonly legacy: LegacyNoteEvidence | null;
	readonly reason: string | null;
}

export interface InventoryDiagnostic {
	readonly ref: string;
	readonly code: "root_missing" | "root_rejected" | "enumeration_failed" | "enumeration_changed";
	readonly message: string;
}

export type InventoryStatus = "complete" | "incomplete" | "interrupted" | "error";

export interface InventoryReport {
	readonly schemaVersion: typeof MEETING_CONTEXT_SCHEMA_VERSION;
	/**
	 * `complete`: every enumerated entry was processed without enumeration errors.
	 * `incomplete`: a page bound was reached; continue from `nextCursor`.
	 * `interrupted`: the signal aborted the run; resume from `nextCursor`.
	 * `error`: a root or directory could not be enumerated, or the candidate set changed
	 * after the cursor was issued; absent entries are unknown, not deleted. A changed
	 * set returns no entries and no cursor: restart the inventory from the beginning.
	 */
	readonly status: InventoryStatus;
	readonly cursor: string | null;
	readonly nextCursor: string | null;
	/** Entries enumerated across all selected roots for this page; every page of one pass sees the same set. */
	readonly enumerated: number;
	readonly entries: ReadonlyArray<InventoryEntry>;
	readonly diagnostics: ReadonlyArray<InventoryDiagnostic>;
}

export interface InventoryOptions {
	readonly contextRoot: string;
	readonly roots: ReadonlyArray<InventoryRoot>;
	readonly accountScopes: ReadonlyArray<AccountScopeMapping>;
	readonly pageSize?: number;
	readonly cursor?: string | null;
	readonly maxArtifactBytes?: number;
	readonly signal?: AbortSignal;
	/** Observer for progress; it cannot alter the report. */
	readonly onEntry?: (entry: InventoryEntry) => void;
}

interface Candidate {
	readonly ref: string;
	readonly rootKind: InventoryRootKind;
	readonly account: string | null;
	readonly bucket: (typeof BUCKETS)[number] | null;
	readonly type: "envelope" | "note" | "link" | "unsupported";
	readonly reason: string | null;
}

const invalid = (message: string): never => {
	throw new MeetingContextError("invalid_input", message);
};

/** Byte order of UTF-8 references; the same order sorts entries and positions cursors. */
const compareRefs = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const byRef = (a: { readonly ref: string }, b: { readonly ref: string }): number => compareRefs(a.ref, b.ref);

const validateRoots = (roots: ReadonlyArray<InventoryRoot>): ReadonlyArray<InventoryRoot> => {
	if (roots.length === 0) invalid("Select at least one inventory root");
	const normalized = roots.map((root) => {
		if (root.kind !== "fathom-inbox" && root.kind !== "legacy-notes") invalid("Unsupported inventory root kind");
		return { kind: root.kind, path: contextRef(root.path) };
	});
	for (const a of normalized)
		for (const b of normalized)
			if (a !== b && (a.path === b.path || b.path.startsWith(`${a.path}/`)))
				invalid(`Inventory roots overlap: ${a.path} and ${b.path}`);
	return [...normalized].sort((a, b) => byRef({ ref: a.path }, { ref: b.path }));
};

export const validateAccountScopes = (
	mappings: ReadonlyArray<AccountScopeMapping>,
): ReadonlyMap<string, AccountScopeMapping> => {
	const result = new Map<string, AccountScopeMapping>();
	for (const mapping of mappings) {
		if (!ACCOUNT_LABEL.test(mapping.accountLabel))
			invalid(`Invalid account label ${JSON.stringify(mapping.accountLabel)}`);
		validateSourceScope(mapping.provider, mapping.scope);
		if (result.has(mapping.accountLabel)) invalid(`Account label ${mapping.accountLabel} is mapped more than once`);
		result.set(mapping.accountLabel, { ...mapping });
	}
	return result;
};

const rootsFingerprint = (roots: ReadonlyArray<InventoryRoot>): string =>
	sha256Hex(JSON.stringify(roots.map((root) => [root.kind, root.path]))).slice(0, 16);

/** Fingerprint of the enumerated candidate set; a cursor is valid only while the set is unchanged. */
const candidateSetFingerprint = (candidates: ReadonlyArray<Candidate>): string =>
	sha256Hex(JSON.stringify(candidates.map((candidate) => [candidate.ref, candidate.type]))).slice(0, 32);

interface DecodedCursor {
	readonly set: string;
	readonly after: string;
}

const encodeCursor = (roots: string, set: string, after: string): string =>
	Buffer.from(JSON.stringify({ v: 1, roots, set, after })).toString("base64url");

const decodeCursor = (cursor: string, roots: string): DecodedCursor => {
	const parsed = Result.try((): unknown => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
	if (Result.isFailure(parsed)) return invalid("Invalid inventory cursor");
	const record = parsed.success as { v?: unknown; roots?: unknown; set?: unknown; after?: unknown } | null;
	if (record?.v !== 1 || typeof record.after !== "string" || typeof record.set !== "string")
		return invalid("Invalid inventory cursor");
	if (record.roots !== roots) return invalid("Inventory cursor belongs to a different root selection");
	return { set: record.set, after: record.after };
};

const enumerate = (
	contextRoot: string,
	roots: ReadonlyArray<InventoryRoot>,
	diagnostics: InventoryDiagnostic[],
): ReadonlyArray<Candidate> => {
	const candidates: Candidate[] = [];
	const list = (ref: string): ReadonlyArray<Dirent> | null => {
		const listed = Result.try(() => readdirSync(join(contextRoot, ref), { withFileTypes: true }));
		if (Result.isSuccess(listed)) return listed.success;
		diagnostics.push({ ref, code: "enumeration_failed", message: (listed.failure as Error).message });
		return null;
	};
	const walkNotes = (directory: string): void => {
		for (const entry of list(directory) ?? []) {
			const ref = `${directory}/${entry.name}`;
			const base = { ref, rootKind: "legacy-notes" as const, account: null, bucket: null };
			if (entry.isSymbolicLink()) candidates.push({ ...base, type: "link", reason: "symbolic link" });
			else if (entry.isDirectory()) walkNotes(ref);
			else if (entry.isFile() && entry.name.endsWith(".md"))
				candidates.push({ ...base, type: "note", reason: null });
			else candidates.push({ ...base, type: "unsupported", reason: "not a Markdown note" });
		}
	};
	const walkInbox = (root: string): void => {
		for (const account of list(root) ?? []) {
			const accountRef = `${root}/${account.name}`;
			const base = { rootKind: "fathom-inbox" as const, account: account.name, bucket: null };
			if (account.isSymbolicLink()) {
				candidates.push({ ...base, ref: accountRef, type: "link", reason: "symbolic link" });
				continue;
			}
			if (!account.isDirectory()) {
				candidates.push({ ...base, ref: accountRef, type: "unsupported", reason: "not an account directory" });
				continue;
			}
			for (const bucket of list(accountRef) ?? []) {
				const bucketRef = `${accountRef}/${bucket.name}`;
				const name = BUCKETS.find((value) => value === bucket.name);
				if (bucket.isSymbolicLink()) {
					candidates.push({ ...base, ref: bucketRef, type: "link", reason: "symbolic link" });
					continue;
				}
				if (name === undefined || !bucket.isDirectory()) {
					candidates.push({ ...base, ref: bucketRef, type: "unsupported", reason: "not an inbox bucket" });
					continue;
				}
				for (const file of list(bucketRef) ?? []) {
					const entry = { ...base, ref: `${bucketRef}/${file.name}`, bucket: name };
					if (file.isSymbolicLink()) candidates.push({ ...entry, type: "link", reason: "symbolic link" });
					else if (file.isFile() && file.name.endsWith(".json"))
						candidates.push({ ...entry, type: "envelope", reason: null });
					else candidates.push({ ...entry, type: "unsupported", reason: "not a JSON envelope" });
				}
			}
		}
	};
	for (const root of roots) {
		const inspected = Result.try(() => lstatContextPath(contextRoot, root.path));
		if (Result.isFailure(inspected)) {
			diagnostics.push({ ref: root.path, code: "root_rejected", message: (inspected.failure as Error).message });
			continue;
		}
		const stat = inspected.success;
		if (stat === null)
			diagnostics.push({ ref: root.path, code: "root_missing", message: "Selected root is missing" });
		else if (!stat.isDirectory())
			diagnostics.push({ ref: root.path, code: "root_rejected", message: "Selected root is not a directory" });
		else if (root.kind === "fathom-inbox") walkInbox(root.path);
		else walkNotes(root.path);
	}
	return candidates.sort(byRef);
};

const NOTE_LINE = (label: string): RegExp => new RegExp(`^- ${label}: *(.+?) *$`, "mu");

const inspect = (
	contextRoot: string,
	candidate: Candidate,
	scopes: ReadonlyMap<string, AccountScopeMapping>,
	maxBytes: number,
): InventoryEntry => {
	const base = {
		ref: candidate.ref,
		rootKind: candidate.rootKind,
		account: candidate.account,
		bucket: candidate.bucket,
		bytes: null,
		sha256: null,
		source: null,
		legacy: null,
		reason: candidate.reason,
	};
	if (candidate.type === "link") return { ...base, disposition: "rejected-link" };
	if (candidate.type === "unsupported") return { ...base, disposition: "unsupported" };
	const attempt = Result.try(() => readContextArtifact(contextRoot, candidate.ref, maxBytes));
	if (Result.isFailure(attempt)) {
		const error = attempt.failure as Error;
		const code = error instanceof MeetingContextError ? error.code : null;
		const disposition = code === "link_rejected" ? "rejected-link" : code === "too_large" ? "oversize" : "unreadable";
		return { ...base, disposition, reason: error.message };
	}
	const read = attempt.success;
	const file = { ...base, bytes: read.bytes.length, sha256: read.sha256 };
	const text = read.bytes.toString("utf8");
	if (candidate.type === "note") {
		const sourceRef = NOTE_LINE("Source Ref").exec(text)?.[1] ?? null;
		const objectId = sourceRef?.startsWith("fathom:") ? sourceRef.slice("fathom:".length) || null : null;
		return {
			...file,
			disposition: "legacy",
			legacy: { sourceRef, objectId, fingerprint: NOTE_LINE("Fingerprint").exec(text)?.[1] ?? null },
			reason: "legacy note lacks account scope; identity requires review",
		};
	}
	const parsed = Result.try((): unknown => JSON.parse(text));
	if (Result.isFailure(parsed)) return { ...file, disposition: "invalid", reason: "envelope is not valid JSON" };
	const value = parsed.success as {
		version?: unknown;
		verified?: unknown;
		source?: unknown;
		account?: unknown;
		payload?: unknown;
	} | null;
	const payload = value?.payload as Record<string, unknown> | undefined;
	const recordingId = payload?.recording_id;
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		value.version !== 1 ||
		value.source !== "fathom-api" ||
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		!((typeof recordingId === "string" && recordingId.trim()) || typeof recordingId === "number")
	)
		return { ...file, disposition: "invalid", reason: "not a supported Fathom envelope" };
	if (value.verified !== true) return { ...file, disposition: "invalid", reason: "envelope is not verified" };
	const label = candidate.account as string;
	if (value.account !== label)
		return { ...file, disposition: "unresolved", reason: "envelope account differs from its inbox account label" };
	const mapping = scopes.get(label);
	if (mapping === undefined)
		return { ...file, disposition: "unresolved", reason: "no explicit source-scope mapping for this account label" };
	const objectId = String(recordingId);
	const transcript = normalizeFathomTranscript(payload.transcript);
	const summary = providerSummaryText(payload);
	return {
		...file,
		disposition: "indexed",
		reason: null,
		source: {
			sourceKey: meetingSourceKey({ provider: mapping.provider, scope: mapping.scope, objectId }),
			provider: mapping.provider,
			scope: mapping.scope,
			objectId,
			accountLabel: label,
			ref: candidate.ref,
			sha256: read.sha256,
			transcript: {
				state: transcript.state,
				sha256: transcript.sha256,
				segmentCount: transcript.segments.length,
				dropped: transcript.dropped,
				preview: transcriptPreview(transcript.segments),
				reason: transcript.reason,
			},
			providerSummarySha256: summary === null ? null : sha256Hex(summary),
		},
	};
};

/** One deterministic inventory page. The run never writes to the context root. */
export const inventoryMeetingSources = (options: InventoryOptions): InventoryReport => {
	const roots = validateRoots(options.roots);
	const scopes = validateAccountScopes(options.accountScopes);
	const pageSize = options.pageSize ?? DEFAULT_INVENTORY_PAGE_SIZE;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_INVENTORY_PAGE_SIZE)
		invalid(`Inventory page size must be an integer from 1 to ${MAX_INVENTORY_PAGE_SIZE}`);
	const maxBytes = validateByteLimit(options.maxArtifactBytes ?? MAX_CONTEXT_ARTIFACT_BYTES);
	const fingerprint = rootsFingerprint(roots);
	const cursor = options.cursor ?? null;
	const decoded = cursor === null ? null : decodeCursor(cursor, fingerprint);
	const diagnostics: InventoryDiagnostic[] = [];
	const candidates = enumerate(options.contextRoot, roots, diagnostics);
	const set = candidateSetFingerprint(candidates);
	if (decoded !== null && decoded.set !== set)
		return {
			schemaVersion: MEETING_CONTEXT_SCHEMA_VERSION,
			status: "error",
			cursor,
			nextCursor: null,
			enumerated: candidates.length,
			entries: [],
			diagnostics: [
				...diagnostics,
				{
					ref: (roots[0] as InventoryRoot).path,
					code: "enumeration_changed" as const,
					message: "Selected roots changed after this cursor was issued; restart the inventory",
				},
			].sort(byRef),
		};
	const after = decoded?.after ?? null;
	const pending =
		after === null ? candidates : candidates.filter((candidate) => compareRefs(candidate.ref, after) > 0);
	const entries: InventoryEntry[] = [];
	let interrupted = false;
	for (const candidate of pending) {
		if (entries.length >= pageSize) break;
		if (options.signal?.aborted) {
			interrupted = true;
			break;
		}
		const entry = inspect(options.contextRoot, candidate, scopes, maxBytes);
		entries.push(entry);
		options.onEntry?.(entry);
	}
	const remaining = entries.length < pending.length;
	const last = entries.at(-1)?.ref ?? after;
	return {
		schemaVersion: MEETING_CONTEXT_SCHEMA_VERSION,
		status: interrupted ? "interrupted" : diagnostics.length > 0 ? "error" : remaining ? "incomplete" : "complete",
		cursor,
		nextCursor: remaining ? encodeCursor(fingerprint, set, last ?? "") : null,
		enumerated: candidates.length,
		entries,
		diagnostics: diagnostics.sort(byRef),
	};
};

/**
 * Page through every selected root. Stops early only on interruption, which is
 * reported with a resumable cursor. Enumeration errors are retained and make the
 * merged status `error`.
 */
export const collectMeetingInventory = (options: InventoryOptions): InventoryReport => {
	const entries: InventoryEntry[] = [];
	const diagnostics = new Map<string, InventoryDiagnostic>();
	let cursor = options.cursor ?? null;
	while (true) {
		const page = inventoryMeetingSources({ ...options, cursor });
		entries.push(...page.entries);
		for (const diagnostic of page.diagnostics) diagnostics.set(`${diagnostic.code}\0${diagnostic.ref}`, diagnostic);
		if (page.status === "interrupted" || page.nextCursor === null)
			return {
				...page,
				cursor: options.cursor ?? null,
				status: page.status === "interrupted" ? "interrupted" : diagnostics.size > 0 ? "error" : "complete",
				entries,
				diagnostics: [...diagnostics.values()].sort(byRef),
			};
		cursor = page.nextCursor;
	}
};

export type LegacyResolution = "single-candidate" | "ambiguous" | "unmatched" | "no-source-ref";

export interface LegacyCandidate {
	readonly ref: string;
	readonly objectId: string | null;
	readonly resolution: LegacyResolution;
	/** Candidate source keys for review; never merged automatically. */
	readonly candidates: ReadonlyArray<string>;
}

/** Report legacy-note candidates over a complete inventory without assigning identity. */
export const legacyNoteCandidates = (report: InventoryReport): ReadonlyArray<LegacyCandidate> => {
	if (report.status !== "complete")
		throw new MeetingContextError("incomplete_inventory", "Legacy reconciliation requires a complete inventory");
	const byObject = new Map<string, string[]>();
	for (const entry of report.entries)
		if (entry.source !== null)
			byObject.set(entry.source.objectId, [...(byObject.get(entry.source.objectId) ?? []), entry.source.sourceKey]);
	return report.entries.flatMap((entry): LegacyCandidate[] => {
		if (entry.legacy === null) return [];
		const objectId = entry.legacy.objectId;
		const candidates = objectId === null ? [] : [...new Set(byObject.get(objectId) ?? [])].sort();
		return [
			{
				ref: entry.ref,
				objectId,
				candidates,
				resolution:
					objectId === null
						? "no-source-ref"
						: candidates.length === 0
							? "unmatched"
							: candidates.length === 1
								? "single-candidate"
								: "ambiguous",
			},
		];
	});
};
