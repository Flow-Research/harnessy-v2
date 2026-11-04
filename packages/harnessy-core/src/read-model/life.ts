/**
 * Read-only Life Orchestrator summary.
 *
 * `inspectLifeStatus` opens the ledger through `LifeReadingLedger.open`, which
 * can create the state directory and database and run schema migrations. This
 * reader never calls it: it reads the ledger through a bounded read-only
 * snapshot and reads briefs, previews and weekly runs from the file system.
 */
import { existsSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";

import type { LifeOrchestratorSettings } from "../jarvis/life-orchestrator/config.ts";
import { canonicalLifeBriefPath, compatibilityScriptPath } from "../jarvis/life-orchestrator/history.ts";
import {
	LIFE_WEEKLY_OUTCOME_FILE,
	LIFE_WEEKLY_RECONCILIATION_FILE,
	LIFE_WEEKLY_RUN_FILE,
	listLifeWeeklyRuns,
} from "../jarvis/life-orchestrator/weekly-runs.ts";
import type { LifeBriefDatesData, LifeWeeklyDraftData } from "./app-schemas.ts";
import { assertDelegatedFileBounded, readBoundedDirectory, readBoundedFile } from "./files.ts";
import type {
	LifeBriefStatusData,
	LifeBriefTextData,
	LifePreviewData,
	LifeReadingCountsData,
	LifeSetupData,
	LifeWeeklyRunsData,
} from "./schemas.ts";
import { readSqliteSnapshot } from "./sqlite-snapshot.ts";
import {
	guardTile,
	MAX_TEXT_BYTES,
	okTile,
	type ReadModelOptions,
	ReadModelStateError,
	readClock,
	readTimeout,
	stateTile,
	type TileResult,
} from "./tile.ts";

/** The newest ledger schema this reader understands (`life-orchestrator/store.ts`). */
export const LIFE_LEDGER_SUPPORTED_SCHEMA = 2;
const PREVIEW_NAME = /^(\d{4}-\d{2}-\d{2})-[A-Za-z0-9]+\.md$/u;
const WEEKLY_RUN_NAME = /^weekly-\d{4}-W\d{2}-[a-f0-9]{64}$/u;
/** Review directory entries read at most. Past this the newest preview is not certain, so the tile degrades. */
export const MAX_REVIEW_SCAN = 5_000;
const MAX_WEEKLY_RUNS = 8;
const READING_STATUSES = ["available", "reserved", "delivered"] as const;

export interface LifeReadOptions extends ReadModelOptions {
	/** The newest weekly runs to return. */
	readonly weeklyRunLimit?: number;
}

export interface LifeSummary {
	readonly readings: TileResult<LifeReadingCountsData>;
	readonly brief: TileResult<LifeBriefStatusData>;
	readonly latestPreview: TileResult<LifePreviewData>;
	readonly weeklyRuns: TileResult<LifeWeeklyRunsData>;
	readonly setup: TileResult<LifeSetupData>;
}

const lagosDate = (date: Date): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Lagos",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);

const readReadingCounts = (
	settings: LifeOrchestratorSettings,
	options: LifeReadOptions,
	now: Date,
): TileResult<LifeReadingCountsData> =>
	guardTile(now, () => {
		const snapshot = readSqliteSnapshot(
			settings.paths.databasePath,
			{ timeoutMs: readTimeout(options) },
			(database) => {
				// `PRAGMA user_version` always returns one row.
				const schemaVersion = Number(database.prepare("PRAGMA user_version").get()!.user_version);
				if (schemaVersion === 0) throw new ReadModelStateError("missing", "ledger_uninitialized");
				if (schemaVersion > LIFE_LEDGER_SUPPORTED_SCHEMA)
					throw new ReadModelStateError("unsupported", "schema_newer");
				const counts = { available: 0, reserved: 0, delivered: 0 };
				for (const row of database
					.prepare("SELECT status, COUNT(*) AS count FROM reading_candidates GROUP BY status")
					.all()) {
					const status = String(row.status);
					if (!(READING_STATUSES as ReadonlyArray<string>).includes(status))
						throw new ReadModelStateError("unsupported", "schema_invalid");
					counts[status as keyof typeof counts] = Number(row.count);
				}
				return {
					schemaVersion,
					...counts,
					total: counts.available + counts.reserved + counts.delivered,
				};
			},
		);
		return snapshot.state === "ok" ? okTile(snapshot.value, now) : stateTile(snapshot.state, snapshot.reason, now);
	});

const readBriefStatus = (settings: LifeOrchestratorSettings, now: Date): TileResult<LifeBriefStatusData> =>
	guardTile(now, () => {
		const path = canonicalLifeBriefPath(settings.paths.lifeDirectory, now);
		const file = readBoundedFile(path, 0);
		return okTile(
			{
				date: lagosDate(now),
				relativePath: relative(settings.paths.lifeDirectory, path),
				journaled: existsSync(`${path}.journaled`),
				bytes: file.size,
				modifiedAt: file.modifiedAt.toISOString(),
			},
			now,
		);
	});

const readLatestPreview = (settings: LifeOrchestratorSettings, now: Date): TileResult<LifePreviewData> =>
	guardTile(now, () => {
		const listing = readBoundedDirectory(settings.paths.reviewDirectory, MAX_REVIEW_SCAN);
		// Directory order is not name order, so a partial scan could miss the newest preview.
		if (listing.truncated) return stateTile("unsupported", "scan_limit", now);
		let newest: { readonly name: string; readonly date: string } | undefined;
		for (const entry of listing.entries) {
			const match = PREVIEW_NAME.exec(entry.name);
			if (match === null || !entry.isFile()) continue;
			if (newest === undefined || entry.name > newest.name) newest = { name: entry.name, date: match[1]! };
		}
		if (newest === undefined) return stateTile("missing", "no_preview", now);
		const file = readBoundedFile(join(settings.paths.reviewDirectory, newest.name), 0);
		return okTile(
			{
				name: newest.name,
				date: newest.date,
				bytes: file.size,
				modifiedAt: file.modifiedAt.toISOString(),
			},
			now,
		);
	});

const readWeeklyRuns = (
	settings: LifeOrchestratorSettings,
	options: LifeReadOptions,
	now: Date,
): TileResult<LifeWeeklyRunsData> =>
	guardTile(now, () => {
		if (!existsSync(settings.paths.reviewDirectory)) return stateTile("missing", "directory_missing", now);
		// `listLifeWeeklyRuns` lists the whole directory and reads each run's JSON whole.
		// Bound the scan and refuse a FIFO or an oversize evidence file before delegating.
		const listing = readBoundedDirectory(settings.paths.reviewDirectory, MAX_REVIEW_SCAN);
		if (listing.truncated) return stateTile("unsupported", "scan_limit", now);
		for (const entry of listing.entries) {
			if (!entry.isDirectory() || !WEEKLY_RUN_NAME.test(entry.name)) continue;
			for (const name of [LIFE_WEEKLY_RUN_FILE, LIFE_WEEKLY_OUTCOME_FILE, LIFE_WEEKLY_RECONCILIATION_FILE])
				assertDelegatedFileBounded(join(settings.paths.reviewDirectory, entry.name, name), MAX_TEXT_BYTES);
		}
		const runs = listLifeWeeklyRuns(settings.paths.reviewDirectory);
		const counts: Record<string, number> = {};
		for (const run of runs) counts[run.state] = (counts[run.state] ?? 0) + 1;
		const limit = Math.max(1, Math.min(options.weeklyRunLimit ?? MAX_WEEKLY_RUNS, 52));
		return okTile(
			{
				runs: runs.slice(0, limit).map((run) => ({
					periodId: run.periodId,
					runHash: run.runHash,
					state: run.state,
					incompleteReconciliation: run.incompleteReconciliation,
				})),
				counts,
				total: runs.length,
			},
			now,
		);
	});

const readSetup = (settings: LifeOrchestratorSettings, now: Date): TileResult<LifeSetupData> =>
	guardTile(now, () =>
		okTile(
			{
				steeringReady: existsSync(settings.paths.steeringPath),
				compatibilityReady: ["daily-brief", "learning-research", "weekly-plan"].every((name) =>
					existsSync(compatibilityScriptPath(settings.paths.compatibilityScriptsDirectory, name)),
				),
			},
			now,
		),
	);

/** Today's Life state as tiles. Never opens the ledger for writing and never creates a file. */
export const readLifeSummary = (settings: LifeOrchestratorSettings, options: LifeReadOptions = {}): LifeSummary => {
	const now = readClock(options);
	return {
		readings: readReadingCounts(settings, options, now),
		brief: readBriefStatus(settings, now),
		latestPreview: readLatestPreview(settings, now),
		weeklyRuns: readWeeklyRuns(settings, options, now),
		setup: readSetup(settings, now),
	};
};

/** The text of the canonical daily brief for `date`, up to 64 KiB, to be rendered as plain text. */
export const readLifeBrief = (
	settings: LifeOrchestratorSettings,
	date: Date,
	options: ReadModelOptions = {},
): TileResult<LifeBriefTextData> => {
	const now = readClock(options);
	return guardTile(now, () => {
		const path = canonicalLifeBriefPath(settings.paths.lifeDirectory, date);
		const file = readBoundedFile(path, MAX_TEXT_BYTES);
		return okTile(
			{
				date: lagosDate(date),
				journaled: existsSync(`${path}.journaled`),
				text: new TextDecoder("utf-8", { fatal: false }).decode(file.bytes),
				truncated: file.truncated,
			},
			now,
		);
	});
};

/** How many recent days the brief date switcher offers, today included. */
export const LIFE_BRIEF_DAYS = 7;
const DAY_MS = 86_400_000;

/** The canonical briefs that exist among the last {@link LIFE_BRIEF_DAYS} days, newest first. */
export const readLifeBriefDates = (
	settings: LifeOrchestratorSettings,
	options: ReadModelOptions = {},
): TileResult<LifeBriefDatesData> => {
	const now = readClock(options);
	return guardTile(now, () => {
		const dates: Array<LifeBriefDatesData["dates"][number]> = [];
		for (let offset = 0; offset < LIFE_BRIEF_DAYS; offset += 1) {
			const date = new Date(now.getTime() - offset * DAY_MS);
			const path = canonicalLifeBriefPath(settings.paths.lifeDirectory, date);
			const stat = lstatSync(path, { throwIfNoEntry: false });
			if (stat === undefined || !stat.isFile()) continue;
			dates.push({ date: lagosDate(date), journaled: existsSync(`${path}.journaled`), bytes: stat.size });
		}
		return okTile({ dates }, now);
	});
};

const RUN_HASH = /^[a-f0-9]{64}$/u;

/**
 * The text of one weekly run's `draft.md`, up to 64 KiB, to be rendered as text.
 * The run is named by its 64-hex run hash; anything else is refused.
 */
export const readLifeWeeklyDraft = (
	settings: LifeOrchestratorSettings,
	runHash: string,
	options: ReadModelOptions = {},
): TileResult<LifeWeeklyDraftData> => {
	const now = readClock(options);
	return guardTile(now, () => {
		if (!RUN_HASH.test(runHash)) return stateTile("error", "run_invalid", now);
		const listing = readBoundedDirectory(settings.paths.reviewDirectory, MAX_REVIEW_SCAN);
		const entry = listing.entries.find(
			(candidate) =>
				candidate.isDirectory() && WEEKLY_RUN_NAME.test(candidate.name) && candidate.name.endsWith(`-${runHash}`),
		);
		if (entry === undefined)
			return stateTile(
				listing.truncated ? "unsupported" : "missing",
				listing.truncated ? "scan_limit" : "run_missing",
				now,
			);
		const file = readBoundedFile(join(settings.paths.reviewDirectory, entry.name, "draft.md"), MAX_TEXT_BYTES);
		return okTile(
			{
				periodId: /^weekly-(\d{4}-W\d{2})-/u.exec(entry.name)![1]!,
				runHash,
				text: new TextDecoder("utf-8", { fatal: false }).decode(file.bytes),
				truncated: file.truncated,
				bytes: file.size,
				modifiedAt: file.modifiedAt.toISOString(),
			},
			now,
		);
	});
};

/** Today's canonical brief path when it exists as a regular file, else `null`. */
export const lifeBriefPathIfPresent = (settings: LifeOrchestratorSettings, date: Date): string | null => {
	const path = canonicalLifeBriefPath(settings.paths.lifeDirectory, date);
	return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true ? path : null;
};
