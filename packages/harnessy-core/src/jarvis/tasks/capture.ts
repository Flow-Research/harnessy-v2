/**
 * Write captured follow-ups into the task store and queue them for the VPS.
 *
 * Capture runs inside scheduled jobs (the Fathom poll and the daily brief), so
 * it never blocks on the network: it applies each change to the local cache,
 * appends the same change to the offline queue when sync is configured, and
 * lets one `syncTasks` pass replay the queue. A failed sync leaves the queue
 * for the next pass or for `harnessy jarvis tasks sync`.
 */
import { existsSync } from "node:fs";

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { ingestPublishedBrief } from "./ingest.ts";
import { applyMeetingFollowupBatch, type MeetingFollowupNote, meetingFollowupBatch } from "./meeting-followups.ts";
import { TaskRefused, TasksState } from "./store.ts";
import {
	defaultQueuePath,
	enqueueMutation,
	readQueue,
	syncTasks,
	type TasksSyncConfig,
	type TasksTransport,
} from "./sync.ts";

export interface CaptureStoreOptions {
	readonly tasksFile: string;
	/** When set, each change is also queued for the VPS. */
	readonly syncConfig?: TasksSyncConfig;
	readonly queuePath?: string;
}

export interface MeetingCaptureResult {
	readonly notes: number;
	readonly created: number;
	readonly existing: number;
	readonly queued: number;
	/** Notes whose follow-ups were refused; the note itself stays imported. */
	readonly failed: number;
}

/** Add follow-ups for notes the poll has just written. Never scans other notes. */
export const captureMeetingFollowups = (
	notes: ReadonlyArray<MeetingFollowupNote>,
	options: CaptureStoreOptions,
): MeetingCaptureResult => {
	const state = new TasksState(options.tasksFile);
	const queuePath = options.queuePath ?? defaultQueuePath(options.tasksFile);
	let created = 0;
	let existing = 0;
	let queued = 0;
	let failed = 0;
	for (const note of notes) {
		const batch = meetingFollowupBatch(note);
		if (batch.items.length === 0) continue;
		const applied = Result.try(() => {
			const result = applyMeetingFollowupBatch(state, batch);
			// Queue only what this pass created; the VPS dedupes by id and fingerprint as well.
			if (options.syncConfig !== undefined && result.created > 0) {
				const createdIds = new Set(result.items.map((item) => item.id));
				enqueueMutation(
					queuePath,
					{
						op: "ingestMeeting",
						batch: { ...batch, items: batch.items.filter((item) => createdIds.has(item.id)) },
					},
					state,
				);
				queued += 1;
			}
			return result;
		});
		if (Result.isFailure(applied)) {
			failed += 1;
			continue;
		}
		created += applied.success.created;
		existing += applied.success.existing;
	}
	return { notes: notes.length, created, existing, queued, failed };
};

export interface BriefCaptureResult {
	readonly created: number;
	readonly matched: number;
	readonly followups: number;
	readonly queued: boolean;
}

/**
 * Ingest a published brief: its "Decisions and Actions for You" stay tasks and
 * its "Delegated or Waiting" items become follow-ups. The brief markdown and the
 * ids just allocated are queued so the VPS copy mints the same items.
 */
export const capturePublishedBrief = (
	homeRoot: string,
	briefPath: string,
	date: string,
	options: { readonly syncConfig?: TasksSyncConfig; readonly tasksFile?: string; readonly clock?: () => Date } = {},
): BriefCaptureResult | null => {
	const result = ingestPublishedBrief(homeRoot, briefPath, date, options.clock, options.tasksFile);
	if (result === null) return null;
	const followups = result.items.filter((item) => item.kind === "followup").length;
	if (options.syncConfig === undefined)
		return { created: result.created, matched: result.matched, followups, queued: false };
	const state = new TasksState(result.tasksFile);
	enqueueMutation(
		defaultQueuePath(result.tasksFile),
		{
			op: "ingest",
			markdown: result.markdown,
			date,
			path: result.path,
			displayRef: `brief ${date}`,
			allocations: result.items
				.filter((item) => item.fingerprint !== null)
				.map((item) => ({ id: item.id, fingerprint: item.fingerprint as string })),
		},
		state,
	);
	return { created: result.created, matched: result.matched, followups, queued: true };
};

export type TasksFlushResult =
	| { readonly state: "skipped"; readonly remaining: number }
	| { readonly state: "synced"; readonly replayed: number; readonly remaining: number }
	| { readonly state: "failed"; readonly code: string; readonly remaining: number };

/** Replay the offline queue once when it holds work. Errors are reported, never thrown. */
export const flushTasksQueue = async (
	options: CaptureStoreOptions & { readonly transport?: TasksTransport },
): Promise<TasksFlushResult> => {
	const queuePath = options.queuePath ?? defaultQueuePath(options.tasksFile);
	const pending = existsSync(queuePath) ? readQueue(queuePath).items.length : 0;
	if (options.syncConfig === undefined || pending === 0) return { state: "skipped", remaining: pending };
	const synced = await Effect.runPromise(
		Effect.tryPromise({
			try: () =>
				syncTasks({
					tasksFile: options.tasksFile,
					config: options.syncConfig!,
					queuePath,
					transport: options.transport,
				}),
			catch: (error) => error,
		}).pipe(Effect.result),
	);
	if (Result.isSuccess(synced))
		return { state: "synced", replayed: synced.success.replayed, remaining: synced.success.remaining };
	const code = synced.failure instanceof TaskRefused ? synced.failure.code : "sync_unreachable";
	return { state: "failed", code, remaining: readQueue(queuePath).items.length };
};
