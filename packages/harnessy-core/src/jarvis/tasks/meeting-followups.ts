/**
 * Durable follow-ups from meeting action items.
 *
 * The Fathom poll calls this for each note it has just written; it never scans
 * the archive. Identity is the note fingerprint plus the normalised action text
 * (and its occurrence when a meeting repeats an action), so a second poll, a
 * queued replay or the VPS copy all reach the same item. A follow-up keeps the
 * note path as its source and the recording (or the moment in it) as its link.
 * An item can carry a due date that its source text stated. Nothing here closes
 * an item.
 */
import { createHash } from "node:crypto";

import { normaliseTaskText } from "../../read-model/followups.ts";
import {
	type IngestCandidate,
	type StoredTask,
	TASK_DAY,
	TASK_FINGERPRINT,
	TASK_ID,
	TASK_LINK_MAX,
	TASK_OWNER_MAX,
	TASK_PROJECT_MAX,
	TASK_TITLE_MAX,
	TaskRefused,
	type TasksState,
	taskFingerprint,
} from "./store.ts";

export const MEETING_FOLLOWUP_BATCH_MAX = 50;

export interface MeetingFollowupNote {
	readonly path: string;
	readonly project: string | null;
	readonly title: string;
	readonly date: string;
	/** The note's `Fingerprint:` metadata, for example `fathom:123:2026-11-27T09:00:00Z`. */
	readonly fingerprint: string;
	readonly shareUrl: string | null;
	/** Fathom action items and the commitments extracted from the summary or transcript. */
	readonly actionItems: ReadonlyArray<{
		readonly text: string;
		readonly owner: string | null;
		readonly completed: boolean;
		/** 1-based line of the item in the note. */
		readonly line: number;
		/**
		 * The text the fingerprint hashes, when it is not `text`. Fathom action items
		 * leave it out, so their ids are the same as before extraction existed.
		 */
		readonly key?: string;
		readonly due?: string | null;
		/** A link to the moment in the recording; the note's share URL otherwise. */
		readonly link?: string | null;
	}>;
}

export interface MeetingFollowupItem {
	readonly id: string;
	readonly title: string;
	readonly owner: string | null;
	readonly line: number;
	readonly fingerprint: string;
	readonly link: string | null;
	readonly project: string | null;
	/** Present only when the source stated a date. */
	readonly due?: string;
}

/** One note's follow-ups: the unit that is applied locally, queued and sent to the VPS. */
export interface MeetingFollowupBatch {
	readonly path: string;
	readonly displayRef: string;
	readonly items: ReadonlyArray<MeetingFollowupItem>;
}

export interface MeetingFollowupResult {
	readonly created: number;
	readonly existing: number;
	readonly items: ReadonlyArray<StoredTask>;
}

