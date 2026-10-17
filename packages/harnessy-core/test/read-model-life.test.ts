import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import type { LifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { canonicalLifeBriefPath } from "../src/jarvis/life-orchestrator/history.ts";
import { inspectLifeStatus } from "../src/jarvis/life-orchestrator/service.ts";
import { LifeReadingLedger } from "../src/jarvis/life-orchestrator/store.ts";
import { MAX_REVIEW_SCAN, PortalSchemas, readLifeBrief, readLifeSummary } from "../src/read-model.ts";
import {
	cleanupReadModelFixtures,
	databaseFingerprint,
	killWriter,
	startSqliteWriter,
	tempHome,
	treeListing,
} from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T08:00:00.000Z");

const lifeSettings = (home: string): LifeOrchestratorSettings => {
	const stateDirectory = join(home, ".harnessy", "jarvis", "life");
	return {
		paths: {
			projectRoot: home,
			contextRoot: join(home, "context"),
			homeRoot: home,
			lifeDirectory: join(home, ".agents", "life"),
			stateDirectory,
			databasePath: join(stateDirectory, "life-orchestrator.sqlite3"),
			reviewDirectory: join(stateDirectory, "reviews"),
			researchStatusDirectory: join(stateDirectory, "research"),
			rawArticlesDirectory: join(home, "raw"),
			steeringPath: join(home, "context", "private", "owner", "learning-research.md"),
			compatibilityScriptsDirectory: join(home, "scripts"),
		},
		lookbackDays: 21,
		targetReadings: 2,
		maximumReadings: 3,
		sources: [],
		curricula: [],
	};
};

const reading = (index: number) => ({
	url: `https://example.test/reading-${index}`,
	title: `Reading ${index}`,
	topic: "Synthetic topic",
	publishedAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
	sourceName: "Synthetic feed",
	sourceKind: "rss" as const,
});

/** Build a real ledger with the writer code: 2 delivered, 1 reserved, 2 available. */
const populateLedger = (settings: LifeOrchestratorSettings) =>
	Effect.runPromise(
		Effect.acquireUseRelease(
			LifeReadingLedger.open(settings.paths.databasePath),
			(ledger) =>
				Effect.gen(function* () {
					yield* ledger.upsertCandidates([0, 1, 2, 3, 4].map(reading), NOW.toISOString());
					yield* ledger.reserve("run-delivered", NOW.toISOString(), 2);
					yield* ledger.markDelivered("run-delivered", "brief.md", NOW.toISOString());
					yield* ledger.reserve("run-open", NOW.toISOString(), 1);
				}),
			(ledger) => Effect.sync(() => ledger.close()),
		),
	);

const weeklyRun = (settings: LifeOrchestratorSettings, periodId: string, files: Record<string, string>) => {
	const directory = join(
		settings.paths.reviewDirectory,
		`weekly-${periodId}-${createHash("sha256").update(periodId).digest("hex")}`,
	);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "run.json"), JSON.stringify({ runId: `weekly:${periodId}`, grantId: "g", pid: 1 }));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
};

const populateFiles = (settings: LifeOrchestratorSettings) => {
	const brief = canonicalLifeBriefPath(settings.paths.lifeDirectory, NOW);
	mkdirSync(dirname(brief), { recursive: true });
	writeFileSync(brief, "# Daily brief\n\n<script>alert(1)</script>\n");
	writeFileSync(`${brief}.journaled`, "");
	mkdirSync(settings.paths.reviewDirectory, { recursive: true });
	writeFileSync(join(settings.paths.reviewDirectory, "2026-10-15-aaaa.md"), "older");
	writeFileSync(join(settings.paths.reviewDirectory, "2026-10-16-bbbb.md"), "newest preview");
	writeFileSync(join(settings.paths.reviewDirectory, "prompt-1234.md"), "not a preview");
	mkdirSync(join(settings.paths.reviewDirectory, "2026-10-17-dir.md"));
	weeklyRun(settings, "2026-W40", { "draft.md": "draft" });
	weeklyRun(settings, "2026-W41", { "outcome.json": JSON.stringify({ status: "failed" }) });
	weeklyRun(settings, "2026-W42", { "reconciliation.json": "{" });
	mkdirSync(dirname(settings.paths.steeringPath), { recursive: true });
	writeFileSync(settings.paths.steeringPath, "steering");
};

