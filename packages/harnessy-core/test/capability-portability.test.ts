import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";

import { CAPABILITY_MANIFEST_NAME } from "../src/capabilities/manifest.ts";
import { CapabilityRegistry } from "../src/capabilities/registry.ts";
import { CapabilityEntry, CapabilitySource } from "../src/capabilities/source.ts";
import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { HarnessProject } from "../src/operations.ts";
import { formatLockfile, HarnessLockfile, parseLockfile } from "../src/runtime/lockfile.ts";
import { LockfileStore } from "../src/runtime/lockfile-store.ts";
import { HarnessProfile } from "../src/runtime/profile.ts";
import { ProfileStore } from "../src/runtime/profile-store.ts";

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(HarnessProject.layer), Effect.provide(NodeServices.layer));

const writeManifest = (fs: FileSystem.FileSystem, directory: string, manifest: Readonly<Record<string, unknown>>) =>
	fs.writeFileString(`${directory}/${CAPABILITY_MANIFEST_NAME}`, `${JSON.stringify(manifest, null, "\t")}\n`);

const portableManifest = (resources: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
	id: "local:portable",
	name: "Portable Capability",
	version: "1.0.0",
	resources,
	checks: [{ id: "script-present", kind: "path-exists", path: "bin/run.sh" }],
});