/** A UUID (version 8, RFC 9562) derived from the fingerprint, so every copy mints the same id. */
export const meetingFollowupId = (fingerprint: string): string => {
	const hex = createHash("sha256").update(`harnessy-meeting-followup\0${fingerprint}`).digest("hex").slice(0, 32);
	const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** The batch for one note: open action items only, in note order. */
export const meetingFollowupBatch = (note: MeetingFollowupNote): MeetingFollowupBatch => {
	const seen = new Map<string, number>();
	const items: MeetingFollowupItem[] = [];
	for (const action of note.actionItems) {
		const keyText = action.key ?? action.text;
		const key = normaliseTaskText(keyText);
		if (key.length === 0 || normaliseTaskText(action.text).length === 0) continue;
		const occurrence = seen.get(key) ?? 0;
		seen.set(key, occurrence + 1);
		if (action.completed) continue;
		const fingerprint = taskFingerprint("meeting", keyText, occurrence, note.fingerprint);
		const due = action.due != null && TASK_DAY.test(action.due) ? action.due : null;
		items.push({
			id: meetingFollowupId(fingerprint),
			title: action.text.slice(0, TASK_TITLE_MAX),
			owner: action.owner === null ? null : action.owner.slice(0, TASK_OWNER_MAX),
			line: action.line,
			fingerprint,
			link: action.link ?? note.shareUrl,
			project: note.project === null ? null : note.project.slice(0, TASK_PROJECT_MAX),
			...(due === null ? {} : { due }),
		});
		if (items.length >= MEETING_FOLLOWUP_BATCH_MAX) break;
	}
	return { path: note.path, displayRef: `meeting ${note.date} ${note.title}`.slice(0, 96), items };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const control = /[\p{Cc}\p{Cf}]/u;
const text = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max && !control.test(value);
const optional = (value: unknown, max: number, code: string): string | null => {
	if (value === null || value === undefined) return null;
	if (!text(value, max)) throw new TaskRefused(code);
	return value;
};

/** Validate a batch from the queue or the HTTP body. The store validates the link again. */
export const parseMeetingFollowupBatch = (value: unknown): MeetingFollowupBatch => {
	if (!isRecord(value) || !text(value.path, 512) || !text(value.displayRef, 96) || !Array.isArray(value.items))
		throw new TaskRefused("invalid_body");
	if (value.items.length === 0 || value.items.length > MEETING_FOLLOWUP_BATCH_MAX)
		throw new TaskRefused("invalid_body");
	const items = value.items.map((raw): MeetingFollowupItem => {
		if (!isRecord(raw)) throw new TaskRefused("invalid_body");
		if (typeof raw.id !== "string" || !TASK_ID.test(raw.id)) throw new TaskRefused("invalid_id");
		if (typeof raw.fingerprint !== "string" || !TASK_FINGERPRINT.test(raw.fingerprint))
			throw new TaskRefused("invalid_fingerprint");
		if (raw.id !== meetingFollowupId(raw.fingerprint)) throw new TaskRefused("invalid_id");
		if (!text(raw.title, TASK_TITLE_MAX)) throw new TaskRefused("invalid_title");
		if (!Number.isInteger(raw.line) || (raw.line as number) < 1) throw new TaskRefused("invalid_line");
		if (raw.due != null && (typeof raw.due !== "string" || !TASK_DAY.test(raw.due)))
			throw new TaskRefused("invalid_due");
		return {
			id: raw.id,
			title: raw.title.trim(),
			owner: optional(raw.owner, TASK_OWNER_MAX, "invalid_owner"),
			line: raw.line as number,
			fingerprint: raw.fingerprint,
			link: optional(raw.link, TASK_LINK_MAX, "invalid_link"),
			project: optional(raw.project, TASK_PROJECT_MAX, "invalid_project"),
			...(typeof raw.due === "string" ? { due: raw.due } : {}),
		};
	});
	return { path: value.path, displayRef: value.displayRef, items };
};

/**
 * Add the batch's new follow-ups in one locked write. An item whose id or
 * fingerprint is already stored, in any status, is left alone: a resolved
 * follow-up is never reopened and an open one is never duplicated.
 */
export const applyMeetingFollowupBatch = (
	state: TasksState,
	batch: MeetingFollowupBatch,
	expectedRevision?: number,
): MeetingFollowupResult =>
	state.runExclusive(() => {
		const store = state.read();
		if (expectedRevision !== undefined && store.revision !== expectedRevision)
			throw new TaskRefused("stale_revision");
		const ids = new Set(store.items.map((item) => item.id));
		const fingerprints = new Set(
			store.items.flatMap((item) => (item.fingerprint === null ? [] : [item.fingerprint])),
		);
		const fresh = batch.items.filter((item) => !ids.has(item.id) && !fingerprints.has(item.fingerprint));
		const existing = batch.items.length - fresh.length;
		if (fresh.length === 0) return { created: 0, existing, items: [] };
		const candidates: IngestCandidate[] = fresh.map((item) => ({
			id: item.id,
			title: item.title,
			status: "todo",
			owner: item.owner,
			due: item.due ?? null,
			line: item.line,
			fingerprint: item.fingerprint,
			displayRef: batch.displayRef,
			kind: "followup",
			link: item.link,
			project: item.project,
		}));
		const result = state.ingest(candidates, {
			kind: "meeting",
			path: batch.path,
			displayRef: batch.displayRef,
			briefDate: null,
		});
		return { created: result.created, existing: existing + result.matched, items: result.items };
	});
