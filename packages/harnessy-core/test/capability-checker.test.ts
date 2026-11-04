import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { CapabilityChecker } from "../src/capabilities/checker.ts";
import {
	type CapabilityCheck,
	CapabilityManifest,
	FileContainsCheck,
	PathExistsCheck,
	ToolAvailableCheck,
} from "../src/capabilities/manifest.ts";
import { CapabilityEntry, CapabilitySource } from "../src/capabilities/source.ts";
import type { HarnessPaths } from "../src/paths.ts";
import { pathsForTarget } from "../src/paths.ts";
import { CommandLookup } from "../src/runtime/command-lookup.ts";
import { RuntimeEnvironment } from "../src/runtime/environment.ts";
import { HarnessLockfile } from "../src/runtime/lockfile.ts";

const addedAt = "2026-01-01T00:00:00.000Z";

const runCheck = (
	paths: HarnessPaths,
	lockfile: HarnessLockfile,
	pathEntries: ReadonlyArray<string> = [],
	options: { readonly executableExtensions?: ReadonlyArray<string> } = {},
) =>
	Effect.gen(function* () {
		const checker = yield* CapabilityChecker;
		return yield* checker.checkLockfile(paths, lockfile);
	}).pipe(
		Effect.provide(CapabilityChecker.layer),
		Effect.provide(CommandLookup.layer),
		Effect.provide(RuntimeEnvironment.testLayer(pathEntries, options)),
	);

const lockfileWith = (capabilities: ReadonlyArray<CapabilityEntry>): HarnessLockfile =>
	new HarnessLockfile({
		version: 1,
		harnessDir: ".harnessy",
		contextDir: ".harnessy/context",
		profile: ".harnessy/profiles/default.json",
		capabilities: [...capabilities],
	});

const capabilityWithChecks = (
	id: string,
	source: CapabilitySource,
	checks: ReadonlyArray<CapabilityCheck>,
): CapabilityEntry =>
	new CapabilityEntry({
		id,
		source,
		addedAt,
		manifest: new CapabilityManifest({
			id,
			name: "Checker Capability",
			checks: [...checks],
		}),
	});

