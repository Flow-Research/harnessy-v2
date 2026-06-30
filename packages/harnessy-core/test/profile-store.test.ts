import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem } from "effect";
import * as Effect from "effect/Effect";

import { pathsForTarget } from "../src/paths.ts";
import { parseProfile } from "../src/runtime/profile.ts";
import { ProfileStore } from "../src/runtime/profile-store.ts";

/** Provide the live profile store plus Node platform services for filesystem-backed tests. */
const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(ProfileStore.layer), Effect.provide(NodeServices.layer));

describe("profiles", () => {
	it.effect("parses legacy and extended profile shapes", () =>
		Effect.gen(function* () {
			const legacy = yield* parseProfile(
				JSON.stringify({ name: "default", context: [".harnessy/context/AGENTS.md"], capabilities: [] }),
				"legacy-profile.json",
			);
			expect(legacy.name).toBe("default");
			expect(legacy.memory).toBeUndefined();
			expect(legacy.defaultOutputMode).toBeUndefined();

			const extended = yield* parseProfile(
				JSON.stringify({
					name: "delivery",
					description: "Delivery-focused project profile.",
					context: [".harnessy/context/AGENTS.md"],
					memory: [".harnessy/memory/project.md"],
					capabilities: ["local:delivery"],
					defaultOutputMode: "json",
					labels: ["scope:project", "mode:delivery"],
				}),
				"extended-profile.json",
			);
			expect(extended.description).toBe("Delivery-focused project profile.");
			expect(extended.memory).toEqual([".harnessy/memory/project.md"]);
			expect(extended.defaultOutputMode).toBe("json");
			expect(extended.labels).toEqual(["scope:project", "mode:delivery"]);
		}),
	);

	it.effect("reports missing context and memory paths deterministically", () =>
		provideLive(
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const targetDir = yield* fs.makeTempDirectoryScoped();
					const paths = yield* pathsForTarget(targetDir);
					yield* fs.makeDirectory(paths.contextDir, { recursive: true });
					yield* fs.makeDirectory(paths.profilesDir, { recursive: true });
					yield* fs.makeDirectory(paths.memoryDir, { recursive: true });

					yield* fs.writeFileString(paths.contextAgentsFile, "# Harnessy Context\n");
					const absoluteMemoryPath = `${paths.memoryDir}/project.md`;
					yield* fs.writeFileString(absoluteMemoryPath, "# Project Memory\n");
					yield* fs.writeFileString(
						paths.defaultProfile,
						JSON.stringify({
							name: "default",
							context: [
								".harnessy/context/AGENTS.md",
								"missing-context.md",
								"docs/missing-capability-context.md",
							],
							memory: [absoluteMemoryPath, ".harnessy/memory/missing.md"],
							capabilities: [],
						}),
					);

					const store = yield* ProfileStore;
					const verification = yield* store.verifyDefault(paths);
					expect(verification.issues).toEqual([
						"Profile context path does not exist: missing-context.md",
						"Profile context path does not exist: docs/missing-capability-context.md",
						"Profile memory path does not exist: .harnessy/memory/missing.md",
					]);
				}),
			),
		),
	);
});
