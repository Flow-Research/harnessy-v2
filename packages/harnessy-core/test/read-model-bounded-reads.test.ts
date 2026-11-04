import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { assertDelegatedFileBounded, MAX_DELEGATED_FILE_BYTES } from "../src/read-model/files.ts";
import { ReadModelStateError } from "../src/read-model/tile.ts";
import { PortalSchemas, readCommunitySummary, readFathomSummary, readLifeSummary } from "../src/read-model.ts";
import { cleanupReadModelFixtures, tempHome } from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T12:00:00.000Z");
const RUN = `weekly-2026-W42-${"a".repeat(64)}`;

/**
 * A FIFO with no writer blocks `readFileSync` forever. These tests use a real FIFO, so
 * before the bounds were added they hung until the test timeout instead of failing fast.
 */
const makeFifo = (path: string) => {
	mkdirSync(dirname(path), { recursive: true });
	const made = spawnSync("/usr/bin/mkfifo", [path], { encoding: "utf8" });
	expect(made.status, made.stderr).toBe(0);
};

const oversize = (path: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `# ${"x".repeat(MAX_DELEGATED_FILE_BYTES)}\n`);
};

const lifeSettings = (home: string) => {
	const stateDirectory = join(home, "life-state");
	return {
		paths: {
			projectRoot: home,
			contextRoot: join(home, "context"),
			homeRoot: home,
			lifeDirectory: join(home, "life"),
			stateDirectory,
			databasePath: join(stateDirectory, "life-orchestrator.sqlite3"),
			reviewDirectory: join(stateDirectory, "reviews"),
			researchStatusDirectory: join(stateDirectory, "research"),
			rawArticlesDirectory: join(home, "raw"),
			steeringPath: join(home, "steering.md"),
			compatibilityScriptsDirectory: join(home, "scripts"),
		},
		lookbackDays: 21,
		targetReadings: 2,
		maximumReadings: 3,
		sources: [],
		curricula: [],
	};
};

const unix = process.platform !== "win32";

describe("bounded reads before delegating to whole-file readers", () => {
	it("passes absent files and linked regular files, and refuses special or oversize files", () => {
		const home = tempHome("bounded-helper");
		expect(() => assertDelegatedFileBounded(join(home, "absent"))).not.toThrow();
		writeFileSync(join(home, "real.yaml"), "a: 1\n");
		symlinkSync(join(home, "real.yaml"), join(home, "linked.yaml"));
		expect(() => assertDelegatedFileBounded(join(home, "linked.yaml"))).not.toThrow();
		expect(() => assertDelegatedFileBounded(home)).toThrow(new ReadModelStateError("unsafe", "file_not_regular"));
		expect(() => assertDelegatedFileBounded(join(home, "real.yaml"), 2)).toThrow(
			new ReadModelStateError("unsafe", "file_oversize"),
		);
	});

	it.skipIf(!unix)("refuses a FIFO or oversize community configuration", () => {
		const home = tempHome("bounded-community");
		const fifo = join(home, "fifo.yaml");
		makeFifo(fifo);
		const blocked = readCommunitySummary({ configPath: fifo, now: NOW });
		expect(blocked).toMatchObject({
			config: { state: "unsafe", reason: "file_not_regular" },
			queue: { state: "missing", reason: "config_unavailable" },
		});
		expect(Value.Check(PortalSchemas.CommunitySummary, blocked)).toBe(true);
		const large = join(home, "large.yaml");
		oversize(large);
		expect(readCommunitySummary({ configPath: large, now: NOW }).config).toMatchObject({
			state: "unsafe",
			reason: "file_oversize",
		});
	});

	it.skipIf(!unix)("refuses a FIFO or oversize Fathom configuration or V1 poll state", () => {
		const home = tempHome("bounded-fathom");
		const configPath = join(home, ".jarvis", "config.yaml");
		makeFifo(configPath);
		expect(readFathomSummary({ homeRoot: home, now: NOW })).toMatchObject({
			config: { state: "unsafe", reason: "file_not_regular" },
			inbox: { state: "missing", reason: "config_unavailable" },
			checkpoint: { state: "missing", reason: "config_unavailable" },
		});

		const other = tempHome("bounded-fathom-large");
		oversize(join(other, ".jarvis", "config.yaml"));
		expect(readFathomSummary({ homeRoot: other, now: NOW }).config).toMatchObject({
			state: "unsafe",
			reason: "file_oversize",
		});

		const legacy = tempHome("bounded-fathom-poll");
		mkdirSync(join(legacy, ".jarvis"));
		writeFileSync(join(legacy, ".jarvis", "config.yaml"), "fathom:\n  accounts:\n    personal: {}\n");
		makeFifo(join(legacy, ".harnessy", "jarvis", "state", "fathom", "poll-state.json"));
		expect(readFathomSummary({ homeRoot: legacy, now: NOW }).config).toMatchObject({
			state: "unsafe",
			reason: "file_not_regular",
		});
	});

	it.skipIf(!unix)("refuses a FIFO or oversize weekly-run evidence file", () => {
		const home = tempHome("bounded-life");
		const settings = lifeSettings(home);
		const runDirectory = join(settings.paths.reviewDirectory, RUN);
		makeFifo(join(runDirectory, "run.json"));
		const blocked = readLifeSummary(settings, { now: NOW });
		expect(blocked.weeklyRuns).toMatchObject({ state: "unsafe", reason: "file_not_regular" });
		expect(Value.Check(PortalSchemas.LifeSummary, blocked)).toBe(true);

		const other = tempHome("bounded-life-large");
		const otherSettings = lifeSettings(other);
		const otherRun = join(otherSettings.paths.reviewDirectory, RUN);
		mkdirSync(otherRun, { recursive: true });
		writeFileSync(join(otherRun, "outcome.json"), JSON.stringify({ status: "failed", pad: "x".repeat(70 * 1024) }));
		expect(readLifeSummary(otherSettings, { now: NOW }).weeklyRuns).toMatchObject({
			state: "unsafe",
			reason: "file_oversize",
		});
		writeFileSync(join(otherRun, "outcome.json"), JSON.stringify({ status: "failed" }));
		expect(readLifeSummary(otherSettings, { now: NOW }).weeklyRuns).toMatchObject({
			state: "ok",
			data: { total: 1, counts: { failed: 1 } },
		});
	});
});
