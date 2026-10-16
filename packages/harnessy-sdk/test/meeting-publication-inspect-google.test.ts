import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";
import { makeWireState, startWireServer, type WireState } from "./support/meeting-provider-wire.ts";

const input = { itemId: "a".repeat(24), expectedOwnerEmail: "owner@example.test" };
const document = {
	id: "partial-document",
	name: "PRIVATE_TITLE",
	mimeType: "application/vnd.google-apps.document",
	parents: ["unexpected-folder"],
	appProperties: {
		harnessyMeetingItemId: input.itemId,
		harnessyMeetingSourceHash: "b".repeat(64),
		privateMarker: "PRIVATE_PROPERTY",
	},
	trashed: false,
};

const inspect = (wire: WireState, args: unknown = input, policy?: "block" | "require_approval") =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(realpathSync(tmpdir()), "meeting-inspect-"))),
					(path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
				);
				const server = yield* Effect.acquireRelease(
					Effect.promise(() => startWireServer(wire, { keepAlive: false })),
					(value) => Effect.promise(() => value.close()),
				);
				const plugins = [
					googleMeetingPublicationPlugin({
						transport: {
							kind: "test-loopback",
							googleDriveBaseUrl: server.origin,
							googleDocsBaseUrl: server.origin,
							discordBaseUrl: server.origin,
						},
					}),
					fileSecretsPlugin({ directory: join(root, "credentials") }),
				] as const;
				const config = makeTestConfig({ plugins, dataDir: join(root, "executor"), subject: null });
				yield* Effect.acquireRelease(
					Effect.promise(() => config.testDb.warm()),
					() => Effect.promise(() => config.testDb.close()),
				);
				const executor = yield* Effect.acquireRelease(
					createExecutor({ ...config, onElicitation: () => Effect.succeed({ action: "decline" }) }),
					(value) => value.close().pipe(Effect.orDie),
				);
				yield* executor["harnessy-google-meeting-publication"].register();
				yield* executor.connections.create({
					owner: "org",
					integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
					name: ConnectionName.make("meetings-google"),
					template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
					values: { token: "SYNTHETIC_INSPECT_TOKEN" },
				});
				if (policy !== undefined)
					yield* executor.policies.create({
						owner: "org",
						pattern: `${GOOGLE_MEETING_INTEGRATION}.*.*.inspect`,
						action: policy,
					});
				return yield* harnessyEngineHandle(executor).execute(
					"tools.google-meeting-publication.org.meetingsGoogle.inspect",
					args,
				);
			}),
		),
	);

describe("Executor-owned read-only meeting receipt inspection", () => {
	for (const marker of ["native", "legacy", "both"] as const) {
		it(`finds ${marker} markers even in a trashed document outside the expected folder`, async () => {
			const wire = makeWireState();
			const file = structuredClone(document);
			file.trashed = true;
			if (marker !== "native")
				file.appProperties = {
					...(marker === "both" ? file.appProperties : {}),
					jarvisMeetingId: input.itemId,
					jarvisSourceHash: "b".repeat(64),
				} as typeof file.appProperties;
			wire.files.set(file.id, file);
			const before = structuredClone([...wire.files]);
			const result = await inspect(wire);
			expect(result).toEqual({
				ok: true,
				data: {
					status: "found",
					itemId: input.itemId,
					document: { docId: file.id, parents: file.parents, trashed: true, marker, sourceHash: "b".repeat(64) },
				},
			});
			expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|SYNTHETIC_/);
			expect(wire.requests.map(({ method, path }) => [method, path])).toEqual([
				["GET", "/about"],
				["GET", "/files"],
			]);
			expect(wire.fileQueries[0]).toContain(" or ");
			expect(wire.fileQueries[0]).not.toMatch(/in parents|trashed=/);
			expect([...wire.files]).toEqual(before);
		});
	}
	it("reports only a complete empty result as not found", async () => {
		const wire = makeWireState();
		expect(await inspect(wire)).toEqual({
			ok: true,
			data: { status: "not_found", itemId: input.itemId, document: null },
		});
		expect(wire.requests.every(({ method }) => method === "GET")).toBe(true);
	});
	for (const scenario of [
		"401",
		"404",
		"duplicate",
		"pagination",
		"incomplete",
		"wrong-owner",
		"wrong-marker",
		"conflicting-hash",
		"invalid-id",
		"invalid-parent",
		"invalid-hash",
	] as const) {
		it(`does not establish a receipt or mutate anything after ${scenario}`, async () => {
			const wire = makeWireState();
			const file = structuredClone(document);
			wire.files.set(file.id, file);
			if (scenario === "401" || scenario === "404")
				wire.failures.push({ method: "GET", path: "/files", status: Number(scenario) });
			if (scenario === "duplicate") wire.files.set("duplicate", { ...file, id: "duplicate" });
			if (scenario === "pagination" || scenario === "incomplete")
				wire.failures.push({
					method: "GET",
					path: "/files",
					status: 200,
					body: {
						files: [],
						...(scenario === "pagination" ? { nextPageToken: "next" } : { incompleteSearch: true }),
					},
				});
			if (scenario === "wrong-owner") wire.ownerEmail = "other@example.test";
			if (scenario === "wrong-marker")
				wire.failures.push({
					method: "GET",
					path: "/files",
					status: 200,
					body: { files: [{ ...file, appProperties: { harnessyMeetingItemId: "wrong" } }] },
				});
			if (scenario === "conflicting-hash")
				Object.assign(file.appProperties, { jarvisMeetingId: input.itemId, jarvisSourceHash: "c".repeat(64) });
			if (scenario === "invalid-id") file.id = "unsafe/id";
			if (scenario === "invalid-parent") file.parents = ["unsafe/parent"];
			if (scenario === "invalid-hash") file.appProperties.harnessyMeetingSourceHash = "unsafe-hash";
			const before = structuredClone([...wire.files]);
			expect(await inspect(wire)).toMatchObject({ ok: false });
			expect(wire.requests.every(({ method }) => method === "GET")).toBe(true);
			expect([...wire.files]).toEqual(before);
			expect(wire.permissions.size).toBe(0);
		});
	}
	for (const policy of ["block", "require_approval"] as const) {
		it(`honors ${policy} policy without bypassing owner consent`, async () => {
			const wire = makeWireState();
			await expect(inspect(wire, input, policy)).rejects.toBeDefined();
			expect(wire.requests).toEqual([]);
		});
	}
	it("rejects invalid query input before credentialed network access", async () => {
		const wire = makeWireState();
		expect(await inspect(wire, { ...input, itemId: "' or trashed=true" })).toMatchObject({
			ok: false,
			error: { code: "invalid_input" },
		});
		expect(wire.requests).toEqual([]);
	});
});
