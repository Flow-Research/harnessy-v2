import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { CAPABILITY_MANIFEST_NAME } from "../src/capabilities/manifest.ts";
import {
	localCapabilityPath,
	makeCapabilityId,
	parseAndPlanCapabilitySource,
	parseCapabilitySource,
	planCapabilityResolution,
} from "../src/capabilities/source.ts";

const targetDir = resolve("/tmp/harnessy-source-resolution-target");

const provideNode = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(NodeServices.layer));

const expectSafeSlug = (value: string) => expect(value).toMatch(/^[a-z0-9._-]+$/);

describe("capability source resolution", () => {
	it.effect("preserves existing git, npm, and local parsing", () =>
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

	it.effect("plans git sources with refs as remote fetch requirements", () =>
		provideNode(
			Effect.gen(function* () {
				const plan = yield* parseAndPlanCapabilitySource(
					targetDir,
					"git+https://github.com/acme/team-capability.git#release-1",
				);

				expect(plan.source).toMatchObject({
					type: "git",
					value: "git+https://github.com/acme/team-capability.git#release-1",
				});
				expect(plan.normalizedSource).toMatchObject({
					type: "git",
					value: "https://github.com/acme/team-capability.git#release-1",
				});
				expect(plan.id).toBe("git:team-capability");
				expect(plan.slug).toBe("git-team-capability");
				expect(plan.requiresFetch).toBe(true);
				expect(plan.local).toBeNull();
				expect(plan.remote).toMatchObject({
					type: "git",
					locator: "https://github.com/acme/team-capability.git",
					ref: "release-1",
				});
			}),
		),
	);

	it.effect("plans npm scoped packages without changing bare scoped ids", () =>
		provideNode(
			Effect.gen(function* () {
				const scoped = yield* parseAndPlanCapabilitySource(targetDir, "npm:@harnessy/capability-demo");
				const versioned = yield* parseAndPlanCapabilitySource(targetDir, "npm:@harnessy/capability-demo@1.2.3");

				expect(scoped.id).toBe("npm:harnessy-capability-demo");
				expect(scoped.remote).toMatchObject({
					type: "npm",
					locator: "@harnessy/capability-demo",
					packageName: "@harnessy/capability-demo",
				});
				expect(versioned.source).toMatchObject({ type: "npm", value: "@harnessy/capability-demo@1.2.3" });
				expect(versioned.remote).toMatchObject({
					type: "npm",
					locator: "@harnessy/capability-demo@1.2.3",
					packageName: "@harnessy/capability-demo",
					packageSpec: "1.2.3",
				});
				expect(versioned.requiresFetch).toBe(true);
			}),
		),
	);

	it.effect("plans URL manifest and archive sources without fetching", () =>
		provideNode(
			Effect.gen(function* () {
				const manifest = yield* parseAndPlanCapabilitySource(
					targetDir,
					"https://cdn.example.com/caps/harnessy.capability.json",
				);
				const archive = yield* parseAndPlanCapabilitySource(
					targetDir,
					"url:https://cdn.example.com/caps/team-kit.tgz#sha256=abc123",
				);

				expect(manifest.source).toMatchObject({
					type: "url",
					value: "https://cdn.example.com/caps/harnessy.capability.json",
				});
				expect(manifest.remote).toMatchObject({
					type: "url-manifest",
					locator: "https://cdn.example.com/caps/harnessy.capability.json",
					ref: null,
					urlKind: "manifest",
				});
				expect(manifest.requiresFetch).toBe(true);
				expect(manifest.local).toBeNull();

				expect(archive.source).toMatchObject({
					type: "url",
					value: "https://cdn.example.com/caps/team-kit.tgz#sha256=abc123",
				});
				expect(archive.remote).toMatchObject({
					type: "url-archive",
					locator: "https://cdn.example.com/caps/team-kit.tgz",
					ref: "sha256=abc123",
					urlKind: "archive",
				});
			}),
		),
	);

	it.effect("resolves home, relative, and absolute local paths to manifest roots", () =>
		provideNode(
			Effect.gen(function* () {
				const relativeSource = yield* parseCapabilitySource("./capabilities/demo");
				const relativePath = yield* localCapabilityPath(targetDir, relativeSource);
				const relativePlan = yield* planCapabilityResolution(targetDir, relativeSource);
				const expectedRelativePath = resolve(targetDir, "./capabilities/demo");

				expect(relativePath).toBe(expectedRelativePath);
				expect(relativePlan.normalizedSource.value).toBe(expectedRelativePath);
				expect(relativePlan.requiresFetch).toBe(false);
				expect(relativePlan.remote).toBeNull();
				expect(relativePlan.local).toMatchObject({
					root: expectedRelativePath,
					manifestPath: join(expectedRelativePath, CAPABILITY_MANIFEST_NAME),
				});

				const absolutePath = join(targetDir, "absolute-demo");
				const absolutePlan = yield* parseAndPlanCapabilitySource(targetDir, absolutePath);
				expect(absolutePlan.source).toMatchObject({ type: "local", value: absolutePath });
				expect(absolutePlan.local?.root).toBe(absolutePath);

				const homePlan = yield* parseAndPlanCapabilitySource(targetDir, "~/harnessy-home-demo");
				expect(homePlan.source).toMatchObject({ type: "local", value: "~/harnessy-home-demo" });
				expect(homePlan.local?.root).toBe(join(homedir(), "harnessy-home-demo"));
			}),
		),
	);

	it.effect("derives stable ids and cache-safe slugs", () =>
		provideNode(
			Effect.gen(function* () {
				const first = yield* parseAndPlanCapabilitySource(
					targetDir,
					" https://cdn.example.com/caps/team-kit.tgz?download=1 ",
				);
				const second = yield* parseAndPlanCapabilitySource(
					targetDir,
					"https://cdn.example.com/caps/team-kit.tgz?download=1",
				);

				expect(first.id).toBe(second.id);
				expect(first.slug).toBe(second.slug);
				expect(first.cacheSlug).toBe(second.cacheSlug);
				expectSafeSlug(first.slug);
				expectSafeSlug(first.cacheSlug);
			}),
		),
	);
});
