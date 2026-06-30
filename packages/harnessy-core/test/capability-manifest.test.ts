import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { CAPABILITY_MANIFEST_NAME, parseCapabilityManifest } from "../src/capabilities/manifest.ts";

const fixtureManifestPath = `fixtures/tiny-capability/${CAPABILITY_MANIFEST_NAME}`;

describe("capability manifest schema", () => {
	it.effect("parses resources and deterministic checks from the tiny fixture", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const raw = yield* fs.readFileString(fixtureManifestPath);
			const manifest = yield* parseCapabilityManifest(raw, fixtureManifestPath);

			expect(manifest.resources?.map((resource) => [resource.kind, resource.path, resource.target])).toEqual([
				["context", "context/AGENTS.md", undefined],
				["skill", "skills/tiny-skill", "skills/tiny-skill"],
			]);
			expect(manifest.checks?.[0]).toMatchObject({
				id: "tiny-context-contains-title",
				kind: "file-contains",
				path: "context/AGENTS.md",
				contains: "Tiny Capability",
				required: true,
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("fails through HarnessError for resource paths that escape the capability root", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({
				id: "local:bad-resource",
				name: "Bad Resource",
				resources: [
					{
						kind: "context",
						path: "../outside.md",
					},
				],
			});

			const error = yield* Effect.flip(parseCapabilityManifest(raw, "bad-resource.json"));
			expect(error._tag).toBe("HarnessError");
			expect(error.message).toContain("Invalid Harnessy capability manifest");
			expect(error.message).toContain("path must be relative to the capability root");
		}),
	);

	it.effect("fails through HarnessError for malformed deterministic checks", () =>
		Effect.gen(function* () {
			const raw = JSON.stringify({
				id: "local:bad-check",
				name: "Bad Check",
				checks: [
					{
						id: "missing-contains",
						kind: "file-contains",
						path: "context/AGENTS.md",
					},
				],
			});

			const error = yield* Effect.flip(parseCapabilityManifest(raw, "bad-check.json"));
			expect(error._tag).toBe("HarnessError");
			expect(error.message).toContain("Invalid Harnessy capability manifest");
			expect(error.message).toContain("contains");
		}),
	);
});
