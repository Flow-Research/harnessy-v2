import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { LifeDraftGrantHost, readLifeDraftGrantState } from "../src/jarvis/life-orchestrator/draft-grant-host.ts";
import {
	inspectLifeStatus,
	lifeWeeklyPeriodId,
	prepareLifeWeeklyPrompt,
	reconcileLifeWeekly,
	runLifeWeekly,
} from "../src/jarvis/life-orchestrator/service.ts";
import { listLifeWeeklyRuns, reserveLifeWeeklyRun } from "../src/jarvis/life-orchestrator/weekly-runs.ts";
import { CommandRunner, CommandRunResult, type ExternalCommand } from "../src/runtime/command-runner.ts";

// Scenario under test: the Sep 27 and Oct 4 2026 scheduled weekly drafts consumed their
// local grants, failed during generation, and left only an empty reserved directory and a
// one-line log. These tests use the real orchestrator, real files and the real grant SQLite.
const now = new Date("2030-12-29T12:00:00Z"); // Sunday prepares ISO 2031-W01.
const period = "2031-W01";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const roots: string[] = [];
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const commandResult = (command: ExternalCommand, status: "succeeded" | "failed" = "succeeded") =>
	new CommandRunResult({
		...command,
		args: [...command.args],
		command: "isolated fixture",
		status,
		stdout: "",
		stderr: status === "failed" ? "synthetic failure" : "",
		exitCode: status === "failed" ? 2 : 0,
	});

/** Real hygiene stand-in at the external command boundary: rewrites the raw draft file. */
const cleaningRunner = {
	run: (command: ExternalCommand) =>
		Effect.sync(() => {
			writeFileSync(command.args[2]!, "# Weekly plan\nClean draft\n");
			return commandResult(command);
		}),
};

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "life-weekly-reconcile-")));
	roots.push(root);
	const settings = resolveLifeOrchestratorSettings({
		projectRoot: root,
		homeRoot: root,
		compatibilityRoot: join(root, "absent"),
	});
	let requests = 0;
	const request = (label = `run-${++requests}`) => {
		const runId = `weekly:${period}:${label}`;
		const requestPath = join(root, `${label}.request.json`);
		writeFileSync(
			requestPath,
			JSON.stringify({
				runId,
				kind: "weekly",
				provider: "codex",
				model: "synthetic-model",
				prompt: `Week ${label}`,
			}),
			{ mode: 0o600 },
		);
		return { runId, requestPath, grantId: `local:${hash(runId)}` };
	};
	const provider = {
		generate: vi.fn(async () => ({
			markdown: "# Weekly plan\nRaw draft\n",
			provider: "codex",
			model: "synthetic-model",
			receiptId: "synthetic-receipt",
		})),
	};
	const run = (requestPath: string, runner: Parameters<typeof Effect.provideService>[2] = cleaningRunner) =>
		Effect.runPromise(
			runLifeWeekly(settings, {
				now,
				publish: false,
				nativePreview: { requestPath, local: { timeoutMs: 60_000, maximumOutputBytes: 4096 } },
				draftProvider: provider,
			}).pipe(Effect.provideService(CommandRunner, runner as typeof cleaningRunner)),
		);
	const grantRows = () => {
		const database = new DatabaseSync(join(settings.paths.stateDirectory, "draft-grants.sqlite3"), {
			readOnly: true,
		});
		try {
			return database.prepare("SELECT grant_id,consumed_at,revoked FROM life_draft_grants ORDER BY grant_id").all();
		} finally {
			database.close();
		}
	};
	const runDirectory = (runId: string) => join(settings.paths.reviewDirectory, `weekly-${period}-${hash(runId)}`);
	return { root, settings, request, provider, run, grantRows, runDirectory };
}

const runCli = (root: string, args: readonly string[]) =>
	spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			"--no-warnings",
			cli,
			"jarvis",
			"life",
			...args,
			"--target",
			root,
			"--home-root",
			root,
			"--compatibility-root",
			join(root, "absent"),
		],
		{ encoding: "utf8", env: { PATH: process.env.PATH, HOME: root }, timeout: 60_000 },
	);

