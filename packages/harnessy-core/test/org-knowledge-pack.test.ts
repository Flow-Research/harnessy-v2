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
import type { StructuredDepsCheckOutput, StructuredVerifyOutput } from "../src/structured-output.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const orgKnowledgePackRoot = resolve(testDir, "../../capability-org-knowledge");

/** Provide the live Harnessy project service plus Node platform services for filesystem-backed tests. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

describe("org knowledge capability pack", () => {
	it.effect("adds, materializes, and verifies the local pack", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);

				const added = yield* project.addCapability(targetDir, orgKnowledgePackRoot, undefined);
				yield* project.activateCapability(targetDir, "npm:@harnessy/capability-org-knowledge");
				expect(added.added).toBe(true);
				expect(added.capability.id).toBe("npm:@harnessy/capability-org-knowledge");
				expect(added.capability.resolvedSource?.local?.root).toBe(orgKnowledgePackRoot);
				expect(added.capability.fingerprint?.kind).toBe("directory");
				expect(added.capability.fingerprint?.fileCount).toBeGreaterThan(10);
				expect(added.capability.manifest?.resources?.length).toBeGreaterThan(0);
				expect(added.materialization?.issues).toEqual([]);
				expect(added.materialization?.copied.length).toBe(15);

				const artifactRoot = `${targetDir}/.harnessy/capabilities/npm-harnessy-capability-org-knowledge/resources`;
				expect(yield* fs.exists(`${artifactRoot}/context/AGENTS.md`)).toBe(true);
				expect(yield* fs.exists(`${artifactRoot}/templates/github-issue-suggestion.md`)).toBe(true);
				expect(yield* fs.exists(`${artifactRoot}/prompts/meeting-ingest.md`)).toBe(true);

				const verify = yield* project.verify(targetDir);
				expect(verify.issues).toEqual([]);
				expect(verify.checks?.results.map((result) => [result.checkId, result.status])).toEqual([
					["primary-context-present", "passed"],
					["garden-boundary-documented", "passed"],
					["issue-template-present", "passed"],
				]);

				const dependencyReport = yield* project.checkDependencies(targetDir);
				expect(dependencyReport.results.map((result) => [result.name, result.required, result.status])).toEqual([
					["garden-meeting-connector", false, "missing"],
					["garden-org-wiki-connector", false, "missing"],
					["garden-github-connector", false, "missing"],
				]);
				expect(dependencyReport.missingRequired).toEqual([]);
			}),
		),
	);

	it.live("loads the local pack through the live CLI command tree", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

				yield* run(["init", "--target", targetDir]);
				yield* run(["capability", "add", orgKnowledgePackRoot, "--target", targetDir]);
				yield* run(["capability", "activate", "npm:@harnessy/capability-org-knowledge", "--target", targetDir]);
				yield* run(["verify", "--json", "--target", targetDir]);
				yield* run(["deps", "check", "--json", "--target", targetDir]);

				const artifactRoot = `${targetDir}/.harnessy/capabilities/npm-harnessy-capability-org-knowledge/resources`;
				expect(yield* fs.exists(`${artifactRoot}/context/AGENTS.md`)).toBe(true);
				expect(yield* fs.exists(`${artifactRoot}/templates/github-issue-suggestion.md`)).toBe(true);

				const logs = yield* TestConsole.logLines;
				const verifyLog = logs.find(
					(logged): logged is string => typeof logged === "string" && logged.includes('"command": "verify"'),
				);
				if (verifyLog === undefined) throw new Error("verify --json did not emit structured output");
				const verify = JSON.parse(verifyLog) as StructuredVerifyOutput;
				expect(verify.ok).toBe(true);
				expect(verify.lockfile.capabilities[0]?.resolvedSource?.local?.root).toBe(orgKnowledgePackRoot);
				expect(verify.lockfile.capabilities[0]?.fingerprint?.fileCount).toBeGreaterThan(10);
				expect(verify.checks?.results.map((result) => [result.checkId, result.status])).toEqual([
					["primary-context-present", "passed"],
					["garden-boundary-documented", "passed"],
					["issue-template-present", "passed"],
				]);

				const depsLog = logs.find(
					(logged): logged is string => typeof logged === "string" && logged.includes('"command": "deps check"'),
				);
				if (depsLog === undefined) throw new Error("deps check --json did not emit structured output");
				const deps = JSON.parse(depsLog) as StructuredDepsCheckOutput;
				expect(deps.ok).toBe(true);
				expect(deps.results.map((result) => [result.name, result.required, result.status])).toEqual([
					["garden-meeting-connector", false, "missing"],
					["garden-org-wiki-connector", false, "missing"],
					["garden-github-connector", false, "missing"],
				]);
				expect(deps.missingRequired).toEqual([]);
			}),
		).pipe(
			Effect.provide(HarnessProject.layer),
			Effect.provide(NodeServices.layer),
			Effect.provide(TestConsole.layer),
		),
	);
});
