import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import { TestConsole } from "effect/testing";
import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";
import type { StructuredVerifyOutput } from "../src/structured-output.ts";
import { unselectedCliServices } from "./lib/unselected-cli-services.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, "../../..");
const v1FullPackRoot = resolve(testDir, "../../capability-harnessy-v1-full");
const v1ArtifactResources = ".harnessy/capabilities/npm-harnessy-capability-harnessy-v1-full/resources";
const engineeringSkillFiles = [
	"SKILL.md",
	"manifest.yaml",
	"references/attribution.md",
	"references/experiment-record.md",
	"test/verify-skill.test.mjs",
] as const;
// The reviewed V2 amendment adds five files to the prior 751-file package.
const amendedPackFileCount = 751 + engineeringSkillFiles.length;

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
	effect.pipe(
		Effect.provide(HarnessProject.layer),
		Effect.provide(unselectedCliServices),
		Effect.provide(NodeServices.layer),
	);

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
					expect(added.capability.fingerprint?.fileCount).toBe(amendedPackFileCount);
					expect(added.materialization?.issues).toEqual([]);
					expect(added.materialization?.copied.map((resource) => resource.target)).toEqual([
						"source",
						"SOURCE.json",
						"npm-transport.json",
					]);

					const artifactRoot = `${targetDir}/${v1ArtifactResources}`;
					for (const file of engineeringSkillFiles) {
						expect(
							yield* fs.exists(`${artifactRoot}/source/tools/flow-install/skills/engineering-loop/${file}`),
						).toBe(true);
					}
					expect(yield* fs.readFileString(`${artifactRoot}/source/.jarvis/context/skills/_catalog.md`)).toContain(
						"engineering-loop",
					);
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
					expect(yield* fs.exists(`${artifactRoot}/source/tools/flow-install/index.mjs`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/tools/flow-install/skills/goal-agent/SKILL.md`)).toBe(
						true,
					);
					expect(yield* fs.exists(`${artifactRoot}/source/.jarvis/context/AGENTS.md`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/jarvis-cli/pyproject.toml`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/install.sh`)).toBe(true);

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

	it("verifies provenance, privacy exclusions, and the canonical compatibility source in a real subprocess", () => {
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
		expect(report.tree.fileCount).toBe(745 + engineeringSkillFiles.length);
		expect(report.tree.digest).toMatch(/^[a-f0-9]{64}$/);
		const provenance = JSON.parse(readFileSync(resolve(v1FullPackRoot, "resources/SOURCE.json"), "utf8"));
		expect(provenance.source.repository).toBe("https://github.com/Flow-Research/harnessy.git");
		expect(provenance.source.v2Amendments.map((entry: { id: string }) => entry.id)).toEqual([
			"engineering-loop-shared-skill-20261121",
			"jarvis-pypdf-6-21-4",
			"tasks-store-brief-ingest-20261127",
			"meeting-capture-routing-20261127",
			"meeting-single-folder-20261128",
		]);
		const [amendment, dependencyAmendment, briefAmendment, meetingAmendment, folderAmendment] =
			provenance.source.v2Amendments;
		expect(dependencyAmendment).toMatchObject({
			owner: "harnessy-v2",
			baseTree: { fileCount: 750 },
			changes: [{ path: "jarvis-cli/uv.lock", before: { size: 273501 }, after: { size: 273668 } }],
		});
		expect(amendment.owner).toBe("harnessy-v2");
		// The base tree changes whenever the V1 source changes. The compatibility check above proves
		// that the amendment binds the tree that precedes it, so only its shape is fixed here.
		expect(amendment.baseTree).toMatchObject({ fileCount: 745, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(amendment.changes.map((change: { path: string }) => change.path).sort()).toEqual(
			[
				".jarvis/context/skills/_catalog.md",
				...engineeringSkillFiles.map((file) => `tools/flow-install/skills/engineering-loop/${file}`),
			].sort(),
		);
		expect(amendment.changes.filter((change: { before: unknown }) => change.before === null)).toHaveLength(5);
		expect(briefAmendment).toMatchObject({
			owner: "harnessy-v2",
			baseTree: { fileCount: 750 },
		});
		expect(briefAmendment.changes.map((change: { path: string }) => change.path).sort()).toEqual([
			"tools/flow-install/skills/life-orchestrator/scripts/collect-state",
			"tools/flow-install/skills/life-orchestrator/scripts/daily-brief",
		]);
		expect(meetingAmendment).toMatchObject({ owner: "harnessy-v2", baseTree: { fileCount: 750 } });
		expect(meetingAmendment.changes.map((change: { path: string }) => change.path).sort()).toEqual([
			"tools/flow-install/skills/jarvis/commands/jarvis.md",
			"tools/flow-install/skills/life-orchestrator/scripts/collect-state",
			"tools/flow-install/tests/test_life_orchestrator_collect_state.py",
		]);
		expect(folderAmendment).toMatchObject({ owner: "harnessy-v2", baseTree: { fileCount: 750 } });
		expect(folderAmendment.changes.map((change: { path: string }) => change.path)).toEqual([
			"tools/flow-install/skills/jarvis/commands/jarvis.md",
		]);
	});

	it("fails closed when the authoritative snapshot is tampered without updating provenance", () => {
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
			rmSync(resolve(copyRoot, "resources/source/TAMPERED.txt"));
			const skillPath = "resources/source/tools/flow-install/skills/engineering-loop/SKILL.md";
			writeFileSync(resolve(copyRoot, skillPath), "unreviewed skill bytes\n");
			const alteredSkill = spawnSync(
				process.execPath,
				[resolve(repositoryRoot, "scripts/verify-v1-compatibility.mjs"), copyRoot],
				{ encoding: "utf8" },
			);
			expect(alteredSkill.status).toBe(1);
			expect(JSON.parse(alteredSkill.stdout).issues).toContain(
				"v2-amendment-base-mismatch: meeting-single-folder-20261128",
			);
			cpSync(resolve(v1FullPackRoot, skillPath), resolve(copyRoot, skillPath));
			writeFileSync(resolve(copyRoot, "resources/source/jarvis-cli/uv.lock"), "unreviewed lock bytes\n");
			const altered = spawnSync(
				process.execPath,
				[resolve(repositoryRoot, "scripts/verify-v1-compatibility.mjs"), copyRoot],
				{ encoding: "utf8" },
			);
			expect(altered.status).toBe(1);
			// An older file no longer matches the latest amendment's bound prior tree.
			expect(JSON.parse(altered.stdout).issues).toContain(
				"v2-amendment-base-mismatch: meeting-single-folder-20261128",
			);
			cpSync(
				resolve(v1FullPackRoot, "resources/source/jarvis-cli/uv.lock"),
				resolve(copyRoot, "resources/source/jarvis-cli/uv.lock"),
			);
			// The latest amendment changed jarvis.md, so altered bytes fail its recorded after-hash.
			const briefPath = "resources/source/tools/flow-install/skills/jarvis/commands/jarvis.md";
			writeFileSync(resolve(copyRoot, briefPath), "unreviewed skill bytes\n");
			const alteredBrief = spawnSync(
				process.execPath,
				[resolve(repositoryRoot, "scripts/verify-v1-compatibility.mjs"), copyRoot],
				{ encoding: "utf8" },
			);
			expect(alteredBrief.status).toBe(1);
			expect(JSON.parse(alteredBrief.stdout).issues).toContain(
				"v2-amendment-after-mismatch: tools/flow-install/skills/jarvis/commands/jarvis.md",
			);
			cpSync(resolve(v1FullPackRoot, briefPath), resolve(copyRoot, briefPath));
			mkdirSync(resolve(copyRoot, "resources/source/private"));
			writeFileSync(resolve(copyRoot, "resources/source/private/secret.md"), "synthetic private fixture\n");
			const privateBytes = spawnSync(
				process.execPath,
				[resolve(repositoryRoot, "scripts/verify-v1-compatibility.mjs"), copyRoot],
				{ encoding: "utf8" },
			);
			expect(privateBytes.status).toBe(1);
			expect(JSON.parse(privateBytes.stdout).issues).toContain("private-context: private/secret.md");
		} finally {
			rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});

	it.live(
		"loads the full v1 pack through the live CLI command tree",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

					yield* run(["init", "--target", targetDir]);
					yield* run(["capability", "add", v1FullPackRoot, "--target", targetDir]);
					yield* run([
						"capability",
						"activate",
						"npm:@harnessy/capability-harnessy-v1-full",
						"--target",
						targetDir,
					]);
					yield* run(["verify", "--json", "--target", targetDir]);

					const artifactRoot = `${targetDir}/${v1ArtifactResources}`;
					expect(yield* fs.exists(`${artifactRoot}/source/package.json`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/scripts/flow/verify-harness.mjs`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/tools/flow-install/index.mjs`)).toBe(true);
					expect(yield* fs.exists(`${artifactRoot}/source/jarvis-cli/pyproject.toml`)).toBe(true);

					const logs = yield* TestConsole.logLines;
					const verifyLog = logs.find(
						(logged): logged is string => typeof logged === "string" && logged.includes('"command": "verify"'),
					);
					if (verifyLog === undefined) throw new Error("verify --json did not emit structured output");
					const verify = JSON.parse(verifyLog) as StructuredVerifyOutput;
					expect(verify.ok).toBe(true);
					expect(verify.lockfile.capabilities[0]?.resolvedSource?.local?.root).toBe(v1FullPackRoot);
					expect(verify.lockfile.capabilities[0]?.fingerprint?.fileCount).toBe(amendedPackFileCount);
					expect(verify.checks?.results.map((result) => [result.checkId, result.status])).toEqual(
						expectedV1Checks,
					);
				}),
			).pipe(
				Effect.provide(HarnessProject.layer),
				Effect.provide(unselectedCliServices),
				Effect.provide(NodeServices.layer),
				Effect.provide(TestConsole.layer),
			),
		// This path performs the same full-tree materialization as the first test and
		// reached the default 30s bound on the hosted Linux runner.
		{ timeout: 60_000 },
	);
});
