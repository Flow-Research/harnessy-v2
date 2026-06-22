import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import {
	CAPABILITY_MANIFEST_NAME,
	CapabilityManifest,
	CapabilityResource,
	DependencyRequirement,
	parseCapabilityManifest,
} from "../src/capability-manifest.ts";
import {
	CapabilityEntry,
	CapabilitySource,
	makeCapabilityId,
	parseCapabilitySource,
} from "../src/capability-source.ts";
import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { DependencyChecker } from "../src/dependency-checker.ts";
import { formatLockfile, HarnessLockfile, parseLockfile } from "../src/lockfile.ts";
import { HarnessProject } from "../src/operations.ts";
import { parseGitRemote, parsePnpmWorkspaceGlobs } from "../src/project-detection.ts";
import { RuntimeEnvironment } from "../src/runtime-environment.ts";

/** Provide the live Harnessy service plus Node platform services for filesystem-backed tests. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

describe("capability manifests", () => {
	it.effect("parses the tiny local fixture", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const raw = yield* fs.readFileString(`fixtures/tiny-capability/${CAPABILITY_MANIFEST_NAME}`);
			const manifest = yield* parseCapabilityManifest(raw, `fixtures/tiny-capability/${CAPABILITY_MANIFEST_NAME}`);
			expect(manifest.id).toBe("local:tiny-capability");
			expect(manifest.context).toEqual(["context/AGENTS.md"]);
			expect(manifest.blastRadius).toBe("low");
			expect(manifest.permissions).toEqual(["context:read"]);
			expect(manifest.dataCategories).toEqual(["project_context"]);
			expect(manifest.egress).toEqual([]);
			expect(manifest.dependencies?.[0]?.name).toBe("tiny-tool");
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("dependencies", () => {
	it.effect("checks tool dependencies through a caller-controlled PATH", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const binDir = yield* fs.makeTempDirectoryScoped();
			yield* fs.writeFileString(`${binDir}/tiny-tool`, "#!/bin/sh\n");
			yield* fs.chmod(`${binDir}/tiny-tool`, 0o755);

			const lockfile = new HarnessLockfile({
				version: 1,
				harnessDir: ".harnessy",
				contextDir: ".harnessy/context",
				profile: ".harnessy/profiles/default.json",
				capabilities: [
					new CapabilityEntry({
						id: "local:tiny-capability",
						source: new CapabilitySource({ type: "local", value: "./tiny-capability" }),
						addedAt: "2026-01-01T00:00:00.000Z",
						manifest: new CapabilityManifest({
							id: "local:tiny-capability",
							name: "Tiny Capability",
							dependencies: [
								new DependencyRequirement({
									kind: "tool",
									name: "tiny-tool",
									command: "tiny-tool",
									required: true,
								}),
								new DependencyRequirement({
									kind: "tool",
									name: "missing-tool",
									command: "missing-tool",
									required: true,
								}),
							],
						}),
					}),
				],
			});

			const report = yield* Effect.gen(function* () {
				const checker = yield* DependencyChecker;
				return yield* checker.checkLockfile(lockfile);
			}).pipe(Effect.provide(DependencyChecker.layer), Effect.provide(RuntimeEnvironment.testLayer([binDir])));

			expect(report.results.map((result) => [result.name, result.status])).toEqual([
				["tiny-tool", "available"],
				["missing-tool", "missing"],
			]);
			expect(report.missingRequired.map((result) => result.name)).toEqual(["missing-tool"]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("capability sources", () => {
	it.effect("classifies git, npm, and local sources", () =>
		Effect.gen(function* () {
			const git = yield* parseCapabilitySource("https://example.com/team/capability.git#main");
			const npm = yield* parseCapabilitySource("npm:@harnessy/capability-demo");
			const local = yield* parseCapabilitySource("./capability-demo");

			expect(git.type).toBe("git");
			expect(npm).toMatchObject({ type: "npm", value: "@harnessy/capability-demo" });
			expect(local.type).toBe("local");
			expect(makeCapabilityId(npm.type, npm.value)).toBe("npm:harnessy-capability-demo");
		}),
	);
});

describe("project detection", () => {
	it("parses git remote URLs", () => {
		expect(parseGitRemote("git@github.com:org/repo.git")).toEqual({ org: "org", repo: "repo" });
		expect(parseGitRemote("https://github.com/acme/tooling.git")).toEqual({ org: "acme", repo: "tooling" });
	});

	it("parses pnpm workspace globs", () => {
		expect(parsePnpmWorkspaceGlobs("packages:\n  - 'apps/*'\n  - packages/*\nignored: true\n")).toEqual([
			"apps/*",
			"packages/*",
		]);
	});

	it.effect("detects npm workspaces in doctor output", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* fs.writeFileString(
					`${targetDir}/package.json`,
					JSON.stringify({
						name: "demo-project",
						version: "1.2.3",
						packageManager: "npm@10.9.0",
						workspaces: ["apps/*", "packages/*"],
					}),
				);
				yield* fs.makeDirectory(`${targetDir}/apps/web`, { recursive: true });
				yield* fs.makeDirectory(`${targetDir}/packages/core`, { recursive: true });
				yield* fs.makeDirectory(`${targetDir}/.git`, { recursive: true });
				yield* fs.writeFileString(`${targetDir}/apps/web/package.json`, JSON.stringify({ name: "web" }));
				yield* fs.writeFileString(`${targetDir}/packages/core/package.json`, JSON.stringify({ name: "core" }));
				yield* fs.writeFileString(
					`${targetDir}/.git/config`,
					'[remote "origin"]\n\turl = git@github.com:demo/demo-project.git\n',
				);

				const doctor = yield* project.doctor(targetDir);
				expect(doctor.project.name).toBe("demo-project");
				expect(doctor.project.version).toBe("1.2.3");
				expect(doctor.project.packageManager).toBe("npm");
				expect(doctor.project.monorepo?.type).toBe("npm-workspaces");
				expect(doctor.project.apps.map((workspace) => workspace.relativePath)).toEqual(["apps/web"]);
				expect(doctor.project.packages.map((workspace) => workspace.relativePath)).toEqual(["packages/core"]);
				expect(doctor.project.gitOrg).toBe("demo");
				expect(doctor.project.gitRepo).toBe("demo-project");
			}),
		),
	);
});

describe("lockfile parsing", () => {
	it.effect("fails through the typed error channel for malformed lockfiles", () =>
		Effect.gen(function* () {
			const error = yield* Effect.flip(parseLockfile('{"version":2}', "/tmp/harnessy.lock.json"));
			expect(error.message).toContain("Invalid Harnessy lockfile");
		}),
	);
});

describe("Harnessy CLI", () => {
	it.live("runs the command tree against live Node services", () =>
		provideLive(
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

					yield* run(["install", "--target", targetDir]);
					yield* fs.makeDirectory(`${targetDir}/tiny-capability`);
					yield* run(["capability", "add", "./tiny-capability", "--target", targetDir]);
					yield* run(["verify", "--target", targetDir]);
					yield* run(["deps", "check", "--target", targetDir]);

					const lockfileText = yield* fs.readFileString(`${targetDir}/.harnessy/harnessy.lock.json`);
					expect(lockfileText).toContain("local:tiny-capability");
					const manifestExists = yield* fs.exists(
						`${targetDir}/.harnessy/capabilities/local-tiny-capability.json`,
					);
					expect(manifestExists).toBe(true);
				}),
			),
		),
	);

	it.live("runs v1-compatible installer flags through the live CLI", () =>
		provideLive(
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

					yield* run(["install", "--dry-run", "--step", "memory", "--target", targetDir]);
					expect(yield* fs.exists(`${targetDir}/.harnessy`)).toBe(false);

					yield* run([
						"install",
						"--target",
						targetDir,
						"--reconfigure",
						"--agents-file",
						"docs/AGENTS.md",
						"--context-dir",
						"custom/context",
						"--skills-dir",
						"custom/skills",
						"--scripts-dir",
						"scripts/custom",
					]);

					expect(yield* fs.exists(`${targetDir}/docs/AGENTS.md`)).toBe(true);
					expect(yield* fs.exists(`${targetDir}/custom/context/AGENTS.md`)).toBe(true);
					const lockfileText = yield* fs.readFileString(`${targetDir}/.harnessy/harnessy.lock.json`);
					expect(lockfileText).toContain('"contextDir": "custom/context"');
				}),
			),
		),
	);
});

describe("HarnessProject", () => {
	it.effect("installs package scripts without overwriting existing commands", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* fs.writeFileString(
					`${targetDir}/package.json`,
					JSON.stringify({ scripts: { "harness:verify": "custom verify" } }),
				);

				const install = yield* project.runInstaller(targetDir, {
					force: false,
					step: "package-scripts",
					reconfigure: true,
					installPathOverrides: { scriptsDir: "scripts/flow" },
				});
				expect(install.scripts?.added).toEqual([
					"skills:validate",
					"skills:register",
					"skills:register:claude",
					"skills:register:opencode",
					"skills:register:codex",
					"flow:cleanup",
					"flow:sync",
					"flow:sync:force",
					"flow:sync:remote",
					"flow:sync:remote:force",
					"postinstall",
				]);
				expect(install.scripts?.updated).toEqual(["harness:verify"]);

				const packageJson = JSON.parse(yield* fs.readFileString(`${targetDir}/package.json`)) as {
					readonly scripts: Record<string, string>;
				};
				expect(packageJson.scripts["skills:validate"]).toBe("node scripts/flow/validate-skills.mjs");
				expect(packageJson.scripts["skills:register:codex"]).toBe("node scripts/flow/register-codex-skills.mjs");
				expect(packageJson.scripts["flow:cleanup"]).toBe("node scripts/flow/cleanup-stale-plugins.mjs");
				expect(packageJson.scripts["harness:verify"]).toBe("node scripts/flow/verify-harness.mjs");
				expect(packageJson.scripts.postinstall).toBe("node scripts/flow/sync-rules.mjs");
			}),
		),
	);

	it.effect("installs and records an initial capability source", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* fs.makeDirectory(`${targetDir}/initial-capability`);

				const install = yield* project.install(targetDir, false, "./initial-capability");
				expect(install.init.initialized).toBe(true);
				expect(install.capability?.capability.id).toBe("local:initial-capability");

				const capabilities = yield* project.listCapabilities(targetDir);
				expect(capabilities.map((capability) => capability.id)).toEqual(["local:initial-capability"]);
			}),
		),
	);

	it.effect("force install refreshes generated files without deleting capabilities", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* fs.makeDirectory(`${targetDir}/initial-capability`);

				yield* project.install(targetDir, false, "./initial-capability");
				const forced = yield* project.install(targetDir, true, undefined);
				expect(forced.init.initialized).toBe(false);
				const capabilities = yield* project.listCapabilities(targetDir);
				expect(capabilities.map((capability) => capability.id)).toEqual(["local:initial-capability"]);
			}),
		),
	);

	it.effect("initializes and verifies a project", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const init = yield* project.init(targetDir, false);
				expect(init.initialized).toBe(true);
				expect(init.written).toHaveLength(9);

				const lockfileExists = yield* fs.exists(init.paths.lockfile);
				const contextExists = yield* fs.exists(init.paths.contextAgentsFile);
				const profileExists = yield* fs.exists(init.paths.defaultProfile);
				const memoryExists = yield* fs.exists(`${init.paths.memoryDir}/project.md`);
				const memoryScopesExist = yield* fs.exists(`${init.paths.memoryDir}/_scopes.yaml`);
				expect(lockfileExists).toBe(true);
				expect(contextExists).toBe(true);
				expect(profileExists).toBe(true);
				expect(memoryExists).toBe(true);
				expect(memoryScopesExist).toBe(true);

				const verify = yield* project.verify(targetDir);
				expect(verify.issues).toEqual([]);
				expect(verify.lockfile.capabilities).toHaveLength(0);
			}),
		),
	);

	it.effect("supports native v1-compatible dry-run and saved install path overrides", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const dryRun = yield* project.runInstaller(targetDir, {
					force: false,
					dryRun: true,
					reconfigure: true,
					installPathOverrides: {
						agentsFile: "docs/AGENTS.md",
						contextDir: "custom/context",
						skillsDir: "custom/skills",
						scriptsDir: "scripts/custom",
					},
				});
				expect(dryRun.dryRun).toBe(true);
				expect(dryRun.installPaths.contextDir).toBe("custom/context");
				expect(dryRun.written).toContain(`${targetDir}/docs/AGENTS.md`);
				expect(yield* fs.exists(`${targetDir}/.harnessy`)).toBe(false);

				const installed = yield* project.runInstaller(targetDir, {
					force: false,
					reconfigure: true,
					installPathOverrides: {
						agentsFile: "docs/AGENTS.md",
						contextDir: "custom/context",
						skillsDir: "custom/skills",
						scriptsDir: "scripts/custom",
					},
				});
				expect(installed.init?.initialized).toBe(true);
				expect(installed.installPaths).toMatchObject({
					agentsFile: "docs/AGENTS.md",
					contextDir: "custom/context",
					skillsDir: "custom/skills",
					scriptsDir: "scripts/custom",
				});
				expect(yield* fs.exists(`${targetDir}/docs/AGENTS.md`)).toBe(true);
				expect(yield* fs.exists(`${targetDir}/custom/context/AGENTS.md`)).toBe(true);

				const lockfile = JSON.parse(yield* fs.readFileString(`${targetDir}/.harnessy/harnessy.lock.json`)) as {
					readonly installPaths: Record<string, string>;
				};
				expect(lockfile.installPaths).toEqual({
					agentsFile: "docs/AGENTS.md",
					contextDir: "custom/context",
					skillsDir: "custom/skills",
					scriptsDir: "scripts/custom",
				});
			}),
		),
	);

	it.effect("supports v1-style step-only memory and AGENTS.md installs", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();

				const memory = yield* project.runInstaller(targetDir, { force: false, step: "memory" });
				expect(memory.step).toBe("memory");
				expect(memory.written).toContain(`${targetDir}/.harnessy/memory/_scopes.yaml`);
				expect(yield* fs.exists(`${targetDir}/.harnessy/memory/_scopes.yaml`)).toBe(true);
				expect(yield* fs.exists(`${targetDir}/.harnessy/harnessy.lock.json`)).toBe(false);

				const agentsMd = yield* project.runInstaller(targetDir, { force: false, step: "agents-md" });
				expect(agentsMd.managedBlocks.agentsMd?.status).toBe("created");
				const agentsText = yield* fs.readFileString(`${targetDir}/AGENTS.md`);
				expect(agentsText).toContain("<!-- harnessy:start -->");
				expect(agentsText).toContain("This repo is Harnessy-managed.");
			}),
		),
	);

	it.effect("records a local capability and writes a manifest", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);
				yield* fs.makeDirectory(`${targetDir}/tiny-capability`);

				const added = yield* project.addCapability(targetDir, "./tiny-capability", undefined);
				expect(added.added).toBe(true);
				expect(added.capability.id).toBe("local:tiny-capability");
				expect(added.manifestPath).not.toBeNull();
				if (added.manifestPath !== null) {
					const manifestExists = yield* fs.exists(added.manifestPath);
					expect(manifestExists).toBe(true);
				}

				const duplicate = yield* project.addCapability(targetDir, "./tiny-capability", undefined);
				expect(duplicate.added).toBe(false);

				const capabilities = yield* project.listCapabilities(targetDir);
				expect(capabilities).toHaveLength(1);

				const verify = yield* project.verify(targetDir);
				expect(verify.issues).toEqual([]);
			}),
		),
	);

	it.effect("uses a local capability manifest when present", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);
				yield* fs.makeDirectory(`${targetDir}/manifested-capability`);
				yield* fs.writeFileString(
					`${targetDir}/manifested-capability/${CAPABILITY_MANIFEST_NAME}`,
					JSON.stringify({
						id: "local:manifested",
						name: "Manifested Capability",
						version: "0.1.0",
						description: "Loaded from a local manifest.",
					}),
				);

				const added = yield* project.addCapability(targetDir, "./manifested-capability", undefined);
				expect(added.capability.id).toBe("local:manifested");
				expect(added.capability.manifest?.name).toBe("Manifested Capability");

				const inspected = yield* project.inspectCapability(targetDir, "local:manifested");
				expect(inspected.manifest?.description).toBe("Loaded from a local manifest.");

				const capabilities = yield* project.listCapabilities(targetDir);
				expect(capabilities[0]?.manifest?.version).toBe("0.1.0");
			}),
		),
	);

	it.effect("materializes local capability manifest resources during add", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);
				yield* fs.makeDirectory(`${targetDir}/resource-capability/context`, { recursive: true });
				yield* fs.writeFileString(`${targetDir}/resource-capability/context/AGENTS.md`, "# Resource Capability\n");
				yield* fs.writeFileString(
					`${targetDir}/resource-capability/${CAPABILITY_MANIFEST_NAME}`,
					JSON.stringify({
						id: "local:resource-capability",
						name: "Resource Capability",
						resources: [
							{
								kind: "context",
								path: "context/AGENTS.md",
							},
						],
						checks: [
							{
								id: "context-present",
								kind: "path-exists",
								path: "context/AGENTS.md",
							},
						],
					}),
				);

				const added = yield* project.addCapability(targetDir, "./resource-capability", undefined);
				expect(added.capability.resolvedSource?.local?.manifestPath).toContain(CAPABILITY_MANIFEST_NAME);
				expect(added.capability.fingerprint?.kind).toBe("directory");
				expect(added.capability.fingerprint?.fileCount).toBe(2);
				expect(added.materialization?.copied.map((resource) => resource.target)).toEqual(["context/AGENTS.md"]);
				expect(added.materialization?.issues).toEqual([]);

				const lockfile = yield* project.inspectCapability(targetDir, "local:resource-capability");
				expect(lockfile.fingerprint?.sha256).toBe(added.capability.fingerprint?.sha256);

				const materialized = yield* fs.readFileString(
					`${targetDir}/.harnessy/capabilities/local-resource-capability/resources/context/AGENTS.md`,
				);
				expect(materialized).toBe("# Resource Capability\n");

				const verify = yield* project.verify(targetDir);
				expect(verify.checks?.results.map((result) => [result.checkId, result.status])).toEqual([
					["context-present", "passed"],
				]);
				expect(verify.issues).toEqual([]);
			}),
		),
	);

	it.effect("refreshes materialized resources and fingerprints on demand", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);
				yield* fs.makeDirectory(`${targetDir}/refresh-capability/context`, { recursive: true });
				yield* fs.writeFileString(`${targetDir}/refresh-capability/context/AGENTS.md`, "# Before\n");
				yield* fs.writeFileString(
					`${targetDir}/refresh-capability/${CAPABILITY_MANIFEST_NAME}`,
					JSON.stringify({
						id: "local:refresh-capability",
						name: "Refresh Capability",
						resources: [{ kind: "context", path: "context/AGENTS.md" }],
					}),
				);

				const added = yield* project.addCapability(targetDir, "./refresh-capability", undefined);
				const originalFingerprint = added.capability.fingerprint?.sha256;
				yield* fs.writeFileString(`${targetDir}/refresh-capability/context/AGENTS.md`, "# After\n");

				const dryRun = yield* project.materializeCapabilities(targetDir, "local:refresh-capability", {
					dryRun: true,
					refresh: true,
				});
				expect(dryRun.dryRun).toBe(true);
				expect(dryRun.results[0]?.copied.map((resource) => resource.target)).toEqual(["context/AGENTS.md"]);
				expect(dryRun.capabilities[0]?.fingerprint?.sha256).not.toBe(originalFingerprint);
				expect(
					yield* fs.readFileString(
						`${targetDir}/.harnessy/capabilities/local-refresh-capability/resources/context/AGENTS.md`,
					),
				).toBe("# Before\n");

				const refreshed = yield* project.materializeCapabilities(targetDir, "local:refresh-capability", {
					refresh: true,
				});
				expect(refreshed.issues).toEqual([]);
				expect(
					yield* fs.readFileString(
						`${targetDir}/.harnessy/capabilities/local-refresh-capability/resources/context/AGENTS.md`,
					),
				).toBe("# After\n");
				const inspected = yield* project.inspectCapability(targetDir, "local:refresh-capability");
				expect(inspected.fingerprint?.sha256).toBe(refreshed.capabilities[0]?.fingerprint?.sha256);
			}),
		),
	);

	it.effect("retries materialization for duplicate capability records", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(targetDir, false);
				yield* fs.makeDirectory(`${targetDir}/retry-capability/context`, { recursive: true });
				yield* fs.writeFileString(`${targetDir}/retry-capability/context/AGENTS.md`, "# Retry Capability\n");

				const capability = new CapabilityEntry({
					id: "local:retry-capability",
					source: new CapabilitySource({ type: "local", value: "./retry-capability" }),
					addedAt: "2026-01-01T00:00:00.000Z",
					manifest: new CapabilityManifest({
						id: "local:retry-capability",
						name: "Retry Capability",
						resources: [
							new CapabilityResource({
								kind: "context",
								path: "context/AGENTS.md",
							}),
						],
					}),
				});
				const initialLockfileText = yield* fs.readFileString(init.paths.lockfile);
				const initialLockfile = yield* parseLockfile(initialLockfileText, init.paths.lockfile);
				yield* fs.writeFileString(
					init.paths.lockfile,
					formatLockfile(new HarnessLockfile({ ...initialLockfile, capabilities: [capability] })),
				);

				const artifactPath = `${targetDir}/.harnessy/capabilities/local-retry-capability/resources/context/AGENTS.md`;
				expect(yield* fs.exists(artifactPath)).toBe(false);

				const duplicate = yield* project.addCapability(targetDir, "./retry-capability", undefined);

				expect(duplicate.added).toBe(false);
				expect(duplicate.manifestPath).not.toBeNull();
				expect(duplicate.capability.resolvedSource?.local?.manifestPath).toContain(CAPABILITY_MANIFEST_NAME);
				expect(duplicate.capability.fingerprint?.kind).toBe("directory");
				expect(duplicate.capability.fingerprint?.fileCount).toBe(1);
				expect(duplicate.materialization?.copied.map((resource) => resource.target)).toEqual(["context/AGENTS.md"]);
				expect(yield* fs.readFileString(artifactPath)).toBe("# Retry Capability\n");
			}),
		),
	);

	it.effect("reports manifest-defined required check failures during verify", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);
				yield* fs.makeDirectory(`${targetDir}/check-capability`, { recursive: true });
				yield* fs.writeFileString(
					`${targetDir}/check-capability/${CAPABILITY_MANIFEST_NAME}`,
					JSON.stringify({
						id: "local:check-capability",
						name: "Check Capability",
						checks: [
							{
								id: "missing-required-file",
								kind: "path-exists",
								path: "missing.md",
								required: true,
							},
						],
					}),
				);

				yield* project.addCapability(targetDir, "./check-capability", undefined);
				const verify = yield* project.verify(targetDir);

				expect(verify.checks?.requiredFailures.map((result) => result.checkId)).toEqual(["missing-required-file"]);
				expect(verify.issues).toContain(
					"Required capability check failed for local:check-capability/missing-required-file: Path does not exist: missing.md",
				);
			}),
		),
	);

	it.effect("fails through the typed error channel for malformed local capability manifests", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);
				yield* fs.makeDirectory(`${targetDir}/bad-capability`);
				yield* fs.writeFileString(`${targetDir}/bad-capability/${CAPABILITY_MANIFEST_NAME}`, "{}");

				const error = yield* Effect.flip(project.addCapability(targetDir, "./bad-capability", undefined));
				expect(error.message).toContain("Invalid Harnessy capability manifest");
			}),
		),
	);

	it.effect("reports missing local capability paths without throwing", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				yield* project.init(targetDir, false);
				yield* project.addCapability(targetDir, "./missing-capability", undefined);

				const verify = yield* project.verify(targetDir);
				expect(verify.issues).toHaveLength(1);
				expect(verify.issues[0]).toContain("missing-capability");
			}),
		),
	);

	it.effect("reports missing profile context paths", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(targetDir, false);
				yield* fs.writeFileString(
					init.paths.defaultProfile,
					JSON.stringify({ name: "default", context: ["missing-context.md"], capabilities: [] }),
				);

				const verify = yield* project.verify(targetDir);
				expect(verify.issues).toContain("Profile context path does not exist: missing-context.md");
			}),
		),
	);

	it.effect("reports profile capability ids that are not in the lockfile", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(targetDir, false);
				yield* fs.writeFileString(
					init.paths.defaultProfile,
					JSON.stringify({
						name: "default",
						context: [".harnessy/context/AGENTS.md"],
						capabilities: ["npm:missing"],
					}),
				);

				const verify = yield* project.verify(targetDir);
				expect(verify.issues).toContain("Profile references missing capability: npm:missing");
			}),
		),
	);

	it.effect("fails through the typed error channel for malformed profiles", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(targetDir, false);
				yield* fs.writeFileString(init.paths.defaultProfile, "{");

				const error = yield* Effect.flip(project.verify(targetDir));
				expect(error.message).toContain("Invalid Harnessy profile");
			}),
		),
	);
});
