import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { checkCommunityBriefingProviders } from "../src/community-briefing/providers.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import {
	DISCORD_MEETING_AUTH_TEMPLATE,
	DISCORD_MEETING_INTEGRATION,
	discordMeetingPublicationPlugin,
} from "../src/plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";
import { type FailureResponse, makeWireState, startWireServer } from "./support/meeting-provider-wire.ts";

const inspect = async (options: { failure?: FailureResponse; mismatch?: boolean; missing?: boolean } = {}) => {
	const root = mkdtempSync(join(tmpdir(), "community-provider-contract-"));
	const wire = makeWireState();
	if (options.failure) wire.failures.push(options.failure);
	if (options.mismatch) wire.ownerEmail = "different@example.test";
	const server = await startWireServer(wire);
	try {
		const health = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const transport = {
						kind: "test-loopback" as const,
						googleDriveBaseUrl: server.origin,
						googleDocsBaseUrl: server.origin,
						discordBaseUrl: server.origin,
					};
					const config = makeTestConfig({
						plugins: [
							googleMeetingPublicationPlugin({ transport }),
							discordMeetingPublicationPlugin({ transport }),
							fileSecretsPlugin({ directory: join(root, "credentials") }),
						],
						dataDir: join(root, "executor"),
						subject: null,
					});
					yield* Effect.acquireRelease(
						Effect.promise(async () => {
							await config.testDb.warm();
							return config.testDb;
						}),
						(db) => Effect.promise(() => db.close()),
					);
					const executor = yield* Effect.acquireRelease(
						createExecutor({ ...config, onElicitation: () => Effect.die("unexpected consent") }),
						(value) => value.close().pipe(Effect.orDie),
					);
					yield* executor["harnessy-google-meeting-publication"].register();
					yield* executor["harnessy-discord-meeting-publication"].register();
					if (!options.missing) {
						yield* executor.connections.create({
							owner: "org",
							integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
							name: ConnectionName.make("briefing-google"),
							template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
							values: { token: "SYNTHETIC_GOOGLE_SECRET" },
						});
					}
					yield* executor.connections.create({
						owner: "org",
						integration: IntegrationSlug.make(DISCORD_MEETING_INTEGRATION),
						name: ConnectionName.make("briefing-discord"),
						template: AuthTemplateSlug.make(DISCORD_MEETING_AUTH_TEMPLATE),
						values: { token: "SYNTHETIC_DISCORD_SECRET" },
					});
					const handle = harnessyEngineHandle(executor);
					return yield* checkCommunityBriefingProviders({
						google: {
							handle,
							owner: "org",
							connection: "briefingGoogle",
							expectedOwnerEmail: "owner@example.test",
							folderPath: "Community",
						},
						discord: {
							handle,
							owner: "org",
							connection: "briefingDiscord",
							expectedChannelId: wire.channelId,
						},
					});
				}),
			),
		);
		expect(health.publicationEnabled).toBe(false);
		expect(wire.requests.every((request) => request.method === "GET")).toBe(true);
		expect(wire.documents.size).toBe(0);
		expect(wire.messagesByNonce.size).toBe(0);
		expect(JSON.stringify(health)).not.toMatch(/SYNTHETIC_|UPSTREAM_|example\.test/);
		return { health, requests: wire.requests };
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
};

describe("community provider health contract", () => {
	it("uses real Executor-owned connections without enabling publication", async () => {
		const { health, requests } = await inspect();
		expect(health).toEqual({ google: { ready: true }, discord: { ready: true }, publicationEnabled: false });
		expect(requests.map((request) => request.path)).toEqual(["/about", "/users/@me", "/channels/555555555555555555"]);
	});
	it.each([
		[401, "authentication_failed"],
		[403, "permission_denied"],
		[302, "unsafe_redirect"],
	] as const)("reports Google %s independently, without retries or leaked error bodies", async (status, code) => {
		const { health, requests } = await inspect({
			failure: {
				method: "GET",
				path: "/about",
				status,
				headers: { location: "http://127.0.0.1:1/forbidden" },
				body: { message: "UPSTREAM_SECRET" },
			},
		});
		expect(health.google).toEqual({ ready: false, code, retryable: false, retryAfterSeconds: null });
		expect(health.discord).toEqual({ ready: true });
		expect(requests.filter((request) => request.path === "/about")).toHaveLength(1);
	});
	it("rejects mismatched identity", async () => {
		const { health } = await inspect({ mismatch: true });
		expect(health.google).toMatchObject({ ready: false, code: "identity_mismatch" });
	});
	it("reports a missing connection before Google network access", async () => {
		const { health, requests } = await inspect({ missing: true });
		expect(health.google).toMatchObject({ ready: false, code: "missing_credential" });
		expect(requests.some((request) => request.path === "/about")).toBe(false);
	});
});