describe("capability portability lifecycle", () => {
	it.effect("creates only a validated manifest and requires explicit force for replacement", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const target = yield* fs.makeTempDirectoryScoped();
				yield* project.init(target, false);

				const created = yield* project.createCapability(target, "created-pack", {
					id: "local:created",
					name: "Created",
				});
				const original = yield* fs.readFileString(created.manifestPath);
				expect(JSON.parse(original)).toEqual({ id: "local:created", name: "Created" });
				expect(yield* fs.readDirectory(created.directory)).toEqual([CAPABILITY_MANIFEST_NAME]);
				expect(
					(yield* Effect.flip(
						project.createCapability(target, "created-pack", {
							id: "local:replacement",
							name: "Replacement",
						}),
					)).message,
				).toContain("Destination already exists");
				yield* project.createCapability(target, "created-pack", {
					id: "local:replacement",
					name: "Replacement",
					force: true,
					dryRun: true,
				});
				expect(yield* fs.readFileString(created.manifestPath)).toBe(original);
				yield* project.createCapability(target, "created-pack", {
					id: "local:replacement",
					name: "Replacement",
					force: true,
				});
				expect(JSON.parse(yield* fs.readFileString(created.manifestPath))).toEqual({
					id: "local:replacement",
					name: "Replacement",
				});
				expect(
					(yield* Effect.flip(
						project.createCapability(target, "../escape", {
							id: "local:escape",
							name: "Escape",
						}),
					)).message,
				).toContain("must be below");
			}),
		),
	);

	it.live("round-trips an installed pack through the real CLI after the original source is removed", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const projectA = yield* fs.makeTempDirectoryScoped();
				const projectB = yield* fs.makeTempDirectoryScoped();
				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });

				yield* run(["init", "--target", projectA]);
				yield* run([
					"capability",
					"create",
					"portable-pack",
					"--id",
					"local:portable",
					"--name",
					"Portable Capability",
					"--version",
					"1.0.0",
					"--target",
					projectA,
				]);
				const source = `${projectA}/portable-pack`;
				yield* fs.makeDirectory(`${source}/bin`, { recursive: true });
				yield* fs.writeFileString(`${source}/bin/run.sh`, "#!/bin/sh\necho portable\n");
				yield* fs.chmod(`${source}/bin/run.sh`, 0o644);
				yield* writeManifest(
					fs,
					source,
					portableManifest([{ kind: "script", path: "bin/run.sh", executable: true }]),
				);

				yield* run(["capability", "add", "./portable-pack", "--target", projectA]);
				yield* run(["capability", "activate", "local:portable", "--target", projectA]);
				yield* run(["verify", "--target", projectA]);

				const installedA = yield* project.inspectCapability(projectA, "local:portable");
				expect(installedA.artifact).toBeDefined();
				yield* fs.writeFileString(`${source}/bin/run.sh`, "#!/bin/sh\necho mutated-source\n");
				yield* fs.remove(source, { recursive: true });
				yield* run(["verify", "--target", projectA]);
				yield* run(["capability", "export", "local:portable", "--out", "exported-pack", "--target", projectA]);
				const exported = `${projectA}/exported-pack`;
				expect(yield* fs.readFileString(`${exported}/bin/run.sh`)).toBe("#!/bin/sh\necho portable\n");

				yield* run(["init", "--target", projectB]);
				yield* run(["capability", "add", exported, "--target", projectB]);
				yield* run(["capability", "activate", "local:portable", "--target", projectB]);
				yield* run(["verify", "--target", projectB]);
				yield* run(["capability", "deactivate", "local:portable", "--target", projectB]);
				expect((yield* project.verify(projectB)).checks?.results).toEqual([]);
				yield* run(["capability", "activate", "local:portable", "--target", projectB]);
				yield* run(["verify", "--target", projectB]);

				const installedB = yield* project.inspectCapability(projectB, "local:portable");
				expect(installedB.artifact?.sha256).toBe(installedA.artifact?.sha256);
				expect(installedB.artifact?.bytes).toBe(installedA.artifact?.bytes);
				expect(installedB.artifact?.fileCount).toBe(installedA.artifact?.fileCount);
				expect(
					yield* fs.readFileString(`${projectB}/.harnessy/capabilities/local-portable/package/bin/run.sh`),
				).toBe("#!/bin/sh\necho portable\n");
				const exportedMode = (yield* fs.stat(`${exported}/bin/run.sh`)).mode;
				const installedMode = (yield* fs.stat(
					`${projectB}/.harnessy/capabilities/local-portable/package/bin/run.sh`,
				)).mode;
				expect(exportedMode & 0o111).not.toBe(0);
				expect(installedMode & 0o111).not.toBe(0);

				const logs = (yield* TestConsole.logLines).filter((logged): logged is string => typeof logged === "string");
				expect(logs).toContain(`Created capability pack: ${source}`);
				expect(logs).toContain("Marked capability activated: local:portable");
				expect(logs).toContain("Marked capability deactivated: local:portable");
				expect(logs).toContain(`Exported capability local:portable: ${exported}`);
				expect(logs.filter((line) => line.startsWith("Harnessy verify passed"))).toHaveLength(4);
			}),
		).pipe(
			Effect.provide(HarnessProject.layer),
			Effect.provide(NodeServices.layer),
			Effect.provide(TestConsole.layer),
		),
	);

	it.effect("refreshes the full manifest atomically while dry-run and idempotent activation do not mutate", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const target = yield* fs.makeTempDirectoryScoped();
				const source = `${target}/portable-pack`;
				yield* project.init(target, false);
				yield* fs.makeDirectory(`${source}/docs`, { recursive: true });
				yield* fs.writeFileString(`${source}/docs/old.md`, "old\n");
				yield* writeManifest(fs, source, {
					id: "local:portable",
					name: "Portable Capability",
					resources: [{ kind: "context", path: "docs/old.md" }],
					checks: [{ id: "old-present", kind: "path-exists", path: "docs/old.md" }],
				});
				yield* project.addCapability(target, "./portable-pack", undefined);

				const inactiveVerify = yield* project.verify(target);
				expect(inactiveVerify.checks?.results).toEqual([]);
				const firstActivation = yield* project.activateCapability(target, "local:portable");
				const secondActivation = yield* project.activateCapability(target, "local:portable");
				expect(firstActivation.changed).toBe(true);
				expect(secondActivation.changed).toBe(false);
				expect((yield* project.verify(target)).checks?.results.map((result) => result.checkId)).toEqual([
					"old-present",
				]);

				const lockfilePath = `${target}/.harnessy/harnessy.lock.json`;
				const artifactRoot = `${target}/.harnessy/capabilities/local-portable`;
				const lockBefore = yield* fs.readFileString(lockfilePath);
				yield* fs.writeFileString(`${source}/docs/new.md`, "new\n");
				yield* writeManifest(fs, source, {
					id: "local:portable",
					name: "Portable Capability",
					version: "2.0.0",
					resources: [{ kind: "context", path: "docs/new.md" }],
					checks: [{ id: "new-present", kind: "path-exists", path: "docs/new.md" }],
				});
				yield* project.materializeCapabilities(target, "local:portable", { dryRun: true, refresh: true });
				expect(yield* fs.readFileString(lockfilePath)).toBe(lockBefore);
				expect(yield* fs.exists(`${artifactRoot}/package/docs/old.md`)).toBe(true);
				expect(yield* fs.exists(`${artifactRoot}/package/docs/new.md`)).toBe(false);

				const refreshed = yield* project.materializeCapabilities(target, "local:portable", { refresh: true });
				expect(refreshed.capabilities[0]?.manifest?.version).toBe("2.0.0");
				expect(yield* fs.exists(`${artifactRoot}/package/docs/old.md`)).toBe(false);
				expect(yield* fs.exists(`${artifactRoot}/resources/docs/old.md`)).toBe(false);
				expect(yield* fs.readFileString(`${artifactRoot}/package/docs/new.md`)).toBe("new\n");
				expect((yield* project.verify(target)).checks?.results.map((result) => result.checkId)).toEqual([
					"new-present",
				]);

				const firstDeactivation = yield* project.deactivateCapability(target, "local:portable");
				const secondDeactivation = yield* project.deactivateCapability(target, "local:portable");
				expect(firstDeactivation.changed).toBe(true);
				expect(secondDeactivation.changed).toBe(false);
				expect((yield* project.verify(target)).checks?.results).toEqual([]);
			}),
		),
	);

	it.effect("fails remote lifecycle operations closed without mutating the lockfile", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const target = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(target, false);
				const initial = yield* fs.readFileString(init.paths.lockfile);

				for (const remote of [
					"https://example.com/acme/pack.git",
					"npm:@acme/pack",
					"https://example.com/pack.tgz",
				]) {
					const error = yield* Effect.flip(project.addCapability(target, remote, undefined));
					expect(error.message).toContain("remote fetching is not supported");
					expect(yield* fs.readFileString(init.paths.lockfile)).toBe(initial);
				}

				const parsed = yield* parseLockfile(initial, init.paths.lockfile);
				const remoteEntry = new CapabilityEntry({
					id: "npm:@acme/pack",
					source: new CapabilitySource({ type: "npm", value: "@acme/pack" }),
					addedAt: "2026-01-01T00:00:00.000Z",
				});
				const unresolved = formatLockfile(new HarnessLockfile({ ...parsed, capabilities: [remoteEntry] }));
				yield* fs.writeFileString(init.paths.lockfile, unresolved);
				const materializeError = yield* Effect.flip(
					project.materializeCapabilities(target, undefined, { refresh: true }),
				);
				expect(materializeError.message).toContain("unresolved npm source");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(unresolved);
				const verify = yield* project.verify(target);
				expect(verify.issues).toContain(
					"Capability npm:@acme/pack has unresolved npm source; remote fetching is not supported.",
				);
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(unresolved);
			}),
		),
	);

	it.effect("rejects unsafe packs and tampered artifacts through typed failures without false success", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const target = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(target, false);
				const safe = `${target}/safe-pack`;
				yield* fs.makeDirectory(`${safe}/docs`, { recursive: true });
				yield* fs.writeFileString(`${safe}/docs/readme.md`, "safe\n");
				yield* writeManifest(fs, safe, {
					id: "local:safe",
					name: "Safe",
					resources: [{ kind: "context", path: "docs/readme.md" }],
				});
				yield* project.addCapability(target, "./safe-pack", undefined);
				const lockBefore = yield* fs.readFileString(init.paths.lockfile);
				const safeArtifact = `${target}/.harnessy/capabilities/local-safe/package/docs/readme.md`;

				const missing = `${target}/missing-pack`;
				yield* fs.makeDirectory(missing);
				yield* writeManifest(fs, missing, {
					id: "local:missing",
					name: "Missing",
					resources: [{ kind: "context", path: "missing.md" }],
				});
				expect((yield* Effect.flip(project.addCapability(target, "./missing-pack", undefined))).message).toContain(
					"does not exist",
				);
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);
				expect(yield* fs.readFileString(safeArtifact)).toBe("safe\n");

				const traversal = `${target}/traversal-pack`;
				yield* fs.makeDirectory(traversal);
				yield* writeManifest(fs, traversal, {
					id: "local:traversal",
					name: "Traversal",
					resources: [{ kind: "context", path: "../outside.md" }],
				});
				expect(
					(yield* Effect.flip(project.addCapability(target, "./traversal-pack", undefined))).message,
				).toContain("Invalid Harnessy capability manifest");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);

				const collision = `${target}/collision-pack`;
				yield* fs.makeDirectory(`${collision}/docs`, { recursive: true });
				yield* fs.writeFileString(`${collision}/docs/one.md`, "one\n");
				yield* fs.writeFileString(`${collision}/docs/two.md`, "two\n");
				yield* writeManifest(fs, collision, {
					id: "local:collision",
					name: "Collision",
					resources: [
						{ kind: "context", path: "docs/one.md", target: "same.md" },
						{ kind: "context", path: "docs/two.md", target: "same.md" },
					],
				});
				expect(
					(yield* Effect.flip(project.addCapability(target, "./collision-pack", undefined))).message,
				).toContain("colliding projection targets");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);

				const real = `${target}/real-pack`;
				yield* fs.makeDirectory(real);
				yield* writeManifest(fs, real, { id: "local:linked", name: "Linked" });
				yield* fs.symlink(real, `${target}/linked-pack`);
				expect((yield* Effect.flip(project.addCapability(target, "./linked-pack", undefined))).message).toContain(
					"symbolic link",
				);
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);

				const external = yield* fs.makeTempDirectoryScoped();
				yield* fs.symlink(external, `${target}/linked-parent`);
				expect(
					(yield* Effect.flip(
						project.createCapability(target, "linked-parent/unsafe", {
							id: "local:unsafe",
							name: "Unsafe",
						}),
					)).message,
				).toContain("symbolic link");
				expect(yield* fs.exists(`${external}/unsafe`)).toBe(false);
				expect(
					(yield* Effect.flip(project.exportCapability(target, "local:safe", "linked-parent/exported"))).message,
				).toContain("symbolic link");
				expect(yield* fs.exists(`${external}/exported`)).toBe(false);

				const existingExport = `${target}/existing-export`;
				yield* fs.makeDirectory(existingExport);
				yield* fs.writeFileString(`${existingExport}/marker.txt`, "keep\n");
				expect(
					(yield* Effect.flip(project.exportCapability(target, "local:safe", "existing-export"))).message,
				).toContain("Destination already exists");
				yield* project.exportCapability(target, "local:safe", "existing-export", {
					force: true,
					dryRun: true,
				});
				expect(yield* fs.readFileString(`${existingExport}/marker.txt`)).toBe("keep\n");

				yield* fs.writeFileString(safeArtifact, "tampered\n");
				const verify = yield* project.verify(target);
				expect(verify.issues).toContain("Capability local:safe installed artifact integrity mismatch.");
				const profileBefore = yield* fs.readFileString(init.paths.defaultProfile);
				expect((yield* Effect.flip(project.activateCapability(target, "local:safe"))).message).toContain(
					"integrity mismatch",
				);
				expect(yield* fs.readFileString(init.paths.defaultProfile)).toBe(profileBefore);
				expect(
					(yield* Effect.flip(project.exportCapability(target, "local:safe", "tampered-export"))).message,
				).toContain("integrity mismatch");

				yield* fs.writeFileString(
					`${target}/.harnessy/capabilities/local-safe/package/${CAPABILITY_MANIFEST_NAME}`,
					"{",
				);
				const corruptVerify = yield* project.verify(target);
				expect(corruptVerify.issues.some((issue) => issue.includes("Invalid Harnessy capability manifest"))).toBe(
					true,
				);
			}),
		),
	);

	it.effect("preflights multi-pack refresh and manifest id drift before changing authoritative state", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const target = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(target, false);
				for (const name of ["first", "second"]) {
					const source = `${target}/${name}`;
					yield* fs.makeDirectory(`${source}/docs`, { recursive: true });
					yield* fs.writeFileString(`${source}/docs/value.md`, `${name}-before\n`);
					yield* writeManifest(fs, source, {
						id: `local:${name}`,
						name,
						resources: [{ kind: "context", path: "docs/value.md" }],
					});
					yield* project.addCapability(target, `./${name}`, undefined);
				}

				const lockBefore = yield* fs.readFileString(init.paths.lockfile);
				const firstArtifact = `${target}/.harnessy/capabilities/local-first/package/docs/value.md`;
				const secondArtifact = `${target}/.harnessy/capabilities/local-second/package/docs/value.md`;
				yield* fs.writeFileString(`${target}/first/docs/value.md`, "first-after\n");
				yield* writeManifest(fs, `${target}/second`, {
					id: "local:second",
					name: "second",
					resources: [{ kind: "context", path: "docs/missing.md" }],
				});

				const partialError = yield* Effect.flip(
					project.materializeCapabilities(target, undefined, { refresh: true }),
				);
				expect(partialError.message).toContain("does not exist");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);
				expect(yield* fs.readFileString(firstArtifact)).toBe("first-before\n");
				expect(yield* fs.readFileString(secondArtifact)).toBe("second-before\n");

				yield* writeManifest(fs, `${target}/first`, {
					id: "local:renamed",
					name: "renamed",
					resources: [{ kind: "context", path: "docs/value.md" }],
				});
				const driftError = yield* Effect.flip(
					project.materializeCapabilities(target, "local:first", { refresh: true }),
				);
				expect(driftError.message).toContain("source manifest id changed to local:renamed");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);
				expect(yield* fs.readFileString(firstArtifact)).toBe("first-before\n");
			}),
		),
	);

	it.effect("rejects a symlinked installed-artifact ancestor without writing through it", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const target = yield* fs.makeTempDirectoryScoped();
				const external = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(target, false);
				const source = `${target}/pack`;
				yield* fs.makeDirectory(source);
				yield* writeManifest(fs, source, { id: "local:pack", name: "Pack" });
				yield* fs.remove(init.paths.capabilitiesDir, { recursive: true });
				yield* fs.symlink(external, init.paths.capabilitiesDir);
				const lockBefore = yield* fs.readFileString(init.paths.lockfile);

				const error = yield* Effect.flip(project.addCapability(target, "./pack", undefined));
				expect(error.message).toContain("symbolic link");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);
				expect(yield* fs.exists(`${external}/local-pack`)).toBe(false);
			}),
		),
	);

	it.effect("restores installed artifacts when lockfile metadata cannot be staged", () =>
		provideLive(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const project = yield* HarnessProject;
				const registry = yield* CapabilityRegistry;
				const lockfiles = yield* LockfileStore;
				const profiles = yield* ProfileStore;
				const target = yield* fs.makeTempDirectoryScoped();
				const init = yield* project.init(target, false);
				const source = `${target}/pack`;
				yield* fs.makeDirectory(`${source}/docs`, { recursive: true });
				yield* fs.writeFileString(`${source}/docs/value.md`, "before\n");
				yield* writeManifest(fs, source, {
					id: "local:rollback",
					name: "Rollback",
					resources: [{ kind: "context", path: "docs/value.md" }],
				});
				yield* project.addCapability(target, "./pack", undefined);

				const lockBefore = yield* fs.readFileString(init.paths.lockfile);
				const profileBefore = yield* fs.readFileString(init.paths.defaultProfile);
				const artifact = `${target}/.harnessy/capabilities/local-rollback/package/docs/value.md`;
				const invalidDirectory = `${target}/not-a-directory`;
				yield* fs.writeFileString(invalidDirectory, "file\n");
				const failingLockPaths = { ...init.paths, harnessDir: invalidDirectory };
				const failingProfilePaths = { ...init.paths, profilesDir: invalidDirectory };
				const parsedLockfile = yield* parseLockfile(lockBefore, init.paths.lockfile);

				const lockError = yield* Effect.flip(lockfiles.write(failingLockPaths, parsedLockfile));
				expect(lockError.message).toContain("Could not stage");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);
				const profileError = yield* Effect.flip(
					profiles.writeDefault(
						failingProfilePaths,
						new HarnessProfile({ name: "changed", context: [], capabilities: [] }),
					),
				);
				expect(profileError.message).toContain("Could not stage");
				expect(yield* fs.readFileString(init.paths.defaultProfile)).toBe(profileBefore);

				yield* fs.writeFileString(`${source}/docs/value.md`, "changed-by-add\n");
				const addError = yield* Effect.flip(registry.add(failingLockPaths, "./pack", undefined));
				expect(addError.message).toContain("Could not stage");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);
				expect(yield* fs.readFileString(artifact)).toBe("before\n");

				yield* fs.writeFileString(`${source}/docs/value.md`, "changed-by-refresh\n");
				const refreshError = yield* Effect.flip(
					registry.materialize(failingLockPaths, "local:rollback", { refresh: true }),
				);
				expect(refreshError.message).toContain("Could not stage");
				expect(yield* fs.readFileString(init.paths.lockfile)).toBe(lockBefore);
				expect(yield* fs.readFileString(artifact)).toBe("before\n");
			}),
		),
	);
});
