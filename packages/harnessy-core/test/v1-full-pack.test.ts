import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";

import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";
import type { StructuredVerifyOutput } from "../src/structured-output.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, "../../..");
const v1FullPackRoot = resolve(testDir, "../../capability-harnessy-v1-full");
const v1ArtifactResources = ".harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources";

const expectedV1Checks = [
	["v1-source-root-present", "passed"],
	["v1-source-provenance-present", "passed"],
	["v1-root-flow-scripts-present", "passed"],
	["v1-ci-workflows-present", "passed"],
	["v1-harness-tests-present", "passed"],
	["flow-install-entrypoint-present", "passed"],
	["flow-install-skills-present", "passed"],
	["context-vault-present", "passed"],
	["jarvis-cli-present", "passed"],
	["root-bootstrap-present", "passed"],
] as const;

/** Provide the live Harnessy project service plus Node platform services for filesystem-backed tests. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

describe("Harnessy v1 full compatibility pack", () => {
	it.effect(
		"adds, materializes, and verifies the full v1 source surface",
		() =>
			provideLive(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const project = yield* HarnessProject;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					yield* project.init(targetDir, false);

					const added = yield* project.addCapability(targetDir, v1FullPackRoot, undefined);
					yield* project.activateCapability(targetDir, "npm:@harnessy/capability-harnessy-v1-full");
					expect(added.added).toBe(true);
					expect(added.capability.id).toBe("npm:@harnessy/capability-harnessy-v1-full");
					expect(added.capability.resolvedSource?.local?.root).toBe(v1FullPackRoot);
					expect(added.capability.fingerprint?.kind).toBe("directory");
					expect(added.capability.fingerprint?.fileCount).toBeGreaterThan(1000);
					expect(added.materialization?.issues).toEqual([]);
					expect(added.materialization?.copied.map((resource) => resource.target)).toEqual([
						"source",
						"SOURCE.json",
						"flow-install",
						"context-vault",
						"jarvis-cli",
						"install.sh",
						"README.v1.md",
						"AGENTS.v1.md",
					]);

					const artifactRoot = `${targetDir}/${v1ArtifactResources}`;
					expect(yield* fs.exists(`${artifactRoot}/source/package.json`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/SOURCE.json`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/scripts/flow/verify-harness.mjs`)).toBe(true);
					expect(
						yield* fs.exists(`${artifactRoot}/source/jarvis-cli/src/jarvis/meetings/publication/service.py`),
					).toBe(true);
					expect(
						yield* fs.exists(`${artifactRoot}/source/jarvis-cli/src/jarvis/community_briefing/service.py`),
					).toBe(true);
					expect(
						yield* fs.exists(
							`${artifactRoot}/source/tools/flow-install/skills/life-orchestrator/scripts/learning-research`,
						),
					).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/.github/workflows/harness-verify.yml`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/tests/harness/run-flow-install-eval.sh`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/flow-install/index.mjs`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/flow-install/skills/goal-agent/SKILL.md`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/context-vault/AGENTS.md`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/jarvis-cli/pyproject.toml`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/install.sh`)).toBe(true);

					const verify = yield* project.verify(targetDir);
					expect(verify.issues).toEqual([]);
					expect(verify.checks?.results.map((result) => [result.checkId, result.status])).toEqual(
						expectedV1Checks,
					);

					const dependencyReport = yield* project.checkDependencies(targetDir);
					expect(dependencyReport.missingRequired).toEqual([]);
					expect(dependencyReport.results.map((result) => [result.name, result.required])).toEqual([
						["node", false],
						["python3", false],
						["git", false],
						["uv", false],
						["pnpm", false],
					]);
				}),
			),
		// Full-tree copying and verification exceeded 30s on two hosted runs.
		{ timeout: 60_000 },
	);

	it("verifies provenance, privacy exclusions, and every compatibility projection in a real subprocess", () => {
		const result = spawnSync(
			process.execPath,
			[resolve(repositoryRoot, "scripts/verify-v1-compatibility.mjs"), v1FullPackRoot],
			{
				cwd: repositoryRoot,
				encoding: "utf8",
			},
		);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout) as {
			readonly ok: boolean;
			readonly issues: ReadonlyArray<string>;
			readonly tree: { readonly fileCount: number; readonly digest: string };
		};
		expect(report).toMatchObject({ ok: true, issues: [] });
		expect(report.tree.fileCount).toBeGreaterThan(700);
		expect(report.tree.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("fails closed when the authoritative snapshot is tampered without updating provenance or projections", () => {
		const temporaryRoot = mkdtempSync(resolve(tmpdir(), "harnessy-v1-tamper-"));
		const copyRoot = resolve(temporaryRoot, "capability-harnessy-v1-full");
		try {
			cpSync(v1FullPackRoot, copyRoot, { recursive: true });
			writeFileSync(resolve(copyRoot, "resources/source/TAMPERED.txt"), "unreviewed\n");
			const result = spawnSync(
				process.execPath,
				[resolve(repositoryRoot, "scripts/verify-v1-compatibility.mjs"), copyRoot],
				{
					cwd: repositoryRoot,
					encoding: "utf8",
				},
			);
			expect(result.status).toBe(1);
			const report = JSON.parse(result.stdout) as { readonly ok: boolean; readonly issues: ReadonlyArray<string> };
			expect(report.ok).toBe(false);
			expect(report.issues).toEqual(
				expect.arrayContaining(["source-digest-mismatch", "source-file-count-mismatch"]),
			);
		} finally {
			rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it.live("loads the full v1 pack through the live CLI command tree", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

				yield* run(["init", "--target", targetDir]);
				yield* run(["capability", "add", v1FullPackRoot, "--target", targetDir]);
				yield* run(["capability", "activate", "npm:@harnessy/capability-harnessy-v1-full", "--target", targetDir]);
				yield* run(["verify", "--json", "--target", targetDir]);

				const artifactRoot = `${targetDir}/${v1ArtifactResources}`;
				expect(yield* fs.exists(`${artifactRoot}/source/package.json`)).toBe(true);
				expect(yield* fs.exists(`${artifactRoot}/source/scripts/flow/verify-harness.mjs`)).toBe(true);
				expect(yield* fs.exists(`${artifactRoot}/flow-install/index.mjs`)).toBe(true);
				expect(yield* fs.exists(`${artifactRoot}/jarvis-cli/pyproject.toml`)).toBe(true);

				const logs = yield* TestConsole.logLines;
				const verifyLog = logs.find(
					(logged): logged is string => typeof logged === "string" && logged.includes('"command": "verify"'),
				);
				if (verifyLog === undefined) throw new Error("verify --json did not emit structured output");
				const verify = JSON.parse(verifyLog) as StructuredVerifyOutput;
				expect(verify.ok).toBe(true);
				expect(verify.lockfile.capabilities[0]?.resolvedSource?.local?.root).toBe(v1FullPackRoot);
				expect(verify.lockfile.capabilities[0]?.fingerprint?.fileCount).toBeGreaterThan(1000);
				expect(verify.checks?.results.map((result) => [result.checkId, result.status])).toEqual(expectedV1Checks);
			}),
		).pipe(
			Effect.provide(HarnessProject.layer),
			Effect.provide(NodeServices.layer),
			Effect.provide(TestConsole.layer),
		),
	);
});
