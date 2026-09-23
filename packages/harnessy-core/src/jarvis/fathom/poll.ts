import { type FathomIngestOptions, type FathomIngestReceipt, ingestFathomPage } from "./ingest.ts";

/** Preserve the enabled V1 cadence when a host schedules this bounded job. */
export const FATHOM_POLL_INTERVAL_SECONDS = 5 * 60;

export interface FathomPollOptions {
	readonly accounts: ReadonlyArray<string>;
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
	const accounts = [...new Set(options.accounts.map((account) => account.trim()))];
	if (accounts.length === 0 || accounts.some((account) => !/^[A-Za-z0-9_-]+$/u.test(account)))
		throw new Error("Select valid Fathom accounts explicitly before polling.");
	const results: FathomIngestReceipt[] = [];
	for (const account of accounts) {
		results.push(await ingestFathomPage({ account, ...options.createIngestOptions(account) }));
	}
	return { intervalSeconds: FATHOM_POLL_INTERVAL_SECONDS, accounts, results };
};
