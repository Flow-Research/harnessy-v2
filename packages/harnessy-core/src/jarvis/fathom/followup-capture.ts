/**
 * Turn the follow-up candidates of new and recent Fathom notes into follow-ups.
 *
 * One pass, for each note:
 * 1. Drop candidates below the confidence floor.
 * 2. Build the note's batch (`meetingFollowupBatch`): open items, stable ids.
 * 3. Drop items already stored (id or fingerprint, in any status) and items
 *    that restate a stored follow-up from the same note (`sameCommitment`).
 *    A closed follow-up is never reopened, and a reworded one is not doubled.
 * 4. Unless this is a dry run, add the rest in one locked write and queue them
 *    for the VPS when sync is configured.
 *
 * The capture state records the outcome for each note, so the next poll looks
 * again only when the note's sources change or this capture failed.
 */
import * as Result from "effect/Result";

import type { CaptureStoreOptions } from "../tasks/capture.ts";
import {
	applyMeetingFollowupBatch,
	type MeetingFollowupBatch,
	type MeetingFollowupNote,
	meetingFollowupBatch,
} from "../tasks/meeting-followups.ts";
import { TaskRefused, TasksState } from "../tasks/store.ts";
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

export type CaptureNote = Omit<MeetingFollowupNote, "actionItems"> & {
	readonly actionItems: ReadonlyArray<ExtractedMeetingItem & { readonly line: number }>;
	readonly sourceHash: string;
};

export interface FollowupCaptureOptions extends CaptureStoreOptions {
	/** Compute and report, but write nothing to the task store, the queue or the capture state. */
	readonly dryRun?: boolean;
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
	readonly existing: number;
	readonly similar: number;
	readonly queued: number;
	readonly failed: number;
	readonly dryRun: boolean;
	readonly outcomes: ReadonlyArray<NoteCaptureOutcome>;
	/** The capture state after this pass; the caller writes it unless this was a dry run. */
	readonly state: MeetingCaptureState;
}

/** Each batch item's candidate, by walking both lists in order (the batch is an ordered subsequence). */
const candidateFor = (
	note: CaptureNote,
	batch: MeetingFollowupBatch,
): ReadonlyArray<(ExtractedMeetingItem & { readonly line: number }) | undefined> => {
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

/** Capture the follow-ups of every note that needs it. Errors on one note never stop the others. */
export const captureFathomFollowups = (
	notes: ReadonlyArray<CaptureNote>,
	state: MeetingCaptureState,
	options: FollowupCaptureOptions,
): FollowupCaptureResult => {
	const tasks = new TasksState(options.tasksFile);
	const queuePath = options.queuePath ?? defaultQueuePath(options.tasksFile);
	const minConfidence = options.minConfidence ?? MEETING_MIN_CONFIDENCE;
	const similarity = options.similarity ?? wordOverlapSimilarity;
	const threshold = options.threshold ?? MEETING_DUPLICATE_THRESHOLD;
	const now = (options.clock ?? (() => new Date()))().toISOString();
	const records: Record<string, NoteCaptureRecord> = { ...state.notes };
	const outcomes: NoteCaptureOutcome[] = [];
	let created = 0;
	let existing = 0;
	let similar = 0;
	let queued = 0;
	let failed = 0;
	let unchanged = 0;
	const seen = new Set<string>();
	for (const note of notes) {
		if (seen.has(note.fingerprint)) continue;
		seen.add(note.fingerprint);
		const reason = captureReason({ version: 1, notes: records }, note.fingerprint, note.sourceHash);
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
		const attempt = Result.try(() => {
			const store = tasks.read();
			const ids = new Set(store.items.map((item) => item.id));
			const fingerprints = new Set(
				store.items.flatMap((item) => (item.fingerprint === null ? [] : [item.fingerprint])),
			);
			const fromNote = store.items.filter(
				(item) => item.source.kind === "meeting" && item.source.path === note.path,
			);
			const outcome = batch.items.map((item): CapturedItemRecord["outcome"] => {
				if (ids.has(item.id) || fingerprints.has(item.fingerprint)) return "existing";
				const restated = fromNote.some((stored) =>
					sameCommitment(
						{ text: item.title, owner: item.owner },
						{ text: stored.title, owner: stored.owner },
						similarity,
						threshold,
					),
				);
				return restated ? "similar" : "created";
			});
			const fresh: MeetingFollowupBatch = {
				...batch,
				items: batch.items.filter((_item, index) => outcome[index] === "created"),
			};
			if (!options.dryRun && fresh.items.length > 0) {
				const applied = applyMeetingFollowupBatch(tasks, fresh);
				const createdIds = new Set(applied.items.map((item) => item.id));
				for (const [index, item] of batch.items.entries())
					if (outcome[index] === "created" && !createdIds.has(item.id)) outcome[index] = "existing";
				// Queue only what this pass created; the VPS dedupes by id and fingerprint as well.
				if (options.syncConfig !== undefined && createdIds.size > 0) {
					enqueueMutation(
						queuePath,
						{
							op: "ingestMeeting",
							batch: { ...fresh, items: fresh.items.filter((item) => createdIds.has(item.id)) },
						},
						tasks,
					);
					queued += 1;
				}
			}
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
		existing,
		similar,
		queued,
		failed,
		dryRun: options.dryRun === true,
		outcomes,
		state: { version: 1, notes: records },
	};
};
