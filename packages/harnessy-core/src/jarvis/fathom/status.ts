import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Effect } from "effect";
import { parseDocument } from "yaml";

export interface FathomStatusOptions {
	readonly configPath?: string;
	readonly stateRoot?: string;
	readonly sourceRoot?: string;
}

export interface FathomStatus {
	readonly ready: boolean;
	readonly configPath: string;
	readonly statePath: string;
	readonly inboxPath: string;
	readonly defaultAccount: string | null;
	readonly accounts: ReadonlyArray<string>;
	readonly polling: {
		readonly configured: boolean;
		readonly accounts: ReadonlyArray<string>;
		readonly issues: ReadonlyArray<string>;
	};
	readonly pollStatePresent: boolean;
	readonly pollStateValid: boolean;
	readonly inboxCounts: Readonly<Record<string, Readonly<Record<string, number>>>>;
	readonly issues: ReadonlyArray<string>;
}

export interface FathomInboxItem {
	readonly account: string;
	readonly bucket: "pending" | "processed" | "invalid";
	readonly filename: string;
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface FathomImportCandidate extends FathomInboxItem {
	readonly verified: boolean;
	readonly recordingId: string | null;
	readonly title: string | null;
	readonly scheduledStart: string | null;
	readonly eligible: boolean;
	readonly reason: string | null;
}

const recordValue = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const expand = (value: string, base: string): string => {
	const expanded = value.replace(/^~(?=\/|$)/, homedir());
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
};

const emptyCounts = (): Record<string, number> => ({ pending: 0, processed: 0, invalid: 0 });

const countInbox = (root: string): Readonly<Record<string, Readonly<Record<string, number>>>> => {
	if (!existsSync(root)) return {};
	const result: Record<string, Readonly<Record<string, number>>> = {};
	for (const account of readdirSync(root, { withFileTypes: true })) {
		if (!account.isDirectory()) continue;
		const counts = emptyCounts();
		for (const state of Object.keys(counts)) {
			const path = join(root, account.name, state);
			if (existsSync(path))
				counts[state] = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
		}
		result[account.name] = counts;
	}
	return result;
};

/** Inspect configured Fathom accounts and local inbox state without provider calls or mutation. */
export const inspectFathomStatus = (options: FathomStatusOptions = {}): FathomStatus => {
	const configPath = resolve(options.configPath ?? join(homedir(), ".jarvis", "config.yaml"));
	const base = dirname(configPath);
	const issues: Array<string> = [];
	let config: Record<string, unknown> = {};
	if (!existsSync(configPath)) issues.push(`configuration is missing: ${configPath}`);
	else {
		const parsed = Effect.runSync(
			Effect.try({
				try: () => parseDocument(readFileSync(configPath, "utf8")),
				catch: () => null,
			}),
		);
		if (parsed === null || parsed.errors.length > 0) issues.push("configuration has invalid YAML");
		else config = recordValue(parsed.toJS()) ?? {};
	}
	const fathom = recordValue(config.fathom) ?? {};
	const accountsRecord = recordValue(fathom.accounts) ?? {};
	const accounts = Object.keys(accountsRecord).sort();
	const pollIssues: string[] = [];
	const selection = fathom.poll_accounts;
	const pollAccounts: string[] = [];
	if (!Array.isArray(selection) || selection.length === 0) {
		pollIssues.push("Set fathom.poll_accounts or pass --account before polling.");
	} else {
		for (const value of selection) {
			if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value.trim())) {
				pollIssues.push("Polling account labels must contain only letters, numbers, underscores or hyphens.");
				continue;
			}
			const account = value.trim();
			if (!Object.hasOwn(accountsRecord, account)) pollIssues.push("Selected Fathom account is not configured.");
			if (!pollAccounts.includes(account)) pollAccounts.push(account);
		}
	}
	const defaultAccount = stringValue(fathom.default_account);
	const configuredSource = options.sourceRoot ?? stringValue(recordValue(config.community_briefing)?.source_path);
	const inboxPath =
		configuredSource === null
			? join(base, "context", "private", "meeting-inbox", "fathom")
			: join(expand(configuredSource, base), "meeting-inbox", "fathom");
	const stateRoot =
		options.stateRoot === undefined ? join(homedir(), ".jarvis", "state", "fathom") : expand(options.stateRoot, base);
	const pollStatePath = join(stateRoot, "poll-state.json");
	const pollStatePresent = existsSync(pollStatePath);
	const pollStateValid =
		!pollStatePresent ||
		Effect.runSync(
			Effect.try({
				try: () => recordValue(JSON.parse(readFileSync(pollStatePath, "utf8"))) !== null,
				catch: () => false,
			}),
		);
	if (accounts.length === 0) issues.push("no Fathom accounts configured");
	if (defaultAccount !== null && !accounts.includes(defaultAccount))
		issues.push("default Fathom account is not configured");
	if (!pollStateValid) issues.push("Fathom poll state is invalid JSON");
	return {
		ready: issues.length === 0,
		configPath,
		statePath: stateRoot,
		inboxPath,
		defaultAccount,
		accounts,
		polling: { configured: pollIssues.length === 0, accounts: pollAccounts, issues: pollIssues },
		pollStatePresent,
		pollStateValid,
		inboxCounts: countInbox(inboxPath),
		issues,
	};
};

/** List bounded local Fathom inbox metadata for import review without provider calls or mutation. */
export const listFathomInbox = (
	options: FathomStatusOptions & { readonly limit?: number } = {},
): ReadonlyArray<FathomInboxItem> => {
	const status = inspectFathomStatus(options);
	if (status.issues.length > 0 || !existsSync(status.inboxPath)) return [];
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500);
	const entries: FathomInboxItem[] = [];
	for (const account of readdirSync(status.inboxPath, { withFileTypes: true })) {
		if (!account.isDirectory()) continue;
		for (const bucket of ["pending", "processed", "invalid"] as const) {
			const bucketPath = join(status.inboxPath, account.name, bucket);
			if (!existsSync(bucketPath)) continue;
			for (const file of readdirSync(bucketPath, { withFileTypes: true })) {
				if (!file.isFile() || !file.name.endsWith(".json")) continue;
				const path = join(bucketPath, file.name);
				const bytes = readFileSync(path);
				entries.push({
					account: account.name,
					bucket,
					filename: file.name,
					path,
					bytes: statSync(path).size,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				});
				if (entries.length >= limit) return entries;
			}
		}
	}
	return entries;
};

/** Build a no-write import plan from local webhook envelopes. */
export const planFathomImport = (
	options: FathomStatusOptions & { readonly limit?: number } = {},
): ReadonlyArray<FathomImportCandidate> =>
	listFathomInbox(options).map((entry) => {
		const parsed = Effect.runSync(
			Effect.try({
				try: () => recordValue(JSON.parse(readFileSync(entry.path, "utf8"))),
				catch: () => null,
			}),
		);
		const payload = recordValue(parsed?.payload);
		const verified = parsed?.verified === true;
		const recordingId = payload?.recording_id === undefined ? null : String(payload.recording_id);
		const title = stringValue(payload?.meeting_title) ?? stringValue(payload?.title);
		const scheduledStart = stringValue(payload?.scheduled_start_time);
		const eligible = entry.bucket === "pending" && verified && recordingId !== null && title !== null;
		return {
			...entry,
			verified,
			recordingId,
			title,
			scheduledStart,
			eligible,
			reason: eligible
				? null
				: entry.bucket !== "pending"
					? "envelope is not pending"
					: "unverified or missing recording ID/title",
		};
	});
