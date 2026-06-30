import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";

import { CAPABILITY_MANIFEST_NAME, CapabilityManifest, DependencyRequirement } from "../src/capabilities/manifest.ts";
import { CapabilityEntry, CapabilitySource } from "../src/capabilities/source.ts";
import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";
import { DependencyCheckResult } from "../src/runtime/dependency-checker.ts";
import { HarnessLockfile } from "../src/runtime/lockfile.ts";
import { ExistingHarnessState, ProjectInfo } from "../src/runtime/project-detection.ts";
import {
	renderCapabilityInspectJson,
	renderDepsCheckJson,
	renderDoctorJson,
	renderVerifyJson,
	type StructuredCapabilityInspectOutput,
	type StructuredCapabilityMaterializeOutput,
	type StructuredDepsCheckOutput,
	type StructuredDoctorOutput,
	type StructuredVerifyOutput,
} from "../src/structured-output.ts";

const capability = new CapabilityEntry({
	id: "local:tiny-capability",
	source: new CapabilitySource({ type: "local", value: "./tiny-capability" }),
	addedAt: "2026-01-01T00:00:00.000Z",
	manifest: new CapabilityManifest({
		id: "local:tiny-capability",
		name: "Tiny Capability",
		version: "0.1.0",
		description: "Fixture capability.",
		context: ["context/AGENTS.md"],
		dependencies: [
			new DependencyRequirement({
				kind: "tool",
				name: "tiny-tool",
				command: "tiny-tool",
				required: true,
				install: { fallback: "install tiny-tool" },
			}),
		],
		blastRadius: "low",
		permissions: ["context:read"],
		dataCategories: ["project_context"],
		egress: [],
	}),
});

describe("structured output render helpers", () => {
	it("renders verify envelopes with issue state and lockfile payload", () => {
		const lockfile = new HarnessLockfile({
			version: 1,
			harnessDir: ".harnessy",
			contextDir: ".harnessy/context",
			profile: ".harnessy/profiles/default.json",
			capabilities: [capability],
		});
		const parsed = JSON.parse(
			renderVerifyJson("./demo", { lockfile, issues: ["Missing context file"] }),
		) as StructuredVerifyOutput;

		expect(parsed).toEqual({
			command: "verify",
			ok: false,
			target: "./demo",
			issues: ["Missing context file"],
			lockfile: {
				version: 1,
				harnessDir: ".harnessy",
				contextDir: ".harnessy/context",
				profile: ".harnessy/profiles/default.json",
				capabilityCount: 1,
				capabilities: [
					{
						id: "local:tiny-capability",
						source: { type: "local", value: "./tiny-capability" },
						addedAt: "2026-01-01T00:00:00.000Z",
						manifest: {
							id: "local:tiny-capability",
							name: "Tiny Capability",
							version: "0.1.0",
							description: "Fixture capability.",
							context: ["context/AGENTS.md"],
							dependencies: [
								{
									kind: "tool",
									name: "tiny-tool",
									command: "tiny-tool",
									required: true,
									install: { fallback: "install tiny-tool" },
								},
							],
							blastRadius: "low",
							permissions: ["context:read"],
							dataCategories: ["project_context"],
							egress: [],
						},
					},
				],
			},
		});
	});

	it("renders doctor envelopes with diagnostics and project payload", () => {
		const parsed = JSON.parse(
			renderDoctorJson(".", {
				version: "0.0.3",
				paths: {
					targetDir: "/tmp/demo",
					harnessDir: "/tmp/demo/.harnessy",
					lockfile: "/tmp/demo/.harnessy/harnessy.lock.json",
					contextDir: "/tmp/demo/.harnessy/context",
					contextAgentsFile: "/tmp/demo/.harnessy/context/AGENTS.md",
					profilesDir: "/tmp/demo/.harnessy/profiles",
					defaultProfile: "/tmp/demo/.harnessy/profiles/default.json",
					capabilitiesDir: "/tmp/demo/.harnessy/capabilities",
					memoryDir: "/tmp/demo/.harnessy/memory",
				},
				lockfileExists: true,
				contextExists: true,
				profileExists: true,
				capabilityCount: 1,
				project: new ProjectInfo({
					root: "/tmp/demo",
					name: "demo",
					version: "1.0.0",
					packageManager: "npm",
					monorepo: null,
					apps: [],
					packages: [],
					tools: [],
					gitOrg: null,
					gitRepo: null,
					existing: new ExistingHarnessState({
						agentsMd: false,
						harnessDir: true,
						harnessLockfile: true,
						jarvisContext: false,
						agentsDir: false,
						pluginsOpencode: false,
						scopesYaml: false,
					}),
				}),
			}),
		) as StructuredDoctorOutput;

		expect(parsed.command).toBe("doctor");
		expect(parsed.ok).toBe(true);
		expect(parsed.target).toBe(".");
		expect(parsed.paths.targetDir).toBe("/tmp/demo");
		expect(parsed.project).toMatchObject({
			name: "demo",
			packageManager: "npm",
			existing: { harnessLockfile: true },
		});
	});

	it("renders dependency check envelopes with missing-required status", () => {
		const missing = new DependencyCheckResult({
			capabilityId: "local:tiny-capability",
			kind: "tool",
			name: "tiny-tool",
			required: true,
			status: "missing",
			command: "tiny-tool",
			installCommand: "install tiny-tool",
		});
		const parsed = JSON.parse(
			renderDepsCheckJson("./demo", { results: [missing], missingRequired: [missing] }),
		) as StructuredDepsCheckOutput;

		expect(parsed).toEqual({
			command: "deps check",
			ok: false,
			target: "./demo",
			results: [
				{
					capabilityId: "local:tiny-capability",
					kind: "tool",
					name: "tiny-tool",
					required: true,
					status: "missing",
					command: "tiny-tool",
					installCommand: "install tiny-tool",
				},
			],
			missingRequired: [
				{
					capabilityId: "local:tiny-capability",
					kind: "tool",
					name: "tiny-tool",
					required: true,
					status: "missing",
					command: "tiny-tool",
					installCommand: "install tiny-tool",
				},
			],
		});
	});

	it("renders capability inspect envelopes", () => {
		const parsed = JSON.parse(renderCapabilityInspectJson("./demo", capability)) as StructuredCapabilityInspectOutput;

		expect(parsed.command).toBe("capability inspect");
		expect(parsed.ok).toBe(true);
		expect(parsed.capability.id).toBe("local:tiny-capability");
		expect(parsed.capability.manifest?.dependencies?.[0]?.install).toEqual({ fallback: "install tiny-tool" });
	});
});