describe("Life read model", () => {
	it("documents that inspectLifeStatus writes, while readLifeSummary creates nothing", async () => {
		const writerHome = tempHome("life-inspect");
		const writerSettings = lifeSettings(writerHome);
		expect(existsSync(writerSettings.paths.databasePath)).toBe(false);
		await Effect.runPromise(inspectLifeStatus(writerSettings));
		// The existing status path creates the state directory and the ledger database.
		expect(existsSync(writerSettings.paths.databasePath)).toBe(true);

		const home = tempHome("life-empty");
		const settings = lifeSettings(home);
		const before = treeListing(home);
		const summary = readLifeSummary(settings, { now: NOW });
		expect(treeListing(home)).toEqual(before);
		expect(summary.readings).toEqual({ state: "missing", reason: "database_missing", readAt: NOW.toISOString() });
		expect(summary.brief.state).toBe("missing");
		expect(summary.latestPreview).toMatchObject({ state: "missing", reason: "directory_missing" });
		expect(summary.weeklyRuns).toMatchObject({ state: "missing", reason: "directory_missing" });
		expect(summary.setup).toMatchObject({ state: "ok", data: { steeringReady: false, compatibilityReady: false } });
		expect(Value.Check(PortalSchemas.LifeSummary, summary)).toBe(true);
	});

	it("summarizes a ledger built by the writer code, the brief, previews and weekly runs", async () => {
		const home = tempHome("life-full");
		const settings = lifeSettings(home);
		await populateLedger(settings);
		populateFiles(settings);
		mkdirSync(settings.paths.compatibilityScriptsDirectory);
		for (const name of ["daily-brief", "learning-research", "weekly-plan"])
			writeFileSync(join(settings.paths.compatibilityScriptsDirectory, name), "");
		const summary = readLifeSummary(settings, { now: NOW });
		expect(Value.Check(PortalSchemas.LifeSummary, summary)).toBe(true);
		expect(summary.readings).toMatchObject({
			state: "ok",
			data: { schemaVersion: 2, available: 2, reserved: 1, delivered: 2, total: 5 },
		});
		expect(summary.brief).toMatchObject({
			state: "ok",
			data: { date: "2026-10-17", relativePath: join("2026", "Oct", "17-daily-brief.md"), journaled: true },
		});
		expect(summary.latestPreview).toMatchObject({
			state: "ok",
			data: { name: "2026-10-16-bbbb.md", date: "2026-10-16", bytes: 14 },
		});
		expect(summary.weeklyRuns).toMatchObject({
			state: "ok",
			data: {
				total: 3,
				counts: { drafted: 1, failed: 1, unrecorded: 1 },
				runs: [
					{ periodId: "2026-W42", state: "unrecorded", incompleteReconciliation: true },
					{ periodId: "2026-W41", state: "failed", incompleteReconciliation: false },
					{ periodId: "2026-W40", state: "drafted", incompleteReconciliation: false },
				],
			},
		});
		expect(readLifeSummary(settings, { now: NOW, weeklyRunLimit: 1 }).weeklyRuns.data?.runs).toHaveLength(1);
		expect(summary.setup).toMatchObject({ state: "ok", data: { steeringReady: true, compatibilityReady: true } });
		expect(JSON.stringify(summary)).not.toContain(home);
	});

	it("leaves the ledger and every file unchanged over 50 reads", async () => {
		const home = tempHome("life-proof");
		const settings = lifeSettings(home);
		await populateLedger(settings);
		populateFiles(settings);
		const database = databaseFingerprint(settings.paths.databasePath);
		const tree = treeListing(home);
		for (let read = 0; read < 50; read += 1) {
			expect(readLifeSummary(settings, { now: NOW }).readings.state).toBe("ok");
			expect(readLifeBrief(settings, NOW, { now: NOW }).state).toBe("ok");
		}
		expect(databaseFingerprint(settings.paths.databasePath)).toEqual(database);
		expect(database.sidecars).toEqual([]);
		expect(treeListing(home)).toEqual(tree);
	});

	it("returns the brief as plain text, bounded to 64 KiB", () => {
		const home = tempHome("life-brief");
		const settings = lifeSettings(home);
		populateFiles(settings);
		const brief = readLifeBrief(settings, NOW, { now: NOW });
		expect(Value.Check(PortalSchemas.LifeBrief, brief)).toBe(true);
		expect(brief).toMatchObject({
			state: "ok",
			data: {
				date: "2026-10-17",
				journaled: true,
				truncated: false,
				text: "# Daily brief\n\n<script>alert(1)</script>\n",
			},
		});
		const large = new Date("2026-10-18T08:00:00.000Z");
		const largePath = canonicalLifeBriefPath(settings.paths.lifeDirectory, large);
		writeFileSync(largePath, "x".repeat(70_000));
		const truncated = readLifeBrief(settings, large);
		expect(truncated.data).toMatchObject({ journaled: false, truncated: true });
		expect(truncated.data?.text).toHaveLength(64 * 1024);
		expect(readLifeBrief(settings, new Date("2026-01-01T08:00:00.000Z"), { now: NOW })).toMatchObject({
			state: "missing",
			reason: "file_missing",
		});
		const linked = new Date("2026-10-19T08:00:00.000Z");
		symlinkSync(largePath, canonicalLifeBriefPath(settings.paths.lifeDirectory, linked));
		expect(readLifeBrief(settings, linked, { now: NOW })).toMatchObject({
			state: "unsafe",
			reason: "file_not_regular",
		});
	});

	it("reports an uninitialized, newer or unknown ledger schema without opening it for writing", () => {
		const home = tempHome("life-schema");
		const settings = lifeSettings(home);
		mkdirSync(settings.paths.stateDirectory, { recursive: true });
		const database = new DatabaseSync(settings.paths.databasePath);
		database.exec("PRAGMA journal_mode = DELETE; CREATE TABLE placeholder (value TEXT);");
		database.close();
		expect(readLifeSummary(settings, { now: NOW }).readings).toMatchObject({
			state: "missing",
			reason: "ledger_uninitialized",
		});
		const newer = new DatabaseSync(settings.paths.databasePath);
		newer.exec("PRAGMA user_version = 3;");
		newer.close();
		expect(readLifeSummary(settings, { now: NOW }).readings).toMatchObject({
			state: "unsupported",
			reason: "schema_newer",
		});
		const unknown = new DatabaseSync(settings.paths.databasePath);
		unknown.exec(
			"PRAGMA user_version = 2; CREATE TABLE reading_candidates (status TEXT); INSERT INTO reading_candidates VALUES ('lost');",
		);
		unknown.close();
		expect(readLifeSummary(settings, { now: NOW }).readings).toMatchObject({
			state: "unsupported",
			reason: "schema_invalid",
		});
	});

	it("degrades only the ledger tile while a real writer holds the lock or left a hot journal", async () => {
		const home = tempHome("life-busy");
		const settings = lifeSettings(home);
		await populateLedger(settings);
		populateFiles(settings);
		const writer = await startSqliteWriter(settings.paths.databasePath, "exclusive");
		const started = performance.now();
		const busy = readLifeSummary(settings, { now: NOW, timeoutMs: 100 });
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(busy.readings).toMatchObject({ state: "busy", reason: "database_busy" });
		expect(busy.brief.state).toBe("ok");
		await killWriter(writer, "SIGTERM");

		const crashed = await startSqliteWriter(settings.paths.databasePath, "hot-journal");
		await killWriter(crashed);
		const before = databaseFingerprint(settings.paths.databasePath);
		expect(before.sidecars).toEqual(["-journal"]);
		const recovering = readLifeSummary(settings, { now: NOW });
		expect(recovering.readings).toMatchObject({ state: "recovering", reason: "journal_present" });
		expect(Value.Check(PortalSchemas.LifeSummary, recovering)).toBe(true);
		expect(databaseFingerprint(settings.paths.databasePath)).toEqual(before);
	});

	it("reports a preview scan limit, an unreadable review directory and an unsafe brief path", () => {
		const home = tempHome("life-limits");
		const settings = lifeSettings(home);
		mkdirSync(settings.paths.reviewDirectory, { recursive: true });
		for (let index = 0; index < MAX_REVIEW_SCAN; index += 1)
			writeFileSync(join(settings.paths.reviewDirectory, `2026-01-01-${String(index).padStart(4, "0")}.md`), "");
		const atLimit = readLifeSummary(settings, { now: NOW });
		expect(atLimit.latestPreview).toMatchObject({ state: "ok", data: { name: "2026-01-01-4999.md" } });
		expect(atLimit.weeklyRuns).toMatchObject({ state: "ok", data: { total: 0, runs: [] } });
		// Past the limit the scan is partial, and directory order is not name order: the newest
		// preview is not certain, so both tiles degrade instead of reporting a possibly wrong answer.
		writeFileSync(join(settings.paths.reviewDirectory, "2026-10-16-zzzz.md"), "");
		const limited = readLifeSummary(settings, { now: NOW });
		expect(limited.latestPreview).toMatchObject({ state: "unsupported", reason: "scan_limit" });
		expect(limited.weeklyRuns).toMatchObject({ state: "unsupported", reason: "scan_limit" });
		expect(Value.Check(PortalSchemas.LifeSummary, limited)).toBe(true);

		const other = tempHome("life-unsafe");
		const otherSettings = lifeSettings(other);
		mkdirSync(join(other, ".harnessy", "jarvis", "life"), { recursive: true });
		writeFileSync(otherSettings.paths.reviewDirectory, "not a directory");
		const brief = canonicalLifeBriefPath(otherSettings.paths.lifeDirectory, NOW);
		mkdirSync(brief, { recursive: true });
		const summary = readLifeSummary(otherSettings, { now: NOW });
		expect(summary.latestPreview).toMatchObject({ state: "error", reason: "read_failed" });
		expect(summary.weeklyRuns).toMatchObject({ state: "error", reason: "read_failed" });
		expect(summary.brief).toMatchObject({ state: "unsafe", reason: "file_not_regular" });

		const linked = tempHome("life-linked-reviews");
		const linkedSettings = lifeSettings(linked);
		mkdirSync(join(linked, "elsewhere"));
		mkdirSync(linkedSettings.paths.stateDirectory, { recursive: true });
		symlinkSync(join(linked, "elsewhere"), linkedSettings.paths.reviewDirectory);
		expect(readLifeSummary(linkedSettings, { now: NOW }).latestPreview).toMatchObject({
			state: "unsafe",
			reason: "directory_symlink",
		});

		const empty = tempHome("life-no-preview");
		const emptySettings = lifeSettings(empty);
		mkdirSync(emptySettings.paths.reviewDirectory, { recursive: true });
		expect(readLifeSummary(emptySettings, { now: NOW }).latestPreview).toMatchObject({
			state: "missing",
			reason: "no_preview",
		});
	});
});
