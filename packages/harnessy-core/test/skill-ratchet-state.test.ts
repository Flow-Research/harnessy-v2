import { execFileSync } from "node:child_process";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { HarnessProject } from "../src/operations.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

/** Run a git subcommand in `cwd` for test setup (no shell). */
const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
	execFileSync("git", args, { cwd, stdio: "pipe" });
};

/** Locations for a ratchet fixture rooted at a temp git repo. */
interface Fixture {
	readonly repoDir: string;
	readonly skillsRoot: string;
	readonly tracesRoot: string;
	readonly stateDir: string;
	readonly runsFile: string;
	readonly skillFile: string;
}

/** Build a git repo with one committed skill file and an empty run ledger. */
const setupRepo = (fs: FileSystem.FileSystem) =>
	Effect.gen(function* () {
		const repoDir = yield* fs.makeTempDirectoryScoped();
		const skillsRoot = `${repoDir}/skills`;
		const tracesRoot = `${repoDir}/traces`;
		const stateDir = `${tracesRoot}/autoflow`;
		const runsFile = `${stateDir}/runs.ndjson`;
		const skillFile = `${skillsRoot}/demo/SKILL.md`;

		yield* fs.makeDirectory(`${skillsRoot}/demo`, { recursive: true });
		yield* fs.writeFileString(skillFile, "version one\n");
		yield* fs.makeDirectory(stateDir, { recursive: true });
		yield* fs.writeFileString(runsFile, "");

		git(repoDir, "init", "-q");
		git(repoDir, "config", "user.email", "test@example.com");
		git(repoDir, "config", "user.name", "Ratchet Test");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "initial skill");

		return { repoDir, skillsRoot, tracesRoot, stateDir, runsFile, skillFile } satisfies Fixture;
	});

const writeRuns = (fs: FileSystem.FileSystem, runsFile: string, runs: ReadonlyArray<Record<string, unknown>>) =>
	fs.writeFileString(runsFile, runs.length === 0 ? "" : `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`);

describe("Ratchet snapshot/status", () => {
	it.effect("creates a git tag and persists evaluating state", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setupRepo(fs);

				const result = yield* project.ratchetSnapshot({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					skillsRoot: fx.skillsRoot,
					stateDir: fx.stateDir,
					repoDir: fx.repoDir,
				});

				expect(result.tag).toMatch(/^ratchet\/demo\/\d{8}T\d{6}Z$/);
				expect(result.evaluationWindow).toBe(3);
				// The tag exists in the repo.
				const tags = execFileSync("git", ["tag", "--list"], { cwd: fx.repoDir }).toString();
				expect(tags).toContain(result.tag);

				const status = yield* project.ratchetStatus({ skill: "demo", stateDir: fx.stateDir });
				expect(status.status).toBe("evaluating");
				expect(status.snapshotTag).toBe(result.tag);
			}),
		),
	);

	it.effect("reports idle when no cycle exists", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setupRepo(fs);

				const status = yield* project.ratchetStatus({ skill: "demo", stateDir: fx.stateDir });
				expect(status.status).toBe("idle");
				expect(status.message).toContain("No active ratchet cycle");
			}),
		),
	);

	it.effect("fails to snapshot a missing skill", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setupRepo(fs);

				const error = yield* project
					.ratchetSnapshot({
						skill: "ghost",
						tracesRoot: fx.tracesRoot,
						runsFile: fx.runsFile,
						skillsRoot: fx.skillsRoot,
						stateDir: fx.stateDir,
						repoDir: fx.repoDir,
					})
					.pipe(Effect.flip);
				expect(error.message).toContain("Skill not found");
			}),
		),
	);
});

