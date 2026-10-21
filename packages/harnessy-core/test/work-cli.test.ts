import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeWorkCommand } from "../src/cli/work.ts";
import type { WorkDeps } from "../src/work/run.ts";

const TASK = "11111111-2222-4333-8444-555555555555";

const fakeDeps = (herdrVersion = "herdr 0.9.2") => {
	const calls: string[][] = [];
	const deps: WorkDeps = {
		platform: "linux",
		now: () => 0,
		sleep: async () => {},
		uuid: () => "00000000-0000-4000-8000-000000000000",
		log: () => {},
		run: async (argv) => {
			calls.push([...argv]);
			if (argv.includes("--version"))
				return { exitCode: 0, stdout: argv[0] === "herdr" ? herdrVersion : "1.0.0", stderr: "" };
			if (argv.includes("--help")) return { exitCode: 0, stdout: "usage", stderr: "" };
			throw new Error(`dry run must not run ${argv.join(" ")}`);
		},
	};
	return { calls, deps };
};

const runCli = (deps: WorkDeps, args: ReadonlyArray<string>) =>
	Effect.runPromise(
		Command.runWith(
			makeWorkCommand(() => deps),
			{ version: "test" },
		)(args).pipe(Effect.provide(NodeServices.layer)),
	);

const printed = (spy: { mock: { calls: unknown[][] } }) =>
	JSON.parse(String(spy.mock.calls.map((call) => call[0]).find((line) => String(line).startsWith("{"))));

describe("harnessy work CLI", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("parses flags and prints a dry-run plan after read-only preflight", async () => {
		const fake = fakeDeps();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runCli(fake.deps, [
			"--task",
			TASK,
			"--repo",
			"/srv/app",
			"--base",
			"main",
			"--budget-usd",
			"2.5",
			"--max-minutes",
			"10",
			"--workstream-cli",
			"workstream-local --as agent-claude",
			"--dry-run",
			"--json",
		]);
		const report = printed(log);
		expect(report).toMatchObject({
			status: "dry_run",
			task_id: TASK,
			branch: `work/${TASK}`,
			base: "main",
			worktree: `/srv/.harnessy-work/${TASK}`,
		});
		expect(report.steps.claim.slice(0, 3)).toEqual(["workstream-local", "--as", "agent-claude"]);
		expect(report.steps.agent_line).toContain("--max-budget-usd 2.5");
		expect(report.steps.wait).toContain("600000");
		expect(fake.calls).toContainEqual(["workstream-local", "--as", "agent-claude", "--help"]);
		expect(fake.calls.every((argv) => argv.includes("--version") || argv.includes("--help"))).toBe(true);
		expect(process.exitCode).toBeUndefined();
	});

	it("fails preflight with install hints and a non-zero exit", async () => {
		const fake = fakeDeps("herdr 0.8.2");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await runCli(fake.deps, ["--task", TASK, "--dry-run", "--json"]);
		const report = printed(log);
		expect(report.status).toBe("preflight_failed");
		expect(report.tools[0]).toMatchObject({
			name: "herdr",
			ok: false,
			hint: "curl -fsSL https://herdr.dev/install.sh | sh",
		});
		expect(process.exitCode).toBe(1);
	});

	it("requires --task and rejects invalid values", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(runCli(fakeDeps().deps, ["--dry-run"])).rejects.toThrow();
		await expect(runCli(fakeDeps().deps, ["--task", "not-a-uuid", "--dry-run"])).rejects.toThrow("UUID");
		await expect(runCli(fakeDeps().deps, ["--task", TASK, "--budget-usd", "0", "--dry-run"])).rejects.toThrow(
			"--budget-usd",
		);
	});
});
