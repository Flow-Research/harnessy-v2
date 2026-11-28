/**
 * Per-note follow-up capture state for the Fathom poll (`meeting-capture-state-v1.json`).
 *
 * The poll writes one record for each note it captures: the hash of the note's
 * follow-up sources, when it ran, whether it worked and the items it found. The
 * next poll captures a recent note again only when that hash changed or the
 * last capture failed. The task store stays the authority for which items
 * exist: this file only decides when to look again, and it keeps the quote,
 * timestamp and confidence of each item, which the task store has no field for.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import * as Result from "effect/Result";

import type { MeetingItemSource } from "./followup-extract.ts";
import { tryProcessLock } from "./process-lock.ts";

export const MEETING_CAPTURE_STATE_FILE = "meeting-capture-state-v1.json";
/** Records older than this are dropped when the file is written. */
export const MEETING_CAPTURE_STATE_RETENTION_DAYS = 90;
/** The largest state file that is read or written. */
export const MEETING_CAPTURE_STATE_MAX_BYTES = 8 * 1024 * 1024;
const LOCK_WAIT_MS = 5_000;

export type NoteCaptureStatus = "captured" | "empty" | "failed";

export interface CapturedItemRecord {
	readonly id: string;
	readonly fingerprint: string;
	readonly source: MeetingItemSource;
	readonly confidence: number;
	readonly quote: string;
	readonly timestamp: string | null;
	readonly line: number;
	/** `created` by this or an earlier capture, already `existing`, or a `similar` restatement of a stored item. */
	readonly outcome: "created" | "existing" | "similar";
	/** `shared`: the task store that syncs with the VPS. `local`: the local-only meeting store. */
	readonly store?: "shared" | "local";
	/** The id of the local item that this shared item replaced. */
	readonly replaced?: string;
}

export interface NoteCaptureRecord {
	readonly path: string;
	readonly sourceHash: string;
	readonly status: NoteCaptureStatus;
	/** A short code such as `tasks_busy`, never message text. */
	readonly error: string | null;
	readonly capturedAt: string;
	readonly items: ReadonlyArray<CapturedItemRecord>;
}

export interface MeetingCaptureState {
	readonly version: 1;
	/** Keyed by the note's `Fingerprint:` value. */
	readonly notes: Readonly<Record<string, NoteCaptureRecord>>;
}

export const meetingCaptureStatePath = (stateRoot: string): string => join(stateRoot, MEETING_CAPTURE_STATE_FILE);

const empty = (): MeetingCaptureState => ({ version: 1, notes: {} });

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

type ParsedState = { readonly state: MeetingCaptureState; readonly damaged: boolean };

const ITEM_SOURCES: ReadonlyArray<unknown> = ["action_items", "summary", "transcript"];
const ITEM_OUTCOMES: ReadonlyArray<unknown> = ["created", "existing", "similar"];

const isItemRecord = (item: unknown): item is CapturedItemRecord =>
	isRecord(item) &&
	typeof item.id === "string" &&
	typeof item.fingerprint === "string" &&
	ITEM_SOURCES.includes(item.source) &&
	typeof item.confidence === "number" &&
	typeof item.quote === "string" &&
	(item.timestamp === null || typeof item.timestamp === "string") &&
	typeof item.line === "number" &&
	ITEM_OUTCOMES.includes(item.outcome) &&
	(item.store === undefined || item.store === "shared" || item.store === "local") &&
	(item.replaced === undefined || typeof item.replaced === "string");

const isNoteRecord = (record: unknown): record is NoteCaptureRecord =>
	isRecord(record) &&
	typeof record.path === "string" &&
	typeof record.sourceHash === "string" &&
	(record.status === "captured" || record.status === "empty" || record.status === "failed") &&
	(record.error === null || typeof record.error === "string") &&
	typeof record.capturedAt === "string" &&
	!Number.isNaN(Date.parse(record.capturedAt)) &&
	Array.isArray(record.items) &&
	record.items.every(isItemRecord);

