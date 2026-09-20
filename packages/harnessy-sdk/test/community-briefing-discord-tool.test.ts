import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug, ToolAddress } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { withMeetingPublicationMutationGuard } from "../src/meeting-publication/mutation-guard.ts";
import {
	DISCORD_COMMUNITY_UPSERT_TOOL,
	DISCORD_MEETING_AUTH_TEMPLATE,
	DISCORD_MEETING_INTEGRATION,
	DISCORD_MEETING_UPSERT_TOOL,
	discordMeetingPublicationPlugin,
	formatDiscordMeetingMessage,
} from "../src/plugins/discord-meeting-publication.ts";
import { makeWireState, startWireServer, type WireState } from "./support/meeting-provider-wire.ts";

const input = {
	briefingId: "0123456789abcdef01234567",
	sourceHash: "a".repeat(64),
	weekStart: "2026-09-14",
	summary: "**Research update**\n[Project](https://example.test/project) @everyone <@12345>",
	googleDocUrl: "https://docs.google.com/document/d/community-doc/view",
	expectedChannelId: "555555555555555555",
	existingChannelId: null,
	existingMessageId: null,
} as const;

const run = async (
	operations: ReadonlyArray<{
		readonly args: unknown;
		readonly tool?: string;
		readonly guard?: Effect.Effect<void, Error>;
	}>,
	configure?: (wire: WireState) => void,
) => {
	const root = mkdtempSync(join(tmpdir(), "community-discord-tool-"));
	const wire = makeWireState();
	configure?.(wire);
	const server = await startWireServer(wire);
	try {
		const results = await Effect.runPromise(
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
						createExecutor({ ...config, onElicitation: () => Effect.succeed({ action: "accept" }) }),
						(value) => value.close().pipe(Effect.orDie),
					);
					yield* executor["harnessy-discord-meeting-publication"].register();
					yield* executor.connections.create({
						owner: "org",
						integration: IntegrationSlug.make(DISCORD_MEETING_INTEGRATION),
						name: ConnectionName.make("briefing"),
						template: AuthTemplateSlug.make(DISCORD_MEETING_AUTH_TEMPLATE),
						values: { token: "SYNTHETIC_DISCORD_TOKEN" },
					});
					return yield* Effect.forEach(operations, (operation) =>
						Effect.result(
							withMeetingPublicationMutationGuard(
								executor.execute(
									ToolAddress.make(
										`tools.${DISCORD_MEETING_INTEGRATION}.org.briefing.${operation.tool ?? DISCORD_COMMUNITY_UPSERT_TOOL}`,
									),
									operation.args,
								),
								operation.guard ?? Effect.void,
							),
						),
					);
				}),
			),
		);
		return { wire, results };
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
};

describe("community Discord tool namespace", () => {
	it("preserves approved multiline/link text, suppresses mentions, and isolates meeting nonces", async () => {
		const purpose = "Meeting purpose.";
		const { wire, results } = await run([
			{ args: input },
			{
				tool: DISCORD_MEETING_UPSERT_TOOL,
				args: { ...input, itemId: input.briefingId, meetingDate: input.weekStart, title: "Meeting", purpose },
			},
			{ args: input },
		]);
		for (const result of results) expect(result).toMatchObject({ _tag: "Success", success: { ok: true } });
		const writes = wire.requests.filter((request) => request.method === "POST");
		expect(writes).toHaveLength(3);
		expect(writes[0]?.body).toMatchObject({
			content: `${input.summary}\n\n[Read the weekly briefing](${input.googleDocUrl})`,
			allowed_mentions: { parse: [] },
			enforce_nonce: true,
		});
		expect(writes[1]?.body).toMatchObject({ content: formatDiscordMeetingMessage(purpose, input.googleDocUrl) });
		expect(writes[2]?.body).toEqual(writes[0]?.body);
		expect(wire.messagesByNonce.size).toBe(2);
	});

	it("updates the exact checkpoint in the configured channel", async () => {
		const messageId = "700000000000000001";
		const { wire, results } = await run([
			{ args: input },
			{
				args: {
					...input,
					summary: "Reviewed replacement\nhttps://example.test/update",
					sourceHash: "b".repeat(64),
					existingChannelId: input.expectedChannelId,
					existingMessageId: messageId,
				},
			},
		]);
		expect(results[1]).toMatchObject({ _tag: "Success", success: { ok: true, data: { messageId } } });
		expect(wire.requests.filter((request) => request.method === "PATCH")).toMatchObject([
			{
				path: `/channels/${input.expectedChannelId}/messages/${messageId}`,
				body: { allowed_mentions: { parse: [] } },
			},
		]);
		expect(wire.messagesByNonce.size).toBe(1);
	});

	it.each([
		["oversize", { summary: "x".repeat(2_000) }],
		["wrong channel", { existingChannelId: "666666666666666666", existingMessageId: "700000000000000001" }],
		["incomplete checkpoint", { existingMessageId: "700000000000000001" }],
		["invalid ID", { briefingId: "meeting-style-invalid" }],
	] as const)("rejects %s before network access", async (_label, changed) => {
		const { wire, results } = await run([{ args: { ...input, ...changed } }]);
		expect(results[0]).toMatchObject({
			_tag: "Failure",
			failure: { _tag: "ToolInvocationError", cause: { code: "invalid_input" } },
		});
		expect(wire.requests).toEqual([]);
	});

	it("rechecks live authority after preflight before the mutation", async () => {
		let allowed = true;
		const { wire, results } = await run(
			[{ args: input, guard: Effect.suspend(() => (allowed ? Effect.void : Effect.fail(new Error("revoked")))) }],
			(state) => {
				state.onRequest = ({ path }) => {
					if (path === `/channels/${input.expectedChannelId}`) allowed = false;
				};
			},
		);
		expect(results[0]).toMatchObject({ _tag: "Success", success: { ok: false, error: { code: "invalid_grant" } } });
		expect(wire.requests.every((request) => request.method === "GET")).toBe(true);
	});

	it("does not replay a lost successful create response", async () => {
		const { wire, results } = await run([{ args: input }], (state) => {
			state.lostDiscordMessageCreateResponses = 1;
		});
		expect(results[0]).toMatchObject({
			_tag: "Success",
			success: { ok: false, error: { code: "delivery_uncertain", retryable: false } },
		});
		expect(wire.messagesByNonce.size).toBe(1);
		expect(wire.requests.filter((request) => request.method === "POST")).toHaveLength(1);
	});
});
