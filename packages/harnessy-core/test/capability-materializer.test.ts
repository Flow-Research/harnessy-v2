import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { CapabilityManifest, CapabilityResource } from "../src/capabilities/manifest.ts";
import { CapabilityMaterializer } from "../src/capabilities/materializer.ts";
import { CapabilityEntry, CapabilitySource } from "../src/capabilities/source.ts";
import { pathsForTarget } from "../src/paths.ts";

/** Provide the live materializer plus Node platform services for filesystem-backed tests. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(CapabilityMaterializer.layer), Effect.provide(NodeServices.layer));

const localCapability = (id: string, source: string, manifest: CapabilityManifest | undefined): CapabilityEntry =>
	new CapabilityEntry({
		id,
		source: new CapabilitySource({ type: "local", value: source }),
		addedAt: "2026-01-01T00:00:00.000Z",
		...(manifest === undefined ? {} : { manifest }),
	});

describe("CapabilityMaterializer", () => {
	it.effect("copies file and directory resources into a safe capability artifact", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const paths = yield* pathsForTarget(targetDir);
				const sourceRoot = `${targetDir}/demo-capability`;
				yield* fs.makeDirectory(`${sourceRoot}/context`, { recursive: true });
				yield* fs.makeDirectory(`${sourceRoot}/tools`, { recursive: true });
				yield* fs.makeDirectory(`${sourceRoot}/skills/tiny`, { recursive: true });
				yield* fs.writeFileString(`${sourceRoot}/context/AGENTS.md`, "# Demo Context\n");
				yield* fs.writeFileString(`${sourceRoot}/tools/run.sh`, "#!/bin/sh\necho demo\n");
				yield* fs.chmod(`${sourceRoot}/tools/run.sh`, 0o644);
				yield* fs.writeFileString(`${sourceRoot}/skills/tiny/README.md`, "# Tiny Skill\n");

				const capability = localCapability(
					"local:Demo Capability",
					"./demo-capability",
					new CapabilityManifest({
						id: "local:Demo Capability",
						name: "Demo Capability",
						resources: [
							new CapabilityResource({ kind: "context", path: "context/AGENTS.md" }),
							new CapabilityResource({
								kind: "script",
								path: "tools/run.sh",
								target: "bin/run",
								executable: true,
							}),
							new CapabilityResource({ kind: "skill", path: "skills/tiny", target: "skills/tiny" }),
						],
					}),
				);

				const materializer = yield* CapabilityMaterializer;
				const result = yield* materializer.materialize(paths, capability);
				const artifactDir = `${paths.capabilitiesDir}/local-demo-capability`;

				expect(result.artifactDir).toBe(artifactDir);
				expect(result.copied.map((resource) => resource.target)).toEqual([
					"context/AGENTS.md",
					"bin/run",
					"skills/tiny",
				]);
				expect(result.skipped).toEqual([]);
				expect(result.issues).toEqual([]);
				expect(yield* fs.readFileString(`${artifactDir}/resources/context/AGENTS.md`)).toBe("# Demo Context\n");
				expect(yield* fs.readFileString(`${artifactDir}/resources/bin/run`)).toBe("#!/bin/sh\necho demo\n");
				expect(yield* fs.readFileString(`${artifactDir}/resources/skills/tiny/README.md`)).toBe("# Tiny Skill\n");

				const scriptStat = yield* fs.stat(`${artifactDir}/resources/bin/run`);
				expect(scriptStat.mode & 0o111).not.toBe(0);
			}),
		),
	);

	it.effect("succeeds without writes when a capability has no manifest resources", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const paths = yield* pathsForTarget(targetDir);
				const capability = localCapability("local:no-resources", "./missing-capability", undefined);

				const materializer = yield* CapabilityMaterializer;
				const result = yield* materializer.materialize(paths, capability);

				expect(result.copied).toEqual([]);
				expect(result.skipped).toEqual([]);
				expect(result.issues).toEqual([]);
				expect(yield* fs.exists(result.artifactDir)).toBe(false);
			}),
		),
	);

	it.effect("skips remote capability resources without fetching", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const paths = yield* pathsForTarget(targetDir);
				const capability = new CapabilityEntry({
					id: "npm:demo-capability",
					source: new CapabilitySource({ type: "npm", value: "@harnessy/capability-demo" }),
					addedAt: "2026-01-01T00:00:00.000Z",
					manifest: new CapabilityManifest({
						id: "npm:demo-capability",
						name: "Demo Capability",
						resources: [new CapabilityResource({ kind: "context", path: "context/AGENTS.md" })],
					}),
				});

				const materializer = yield* CapabilityMaterializer;
				const result = yield* materializer.materialize(paths, capability);

				expect(result.copied).toEqual([]);
				expect(result.skipped.map((resource) => resource.path)).toEqual(["context/AGENTS.md"]);
				expect(result.issues).toHaveLength(1);
				expect(result.issues[0]).toContain("remote or unresolved");
				expect(yield* fs.exists(result.artifactDir)).toBe(false);
			}),
		),
	);

	it.effect("skips resources that would escape source or artifact boundaries", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const targetDir = yield* fs.makeTempDirectoryScoped();
				const paths = yield* pathsForTarget(targetDir);
				const sourceRoot = `${targetDir}/bounded-capability`;
				yield* fs.makeDirectory(`${sourceRoot}/docs`, { recursive: true });
				yield* fs.writeFileString(`${sourceRoot}/docs/in-root.md`, "safe\n");
				yield* fs.writeFileString(`${targetDir}/outside.md`, "outside\n");

				const sourceEscape = Object.assign(new CapabilityResource({ kind: "context", path: "docs/in-root.md" }), {
					path: "../outside.md",
					target: "outside.md",
				});
				const targetEscape = Object.assign(new CapabilityResource({ kind: "context", path: "docs/in-root.md" }), {
					target: "../../outside-target.md",
				});
				const capability = localCapability(
					"local:bounded-capability",
					"./bounded-capability",
					new CapabilityManifest({
						id: "local:bounded-capability",
						name: "Bounded Capability",
						resources: [sourceEscape, targetEscape],
					}),
				);

				const materializer = yield* CapabilityMaterializer;
				const result = yield* materializer.materialize(paths, capability);

				expect(result.copied).toEqual([]);
				expect(result.skipped.map((resource) => resource.path)).toEqual(["../outside.md", "docs/in-root.md"]);
				expect(result.issues[0]).toContain("escapes capability root");
				expect(result.issues[1]).toContain("escapes capability artifact resources");
				expect(yield* fs.exists(`${paths.capabilitiesDir}/outside-target.md`)).toBe(false);
			}),
		),
	);
});
