/**
 * Read-only community briefing summary.
 *
 * The queue is read through one bounded read-only snapshot, so a busy writer
 * makes this tile `busy` within the timeout instead of blocking for 10 s.
 * Briefing contents, error messages and provider identifiers are never returned.
 */
import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import * as Result from "effect/Result";

import { REQUIRED_QUEUE_COLUMNS, resolveCommunityBriefingConfig } from "../jarvis/community-briefing/status.ts";
import {
	COMMUNITY_GENERATION_STATUS_FILE,
	readCommunityGenerationStatus,
} from "../jarvis/community-briefing/weekly-generation.ts";
import type { CommunityGenerationData } from "./app-schemas.ts";
import { assertDelegatedFileBounded } from "./files.ts";
import { JOB_SCHEDULE_TIMEZONE, nextCalendarRun } from "./job-schedules.ts";
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
	/** The home directory that holds `.jarvis` and that a leading `~` in a configured path expands to. */
	readonly homeRoot?: string;
	/** Defaults to `<homeRoot>/.jarvis/config.yaml`. */
	readonly configPath?: string;
	readonly stateRoot?: string;
	/** Recent briefings to return, newest week first (1–20, default 5). */
	readonly recentLimit?: number;
}

export interface CommunitySummary {
	readonly config: TileResult<CommunityConfigData>;
	readonly queue: TileResult<CommunityQueueData>;
	/** The review service's weekly draft generation record. */
	readonly generation: TileResult<CommunityGenerationData>;
}

const bounded = (value: string, max: number): string => value.slice(0, max);
const isoDay = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/u.test(value);

/**
 * The weekly generation record (`community-weekly-generation.json`), read without
 * following a link and refused unless it is owner-only. Codes and dates only.
 */
export const readCommunityGeneration = (stateRoot: string, now: Date): TileResult<CommunityGenerationData> => {
	const path = join(stateRoot, COMMUNITY_GENERATION_STATUS_FILE);
	// The status reader opens without O_NONBLOCK: a FIFO here would block the portal's event loop. Refuse it first.
	const entry = Result.try(() => lstatSync(path, { throwIfNoEntry: false }));
	if (Result.isFailure(entry)) return stateTile("error", "read_failed", now);
	// A symbolic link is left to the reader's O_NOFOLLOW, which refuses it.
	if (entry.success !== undefined && !entry.success.isFile() && !entry.success.isSymbolicLink())
		return stateTile("unsafe", "status_record_unsafe", now);
	const read = Result.try(() => readCommunityGenerationStatus(path));
	if (Result.isFailure(read)) {
		const message = read.failure instanceof Error ? read.failure.message : "";
		return message === "status_record_unsafe"
			? stateTile("unsafe", "status_record_unsafe", now)
			: stateTile("error", message === "status_record_invalid" ? "status_record_invalid" : "read_failed", now);
	}
	const record = read.success;
	if (record === undefined) return stateTile("missing", "generation_unrecorded", now);
	const schedule = record.schedule;
	const validSchedule =
		schedule.weekday >= 0 &&
		schedule.weekday <= 6 &&
		schedule.hour >= 0 &&
		schedule.hour <= 23 &&
		schedule.minute >= 0 &&
		schedule.minute <= 59;
	const weeks = Object.entries(record.weeks)
		.filter(([weekStart]) => isoDay(weekStart))
		.sort(([a], [b]) => b.localeCompare(a))
		.slice(0, 12)
		.map(([weekStart, week]) => ({
			weekStart,
			status: week.status,
			attempts: Math.max(0, week.attempts),
			lastAttemptAt: bounded(week.lastAttemptAt, 40),
			code: week.code === undefined ? null : bounded(week.code, 64),
			gaveUp: week.gaveUp === true,
			recovered: week.recovered === true,
		}));
	const failure = record.lastFailure;
	const fault = record.standingFault ?? null;
	return okTile(
		{
			schedule: validSchedule ? { ...schedule, timezone: bounded(schedule.timezone, 64) } : null,
			updatedAt: bounded(record.updatedAt, 40),
			nextRun:
				validSchedule && schedule.timezone === JOB_SCHEDULE_TIMEZONE
					? nextCalendarRun(now, schedule.hour, schedule.minute, schedule.weekday).toISOString()
					: null,
			lastFailure:
				failure === null || !isoDay(failure.weekStart)
					? null
					: {
							weekStart: failure.weekStart,
							at: bounded(failure.at, 40),
							code: bounded(failure.code, 64),
							attempts: Math.max(0, failure.attempts),
						},
			standingFault: fault === null ? null : { code: bounded(fault.code, 64), since: bounded(fault.since, 40) },
			weeks,
		},
		now,
	);
};

const nullableText = (value: unknown): string | null => (value === null ? null : String(value));

/** Community briefing configuration and queue state. Reads only. */
export const readCommunitySummary = (options: CommunityReadOptions = {}): CommunitySummary => {
	const now = readClock(options);
	let databasePath: string | undefined;
	let stateRoot: string | undefined;
	const config = guardTile(now, (): TileResult<CommunityConfigData> => {
		const homeRoot = resolve(options.homeRoot ?? homedir());
		const configPath = resolve(options.configPath ?? join(homeRoot, ".jarvis", "config.yaml"));
		// `resolveCommunityBriefingConfig` reads the whole file; refuse a FIFO or an oversize file first.
		assertDelegatedFileBounded(configPath);
		const resolved = resolveCommunityBriefingConfig({
			homeRoot,
			configPath,
			...(options.stateRoot === undefined ? {} : { stateRoot: options.stateRoot }),
		});
		if (!resolved.configPresent) return stateTile("missing", "config_missing", now);
		if (resolved.issues.length > 0) return stateTile("error", "config_invalid", now);
		databasePath = resolved.databasePath;
		stateRoot = resolved.stateRoot;
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
	const root = stateRoot;
	const generation = guardTile(now, () =>
		root === undefined
			? stateTile<CommunityGenerationData>("missing", "config_unavailable", now)
			: readCommunityGeneration(root, now),
	);
	return { config, queue, generation };
};

/**
 * The community review state directory (`community_briefing.state_path`), or `null`
 * when the configuration is missing, unsafe or invalid. Used to fill the opener command.
 */
export const readCommunityStateRoot = (
	options: { readonly homeRoot?: string; readonly configPath?: string } = {},
): string | null => {
	const homeRoot = resolve(options.homeRoot ?? homedir());
	const configPath = resolve(options.configPath ?? join(homeRoot, ".jarvis", "config.yaml"));
	const resolved = Result.try(() => {
		assertDelegatedFileBounded(configPath);
		return resolveCommunityBriefingConfig({ homeRoot, configPath });
	});
	return Result.isSuccess(resolved) && resolved.success.configPresent && resolved.success.issues.length === 0
		? resolved.success.stateRoot
		: null;
};
