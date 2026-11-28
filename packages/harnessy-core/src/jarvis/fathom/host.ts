import { basename, dirname, resolve } from "node:path";

import type { JarvisResolvedConfig } from "../config-model.ts";
import type { JarvisPaths } from "../paths.ts";
import {
	type CaptureStoreOptions,
	captureMeetingFollowups,
	flushTasksQueue,
	type MeetingCaptureResult,
	type TasksFlushResult,
	type TasksTransport,
} from "../tasks/index.ts";
import { FathomFileStore } from "./file-store.ts";
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
	/** When set, action items of newly imported notes become follow-ups in this store. */
	readonly followups?: CaptureStoreOptions & { readonly transport?: TasksTransport };
}

export interface ConfiguredFathomPollReceipt {
	readonly accounts: ReadonlyArray<string>;
	readonly results: ReadonlyArray<FathomIngestReceipt>;
	readonly importedNotes: FathomNoteImportReceipt | null;
	readonly followups: MeetingCaptureResult | null;
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
			})
		: null;
	const followups =
		options.followups === undefined || importedNotes === null
			? null
			: captureMeetingFollowups(importedNotes.notes, options.followups);
	const tasksSync = options.followups === undefined ? null : await flushTasksQueue(options.followups);
	return { accounts: result.accounts, results: result.results, importedNotes, followups, tasksSync };
};
