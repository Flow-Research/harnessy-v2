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

export const MEETING_CAPTURE_STATE_FILE = "meeting-capture-state-v1.json";
/** Records older than this are dropped when the file is written. */
export const MEETING_CAPTURE_STATE_RETENTION_DAYS = 90;
const MAX_BYTES = 8 * 1024 * 1024;

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

/** Read the state. A missing file is empty; an unreadable or invalid file is also empty, so every recent note is checked again. */
export const readMeetingCaptureState = (path: string): MeetingCaptureState => {
	if (!existsSync(path)) return empty();
	const parsed = Result.try(() => {
		const raw = readFileSync(path);
		if (raw.byteLength > MAX_BYTES) throw new Error("capture_state_too_large");
		return JSON.parse(raw.toString("utf8")) as unknown;
	});
	if (Result.isFailure(parsed)) return empty();
	const value = parsed.success;
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.notes)) return empty();
	const notes: Record<string, NoteCaptureRecord> = {};
	for (const [key, record] of Object.entries(value.notes)) {
		if (
			isRecord(record) &&
			typeof record.path === "string" &&
			typeof record.sourceHash === "string" &&
			(record.status === "captured" || record.status === "empty" || record.status === "failed") &&
			typeof record.capturedAt === "string" &&
			Array.isArray(record.items)
		)
			notes[key] = record as unknown as NoteCaptureRecord;
	}
	return { version: 1, notes };
};

/** Write the state atomically (0600), without records older than the retention period. */
export const writeMeetingCaptureState = (path: string, state: MeetingCaptureState, now: Date = new Date()): void => {
	const floor = now.getTime() - MEETING_CAPTURE_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
	const notes = Object.fromEntries(
		Object.entries(state.notes).filter(([, record]) => Date.parse(record.capturedAt) >= floor),
	);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify({ version: 1, notes }, null, 2)}\n`);
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