describe("CapabilityChecker", () => {
	it.effect("passes local path, file substring, and executable PATH checks", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const targetDir = yield* fs.makeTempDirectoryScoped();
			const paths = yield* pathsForTarget(targetDir);
			const binDir = yield* fs.makeTempDirectoryScoped();

			yield* fs.makeDirectory(`${paths.capabilitiesDir}/local-checker/package/docs`, { recursive: true });
			yield* fs.writeFileString(
				`${paths.capabilitiesDir}/local-checker/package/docs/README.md`,
				"Tiny Capability\n",
			);
			yield* fs.writeFileString(`${binDir}/tiny-tool`, "#!/bin/sh\n");
			yield* fs.chmod(`${binDir}/tiny-tool`, 0o755);

			const lockfile = lockfileWith([
				capabilityWithChecks("local:checker", new CapabilitySource({ type: "local", value: "./capability" }), [
					new PathExistsCheck({ id: "readme-exists", kind: "path-exists", path: "docs/README.md" }),
					new FileContainsCheck({
						id: "readme-contains-title",
						kind: "file-contains",
						path: "docs/README.md",
						contains: "Tiny Capability",
					}),
					new ToolAvailableCheck({ id: "tiny-tool", kind: "tool-available", command: "tiny-tool" }),
				]),
			]);

			const report = yield* runCheck(paths, lockfile, [binDir]);

			expect(report.issues).toEqual([]);
			expect(report.requiredFailures).toEqual([]);
			expect(report.results.map((result) => [result.checkId, result.status, result.message])).toEqual([
				["readme-exists", "passed", "Path exists: docs/README.md"],
				["readme-contains-title", "passed", "File contains expected text: docs/README.md"],
				["tiny-tool", "passed", "Tool available on PATH: tiny-tool"],
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("finds Windows command shims with PATHEXT-style suffixes", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const targetDir = yield* fs.makeTempDirectoryScoped();
			const paths = yield* pathsForTarget(targetDir);
			const binDir = yield* fs.makeTempDirectoryScoped();

			yield* fs.makeDirectory(`${paths.capabilitiesDir}/local-checker/package`, { recursive: true });
			yield* fs.writeFileString(`${binDir}/tiny-tool.cmd`, "@echo off\r\n");
			yield* fs.chmod(`${binDir}/tiny-tool.cmd`, 0o755);

			const lockfile = lockfileWith([
				capabilityWithChecks("local:checker", new CapabilitySource({ type: "local", value: "./capability" }), [
					new ToolAvailableCheck({ id: "tiny-tool", kind: "tool-available", command: "tiny-tool" }),
				]),
			]);

			const report = yield* runCheck(paths, lockfile, [binDir], { executableExtensions: [".CMD", ".EXE"] });

			expect(report.issues).toEqual([]);
			expect(report.results.map((result) => [result.checkId, result.status])).toEqual([["tiny-tool", "passed"]]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("reports required failures while ignoring optional failures for issues", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const targetDir = yield* fs.makeTempDirectoryScoped();
			const paths = yield* pathsForTarget(targetDir);
			const binDir = yield* fs.makeTempDirectoryScoped();

			yield* fs.makeDirectory(`${paths.capabilitiesDir}/local-checker/package/docs`, { recursive: true });
			yield* fs.writeFileString(`${paths.capabilitiesDir}/local-checker/package/docs/README.md`, "Present text\n");
			yield* fs.writeFileString(`${binDir}/not-executable-tool`, "#!/bin/sh\n");
			yield* fs.chmod(`${binDir}/not-executable-tool`, 0o644);

			const lockfile = lockfileWith([
				capabilityWithChecks("local:checker", new CapabilitySource({ type: "local", value: "./capability" }), [
					new PathExistsCheck({
						id: "missing-path",
						kind: "path-exists",
						path: "docs/missing.md",
						required: true,
					}),
					new FileContainsCheck({
						id: "missing-text",
						kind: "file-contains",
						path: "docs/README.md",
						contains: "Absent text",
						required: true,
					}),
					new ToolAvailableCheck({
						id: "not-executable-tool",
						kind: "tool-available",
						command: "not-executable-tool",
						required: true,
					}),
					new PathExistsCheck({
						id: "optional-missing-path",
						kind: "path-exists",
						path: "docs/optional.md",
						required: false,
					}),
				]),
			]);

			const report = yield* runCheck(paths, lockfile, [binDir]);

			expect(report.results.map((result) => [result.checkId, result.status])).toEqual([
				["missing-path", "failed"],
				["missing-text", "failed"],
				["not-executable-tool", "failed"],
				["optional-missing-path", "failed"],
			]);
			expect(report.requiredFailures.map((result) => result.checkId)).toEqual([
				"missing-path",
				"missing-text",
				"not-executable-tool",
			]);
			expect(report.issues).toEqual([
				"Required capability check failed for local:checker/missing-path: Path does not exist: docs/missing.md",
				"Required capability check failed for local:checker/missing-text: File does not contain expected text: docs/README.md",
				"Required capability check failed for local:checker/not-executable-tool: Tool not available on PATH: not-executable-tool",
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("fails unresolved remote capability checks", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const targetDir = yield* fs.makeTempDirectoryScoped();
			const paths = yield* pathsForTarget(targetDir);
			const lockfile = lockfileWith([
				capabilityWithChecks(
					"git:remote-checker",
					new CapabilitySource({ type: "git", value: "https://example.com/acme/checker.git" }),
					[
						new PathExistsCheck({ id: "remote-path", kind: "path-exists", path: "docs/README.md" }),
						new ToolAvailableCheck({ id: "remote-tool", kind: "tool-available", command: "tiny-tool" }),
					],
				),
			]);

			const report = yield* runCheck(paths, lockfile);

			expect(report.issues).toHaveLength(2);
			expect(report.requiredFailures.map((result) => result.checkId)).toEqual(["remote-path", "remote-tool"]);
			expect(report.results.map((result) => [result.checkId, result.status, result.message])).toEqual([
				[
					"remote-path",
					"failed",
					"git capability git:remote-checker is unresolved and has no trusted local package.",
				],
				[
					"remote-tool",
					"failed",
					"git capability git:remote-checker is unresolved and has no trusted local package.",
				],
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("fails required checks when a local capability root is missing", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const targetDir = yield* fs.makeTempDirectoryScoped();
			const paths = yield* pathsForTarget(targetDir);
			const lockfile = lockfileWith([
				capabilityWithChecks(
					"local:missing-root",
					new CapabilitySource({ type: "local", value: "./missing-capability" }),
					[
						new PathExistsCheck({ id: "needs-readme", kind: "path-exists", path: "README.md" }),
						new ToolAvailableCheck({ id: "needs-tool", kind: "tool-available", command: "missing-tool" }),
					],
				),
			]);

			const report = yield* runCheck(paths, lockfile);

			expect(report.results.map((result) => [result.checkId, result.status, result.message])).toEqual([
				[
					"needs-readme",
					"failed",
					`Local capability root does not exist: ${paths.capabilitiesDir}/local-missing-root/package`,
				],
				[
					"needs-tool",
					"failed",
					`Local capability root does not exist: ${paths.capabilitiesDir}/local-missing-root/package`,
				],
			]);
			expect(report.requiredFailures.map((result) => result.checkId)).toEqual(["needs-readme", "needs-tool"]);
			expect(report.issues).toEqual([
				`Required capability check failed for local:missing-root/needs-readme: Local capability root does not exist: ${paths.capabilitiesDir}/local-missing-root/package`,
				`Required capability check failed for local:missing-root/needs-tool: Local capability root does not exist: ${paths.capabilitiesDir}/local-missing-root/package`,
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});
