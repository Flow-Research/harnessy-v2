import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk/core";
import { createClient } from "@libsql/client";
import { Cause, Effect } from "effect";
import { expect, it } from "vitest";
import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import { EngineTool } from "../src/engine/compose.ts";
import {
	DISCORD_MEETING_AUTH_TEMPLATE,
	DISCORD_MEETING_INTEGRATION,
	discordMeetingPublicationPlugin,
} from "../src/plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_AUTH_TEMPLATE,
	GOOGLE_MEETING_INTEGRATION,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";

it("refreshes legacy saved catalogs without replacing connections, credentials, meeting tools or policies", async () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "community-existing-catalog-"));
	let requests = 0;
	const server = createServer((_request, response) => {
		requests++;
		response.writeHead(500).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Missing loopback address");
	const origin = `http://127.0.0.1:${address.port}`;
	const transport = {
		kind: "test-loopback" as const,
		googleDriveBaseUrl: origin,
		googleDocsBaseUrl: origin,
		discordBaseUrl: origin,
	};
	const credentials = join(root, "credentials");
	const config = makeTestConfig({
		tenant: "meeting-publication",
		subject: "fixture-owner",
		dataDir: join(root, "executor"),
		plugins: [
			googleMeetingPublicationPlugin({ transport }),
			discordMeetingPublicationPlugin({ transport }),
			fileSecretsPlugin({ directory: credentials }),
		],
	});
	try {
		await config.testDb.warm();
		const sql = createClient({ url: pathToFileURL(join(root, "executor", "test.db")).href });
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const executor = yield* Effect.acquireRelease(createExecutor(config), (value) =>
							value.close().pipe(Effect.orDie),
						);
						yield* executor["harnessy-google-meeting-publication"].register();
						yield* executor["harnessy-discord-meeting-publication"].register();
						for (const [integration, name, template] of [
							[GOOGLE_MEETING_INTEGRATION, "meetingsgoogle", GOOGLE_MEETING_AUTH_TEMPLATE],
							[DISCORD_MEETING_INTEGRATION, "meetingsdiscord", DISCORD_MEETING_AUTH_TEMPLATE],
						]) {
							yield* executor.connections.create({
								owner: "user",
								integration: IntegrationSlug.make(integration),
								name: ConnectionName.make(name),
								template: AuthTemplateSlug.make(template),
								values: { token: `SYNTHETIC_${name}` },
							});
						}
						yield* executor.policies.create({
							owner: "user",
							pattern: "tools.*.user.*.upsert",
							action: "require_approval",
						});
					}),
				),
			);
			// Recreate the installed catalog before this source addition. These are
			// fixture-only SQL writes; no production database is opened by this test.
			await sql.execute("DELETE FROM tool WHERE name = 'community_upsert'");
			await sql.execute("UPDATE connection SET tools_synced_at = CAST('1700000000000' AS BLOB)");
			const beforeConnections = (await sql.execute("SELECT * FROM connection ORDER BY name")).rows;
			const beforeTools = (
				await sql.execute(
					"SELECT integration, connection, name, input_schema, output_schema, annotations FROM tool ORDER BY integration, name",
				)
			).rows;
			const beforePolicies = (await sql.execute("SELECT * FROM tool_policy ORDER BY row_id")).rows;
			const credentialBytes = () =>
				readdirSync(credentials, { recursive: true, withFileTypes: true })
					.filter((entry) => entry.isFile())
					.map((entry) => [
						join(entry.parentPath, entry.name),
						readFileSync(join(entry.parentPath, entry.name)).toString("hex"),
					])
					.sort(([a], [b]) => a.localeCompare(b));
			const beforeCredentials = credentialBytes();
			expect(beforeConnections).toHaveLength(2);
			expect(beforeTools).toHaveLength(5);
			expect(beforePolicies).toHaveLength(1);
			expect(beforeCredentials.length).toBeGreaterThan(0);
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const executor = yield* Effect.acquireRelease(createExecutor(config), (value) =>
							value.close().pipe(Effect.orDie),
						);
						// Opening the upgraded runtime alone does not upgrade saved catalogs.
						const handle = harnessyEngineHandle(executor);
						for (const ref of [
							{ owner: "org" as const, integration: GOOGLE_MEETING_INTEGRATION, name: "meetingsgoogle" },
							{ owner: "user" as const, integration: GOOGLE_MEETING_INTEGRATION, name: "missing" },
						]) {
							const result = yield* Effect.exit(handle.connections.refresh(ref));
							expect(result._tag).toBe("Failure");
							if (result._tag === "Failure")
								expect(Cause.squash(result.cause)).toMatchObject({ _tag: "ConnectionNotFoundError" });
						}
						expect(
							(yield* Effect.promise(() => sql.execute("SELECT * FROM tool WHERE name = 'community_upsert'")))
								.rows,
						).toHaveLength(0);
						for (const [integration, name] of [
							[GOOGLE_MEETING_INTEGRATION, "meetingsgoogle"],
							[DISCORD_MEETING_INTEGRATION, "meetingsdiscord"],
						]) {
							const ref = {
								owner: "user" as const,
								integration,
								name,
							};
							for (let repeat = 0; repeat < 2; repeat++) {
								const tools = yield* handle.connections.refresh(ref);
								expect(tools.every((tool) => tool instanceof EngineTool)).toBe(true);
								expect(tools.find((tool) => tool.name === "community_upsert")).toMatchObject({
									address: `tools.${integration}.user.${name}.community_upsert`,
									owner: "user",
									integration,
									connection: name,
								});
							}
						}
					}),
				),
			);
			const afterConnections = (await sql.execute("SELECT * FROM connection ORDER BY name")).rows;
			for (const [index, row] of afterConnections.entries()) {
				if (!(row.tools_synced_at instanceof ArrayBuffer)) throw new Error("Missing persisted sync stamp");
				expect(Number(Buffer.from(row.tools_synced_at).toString())).toBeGreaterThan(1700000000000);
				expect({ ...row, tools_synced_at: beforeConnections[index].tools_synced_at }).toEqual(
					beforeConnections[index],
				);
			}
			expect(afterConnections).toHaveLength(2);
			expect(
				(
					await sql.execute(
						"SELECT integration, connection, name, input_schema, output_schema, annotations FROM tool WHERE name != 'community_upsert' ORDER BY integration, name",
					)
				).rows,
			).toEqual(beforeTools);
			expect((await sql.execute("SELECT * FROM tool WHERE name = 'community_upsert'")).rows).toHaveLength(2);
			expect((await sql.execute("SELECT * FROM tool_policy ORDER BY row_id")).rows).toEqual(beforePolicies);
			expect(credentialBytes()).toEqual(beforeCredentials);
			expect(requests).toBe(0);
		} finally {
			sql.close();
		}
	} finally {
		await config.testDb.close();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(root, { recursive: true, force: true });
	}
});