describe("weekly consumed-grant reconciliation", () => {
	it("records an attributable failure and refuses a fresh grant for the same period before consumption", async () => {
		const f = fixture();
		const first = f.request();
		f.provider.generate.mockRejectedValueOnce(new Error("synthetic provider outage"));
		const failure = await f.run(first.requestPath).then(
			() => undefined,
			(error: unknown) => error as Error,
		);
		expect(failure?.message).toContain("Native weekly generation failed");
		expect(failure?.message).toContain(first.runId);
		expect(failure?.message).toContain(first.grantId);
		const outcomePath = join(f.runDirectory(first.runId), "outcome.json");
		expect(failure?.message).toContain(outcomePath);
		expect(statSync(outcomePath).mode & 0o777).toBe(0o600);
		const outcome = JSON.parse(readFileSync(outcomePath, "utf8"));
		expect(outcome).toMatchObject({
			status: "failed",
			runId: first.runId,
			periodId: period,
			grantId: first.grantId,
			phase: "generation",
			rawDraftPreserved: false,
			grant: { grantId: first.grantId, revoked: false },
		});
		expect(outcome.grant.consumedAt).toEqual(expect.any(String));
		expect(outcome.errors).toContain("synthetic provider outage");
		const run = JSON.parse(readFileSync(join(f.runDirectory(first.runId), "run.json"), "utf8"));
		expect(run).toMatchObject({ runId: first.runId, grantId: first.grantId, authority: "local", periodId: period });

		// A scheduled or manual rerun mints a new run ID and therefore a new local grant.
		const second = f.request();
		await expect(f.run(second.requestPath)).rejects.toThrow(`Weekly run reserved for ${period}`);
		await expect(f.run(second.requestPath)).rejects.toThrow("No new grant was consumed");
		expect(f.provider.generate).toHaveBeenCalledTimes(1);
		expect(f.grantRows().map((row) => row.grant_id)).toEqual([first.grantId]);
		expect(existsSync(f.runDirectory(second.runId))).toBe(false);
	});

	it("refuses a duplicate generation for a period that already has a reviewed draft", async () => {
		const f = fixture();
		const first = f.request();
		const drafted = await f.run(first.requestPath);
		expect(drafted?.briefPath).toBe(join(f.runDirectory(first.runId), "draft.md"));
		expect(existsSync(join(f.runDirectory(first.runId), "outcome.json"))).toBe(false);
		await expect(f.run(f.request().requestPath)).rejects.toThrow(/Weekly run reserved for 2031-W01: .* is drafted/);
		expect(f.provider.generate).toHaveBeenCalledTimes(1);
		expect(f.grantRows()).toHaveLength(1);
	});

	it("reconciles without touching the consumed grant or evidence, then allows exactly one new run", async () => {
		const f = fixture();
		const first = f.request();
		f.provider.generate.mockRejectedValueOnce(new Error("synthetic provider outage"));
		await expect(f.run(first.requestPath)).rejects.toThrow("consumed grant");
		const before = f.grantRows();
		const evidence = readFileSync(join(f.runDirectory(first.runId), "outcome.json"));

		const reconciled = await Effect.runPromise(
			reconcileLifeWeekly(f.settings, first.runId, "Provider outage; week replanned by hand.", now),
		);
		expect(reconciled).toMatchObject({
			decision: "abandoned",
			priorState: "failed",
			grantId: first.grantId,
			grant: { grantId: first.grantId, revoked: false, consumedAt: before[0]!.consumed_at },
		});
		const decision = JSON.parse(readFileSync(reconciled.path, "utf8"));
		expect(decision).toMatchObject({ decision: "abandoned", reason: "Provider outage; week replanned by hand." });
		expect(f.grantRows()).toEqual(before);
		expect(readFileSync(join(f.runDirectory(first.runId), "outcome.json"))).toEqual(evidence);
		await expect(Effect.runPromise(reconcileLifeWeekly(f.settings, first.runId, "again", now))).rejects.toThrow(
			"already reconciled",
		);

		const second = f.request();
		await expect(f.run(second.requestPath)).resolves.toMatchObject({ runId: second.runId });
		expect(f.provider.generate).toHaveBeenCalledTimes(2);
		expect(f.grantRows()).toEqual(
			[...before, { grant_id: second.grantId, consumed_at: expect.any(String), revoked: 0 }].sort((a, b) =>
				String(a.grant_id).localeCompare(String(b.grant_id)),
			),
		);
		await expect(f.run(f.request().requestPath)).rejects.toThrow("is drafted");
		expect(f.provider.generate).toHaveBeenCalledTimes(2);
		expect(
			listLifeWeeklyRuns(f.settings.paths.reviewDirectory)
				.map((run) => run.state)
				.sort(),
		).toEqual(["drafted", "reconciled"]);
	});

	it("reconciles a pre-record run by its directory hash and real local grant row", async () => {
		const f = fixture();
		const legacy = f.request("legacy");
		// Reproduce the live W40/W41 shape: consumed local grant plus an empty reserved directory.
		const host = new LifeDraftGrantHost(f.settings.paths.stateDirectory, "local-owner");
		try {
			const authority = {
				grantId: legacy.grantId,
				operation: "life.draft",
				runId: legacy.runId,
				kind: "weekly",
				provider: "codex",
				model: "synthetic-model",
				promptHash: hash("Week legacy"),
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				maximumOutputBytes: 4096,
			} as const;
			await host.bindLocal(authority).authorize(authority);
		} finally {
			host.close();
		}
		mkdirSync(f.runDirectory(legacy.runId), { recursive: true, mode: 0o700 });
		const status = await Effect.runPromise(inspectLifeStatus(f.settings));
		expect(status.weeklyRuns).toEqual([
			expect.objectContaining({ periodId: period, state: "unrecorded", runId: null, grantId: null }),
		]);
		await expect(f.run(f.request().requestPath)).rejects.toThrow("is unrecorded");
		const reconciled = await Effect.runPromise(
			reconcileLifeWeekly(f.settings, hash(legacy.runId), "Scheduled run failed; cause was not logged.", now),
		);
		expect(reconciled.grant).toMatchObject({ grantId: legacy.grantId, revoked: false });
		expect(reconciled.grant?.consumedAt).toEqual(expect.any(String));
		expect(readLifeDraftGrantState(f.settings.paths.stateDirectory, legacy.grantId)).toEqual(reconciled.grant);
		expect(f.provider.generate).not.toHaveBeenCalled();
	});

	it("records an interrupted run with its phase and preserved raw draft", async () => {
		const f = fixture();
		const first = f.request();
		let started!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const controller = new AbortController();
		const running = Effect.runPromise(
			runLifeWeekly(f.settings, {
				now,
				publish: false,
				nativePreview: { requestPath: first.requestPath, local: { timeoutMs: 60_000, maximumOutputBytes: 4096 } },
				draftProvider: f.provider,
			}).pipe(
				Effect.provideService(CommandRunner, {
					run: () => Effect.sync(() => started()).pipe(Effect.andThen(Effect.never)),
				}),
			),
			{ signal: controller.signal },
		);
		const rejected = expect(running).rejects.toThrow();
		await entered;
		controller.abort();
		await rejected;
		const outcome = JSON.parse(readFileSync(join(f.runDirectory(first.runId), "outcome.json"), "utf8"));
		expect(outcome).toMatchObject({
			status: "interrupted",
			phase: "text-hygiene",
			rawDraftPreserved: true,
			grant: { grantId: first.grantId },
		});
		await expect(f.run(f.request().requestPath)).rejects.toThrow("is interrupted");
	});

	it("records a hygiene failure after generation as failed with the raw draft preserved", async () => {
		const f = fixture();
		const first = f.request();
		await expect(
			f.run(first.requestPath, {
				run: (command: ExternalCommand) => Effect.succeed(commandResult(command, "failed")),
			}),
		).rejects.toThrow(/text hygiene.*failure recorded at/s);
		const outcome = JSON.parse(readFileSync(join(f.runDirectory(first.runId), "outcome.json"), "utf8"));
		expect(outcome).toMatchObject({ status: "failed", phase: "text-hygiene", rawDraftPreserved: true });
	});

	it("refuses prompt preparation for an unreconciled period before collecting state", async () => {
		const f = fixture();
		const first = f.request();
		f.provider.generate.mockRejectedValueOnce(new Error("synthetic provider outage"));
		await expect(f.run(first.requestPath)).rejects.toThrow();
		const before = readdirSync(f.settings.paths.reviewDirectory);
		await expect(
			Effect.runPromise(
				prepareLifeWeeklyPrompt(f.settings, "synthetic-model", now).pipe(
					Effect.provideService(CommandRunner, {
						run: () => {
							throw new Error("State collection must not start");
						},
					}),
				),
			),
		).rejects.toThrow(`Weekly run reserved for ${period}`);
		expect(readdirSync(f.settings.paths.reviewDirectory)).toEqual(before);
	});

	it("serializes reservation: a live lock owner is refused and a dead owner's lock is reclaimed", () => {
		const f = fixture();
		const reservation = (runId: string) => ({
			runId,
			periodId: period,
			grantId: `local:${hash(runId)}`,
			authority: "local" as const,
			requestPath: join(f.root, "request.json"),
			promptHash: hash("prompt"),
		});
		const lock = join(f.settings.paths.stateDirectory, `weekly-${period}.lock`);
		mkdirSync(f.settings.paths.stateDirectory, { recursive: true, mode: 0o700 });
		writeFileSync(lock, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
		expect(() =>
			reserveLifeWeeklyRun(
				f.settings.paths.stateDirectory,
				f.settings.paths.reviewDirectory,
				reservation("weekly:2031-W01:a"),
				now,
			),
		).toThrow(`another process (${process.pid})`);
		const exited = spawnSync(process.execPath, ["-e", ""]);
		expect(exited.status).toBe(0);
		writeFileSync(lock, JSON.stringify({ pid: exited.pid }), { mode: 0o600 });
		const directory = reserveLifeWeeklyRun(
			f.settings.paths.stateDirectory,
			f.settings.paths.reviewDirectory,
			reservation("weekly:2031-W01:a"),
			now,
		);
		expect(existsSync(lock)).toBe(false);
		expect(JSON.parse(readFileSync(join(directory, "run.json"), "utf8"))).toMatchObject({
			runId: "weekly:2031-W01:a",
			pid: process.pid,
			reservedAt: now.toISOString(),
		});
		// This process is the recorded owner and still running: reconciliation must wait.
		expect(() => Effect.runSync(reconcileLifeWeekly(f.settings, "weekly:2031-W01:a", "premature", now))).toThrow(
			"may still be active",
		);
	});

	it.each([
		["unknown run", "weekly:2031-W01:missing", "reason", "No reserved weekly run"],
		["path traversal", "../../etc", "reason", "No reserved weekly run"],
		["empty reason", "weekly:2031-W01:run-1", "  ", "reason of 1–1000 characters"],
	])("rejects reconciliation of %s without writing", async (_label, selector, reason, message) => {
		const f = fixture();
		const first = f.request();
		f.provider.generate.mockRejectedValueOnce(new Error("synthetic provider outage"));
		await expect(f.run(first.requestPath)).rejects.toThrow();
		await expect(Effect.runPromise(reconcileLifeWeekly(f.settings, selector, reason, now))).rejects.toThrow(message);
		expect(existsSync(join(f.runDirectory(first.runId), "reconciliation.json"))).toBe(false);
	});

	it("drives status, reconcile and the scheduled draft refusal through the real CLI process", async () => {
		const f = fixture();
		// The CLI uses the wall clock; block both sides of a possible period boundary.
		const periods = [
			...new Set([lifeWeeklyPeriodId(new Date()), lifeWeeklyPeriodId(new Date(Date.now() + 3_600_000))]),
		];
		for (const id of periods)
			mkdirSync(join(f.settings.paths.reviewDirectory, `weekly-${id}-${hash(`weekly:${id}:stale`)}`), {
				recursive: true,
				mode: 0o700,
			});
		// Exactly the launchd weekly-plan arguments.
		const draft = runCli(f.root, [
			"draft",
			"--kind",
			"weekly",
			"--timeout-seconds",
			"600",
			"--max-output-bytes",
			"1048576",
		]);
		expect(draft.status).toBe(1);
		expect(draft.stderr).toContain("is unrecorded. No new grant was consumed");
		expect(readdirSync(f.settings.paths.reviewDirectory).some((name) => name.startsWith("weekly-prompt-"))).toBe(
			false,
		);
		expect(existsSync(join(f.settings.paths.stateDirectory, "draft-grants.sqlite3"))).toBe(false);

		const status = runCli(f.root, ["status", "--json"]);
		expect(status.status, status.stderr).toBe(0);
		expect(JSON.parse(status.stdout).weeklyRuns).toHaveLength(periods.length);
		const text = runCli(f.root, ["status"]);
		expect(text.stdout).toContain(`need reconciliation before their period runs again`);

		const target = `weekly:${periods[0]}:stale`;
		const reconciled = runCli(f.root, ["weekly-reconcile", "--run", target, "--reason", "CLI fixture", "--json"]);
		expect(reconciled.status, reconciled.stderr).toBe(0);
		expect(JSON.parse(reconciled.stdout)).toMatchObject({
			command: "jarvis life weekly-reconcile",
			ok: true,
			decision: "abandoned",
			priorState: "unrecorded",
			grant: null,
		});
		const repeated = runCli(f.root, ["weekly-reconcile", "--run", target, "--reason", "CLI fixture"]);
		expect(repeated.status).toBe(1);
		expect(repeated.stderr).toContain("already reconciled");
	});
});
