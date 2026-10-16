import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import type { OpenApiPluginOptions } from "@executor-js/plugin-openapi";
import { Effect } from "@executor-js/sdk/core";

import { acquireHarnessyEngineResource, makeHarnessyEngine, makeHarnessyPlugins } from "../src/engine.ts";
import { HARNESSY_PRESETS } from "../src/presets.ts";

type OpenApiPreset = NonNullable<OpenApiPluginOptions["presets"]>[number];

const presetById = (id: string) => {
	const preset = HARNESSY_PRESETS.find((candidate) => candidate.id === id);
	expect(preset).toBeDefined();
	return preset;
};

describe("Harnessy OpenAPI presets", () => {
	it("conforms to the executor preset type and declares the first-party catalog", () => {
		expectTypeOf(HARNESSY_PRESETS).toEqualTypeOf<readonly OpenApiPreset[]>();
		expect(HARNESSY_PRESETS.map((preset) => preset.id)).toEqual([
			"discord",
			"github",
			"slack",
			"gmail",
			"google-drive",
		]);
		expect(HARNESSY_PRESETS.some((preset) => preset.id.startsWith("exa"))).toBe(false);

		expect(presetById("discord")).toMatchObject({
			url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json",
			authTemplate: [
				{
					kind: "apiKey",
					placements: [{ carrier: "header", name: "Authorization", prefix: "Bot " }],
				},
			],
		});
		expect(presetById("github")).toMatchObject({
			url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
			authTemplate: [
				{
					kind: "oauth2",
					authorizationUrl: "https://github.com/login/oauth/authorize",
					tokenUrl: "https://github.com/login/oauth/access_token",
				},
				{
					kind: "apiKey",
					placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
				},
			],
		});
		expect(presetById("slack")).toMatchObject({
			url: "https://api.apis.guru/v2/specs/slack.com/1.7.0/openapi.json",
			authTemplate: [
				{
					kind: "apiKey",
					placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
				},
			],
		});
		expect(presetById("gmail")).toMatchObject({
			url: "https://api.apis.guru/v2/specs/googleapis.com/gmail/v1/openapi.json",
			authTemplate: [
				{
					kind: "oauth2",
					authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
					tokenUrl: "https://oauth2.googleapis.com/token",
					scopes: expect.arrayContaining(["https://www.googleapis.com/auth/gmail.modify"]),
				},
			],
		});
		expect(presetById("google-drive")).toMatchObject({
			url: "https://api.apis.guru/v2/specs/googleapis.com/drive/v3/openapi.json",
			authTemplate: [
				{
					kind: "oauth2",
					authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
					tokenUrl: "https://oauth2.googleapis.com/token",
					scopes: expect.arrayContaining(["https://www.googleapis.com/auth/drive"]),
				},
			],
		});
	});

	it.effect("composes the catalog into makeHarnessyEngine's OpenAPI plugin", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const credentialDirectory = join(tmpdir(), `harnessy-sdk-presets-${process.pid}`);
				const [openApiPlugin] = makeHarnessyPlugins(credentialDirectory);
				const openApiCatalog = openApiPlugin.integrationPresets ?? [];

				expect(openApiPlugin.id).toBe("openapi");
				expect(openApiCatalog.map((preset) => preset.id)).toEqual(
					expect.arrayContaining(HARNESSY_PRESETS.map((preset) => preset.id)),
				);
				for (const preset of HARNESSY_PRESETS) {
					expect(openApiCatalog.find((entry) => entry.id === preset.id)).toMatchObject(preset);
				}

				const engine = yield* makeHarnessyEngine({
					tenant: "preset-composition-test",
					onElicitation: "accept-all",
					credentialDirectory,
				});
				expect(engine.execute).toBeTypeOf("function");
			}),
		),
	);

	it.effect("bounds credential state to a host-owned directory across the engine scope", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const credentialDirectory = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), "harnessy-sdk-scope-"))),
					(directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const engine = yield* makeHarnessyEngine({
							tenant: "scope-test",
							onElicitation: "accept-all",
							credentialDirectory,
						});
						yield* engine.connections.create({
							owner: "org",
							integration: "anytype",
							name: "main",
							template: "anytype",
							values: {
								apiKey: "fixture-only",
								baseUrl: "http://127.0.0.1:31009",
								allowRemote: "false",
							},
						});
					}),
				);
				expect(existsSync(join(credentialDirectory, "auth.json"))).toBe(true);
				yield* Effect.sync(() => rmSync(credentialDirectory, { recursive: true, force: true }));
				expect(existsSync(credentialDirectory)).toBe(false);
			}),
		),
	);

	it.effect("releases the underlying engine resource when its Effect scope closes", () =>
		Effect.gen(function* () {
			let closed = false;
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* acquireHarnessyEngineResource(
						Effect.succeed({
							close: () =>
								Effect.sync(() => {
									closed = true;
								}),
						}),
					);
					expect(closed).toBe(false);
				}),
			);
			expect(closed).toBe(true);
		}),
	);
});