const parseState = (path: string): ParsedState => {
	if (!existsSync(path)) return { state: empty(), damaged: false };
	const parsed = Result.try(() => {
		const raw = readFileSync(path);
		if (raw.byteLength > MEETING_CAPTURE_STATE_MAX_BYTES) throw new Error("capture_state_too_large");
		return JSON.parse(raw.toString("utf8")) as unknown;
	});
	if (Result.isFailure(parsed)) return { state: empty(), damaged: true };
	const value = parsed.success;
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.notes)) return { state: empty(), damaged: true };
	// A record that fails the check is left out, so its note is captured again,
	// and the file counts as damaged, so the next write keeps a copy of it.
	const notes: Record<string, NoteCaptureRecord> = {};
	let damaged = false;
	for (const [key, record] of Object.entries(value.notes)) {
		if (isNoteRecord(record)) notes[key] = record;
		else damaged = true;
	}
	return { state: { version: 1, notes }, damaged };
};

/**
 * Read the state. A missing file is empty. A damaged or oversized file also
 * reads as empty, so every recent note is checked again (capture is
 * idempotent); `updateMeetingCaptureState` keeps a copy of it before writing.
 */
export const readMeetingCaptureState = (path: string): MeetingCaptureState => parseState(path).state;

const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Hold `<path>.lock` while `run` reads, merges and writes. The lock belongs to
 * this process (`tryProcessLock`); another process waits up to 5 seconds.
 */
const withStateLock = <A>(path: string, run: () => A): A => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const lockPath = `${path}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;
	let release = tryProcessLock(lockPath);
	while (release === null) {
		if (Date.now() > deadline) throw new Error("capture_state_busy");
		sleepSync(50);
		release = tryProcessLock(lockPath);
	}
	try {
		return run();
	} finally {
		release();
	}
};

const writeAtomic = (path: string, text: string): void => {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const renamed = Result.try(() => renameSync(temporary, path));
	if (Result.isFailure(renamed)) {
		unlinkSync(temporary);
		throw renamed.failure;
	}
};

/**
 * Merge `records` into the state on disk under a lock and write it atomically
 * (0600). Records of other notes, from another account or another poll, stay.
 * Records older than the retention period are dropped, and the oldest records
 * go first when the file would pass the size limit. A damaged file is kept as
 * `<file>.damaged-<time>` before it is replaced.
 */
export const updateMeetingCaptureState = (
	path: string,
	records: Readonly<Record<string, NoteCaptureRecord>>,
	now: Date = new Date(),
): MeetingCaptureState =>
	withStateLock(path, () => {
		const current = parseState(path);
		if (current.damaged) renameSync(path, `${path}.damaged-${now.toISOString().replace(/[:.]/gu, "-")}`);
		const floor = now.getTime() - MEETING_CAPTURE_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
		const entries = Object.entries({ ...current.state.notes, ...records })
			.filter(([, record]) => Date.parse(record.capturedAt) >= floor)
			.sort(([, a], [, b]) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
		let kept = entries;
		let text = `${JSON.stringify({ version: 1, notes: Object.fromEntries(kept) }, null, 2)}\n`;
		while (Buffer.byteLength(text) > MEETING_CAPTURE_STATE_MAX_BYTES && kept.length > 0) {
			kept = kept.slice(0, Math.max(0, Math.floor(kept.length * 0.9)));
			text = `${JSON.stringify({ version: 1, notes: Object.fromEntries(kept) }, null, 2)}\n`;
		}
		writeAtomic(path, text);
		return { version: 1, notes: Object.fromEntries(kept) };
	});

/**
 * Why a note needs a capture now, or null when it does not: `new` (no record),
 * `changed` (the sources changed) or `retry` (the last capture failed).
 */
export const captureReason = (
	state: MeetingCaptureState,
	fingerprint: string,
	sourceHash: string,
): "new" | "changed" | "retry" | null => {
	const record = state.notes[fingerprint];
	if (record === undefined) return "new";
	if (record.status === "failed") return "retry";
	return record.sourceHash === sourceHash ? null : "changed";
};
