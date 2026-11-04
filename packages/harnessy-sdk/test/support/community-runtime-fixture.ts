import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import {
	AuthTemplateSlug,
	ConnectionName,
	createExecutor,
	IntegrationSlug,
	Subject,
	Tenant,
} from "@executor-js/sdk/core";
import type { CommunityBriefingProviderScope } from "@harnessy/core";
import { Effect } from "effect";
import { openExistingMeetingEngineStore } from "../../src/meeting-publication/existing-engine-store.ts";
import { seedExistingMeetingEngineStore } from "../../src/meeting-publication/existing-engine-store-test-fixture.ts";
import {
	DISCORD_MEETING_AUTH_TEMPLATE,
	DISCORD_MEETING_INTEGRATION,
	discordMeetingPublicationPlugin,
} from "../../src/plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../../src/plugins/google-meeting-publication.ts";
import { makeWireState, startWireServer } from "./meeting-provider-wire.ts";

const schema = `CREATE TABLE community_briefings (
 briefing_id TEXT PRIMARY KEY, week_start TEXT NOT NULL, week_end TEXT NOT NULL,
 artifact_dir TEXT, briefing_path TEXT NOT NULL, discord_path TEXT NOT NULL, provenance_path TEXT NOT NULL,
 draft_hash TEXT NOT NULL, approved_hash TEXT, status TEXT NOT NULL, provider TEXT,
 google_doc_id TEXT, google_doc_url TEXT, discord_channel_id TEXT, discord_message_id TEXT,
 error_stage TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT, last_notified_at TEXT, lease_until TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, approved_at TEXT, published_at TEXT, rejected_at TEXT
);`;

/** Real persisted Executor/queue state; only the external providers are simulated over loopback. */
export const makeCommunityRuntimeFixture = async () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "community-runtime-"));
	chmodSync(root, 0o700);
	const wire = makeWireState();
	let closeServer: (() => Promise<void>) | undefined;
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		try {
			await closeServer?.();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	};
	try {
		const server = await startWireServer(wire, { keepAlive: false });
		closeServer = server.close;
		const statePath = join(root, "state");
		const credentialDirectory = join(root, "credentials");
		const engineDirectory = join(root, "engine");
		for (const directory of [statePath, credentialDirectory, engineDirectory]) {
			mkdirSync(directory, { mode: 0o700 });
			chmodSync(directory, 0o700);
		}
		const engineStatePath = join(engineDirectory, "data.db");
		await seedExistingMeetingEngineStore(engineStatePath);
		const origins = {
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		};
		const transport = { kind: "test-loopback" as const, ...origins };
		const tenantId = "community-fixture-tenant";
		const subjectId = "community-fixture-subject";
		const connections = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const executor = yield* Effect.acquireRelease(
						createExecutor({
							tenant: Tenant.make(tenantId),
							subject: Subject.make(subjectId),
							db: ({ tables }) => openExistingMeetingEngineStore({ sqlitePath: engineStatePath, tables }),
							onElicitation: "accept-all",
							plugins: [
								googleMeetingPublicationPlugin({ transport }),
								discordMeetingPublicationPlugin({ transport }),
								fileSecretsPlugin({ directory: credentialDirectory }),
							],
						}),
						(resource) => resource.close().pipe(Effect.orDie),
					);
					yield* executor["harnessy-google-meeting-publication"].register();
					yield* executor["harnessy-discord-meeting-publication"].register();
					const google = yield* executor.connections.create({
						owner: "user",
						integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
						name: ConnectionName.make("community-google"),
						template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
						values: { token: "SYNTHETIC_COMMUNITY_GOOGLE_TOKEN" },
					});
					const discord = yield* executor.connections.create({
						owner: "user",
						integration: IntegrationSlug.make(DISCORD_MEETING_INTEGRATION),
						name: ConnectionName.make("community-discord"),
						template: AuthTemplateSlug.make(DISCORD_MEETING_AUTH_TEMPLATE),
						values: { token: "SYNTHETIC_COMMUNITY_DISCORD_TOKEN" },
					});
					return { google: String(google.name), discord: String(discord.name) };
				}),
			),
		);
		for (const suffix of ["", "-wal", "-shm", "-journal"] as const) {
			if (existsSync(`${engineStatePath}${suffix}`)) chmodSync(`${engineStatePath}${suffix}`, 0o600);
		}
		const providerScope: CommunityBriefingProviderScope = {
			tenantId,
			subjectId,
			credentialDirectory,
			engineStatePath,
			google: {
				owner: "user",
				connection: connections.google,
				authTemplate: GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
				ownerEmail: wire.ownerEmail,
				folderPath: "Published/Community",
			},
			discord: {
				owner: "user",
				connection: connections.discord,
				authTemplate: DISCORD_MEETING_AUTH_TEMPLATE,
				channelId: wire.channelId,
			},
			transport: { mode: "loopback", ...origins },
		};
		const briefingId = "0123456789abcdef01234567";
		const markdownPath = join(root, "briefing.md");
		const discordPath = join(root, "discord.txt");
		const provenancePath = join(root, "proof.json");
		const markdown = "# Weekly Research Briefing\n\nDetails.\n";
		const summary = "A concise public update.\n\nRead [the research](https://example.test/research).";
		writeFileSync(markdownPath, markdown, { mode: 0o600 });
		writeFileSync(discordPath, summary, { mode: 0o600 });
		writeFileSync(provenancePath, "{}\n", { mode: 0o600 });
		const sourceHash = createHash("sha256").update(`${markdown.trim()}\0${summary.trim()}`).digest("hex");
		const queuePath = join(root, "weekly-briefings.sqlite3");
		const database = new DatabaseSync(queuePath);
		try {
			database.exec(schema);
			database
				.prepare(`INSERT INTO community_briefings
				(briefing_id,week_start,week_end,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,attempts,created_at,updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
				.run(
					briefingId,
					"2026-09-14",
					"2026-09-20",
					markdownPath,
					discordPath,
					provenancePath,
					sourceHash,
					sourceHash,
					"approved",
					0,
					"2026-09-19T00:00:00.000Z",
					"2026-09-19T00:00:00.000Z",
				);
			database.prepare("UPDATE community_briefings SET artifact_dir=?").run(root);
		} finally {
			database.close();
		}
		chmodSync(queuePath, 0o600);
		return {
			root,
			statePath,
			queuePath,
			credentialDirectory,
			engineStatePath,
			providerScope,
			wire,
			briefingId,
			sourceHash,
			markdownPath,
			discordPath,
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
};
