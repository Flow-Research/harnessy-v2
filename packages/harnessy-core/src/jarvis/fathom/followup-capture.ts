/**
 * Turn the follow-up candidates of new and recent Fathom notes into follow-ups.
 *
 * One pass, for each note:
 * 1. Drop candidates below the confidence floor.
 * 2. Build the note's batch (`meetingFollowupBatch`): open items, stable ids.
 * 3. Drop items already stored (id or fingerprint, in any status, in either
 *    store) and items that restate a follow-up stored for the same note
 *    (`sameCommitment`). A closed follow-up is never reopened, and a reworded
 *    one is not doubled.
 * 4. Unless this is a dry run, write the rest:
 *    - Fathom action items go to the shared task store. With sync configured,
 *      they are queued for the VPS first and written locally second, so a stop
 *      between the two writes leaves work to replay, never a local-only item
 *      that the next pull would erase.
 *    - Items from the summary or the transcript stay on this machine: they go
 *      to a separate local store that sync never reads or replaces, and they are
 *      never queued. `syncExtracted` (off by default, Julian's decision) sends
 *      them the same way as action items.
 *
 * The capture state records the outcome for each note, so the next poll looks
 * again only when the note's sources change or this capture failed.
 */
import { basename, dirname, join } from "node:path";

import * as Result from "effect/Result";

import type { CaptureStoreOptions } from "../tasks/capture.ts";
import {
	applyMeetingFollowupBatch,
	type MeetingFollowupBatch,
	type MeetingFollowupItem,
	type MeetingFollowupNote,
	meetingFollowupBatch,
} from "../tasks/meeting-followups.ts";
import { type StoredTask, TaskRefused, TasksState } from "../tasks/store.ts";
import { defaultQueuePath, enqueueMutation } from "../tasks/sync.ts";
import {
	type CapturedItemRecord,
	captureReason,
	type MeetingCaptureState,
	type NoteCaptureRecord,
} from "./capture-state.ts";
import {
	type ExtractedMeetingItem,
	MEETING_DUPLICATE_THRESHOLD,
	sameCommitment,
	type TitleSimilarity,
	wordOverlapSimilarity,
} from "./followup-extract.ts";

/** Candidates below this confidence are recorded in no batch. Transcript items (0.5) pass by default. */
export const MEETING_MIN_CONFIDENCE = 0.5;

/** The local-only store beside the task store: `tasks.json` gives `tasks.meeting-local.json`. */
export const defaultLocalMeetingFile = (tasksFile: string): string =>
	join(dirname(tasksFile), `${basename(tasksFile).replace(/\.json$/u, "")}.meeting-local.json`);

export type CaptureNote = Omit<MeetingFollowupNote, "actionItems"> & {
	readonly actionItems: ReadonlyArray<ExtractedMeetingItem & { readonly line: number }>;
	readonly sourceHash: string;
};

export interface FollowupCaptureOptions extends CaptureStoreOptions {
	/** Compute and report, but write nothing to either store, the queue or the capture state. */
	readonly dryRun?: boolean;
	/**
	 * Also send summary and transcript items to the shared store and the VPS.
	 * Off by default: these items stay in `localTasksFile`.
	 */
	readonly syncExtracted?: boolean;
	/** The local-only store. Default `defaultLocalMeetingFile(tasksFile)`. */
	readonly localTasksFile?: string;
	readonly minConfidence?: number;
	readonly similarity?: TitleSimilarity;
	readonly threshold?: number;
	readonly clock?: () => Date;
}

export interface NoteCaptureOutcome {
	readonly path: string;
	readonly fingerprint: string;
	readonly reason: "new" | "changed" | "retry";
	readonly record: NoteCaptureRecord;
	readonly created: number;
	readonly existing: number;
	readonly similar: number;
}

export interface FollowupCaptureResult {
	/** Notes looked at, notes captured now, and notes skipped because nothing changed. */
	readonly notes: number;
	readonly captured: number;
	readonly unchanged: number;
	readonly created: number;
	/** Of `created`: items kept in the local-only store. */
	readonly local: number;
	readonly existing: number;
	readonly similar: number;
	readonly queued: number;
	readonly failed: number;
	readonly dryRun: boolean;
	readonly outcomes: ReadonlyArray<NoteCaptureOutcome>;
	/** The records this pass wrote, by note fingerprint; the caller merges them into the state file. */
	readonly records: Readonly<Record<string, NoteCaptureRecord>>;
}

type Candidate = ExtractedMeetingItem & { readonly line: number };

/** Each batch item's candidate, by walking both lists in order (the batch is an ordered subsequence). */
const candidateFor = (note: CaptureNote, batch: MeetingFollowupBatch): ReadonlyArray<Candidate | undefined> => {
	let next = 0;
	return batch.items.map((item) => {
		while (next < note.actionItems.length) {
			const candidate = note.actionItems[next]!;
			next += 1;
			if (!candidate.completed && candidate.text.slice(0, item.title.length) === item.title) return candidate;
		}
		return undefined;
	});
};

const readItems = (state: TasksState | null): ReadonlyArray<StoredTask> => (state === null ? [] : state.read().items);

