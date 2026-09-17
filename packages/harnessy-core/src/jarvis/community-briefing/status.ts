import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { parseDocument } from "yaml";

export type CommunityBriefingStatusCounts = Readonly<Record<string, number>>;

export interface CommunityBriefingStatus {
	readonly ready: boolean;
	readonly configPath: string;
	readonly stateRoot: string;
	readonly databasePath: string;
	readonly sourcePath: string | null;
	readonly draftPath: string | null;
	readonly reviewHost: string | null;
	readonly reviewPort: number | null;
	readonly discordChannelConfigured: boolean;
	readonly counts: CommunityBriefingStatusCounts;
	readonly issues: ReadonlyArray<string>;
}

export interface CommunityBriefingStatusOptions {
	readonly configPath?: string;
	readonly stateRoot?: string;
}

export interface CommunityBriefingPreflight {
	readonly ready: boolean;
	readonly checks: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly detail: string }>;
	readonly status: CommunityBriefingStatus;
}

export interface CommunityBriefingQueueItem {
	readonly briefingId: string;
	readonly weekStart: string;
	readonly weekEnd: string;
	readonly status: string;
	readonly briefingPath: string;
	readonly discordPath: string;
	readonly provenancePath: string;
	readonly draftHash: string;
	readonly approvedHash: string | null;
	readonly provider: string | null;
	readonly errorStage: string | null;
	readonly errorMessage: string | null;
	readonly attempts: number;
	readonly updatedAt: string;
}

const expand = (value: string, base: string): string => {
	const expanded = value.replace(/^~(?=\/|$)/, homedir());
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
};

const stringValue = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const recordValue = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const integerValue = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

const emptyCounts = (): Record<string, number> => ({
	pending_review: 0,
	approved: 0,
	publishing: 0,
	published: 0,
	rejected: 0,
	blocked: 0,
	archived: 0,
});

/** Inspect the preserved briefing queue without creating state or contacting providers. */
export const inspectCommunityBriefingStatus = (
	options: CommunityBriefingStatusOptions = {},
): CommunityBriefingStatus => {
	const configPath = resolve(options.configPath ?? join(homedir(), ".jarvis", "config.yaml"));
	const base = dirname(configPath);
	const issues: Array<string> = [];
	let config: Record<string, unknown> = {};
	if (!existsSync(configPath)) {
		issues.push(`configuration is missing: ${configPath}`);
	} else {
		const result = Effect.runSync(
			Effect.try({
				try: () => {
					const document = parseDocument(readFileSync(configPath, "utf8"));
					if (document.errors.length > 0) issues.push("configuration has invalid YAML");
					else config = recordValue(document.toJS()) ?? {};
					return true;
				},
				catch: () => false,
			}),
		);
		if (!result) {
			issues.push("configuration could not be read");
		}
	}

	const briefing = recordValue(config.community_briefing) ?? {};
	const configuredStateRoot = stringValue(options.stateRoot) ?? stringValue(briefing.state_path);
	const stateRoot =
		configuredStateRoot === null ? join(base, "state", "meeting-publication") : expand(configuredStateRoot, base);
	const databasePath = join(stateRoot, "weekly-briefings.sqlite3");
	const sourcePath = stringValue(briefing.source_path);
	const draftPath = stringValue(briefing.draft_path);
	const reviewHost = stringValue(briefing.review_host);
	const reviewPort = integerValue(briefing.review_port);
	const discordChannelConfigured = stringValue(briefing.discord_channel_id) !== null;
	const counts = emptyCounts();

	if (!existsSync(databasePath)) {
		issues.push(`briefing database is missing: ${databasePath}`);
	} else {
		const result = Effect.runSync(
			Effect.try({
				try: () => {
					const database = new DatabaseSync(databasePath, {
						readOnly: true,
						allowExtension: false,
						timeout: 10_000,
					});
					const table = database
						.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'community_briefings'")
						.get() as { name?: unknown } | undefined;
					if (table?.name !== "community_briefings") {
						issues.push("briefing database schema is missing community_briefings");
					} else {
						for (const row of database
							.prepare("SELECT status, COUNT(*) AS count FROM community_briefings GROUP BY status")
							.all() as Array<{ status?: unknown; count?: unknown }>) {
							if (typeof row.status === "string" && typeof row.count === "number" && row.count >= 0)
								counts[row.status] = row.count;
						}
					}
					database.close();
					return true;
				},
				catch: () => false,
			}),
		);
		if (!result) {
			issues.push("briefing database could not be inspected read-only");
		}
	}

	return {
		ready: issues.length === 0 && discordChannelConfigured && sourcePath !== null && draftPath !== null,
		configPath,
		stateRoot,
		databasePath,
		sourcePath: sourcePath === null ? null : expand(sourcePath, base),
		draftPath: draftPath === null ? null : expand(draftPath, base),
		reviewHost,
		reviewPort,
		discordChannelConfigured,
		counts,
		issues,
	};
};

