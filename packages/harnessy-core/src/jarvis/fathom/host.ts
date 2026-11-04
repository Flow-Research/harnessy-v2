import type { JarvisResolvedConfig } from "../config-model.ts";
import type { JarvisPaths } from "../paths.ts";
import { FathomFileStore } from "./file-store.ts";
import { type FathomNoteImportReceipt, importRecentFathomNotes } from "./import-notes.ts";
import { createFathomHttpProvider, type FathomIngestReceipt } from "./ingest.ts";
import { runFathomPoll } from "./poll.ts";

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
}

export interface ConfiguredFathomPollReceipt {
	readonly accounts: ReadonlyArray<string>;
	readonly results: ReadonlyArray<FathomIngestReceipt>;
	readonly importedNotes: FathomNoteImportReceipt | null;
}

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
			})
		: null;
	return { accounts: result.accounts, results: result.results, importedNotes };
};
