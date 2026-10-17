/**
 * Read-only community briefing summary.
 *
 * The queue is read through one bounded read-only snapshot, so a busy writer
 * makes this tile `busy` within the timeout instead of blocking for 10 s.
 * Briefing contents, error messages and provider identifiers are never returned.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { REQUIRED_QUEUE_COLUMNS, resolveCommunityBriefingConfig } from "../jarvis/community-briefing/status.ts";
import { assertDelegatedFileBounded } from "./files.ts";
import type { CommunityConfigData, CommunityQueueData } from "./schemas.ts";
import { readSqliteSnapshot } from "./sqlite-snapshot.ts";
import {
	guardTile,
	okTile,
	type ReadModelOptions,
	ReadModelStateError,
	readClock,
	readTimeout,
	stateTile,
	type TileResult,
} from "./tile.ts";

export interface CommunityReadOptions extends ReadModelOptions {
	/** Defaults to `~/.jarvis/config.yaml`. */
	readonly configPath?: string;
	readonly stateRoot?: string;
	/** Recent briefings to return, newest week first (1–20, default 5). */
	readonly recentLimit?: number;
}

export interface CommunitySummary {
	readonly config: TileResult<CommunityConfigData>;
	readonly queue: TileResult<CommunityQueueData>;
}

const nullableText = (value: unknown): string | null => (value === null ? null : String(value));

/** Community briefing configuration and queue state. Reads only. */
export const readCommunitySummary = (options: CommunityReadOptions = {}): CommunitySummary => {
	const now = readClock(options);
	let databasePath: string | undefined;
	const config = guardTile(now, (): TileResult<CommunityConfigData> => {
		const configPath = resolve(options.configPath ?? join(homedir(), ".jarvis", "config.yaml"));
		// `resolveCommunityBriefingConfig` reads the whole file; refuse a FIFO or an oversize file first.
		assertDelegatedFileBounded(configPath);
		const resolved = resolveCommunityBriefingConfig({
			configPath,
			...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
		});
		if (!resolved.configPresent) return stateTile("missing", "config_missing", now);
		if (resolved.issues.length > 0) return stateTile("error", "config_invalid", now);
		databasePath = resolved.databasePath;
		return okTile(
			{
				configured:
					resolved.discordChannelConfigured && resolved.sourcePath !== null && resolved.draftPath !== null,
				reviewHost: resolved.reviewHost,
				reviewPort: resolved.reviewPort,
				discordChannelConfigured: resolved.discordChannelConfigured,
				sourceConfigured: resolved.sourcePath !== null,
				draftConfigured: resolved.draftPath !== null,
			},
			now,
		);
	});
	const path = databasePath;
	const queue = guardTile(now, (): TileResult<CommunityQueueData> => {
		if (path === undefined) return stateTile("missing", "config_unavailable", now);
		const limit = Math.max(1, Math.min(Math.trunc(options.recentLimit ?? 5), 20));
		const snapshot = readSqliteSnapshot(path, { timeoutMs: readTimeout(options) }, (database) => {
			const columns = new Set(
				database
					.prepare("SELECT name FROM pragma_table_info('community_briefings')")
					.all()
					.map((row) => String(row.name)),
			);
			if (!REQUIRED_QUEUE_COLUMNS.every((column) => columns.has(column)))
				throw new ReadModelStateError("unsupported", "schema_missing");
			const counts: Record<string, number> = {};
			let total = 0;
			for (const row of database
				.prepare("SELECT status, COUNT(*) AS count FROM community_briefings GROUP BY status")
				.all()) {
				counts[String(row.status)] = Number(row.count);
				total += Number(row.count);
			}
			const recent = database
				.prepare(
					`SELECT week_start, week_end, status, attempts, error_stage, updated_at
					 FROM community_briefings ORDER BY week_start DESC LIMIT ?`,
				)
				.all(limit)
				.map((row) => ({
					weekStart: String(row.week_start),
					weekEnd: String(row.week_end),
					status: String(row.status),
					attempts: Math.max(0, Number(row.attempts)),
					errorStage: nullableText(row.error_stage),
					updatedAt: String(row.updated_at),
				}));
			return { counts, total, recent };
		});
		return snapshot.state === "ok" ? okTile(snapshot.value, now) : stateTile(snapshot.state, snapshot.reason, now);
	});
	return { config, queue };
};
