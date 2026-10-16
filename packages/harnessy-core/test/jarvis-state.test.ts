import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisPathResolver, JarvisRuntimeRoots } from "../src/jarvis/paths.ts";
import { JarvisStateReader, JarvisStateReadLimits } from "../src/jarvis/state.ts";

const fixtureRoot = resolve(import.meta.dirname, "../fixtures/jarvis-v1/state");
const fixture = (name: string) => readFileSync(resolve(fixtureRoot, name), "utf8");
const stateLayer = JarvisStateReader.layer.pipe(Layer.provide(JarvisStateReadLimits.defaultLayer));

const snapshot = (root: string) => {
	const files: Array<string> = [];
	const visit = (directory: string, prefix: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) visit(resolve(directory, entry.name), relative);
			else if (entry.isFile()) files.push(relative);
		}
	};
	visit(root, "");
	return files.sort().map((path) => [path, readFileSync(resolve(root, path), "utf8")] as const);
};

describe("Jarvis legacy state readiness", () => {
	it.effect("reports all twenty missing stores without creating state", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const project = path.join(root, "project");
				yield* fs.makeDirectory(home, { recursive: true });
				yield* fs.makeDirectory(project, { recursive: true });
				const before = snapshot(root);
				const result = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(project);
					return yield* (yield* JarvisStateReader).inspect(paths);
				}).pipe(
					Effect.provide(Layer.mergeAll(JarvisPathResolver.layer, stateLayer)),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);
				expect(result.stores).toHaveLength(20);
				expect(result.counts.absent).toBe(20);
				expect(result.overall).toBe("safe-to-import");
				expect(snapshot(root)).toEqual(before);
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("reads representative fixtures for every manifest store deterministically", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const project = path.join(root, "project");
				const global = path.join(home, ".jarvis");
				const local = path.join(project, ".jarvis");
				const files: ReadonlyArray<readonly [string, string]> = [
					[path.join(global, "config.yaml"), "config.valid.yaml"],
					[path.join(global, "config.json"), "selected-space.valid.json"],
					[path.join(global, "pending.json"), "pending.valid.json"],
					[path.join(global, "journal", "entries.json"), "journal-index.valid.json"],
					[path.join(global, "journal", "deep_dives", "entry.json"), "journal-deep-dives.valid.json"],
					[path.join(global, "journal", "drafts", "draft.txt"), "journal-draft.valid.txt"],
					[path.join(global, "plans", "plan.json"), "schedule-plan.valid.json"],
					[path.join(global, "plans", "plan.apply.json"), "plan-apply.valid.json"],
					[path.join(global, "plans", "2026-03-01.md"), "weekly-plan.valid.md"],
					[path.join(global, "sync", "presets.yaml"), "sync-presets.valid.yaml"],
					[path.join(global, "sync", "state", "flow.json"), "sync.valid.json"],
					[path.join(global, "state", "fathom", "poll-state.json"), "fathom-poll.valid.json"],
					[path.join(global, "cache", "reading-list", "urls", "a.json"), "reading-url-cache.valid.json"],
					[path.join(global, "cache", "reading-list", "results", "a.json"), "reading-result-cache.valid.json"],
					[path.join(global, "wikis", "example", "schema.yaml"), "wiki-domain.valid.yaml"],
					[path.join(local, "context", "preferences.md"), "context-preferences.valid.md"],
					[
						path.join(
							local,
							"context",
							"private",
							"user",
							"meeting-inbox",
							"fathom",
							"work",
							"pending",
							"event.json",
						),
						"fathom-inbox.valid.json",
					],
					[
						path.join(
							local,
							"context",
							"private",
							"user",
							"whatsapp",
							"personal",
							"inbox",
							"pending",
							"event.json",
						),
						"whatsapp-inbox.valid.json",
					],
					[
						path.join(local, "context", "private", "user", "whatsapp", "personal", "threads", "thread.json"),
						"whatsapp-thread.valid.json",
					],
					[
						path.join(local, "context", "private", "user", "whatsapp", "personal", "threads", "thread.md"),
						"whatsapp-thread.valid.md",
					],
				];
				for (const [destination, source] of files) {
					yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
					yield* fs.writeFileString(destination, fixture(source));
				}
				yield* fs.writeFileString(path.join(global, "wikis", "example", "README.md"), "# Wiki\n");
				yield* fs.writeFileString(path.join(global, "wikis", "example", "index.md"), "");
				yield* fs.makeDirectory(path.join(global, "wikis", "example", ".state"), { recursive: true });
				yield* fs.writeFileString(path.join(global, "wikis", "example", ".state", "manifest.json"), "{}\n");
				yield* fs.makeDirectory(
					path.join(local, "context", "private", "user", "whatsapp", "personal", "inbox", "other"),
					{ recursive: true },
				);
				yield* fs.writeFileString(
					path.join(local, "context", "private", "user", "whatsapp", "personal", "inbox", "other", "ignored.json"),
					"{}\n",
				);
				const before = snapshot(root);
				const result = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(project);
					return yield* (yield* JarvisStateReader).inspect(paths);
				}).pipe(
					Effect.provide(Layer.mergeAll(JarvisPathResolver.layer, stateLayer)),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);
				expect(result.stores).toHaveLength(20);
				expect(result.counts.readable).toBe(20);
				expect(result.overall).toBe("safe-to-import");
				expect(result.stores.find((store) => store.storeId === "wiki-domain-v1")?.entriesRead).toBe(4);
				expect(result.stores.find((store) => store.storeId === "whatsapp-inbox-json-v1")?.entriesRead).toBe(1);
				expect(snapshot(root)).toEqual(before);
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("blocks error stores and degrades skipped malformed entries with sanitized codes", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const project = path.join(root, "project");
				const global = path.join(home, ".jarvis");
				yield* fs.makeDirectory(path.join(global, "sync"), { recursive: true });
				yield* fs.writeFileString(
					path.join(global, "sync", "presets.yaml"),
					fixture("sync-presets.malformed.yaml"),
				);
				yield* fs.makeDirectory(path.join(global, "cache", "reading-list", "urls"), { recursive: true });
				yield* fs.writeFileString(
					path.join(global, "cache", "reading-list", "urls", "good.json"),
					fixture("reading-url-cache.valid.json"),
				);
				yield* fs.writeFileString(
					path.join(global, "cache", "reading-list", "urls", "bad.json"),
					fixture("pending.malformed.json"),
				);
				yield* fs.makeDirectory(project, { recursive: true });
				const result = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(project);
					return yield* (yield* JarvisStateReader).inspect(paths);
				}).pipe(
					Effect.provide(Layer.mergeAll(JarvisPathResolver.layer, stateLayer)),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);
				expect(result.overall).toBe("blocked");
				expect(result.stores.find((store) => store.storeId === "sync-presets-yaml-v1")).toMatchObject({
					status: "invalid",
				});
				expect(result.stores.find((store) => store.storeId === "reading-list-url-cache-v1")).toMatchObject({
					status: "partial",
					entriesRead: 1,
					entriesSkipped: 1,
					issues: [{ code: "STATE_ENTRY_SKIPPED", storeId: "reading-list-url-cache-v1" }],
				});
				expect(JSON.stringify(result)).not.toContain("generated_at");
				expect(JSON.stringify(result)).not.toContain(home);
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("applies global fallback and reports every malformed policy without repair", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const project = path.join(root, "project");
				const global = path.join(home, ".jarvis");
				const local = path.join(project, ".jarvis");
				yield* fs.makeDirectory(path.join(global, "context"), { recursive: true });
				yield* fs.writeFileString(path.join(global, "context", "preferences.md"), "global fallback\n");
				yield* fs.makeDirectory(path.join(local, "context", "private"), { recursive: true });
				yield* fs.writeFileString(path.join(global, "pending.json"), fixture("pending.malformed.json"));
				const fathom = path.join(local, "context", "private", "user", "meeting-inbox", "fathom", "work", "pending");
				yield* fs.makeDirectory(fathom, { recursive: true });
				yield* fs.writeFileString(path.join(fathom, "bad.json"), fixture("pending.malformed.json"));
				yield* fs.writeFileString(path.join(global, "plans"), "not a directory");
				const before = snapshot(root);
				const result = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(project);
					return yield* (yield* JarvisStateReader).inspect(paths);
				}).pipe(
					Effect.provide(Layer.mergeAll(JarvisPathResolver.layer, stateLayer)),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);
				expect(result.stores.find((store) => store.storeId === "project-context-v1")).toMatchObject({
					status: "readable",
					issues: [{ code: "STATE_GLOBAL_FALLBACK", storeId: "project-context-v1" }],
				});
				expect(result.stores.find((store) => store.storeId === "pending-suggestions-json-v1")).toMatchObject({
					status: "partial",
					issues: [{ code: "STATE_MALFORMED", storeId: "pending-suggestions-json-v1" }],
				});
				expect(result.stores.find((store) => store.storeId === "fathom-inbox-json-v1")).toMatchObject({
					status: "partial",
					issues: [{ code: "STATE_ENTRY_QUARANTINED", storeId: "fathom-inbox-json-v1" }],
				});
				expect(result.stores.find((store) => store.storeId === "schedule-plan-json-v1")).toMatchObject({
					status: "invalid",
					issues: [{ code: "STATE_IO_UNAVAILABLE", storeId: "schedule-plan-json-v1" }],
				});
				expect(snapshot(root)).toEqual(before);
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("bounds unmatched directory entries and aggregate bytes and rejects directory symlinks", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const project = path.join(root, "project");
				const global = path.join(home, ".jarvis");
				const urls = path.join(global, "cache", "reading-list", "urls");
				yield* fs.makeDirectory(urls, { recursive: true });
				for (const name of ["a.txt", "b.txt", "c.txt"])
					yield* fs.writeFileString(path.join(urls, name), "ignored\n");
				const outside = path.join(root, "outside-results");
				yield* fs.makeDirectory(outside, { recursive: true });
				yield* fs.makeDirectory(path.dirname(path.join(global, "cache", "reading-list", "results")), {
					recursive: true,
				});
				yield* fs.symlink(outside, path.join(global, "cache", "reading-list", "results"));
				const dives = path.join(global, "journal", "deep_dives");
				yield* fs.makeDirectory(dives, { recursive: true });
				yield* fs.writeFileString(path.join(dives, "a.json"), fixture("journal-deep-dives.valid.json"));
				yield* fs.writeFileString(path.join(dives, "b.json"), fixture("journal-deep-dives.valid.json"));
				yield* fs.makeDirectory(project, { recursive: true });
				const boundedLayer = JarvisStateReader.layer.pipe(
					Layer.provide(JarvisStateReadLimits.testLayer({ maxEntriesPerStore: 2, maxBytesPerStore: 400 })),
				);
				const result = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(project);
					return yield* (yield* JarvisStateReader).inspect(paths);
				}).pipe(
					Effect.provide(Layer.mergeAll(JarvisPathResolver.layer, boundedLayer)),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);
				expect(result.stores.find((store) => store.storeId === "reading-list-url-cache-v1")?.issues[0]?.code).toBe(
					"STATE_DIRECTORY_LIMIT_REACHED",
				);
				expect(
					result.stores.find((store) => store.storeId === "reading-list-result-cache-v1")?.issues[0]?.code,
				).toBe("STATE_SYMLINK_REJECTED");
				const deepDives = result.stores.find((store) => store.storeId === "journal-deep-dives-json-v1");
				expect(deepDives?.issues[0]?.code).toBe("STATE_TOTAL_BYTES_LIMIT_REACHED");
				expect(deepDives?.bytesRead).toBeLessThanOrEqual(400);
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("rejects symlinks and enforces configured file bounds", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const project = path.join(root, "project");
				const global = path.join(home, ".jarvis");
				yield* fs.makeDirectory(global, { recursive: true });
				yield* fs.makeDirectory(project, { recursive: true });
				const outside = path.join(root, "outside.json");
				yield* fs.writeFileString(outside, fixture("selected-space.valid.json"));
				yield* fs.symlink(outside, path.join(global, "config.json"));
				yield* fs.writeFileString(path.join(global, "pending.json"), fixture("pending.valid.json"));
				const boundedLayer = JarvisStateReader.layer.pipe(
					Layer.provide(JarvisStateReadLimits.testLayer({ maxFileBytes: 16 })),
				);
				const result = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(project);
					return yield* (yield* JarvisStateReader).inspect(paths);
				}).pipe(
					Effect.provide(Layer.mergeAll(JarvisPathResolver.layer, boundedLayer)),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);
				expect(result.stores.find((store) => store.storeId === "selected-space-json-v1")?.issues[0]?.code).toBe(
					"STATE_SYMLINK_REJECTED",
				);
				expect(
					result.stores.find((store) => store.storeId === "pending-suggestions-json-v1")?.issues[0]?.code,
				).toBe("STATE_FILE_TOO_LARGE");
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);
});
