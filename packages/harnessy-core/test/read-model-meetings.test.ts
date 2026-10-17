import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import {
	inspectMeetingPublicationQueue,
	MeetingPublicationInspector,
} from "../src/jarvis/meeting-publication/inspector.ts";
import { MeetingPublicationNote } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";
import { PortalSchemas, readMeetingSummary } from "../src/read-model.ts";
import {
	cleanupReadModelFixtures,
	databaseFingerprint,
	killWriter,
	startSqliteWriter,
	tempHome,
	treeListing,
} from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T12:00:00.000Z");
const OWNER = "owner@example.test";

const makeConfig = (root: string, statePath: string | null = join(root, "state")) =>
	new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath,
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 8770,
		reviewSessionSeconds: 900,
		reviewMaxSessions: 64,
		reviewMaxBodyBytes: 4_096,
		googleOwnerEmail: OWNER,
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

const note = (root: string, name: string, meetingDate: string) =>
	new MeetingPublicationNote({
		itemId: createHash("sha256").update(`alpha:${name}`).digest("hex").slice(0, 24),
		path: join(root, "notes", `${name}.md`),
		relativePath: `${name}.md`,
		title: name,
		meetingDate,
		project: "alpha",
		sourceHash: createHash("sha256").update(name).digest("hex"),
		summary: "summary",
		markdown: `# ${name}\n`,
	});

/** Build a real queue with the writer store: three pending, one approved, Google auth failure recorded. */
const populateStore = (root: string, config: JarvisMeetingPublicationConfig) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const at = NOW.toISOString();
				for (const [name, date] of [
					["kickoff", "2026-10-01"],
					["retro", "2026-10-03"],
					["planning", "2026-10-02"],
					["approved", "2026-10-04"],
				] as const)
					yield* store.upsert(note(root, name, date), at);
				const approved = note(root, "approved", "2026-10-04");
				yield* store.approve(approved.itemId, approved.sourceHash, null, at);
				yield* store.recordProviderHealth({
					provider: "google",
					account: OWNER,
					failure: "authentication",
					checkedAt: at,
					lastSuccessAt: "2026-10-16T12:00:00.000Z",
					incidentAt: at,
					notifiedAt: null,
					recoveryPending: true,
				});
				return store.dbPath;
			}).pipe(
				Effect.provide(
					MeetingPublicationStore.layer(config).pipe(
						Layer.provide(meetingPublicationTestWriteAuthorityLayer(config)),
					),
				),
			),
		),
	);

const setup = async (prefix: string) => {
	const root = tempHome(prefix);
	mkdirSync(join(root, "notes"));
	const config = makeConfig(root);
	const dbPath = await populateStore(root, config);
	return { root, config, dbPath };
};