/** Validate the local briefing boundary without providers, writes, or scheduling. */
export const preflightCommunityBriefingOffline = (
	options: CommunityBriefingStatusOptions = {},
): CommunityBriefingPreflight => {
	const status = inspectCommunityBriefingStatus(options);
	const checks = [
		{
			name: "configuration",
			ok: status.issues.every((issue) => !issue.startsWith("configuration")),
			detail: status.configPath,
		},
		{
			name: "source",
			ok: status.sourcePath !== null && existsSync(status.sourcePath),
			detail: status.sourcePath ?? "not configured",
		},
		{
			name: "drafts",
			ok: status.draftPath !== null && existsSync(status.draftPath),
			detail: status.draftPath ?? "not configured",
		},
		{
			name: "queue",
			ok: !status.issues.some((issue) => issue.startsWith("briefing database")),
			detail: status.databasePath,
		},
		{
			name: "delivery configuration",
			ok: status.discordChannelConfigured,
			detail: status.discordChannelConfigured ? "Discord channel configured" : "Discord channel missing",
		},
		{
			name: "provider calls",
			ok: true,
			detail: "not performed",
		},
	];
	return { ready: checks.every((check) => check.ok), checks, status };
};

/** List queue entries for local review without reading briefing contents or mutating state. */
export const listCommunityBriefings = (
	options: CommunityBriefingStatusOptions & { readonly limit?: number } = {},
): ReadonlyArray<CommunityBriefingQueueItem> => {
	const status = inspectCommunityBriefingStatus(options);
	if (status.issues.length > 0) return [];
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
	const database = new DatabaseSync(status.databasePath, {
		readOnly: true,
		allowExtension: false,
		timeout: 10_000,
	});
	try {
		return (
			database
				.prepare(
					`SELECT briefing_id, week_start, week_end, status, briefing_path,
				 discord_path, provenance_path, draft_hash, approved_hash, provider,
				 error_stage, error_message, attempts, updated_at
				 FROM community_briefings ORDER BY week_start DESC LIMIT ?`,
				)
				.all(limit) as Array<Record<string, unknown>>
		).map((row) => ({
			briefingId: String(row.briefing_id),
			weekStart: String(row.week_start),
			weekEnd: String(row.week_end),
			status: String(row.status),
			briefingPath: String(row.briefing_path),
			discordPath: String(row.discord_path),
			provenancePath: String(row.provenance_path),
			draftHash: String(row.draft_hash),
			approvedHash: row.approved_hash === null ? null : String(row.approved_hash),
			provider: row.provider === null ? null : String(row.provider),
			errorStage: row.error_stage === null ? null : String(row.error_stage),
			errorMessage: row.error_message === null ? null : String(row.error_message),
			attempts: Number(row.attempts),
			updatedAt: String(row.updated_at),
		}));
	} finally {
		database.close();
	}
};
