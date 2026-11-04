import process from "node:process";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CommandRunner, displayCommand } from "../src/runtime/command-runner.ts";
import { type FakeSpawner, makeFakeSpawner } from "./lib/fake-spawner.ts";

const withFake = <A, E>(fake: FakeSpawner, effect: Effect.Effect<A, E, CommandRunner>) =>
	effect.pipe(Effect.provide(CommandRunner.layer), Effect.provide(fake.layer));

const withLive = <A, E>(effect: Effect.Effect<A, E, CommandRunner>) =>
	effect.pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));

describe("CommandRunner", () => {
	it("renders argv display strings with shell-safe quoting", () => {
		expect(displayCommand("tool", ["plain", "has space", "$HOME", "`tick`", "", "it's"])).toBe(
			"tool plain 'has space' '$HOME' '`tick`' '' 'it'\\''s'",
		);
	});

	it.effect("runs an argv command and captures exit code and output", () => {
		const fake = makeFakeSpawner(() => ({ exitCode: 0, stdout: "hello\n" }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				const result = yield* runner.run({ id: "echo", label: "Echo", executable: "echo", args: ["hello"] });
				expect(result.status).toBe("succeeded");
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toBe("hello\n");
				expect(result.command).toBe("echo hello");
				expect(fake.calls).toHaveLength(1);
				expect(fake.calls[0]).toMatchObject({ executable: "echo", args: ["hello"] });
			}),
		);
	});

	it.effect("passes cwd through to the spawner", () => {
		const fake = makeFakeSpawner();
		return withFake(
			fake,
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				yield* runner.run({ id: "pwd", label: "pwd", executable: "pwd", args: [], cwd: "/work/dir" });
				expect(fake.calls[0]?.cwd).toBe("/work/dir");
			}),
		);
	});

	it.effect("quotes arguments containing spaces in the display string only", () => {
		const fake = makeFakeSpawner();
		return withFake(
			fake,
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				const result = yield* runner.run({
					id: "git",
					label: "git pull",
					executable: "git",
					args: ["-C", "/has a space", "pull"],
				});
				// Display quotes the spacey arg, but the spawned argv stays unsplit.
				expect(result.command).toBe("git -C '/has a space' pull");
				expect(fake.calls[0]?.args).toEqual(["-C", "/has a space", "pull"]);
			}),
		);
	});

	it.effect("caps captured output to the tail for chatty commands", () => {
		const head = "A".repeat(20_000);
		const tailMarker = "TAIL-END";
		const fake = makeFakeSpawner(() => ({ exitCode: 0, stdout: head + tailMarker }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				const result = yield* runner.run({ id: "noisy", label: "Noisy", executable: "noisy", args: [] });
				// Output is bounded (16 KiB cap) and retains the most recent bytes.
				expect(result.stdout.length).toBe(16 * 1024);
				expect(result.stdout.endsWith(tailMarker)).toBe(true);
			}),
		);
	});

	it.effect("reports a non-zero exit as failed without throwing", () => {
		const fake = makeFakeSpawner(() => ({ exitCode: 2, stderr: "boom\n" }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				const result = yield* runner.run({ id: "fail", label: "Fail", executable: "false", args: [] });
				expect(result.status).toBe("failed");
				expect(result.exitCode).toBe(2);
				expect(result.stderr).toBe("boom\n");
				expect(result.error).toBeUndefined();
			}),
		);
	});

	it.effect("captures a spawn failure as a failed result with no exit code", () => {
		const fake = makeFakeSpawner(() => ({ spawnError: "ENOENT: missing" }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				const result = yield* runner.run({ id: "missing", label: "Missing", executable: "nope", args: [] });
				expect(result.status).toBe("failed");
				expect(result.exitCode).toBeUndefined();
				expect(result.error).toContain("ENOENT");
			}),
		);
	});

	// Two tests through the real platform spawner, kept deterministic by invoking
	// the test runner's own node binary with an inline script — no system
	// utilities, no network, no timing assumptions.
	it.live("executes a real process through the live platform spawner", () =>
		withLive(
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				const result = yield* runner.run({
					id: "node-echo",
					label: "node inline",
					executable: process.execPath,
					args: ["-e", "process.stdout.write('live-ok')"],
				});
				expect(result.status).toBe("succeeded");
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("live-ok");
			}),
		),
	);

	it.live("captures a non-zero exit from a real process", () =>
		withLive(
			Effect.gen(function* () {
				const runner = yield* CommandRunner;
				const result = yield* runner.run({
					id: "node-exit-3",
					label: "node exit 3",
					executable: process.execPath,
					args: ["-e", "process.stderr.write('nope'); process.exit(3)"],
				});
				expect(result.status).toBe("failed");
				expect(result.exitCode).toBe(3);
				expect(result.stderr).toContain("nope");
			}),
		),
	);
});