describe("meeting publication read model", () => {
	it("reads queue counts, pending reviews and provider health without the provider account", async () => {
		const { root, config, dbPath } = await setup("meetings-ok");
		const database = databaseFingerprint(dbPath);
		const tree = treeListing(root);
		let summary = readMeetingSummary(config, { now: NOW });
		for (let read = 0; read < 49; read += 1) summary = readMeetingSummary(config, { now: NOW });
		expect(databaseFingerprint(dbPath)).toEqual(database);
		expect(database.sidecars).toEqual([]);
		expect(treeListing(root)).toEqual(tree);
		expect(Value.Check(PortalSchemas.MeetingSummary, summary)).toBe(true);
		expect(summary.config).toMatchObject({
			state: "ok",
			data: { enabled: true, reviewHost: "127.0.0.1", reviewPort: 8770 },
		});
		expect(summary.queue).toMatchObject({
			state: "ok",
			data: {
				schemaVersion: 4,
				schemaState: "current",
				totalItems: 4,
				statusCounts: { pending_review: 3, approved: 1 },
				pendingReviewTruncated: false,
			},
		});
		expect(summary.queue.data?.pendingReview.map((item) => item.meetingDate)).toEqual([
			"2026-10-03",
			"2026-10-02",
			"2026-10-01",
		]);
		expect(summary.providers).toEqual({
			state: "ok",
			readAt: NOW.toISOString(),
			data: {
				providers: [
					{
						provider: "google",
						failure: "authentication",
						checkedAt: NOW.toISOString(),
						lastSuccessAt: "2026-10-16T12:00:00.000Z",
						recoveryPending: true,
					},
				],
			},
		});
		expect(JSON.stringify(summary)).not.toContain(OWNER);
		const limited = readMeetingSummary(config, { now: NOW, pendingLimit: 2 });
		expect(limited.queue.data).toMatchObject({ pendingReviewTruncated: true });
		expect(limited.queue.data?.pendingReview).toHaveLength(2);
	});

	it("keeps the existing state inspection result", async () => {
		const { config } = await setup("meetings-inspect");
		const inspection = await Effect.runPromise(
			Effect.gen(function* () {
				const inspector = yield* MeetingPublicationInspector;
				return yield* inspector.inspectState();
			}).pipe(
				Effect.provide(
					MeetingPublicationInspector.layer(config).pipe(
						Layer.provideMerge(
							Layer.merge(
								meetingPublicationTestWriteAuthorityLayer(config),
								MeetingPublicationSource.layer(config).pipe(
									Layer.provide(meetingPublicationTestWriteAuthorityLayer(config)),
								),
							),
						),
					),
				),
			),
		);
		expect(inspection).toMatchObject({
			exists: true,
			schemaState: "current",
			schemaVersion: 4,
			stateDirectoryMode: 0o700,
			databaseMode: 0o600,
			totalItems: 4,
			statusCounts: { pending_review: 3, approved: 1 },
			failureCounts: {},
		});
	});

	it("reports a writer's journal or lock as busy and never opens or repairs the database", async () => {
		const { config, dbPath } = await setup("meetings-busy");
		const writer = await startSqliteWriter(dbPath, "exclusive");
		const started = performance.now();
		const busy = readMeetingSummary(config, { now: NOW, timeoutMs: 100 });
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(busy.queue).toMatchObject({ state: "busy", reason: "database_busy" });
		expect(busy.providers).toMatchObject({ state: "busy", reason: "database_busy" });
		expect(busy.config.state).toBe("ok");
		await killWriter(writer, "SIGTERM");

		const crashed = await startSqliteWriter(dbPath, "hot-journal");
		await killWriter(crashed);
		const before = databaseFingerprint(dbPath);
		const recovering = readMeetingSummary(config, { now: NOW });
		expect(recovering.queue).toMatchObject({ state: "busy", reason: "journal_present" });
		expect(Value.Check(PortalSchemas.MeetingSummary, recovering)).toBe(true);
		expect(databaseFingerprint(dbPath)).toEqual(before);
	});

	it("reports missing, unsafe and unsupported state as degraded tiles", async () => {
		const empty = tempHome("meetings-missing");
		expect(readMeetingSummary(makeConfig(empty, null), { now: NOW }).queue).toMatchObject({
			state: "missing",
			reason: "database_missing",
		});
		expect(readMeetingSummary(makeConfig(empty), { now: NOW }).queue).toMatchObject({ state: "missing" });
		mkdirSync(join(empty, "state"), { mode: 0o700 });
		expect(readMeetingSummary(makeConfig(empty), { now: NOW }).providers).toMatchObject({ state: "missing" });
		if (process.getuid?.() !== 0) {
			// An unreadable state directory degrades the tiles instead of throwing.
			chmodSync(join(empty, "state"), 0o000);
			const unreadable = readMeetingSummary(makeConfig(empty), { now: NOW });
			chmodSync(join(empty, "state"), 0o700);
			expect(unreadable.queue).toMatchObject({ state: "error", reason: "read_failed" });
		}
		chmodSync(join(empty, "state"), 0o755);
		expect(readMeetingSummary(makeConfig(empty), { now: NOW }).queue).toMatchObject({
			state: "unsafe",
			reason: "unsafe_state",
		});

		const { config, dbPath } = await setup("meetings-schema");
		const downgrade = new DatabaseSync(dbPath);
		downgrade.exec("DROP TABLE provider_health; PRAGMA user_version = 3;");
		downgrade.close();
		const legacy = readMeetingSummary(config, { now: NOW });
		expect(legacy.queue).toMatchObject({
			state: "ok",
			data: { schemaVersion: 3, schemaState: "migration_required" },
		});
		expect(legacy.providers).toMatchObject({ state: "unsupported", reason: "schema_migration_required" });
		const newer = new DatabaseSync(dbPath);
		newer.exec("PRAGMA user_version = 99;");
		newer.close();
		expect(readMeetingSummary(config, { now: NOW }).queue).toMatchObject({
			state: "unsupported",
			reason: "schema_newer",
		});
		writeFileSync(`${dbPath}-wal`, "");
		expect(inspectMeetingPublicationQueue(config)).toEqual({ state: "unsafe", reason: "unsafe_state" });
	});
});
