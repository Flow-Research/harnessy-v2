import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { JarvisResolvedConfig } from "../config-model.ts";
import type { JarvisPaths } from "../paths.ts";
import {
	type CaptureStoreOptions,
	flushTasksQueue,
	type TasksFlushResult,
	type TasksTransport,
} from "../tasks/index.ts";
import { meetingCaptureStatePath, readMeetingCaptureState, updateMeetingCaptureState } from "./capture-state.ts";
import { FathomFileStore } from "./file-store.ts";
import { captureFathomFollowups, type FollowupCaptureOptions, type FollowupCaptureResult } from "./followup-capture.ts";
import type { MeetingExtractOptions } from "./followup-extract.ts";
import { type FathomNoteImportReceipt, importRecentFathomNotes } from "./import-notes.ts";
import { createFathomHttpProvider, type FathomIngestReceipt } from "./ingest.ts";
import { runFathomPoll } from "./poll.ts";
import { loadMeetingRouteRules, type MeetingRouteRules } from "./routes.ts";

export interface ConfiguredFathomPollOptions {
	readonly config: JarvisResolvedConfig;
	readonly paths: JarvisPaths;
	readonly inboxRoot: string;
	readonly stateRoot: string;
	readonly readApiKey: (config: JarvisResolvedConfig, paths: JarvisPaths, account: string) => Promise<string>;
	readonly accounts?: ReadonlyArray<string>;
	readonly limit?: number;
	readonly createdAfter?: string | null;
	readonly sourceRoot?: string | null;
	readonly fetch?: typeof globalThis.fetch;
	/**
	 * When set, follow-ups of new notes (and of recent notes whose Fathom data
	 * changed or whose last capture failed) go to this store.
	 */
	readonly followups?: CaptureStoreOptions &
		Pick<
			FollowupCaptureOptions,
			"dryRun" | "syncExtracted" | "localTasksFile" | "minConfidence" | "similarity" | "threshold" | "clock"
		> & {
			readonly transport?: TasksTransport;
			/** Capture and queue, but do not contact the VPS. */
			readonly noFlush?: boolean;
		};
	/** Days of existing notes to check again. Default `MEETING_RECAPTURE_DAYS`; 0 turns recapture off. */
	readonly recaptureDays?: number;
	readonly extract?: Omit<MeetingExtractOptions, "meetingDate">;
	readonly now?: Date;
}

/** Default recapture window: notes of meetings in the last 14 days. */
export const MEETING_RECAPTURE_DAYS = 14;

/**
 * The provider's `created_after` for one poll: 72 hours back, or the recapture
 * window when that is longer (at most 60 days), so a meeting that Fathom
 * changes after three days is listed again. Ingest pages through the window.
 */
export const fathomPollCreatedAfter = (now: Date, recaptureDays: number): string => {
	const days = Math.max(0, Math.min(60, Math.trunc(recaptureDays)));
	return new Date(now.getTime() - Math.max(72, days * 24) * 60 * 60 * 1000).toISOString();
};

export interface ConfiguredFathomPollReceipt {
	readonly accounts: ReadonlyArray<string>;
	readonly results: ReadonlyArray<FathomIngestReceipt>;
	readonly importedNotes: FathomNoteImportReceipt | null;
	readonly followups: Omit<FollowupCaptureResult, "records"> | null;
	readonly tasksSync: TasksFlushResult | null;
}

/**
 * Route rules for an inbox at `<private root>/meeting-inbox/fathom`. Undefined
 * for any other layout, so notes keep going to the configured source root.
 */
export const meetingRouteRulesForInbox = (
	inboxRoot: string,
	defaultProject: string | null,
): MeetingRouteRules | undefined => {
	const inbox = resolve(inboxRoot);
	if (basename(inbox) !== "fathom" || basename(dirname(inbox)) !== "meeting-inbox") return undefined;
	return loadMeetingRouteRules(dirname(dirname(inbox)), defaultProject ?? "flow");
};

/**
 * The `<project>/meetings` folders of the private root above an inbox at
 * `<private root>/meeting-inbox/fathom`, where earlier releases filed notes by
 * project. At most 200; none for any other layout.
 */
export const meetingNoteRootsForInbox = (inboxRoot: string): ReadonlyArray<string> => {
	const inbox = resolve(inboxRoot);
	if (basename(inbox) !== "fathom" || basename(dirname(inbox)) !== "meeting-inbox") return [];
	const privateRoot = dirname(dirname(inbox));
	if (!existsSync(privateRoot)) return [];
	return readdirSync(privateRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(entry.name))
		.map((entry) => join(privateRoot, entry.name, "meetings"))
		.filter((root) => existsSync(root))
		.sort()
		.slice(0, 200);
};

/** Compose configured credentials, the V2 file store, and one bounded poll pass. */
export const runConfiguredFathomPoll = async (
	options: ConfiguredFathomPollOptions,
): Promise<ConfiguredFathomPollReceipt> => {
	const accounts = options.accounts ?? options.config.fathom.pollAccounts;
	if (accounts === undefined || accounts.length === 0)
		throw new Error("Set fathom.poll_accounts or pass --account before polling.");
	if (accounts.some((account) => !Object.hasOwn(options.config.fathom.accounts, account.trim())))
		throw new Error("Selected Fathom account is not configured.");
	const result = await runFathomPoll({
		accounts,
		createIngestOptions: (account) => ({
			provider: createFathomHttpProvider({
				credentials: {
					account,
					readApiKey: () => options.readApiKey(options.config, options.paths, account),
				},
				fetch: options.fetch,
			}),
			store: new FathomFileStore({ inboxRoot: options.inboxRoot, stateRoot: options.stateRoot }),
			limit: options.limit,
			createdAfter: options.createdAfter,
		}),
	});
	const importedNotes: FathomNoteImportReceipt | null = options.sourceRoot
		? importRecentFathomNotes({
				inboxRoot: options.inboxRoot,
				sourceRoot: options.sourceRoot,
				accounts: result.accounts,
				project: options.config.meetingPublication.project,
				routing: meetingRouteRulesForInbox(options.inboxRoot, options.config.meetingPublication.project),
				recaptureDays: options.followups === undefined ? 0 : (options.recaptureDays ?? MEETING_RECAPTURE_DAYS),
				noteRoots: meetingNoteRootsForInbox(options.inboxRoot),
				extract: options.extract,
				now: options.now,
			})
		: null;
	let followups: Omit<FollowupCaptureResult, "records"> | null = null;
	if (options.followups !== undefined && importedNotes !== null) {
		const statePath = meetingCaptureStatePath(options.stateRoot);
		const { records, ...receipt } = captureFathomFollowups(
			[...importedNotes.notes, ...importedNotes.recent],
			readMeetingCaptureState(statePath),
			options.followups,
		);
		// Merge under a lock: another poll's records for other notes stay.
		if (!receipt.dryRun && receipt.captured > 0) updateMeetingCaptureState(statePath, records, options.now);
		followups = receipt;
	}
	const tasksSync =
		options.followups === undefined || options.followups.dryRun === true || options.followups.noFlush === true
			? null
			: await flushTasksQueue(options.followups);
	return { accounts: result.accounts, results: result.results, importedNotes, followups, tasksSync };
};