/** Capture the follow-ups of every note that needs it. Errors on one note never stop the others. */
export const captureFathomFollowups = (
	notes: ReadonlyArray<CaptureNote>,
	state: MeetingCaptureState,
	options: FollowupCaptureOptions,
): FollowupCaptureResult => {
	const shared = new TasksState(options.tasksFile);
	const local = new TasksState(options.localTasksFile ?? defaultLocalMeetingFile(options.tasksFile));
	const queuePath = options.queuePath ?? defaultQueuePath(options.tasksFile);
	const minConfidence = options.minConfidence ?? MEETING_MIN_CONFIDENCE;
	const similarity = options.similarity ?? wordOverlapSimilarity;
	const threshold = options.threshold ?? MEETING_DUPLICATE_THRESHOLD;
	const now = (options.clock ?? (() => new Date()))().toISOString();
	const records: Record<string, NoteCaptureRecord> = {};
	const outcomes: NoteCaptureOutcome[] = [];
	let created = 0;
	let localCreated = 0;
	let existing = 0;
	let similar = 0;
	let queued = 0;
	let failed = 0;
	let unchanged = 0;
	const seen = new Set<string>();
	for (const note of notes) {
		if (seen.has(note.fingerprint)) continue;
		seen.add(note.fingerprint);
		const known = { version: 1 as const, notes: { ...state.notes, ...records } };
		const reason = captureReason(known, note.fingerprint, note.sourceHash);
		if (reason === null) {
			unchanged += 1;
			continue;
		}
		const confident: CaptureNote = {
			...note,
			actionItems: note.actionItems.filter((item) => item.confidence >= minConfidence),
		};
		const batch = meetingFollowupBatch(confident);
		const candidates = candidateFor(confident, batch);
		const isLocal = (index: number): boolean =>
			options.syncExtracted !== true && (candidates[index]?.source ?? "action_items") !== "action_items";
		// Items an earlier capture recorded for this note count as the note's, even when the note moved.
		const priorIds = new Set((known.notes[note.fingerprint]?.items ?? []).map((item) => item.id));
		const attempt = Result.try(() => {
			const stored = [...readItems(shared), ...readItems(local)];
			const ids = new Set(stored.map((item) => item.id));
			const fingerprints = new Set(stored.flatMap((item) => (item.fingerprint === null ? [] : [item.fingerprint])));
			const fromNote = stored.filter(
				(item) => (item.source.kind === "meeting" && item.source.path === note.path) || priorIds.has(item.id),
			);
			const outcome = batch.items.map((item): CapturedItemRecord["outcome"] => {
				if (ids.has(item.id) || fingerprints.has(item.fingerprint)) return "existing";
				const restated = fromNote.some((other) =>
					sameCommitment(
						{ text: item.title, owner: item.owner },
						{ text: other.title, owner: other.owner },
						similarity,
						threshold,
					),
				);
				return restated ? "similar" : "created";
			});
			if (options.dryRun) return outcome;
			const fresh = (wantLocal: boolean): MeetingFollowupItem[] =>
				batch.items.filter((_item, index) => outcome[index] === "created" && isLocal(index) === wantLocal);
			const sharedItems = fresh(false);
			if (sharedItems.length > 0) {
				const sharedBatch: MeetingFollowupBatch = { ...batch, items: sharedItems };
				// Queue before the local write. A replay of an id the VPS already has changes nothing.
				if (options.syncConfig !== undefined) {
					enqueueMutation(queuePath, { op: "ingestMeeting", batch: sharedBatch }, shared);
					queued += 1;
				}
				applyMeetingFollowupBatch(shared, sharedBatch);
			}
			const localItems = fresh(true);
			if (localItems.length > 0) applyMeetingFollowupBatch(local, { ...batch, items: localItems });
			return outcome;
		});
		const items: CapturedItemRecord[] = Result.isSuccess(attempt)
			? batch.items.map((item, index) => {
					const candidate = candidates[index];
					return {
						id: item.id,
						fingerprint: item.fingerprint,
						source: candidate?.source ?? "action_items",
						confidence: candidate?.confidence ?? 1,
						quote: candidate?.quote ?? item.title.slice(0, 200),
						timestamp: candidate?.timestamp ?? null,
						line: item.line,
						outcome: attempt.success[index]!,
						store: isLocal(index) ? "local" : "shared",
					};
				})
			: [];
		const record: NoteCaptureRecord = {
			path: note.path,
			sourceHash: note.sourceHash,
			status: Result.isFailure(attempt) ? "failed" : batch.items.length === 0 ? "empty" : "captured",
			error: Result.isFailure(attempt)
				? attempt.failure instanceof TaskRefused
					? attempt.failure.code.slice(0, 64)
					: "capture_failed"
				: null,
			capturedAt: now,
			items,
		};
		records[note.fingerprint] = record;
		const count = (kind: CapturedItemRecord["outcome"]) => items.filter((item) => item.outcome === kind).length;
		if (Result.isFailure(attempt)) failed += 1;
		created += count("created");
		localCreated += items.filter((item) => item.outcome === "created" && item.store === "local").length;
		existing += count("existing");
		similar += count("similar");
		outcomes.push({
			path: note.path,
			fingerprint: note.fingerprint,
			reason,
			record,
			created: count("created"),
			existing: count("existing"),
			similar: count("similar"),
		});
	}
	return {
		notes: seen.size,
		captured: outcomes.length,
		unchanged,
		created,
		local: localCreated,
		existing,
		similar,
		queued,
		failed,
		dryRun: options.dryRun === true,
		outcomes,
		records,
	};
};