describe("Harnessy CLI JSON output", () => {
	it.live("runs verify --json through Command.runWith", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

				yield* run(["init", "--target", targetDir]);
				yield* run(["verify", "--json", "--target", targetDir]);

				const logs = yield* TestConsole.logLines;
				const jsonLog = logs.find(
					(logged): logged is string => typeof logged === "string" && logged.includes('"command": "verify"'),
				);
				if (jsonLog === undefined) {
					throw new Error("verify --json did not emit structured output");
				}
				const parsed = JSON.parse(jsonLog) as StructuredVerifyOutput;
				expect(parsed.command).toBe("verify");
				expect(parsed.ok).toBe(true);
				expect(parsed.target).toBe(targetDir);
				expect(parsed.issues).toEqual([]);
				expect(parsed.lockfile.capabilityCount).toBe(0);
			}),
		).pipe(
			Effect.provide(HarnessProject.layer),
			Effect.provide(NodeServices.layer),
			Effect.provide(TestConsole.layer),
		),
	);

	it.live("emits verify --json before failing when verification finds issues", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

				yield* run(["init", "--target", targetDir]);
				yield* fs.remove(`${targetDir}/.harnessy/context/AGENTS.md`);
				yield* Effect.flip(run(["verify", "--json", "--target", targetDir]));

				const logs = yield* TestConsole.logLines;
				const jsonLogs = logs.filter(
					(logged): logged is string => typeof logged === "string" && logged.includes('"command": "verify"'),
				);
				const jsonLog = jsonLogs.at(-1);
				if (jsonLog === undefined) {
					throw new Error("failing verify --json did not emit structured output");
				}
				const parsed = JSON.parse(jsonLog) as StructuredVerifyOutput;
				expect(parsed.ok).toBe(false);
				expect(parsed.issues).toContain(`Missing context file: ${targetDir}/.harnessy/context/AGENTS.md`);
			}),
		).pipe(
			Effect.provide(HarnessProject.layer),
			Effect.provide(NodeServices.layer),
			Effect.provide(TestConsole.layer),
		),
	);

	it.live("runs capability materialize --json through Command.runWith", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });
				yield* fs.makeDirectory(`${targetDir}/json-capability/context`, { recursive: true });
				yield* fs.writeFileString(`${targetDir}/json-capability/context/AGENTS.md`, "# JSON Capability\n");
				yield* fs.writeFileString(
					`${targetDir}/json-capability/${CAPABILITY_MANIFEST_NAME}`,
					JSON.stringify({
						id: "local:json-capability",
						name: "JSON Capability",
						resources: [{ kind: "context", path: "context/AGENTS.md" }],
					}),
				);

				yield* run(["init", "--target", targetDir]);
				yield* run(["capability", "add", "./json-capability", "--target", targetDir]);
				yield* run([
					"capability",
					"materialize",
					"local:json-capability",
					"--refresh",
					"--dry-run",
					"--json",
					"--target",
					targetDir,
				]);

				const logs = yield* TestConsole.logLines;
				const jsonLog = logs.find(
					(logged): logged is string =>
						typeof logged === "string" && logged.includes('"command": "capability materialize"'),
				);
				if (jsonLog === undefined) {
					throw new Error("capability materialize --json did not emit structured output");
				}
				const parsed = JSON.parse(jsonLog) as StructuredCapabilityMaterializeOutput;
				expect(parsed.ok).toBe(true);
				expect(parsed.dryRun).toBe(true);
				expect(parsed.refresh).toBe(true);
				expect(parsed.results[0]?.copied.map((resource) => resource.target)).toEqual(["context/AGENTS.md"]);
				expect(parsed.capabilities[0]?.resolvedSource?.local?.manifestPath).toContain(CAPABILITY_MANIFEST_NAME);
				expect(parsed.capabilities[0]?.fingerprint?.fileCount).toBe(2);
			}),
		).pipe(
			Effect.provide(HarnessProject.layer),
			Effect.provide(NodeServices.layer),
			Effect.provide(TestConsole.layer),
		),
	);
});