describe("Ratchet evaluate", () => {
	it.effect("waits until the window fills, then becomes ready", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setupRepo(fs);

				// Snapshot with an empty ledger -> baselineRunsCount 0.
				yield* project.ratchetSnapshot({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					skillsRoot: fx.skillsRoot,
					stateDir: fx.stateDir,
					repoDir: fx.repoDir,
				});

				// One post-snapshot run -> still waiting for a window of 2.
				yield* writeRuns(fs, fx.runsFile, [{ outcome: "completed" }]);
				const waiting = yield* project.ratchetEvaluate({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
					window: 2,
				});
				expect(waiting.status).toBe("waiting");
				expect(waiting.runsCompleted).toBe(1);
				expect(waiting.runsNeeded).toBe(2);

				// Two post-snapshot runs -> ready, with a candidate score and gates.
				yield* writeRuns(fs, fx.runsFile, [{ outcome: "completed" }, { outcome: "completed" }]);
				const ready = yield* project.ratchetEvaluate({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
					window: 2,
				});
				expect(ready.status).toBe("ready");
				expect(ready.candidateScore).toBeTypeOf("number");
				expect(ready.gates?.allPassed).toBe(true);
			}),
		),
	);
});

describe("Ratchet decide", () => {
	it.effect("reverts the skill to the snapshot tag when a gate fails", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setupRepo(fs);

				yield* project.ratchetSnapshot({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					skillsRoot: fx.skillsRoot,
					stateDir: fx.stateDir,
					repoDir: fx.repoDir,
				});

				// Make an (uncommitted) "improvement" to the skill.
				yield* fs.writeFileString(fx.skillFile, "version two (bad)\n");

				// Evaluation window includes a catastrophic failure -> gate fails.
				yield* writeRuns(fs, fx.runsFile, [{ outcome: "completed", catastrophic_failure: true }]);
				const ready = yield* project.ratchetEvaluate({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
					window: 1,
				});
				expect(ready.status).toBe("ready");
				expect(ready.gates?.allPassed).toBe(false);

				const decision = yield* project.ratchetDecide({
					skill: "demo",
					skillsRoot: fx.skillsRoot,
					stateDir: fx.stateDir,
					repoDir: fx.repoDir,
				});
				expect(decision.decision).toBe("revert");
				expect(decision.reason).toContain("hard constraint gate failed");
				// Working-tree skill file restored to the snapshot content.
				const restored = yield* fs.readFileString(fx.skillFile);
				expect(restored).toBe("version one\n");

				const status = yield* project.ratchetStatus({ skill: "demo", stateDir: fx.stateDir });
				expect(status.status).toBe("decided");
				expect(status.decision).toBe("revert");
			}),
		),
	);

	it.effect("keeps the candidate when within the noise band and gates pass", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setupRepo(fs);

				yield* project.ratchetSnapshot({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					skillsRoot: fx.skillsRoot,
					stateDir: fx.stateDir,
					repoDir: fx.repoDir,
				});
				yield* fs.writeFileString(fx.skillFile, "version two (kept)\n");
				// A clean completed run -> gates pass, delta ~0 within the band.
				yield* writeRuns(fs, fx.runsFile, [{ outcome: "completed" }]);
				yield* project.ratchetEvaluate({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					stateDir: fx.stateDir,
					window: 1,
				});

				const decision = yield* project.ratchetDecide({
					skill: "demo",
					skillsRoot: fx.skillsRoot,
					stateDir: fx.stateDir,
					repoDir: fx.repoDir,
				});
				expect(decision.decision).toBe("keep");
				// The improvement is retained (no revert).
				const kept = yield* fs.readFileString(fx.skillFile);
				expect(kept).toBe("version two (kept)\n");
			}),
		),
	);

	it.effect("fails to decide before evaluation", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const fx = yield* setupRepo(fs);

				yield* project.ratchetSnapshot({
					skill: "demo",
					tracesRoot: fx.tracesRoot,
					runsFile: fx.runsFile,
					skillsRoot: fx.skillsRoot,
					stateDir: fx.stateDir,
					repoDir: fx.repoDir,
				});
				const error = yield* project
					.ratchetDecide({ skill: "demo", skillsRoot: fx.skillsRoot, stateDir: fx.stateDir, repoDir: fx.repoDir })
					.pipe(Effect.flip);
				expect(error.message).toContain("Evaluation not complete");
			}),
		),
	);
});
