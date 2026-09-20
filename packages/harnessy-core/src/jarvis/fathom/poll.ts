import { type FathomIngestOptions, type FathomIngestReceipt, ingestFathomPage } from "./ingest.ts";

/** Preserve the enabled V1 cadence when a host schedules this bounded job. */
export const FATHOM_POLL_INTERVAL_SECONDS = 5 * 60;
/** Owner-approved V2 account scope; excluded configured accounts are never implicit targets. */
export const FATHOM_V2_POLL_ACCOUNTS = ["personal", "flowresearch"] as const;

export interface FathomPollOptions {
	readonly accounts?: ReadonlyArray<string>;
	readonly createIngestOptions: (account: string) => Omit<FathomIngestOptions, "account">;
}

export interface FathomPollReceipt {
	readonly intervalSeconds: number;
	readonly accounts: ReadonlyArray<string>;
	readonly results: ReadonlyArray<FathomIngestReceipt>;
}

/**
 * Run one bounded poll pass for the explicitly selected accounts.
 *
 * The host owns scheduling, credentials and policy. This function deliberately
 * does not retry, switch accounts, or continue after a thrown host failure.
 */
export const runFathomPoll = async (options: FathomPollOptions): Promise<FathomPollReceipt> => {
	const accounts = [
		...new Set((options.accounts ?? FATHOM_V2_POLL_ACCOUNTS).map((account) => account.trim()).filter(Boolean)),
	];
	const results: FathomIngestReceipt[] = [];
	for (const account of accounts) {
		results.push(await ingestFathomPage({ account, ...options.createIngestOptions(account) }));
	}
	return { intervalSeconds: FATHOM_POLL_INTERVAL_SECONDS, accounts, results };
};
