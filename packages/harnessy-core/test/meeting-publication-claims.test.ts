import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationItem, MeetingPublicationTransitionError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: Array<string> = [];

const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-meeting-claims-"));
	roots.push(root);
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (root: string) =>
	new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 900,
		reviewMaxSessions: 64,
		reviewMaxBodyBytes: 4_096,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

const note = (root: string, sourceHash: string) => ({
	itemId: "a".repeat(24),
	path: join(root, "notes", "weekly.md"),
	relativePath: "weekly.md",
	title: "Weekly Sync",
	meetingDate: "2026-09-03",
	project: "alpha",
	sourceHash,
	summary: "We aligned on the release.",
	markdown: "# Weekly Sync\n",
});

const runStore = <A>(
	config: JarvisMeetingPublicationConfig,
	effect: Effect.Effect<A, unknown, MeetingPublicationStore>,
) =>
	Effect.runPromise(
		Effect.scoped(
			effect.pipe(
				Effect.provide(
					MeetingPublicationStore.layer(config).pipe(
						Layer.provide(meetingPublicationTestWriteAuthorityLayer(config)),
					),
				),
			),
		),
	);

const insertApproved = (root: string, sourceHash: string) =>
	Effect.gen(function* () {
		const store = yield* MeetingPublicationStore;
		const source = note(root, sourceHash);
		yield* store.upsert(source, "2026-09-04T12:00:00.000Z");
		yield* store.approve(source.itemId, source.sourceHash, null, "2026-09-04T12:00:01.000Z");
		return source;
	});

describe("MeetingPublicationStore claim fencing", () => {
	it("claims only the exact approved item revision and leaves wrong targets unchanged", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const first = yield* insertApproved(root, "1".repeat(64));
				const second = {
					...note(root, "2".repeat(64)),
					itemId: "b".repeat(24),
					path: join(root, "notes", "second.md"),
					relativePath: "second.md",
				};
				yield* store.upsert(second, "2026-09-04T12:00:00.000Z");
				yield* store.approve(second.itemId, second.sourceHash, null, "2026-09-04T12:00:01.000Z");

				const beforeWrong = readFileSync(store.dbPath);
				const wrongRevision = yield* store.claimExact(
					second.itemId,
					"3".repeat(64),
					"2026-09-04T12:00:02.000Z",
					"2026-09-04T12:01:02.000Z",
				);
				const wrongItem = yield* store.claimExact(
					"c".repeat(24),
					second.sourceHash,
					"2026-09-04T12:00:02.000Z",
					"2026-09-04T12:01:02.000Z",
				);
				const afterWrong = readFileSync(store.dbPath);
				const claimed = yield* store.claimExact(
					second.itemId,
					second.sourceHash,
					"2026-09-04T12:00:02.000Z",
					"2026-09-04T12:01:02.000Z",
				);
				return {
					wrongRevision,
					wrongItem,
					beforeWrong,
					afterWrong,
					claimed,
					first: yield* store.get(first.itemId),
					second: yield* store.get(second.itemId),
				};
			}),
		);

		expect(result.wrongRevision).toBeNull();
		expect(result.wrongItem).toBeNull();
		expect(result.afterWrong).toEqual(result.beforeWrong);
		expect(result.claimed).toMatchObject({
			itemId: "b".repeat(24),
			sourceHash: "2".repeat(64),
			approvedHash: "2".repeat(64),
			status: "publishing",
			attempts: 1,
		});
		expect(result.first).toMatchObject({ status: "approved", attempts: 0, leaseUntil: null });
		expect(result.second).toEqual(result.claimed);
	});

	it("rejects every expired owner mutation after reclaim and accepts the exact current claim", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const source = yield* insertApproved(root, "1".repeat(64));
				const first = yield* store.claim("2026-09-04T12:00:02.000Z", "2026-09-04T12:01:02.000Z");
				if (first === null) return yield* Effect.die("missing first claim");

				const expired = yield* Effect.result(store.getClaim(first, "2026-09-04T12:01:02.000Z"));
				const second = yield* store.claim("2026-09-04T12:01:02.000Z", "2026-09-04T12:02:02.000Z");
				if (second === null) return yield* Effect.die("missing reclaimed claim");
				const sameTimestampsOldAttempt = new MeetingPublicationItem({
					...first,
					leaseUntil: second.leaseUntil,
					updatedAt: second.updatedAt,
				});
				const oldAttempt = yield* Effect.result(
					store.getClaim(sameTimestampsOldAttempt, "2026-09-04T12:01:03.000Z"),
				);

				const beforeItem = yield* store.get(source.itemId);
				const beforeBytes = readFileSync(store.dbPath);
				const google = yield* Effect.result(
					store.recordGoogle(first, "stale-doc", "https://docs.example/stale", "2026-09-04T12:01:03.000Z"),
				);
				const discord = yield* Effect.result(store.recordDiscord(first, "100", "200", "2026-09-04T12:01:03.000Z"));
				const failure = yield* Effect.result(
					store.markFailure(first, "discord", "stale", null, "2026-09-04T12:01:03.000Z"),
				);
				const published = yield* Effect.result(store.markPublished(first, "2026-09-04T12:01:03.000Z"));
				const afterItem = yield* store.get(source.itemId);
				const afterBytes = readFileSync(store.dbPath);

				const current = yield* store.getClaim(second, "2026-09-04T12:01:03.000Z");
				yield* store.recordGoogle(
					second,
					"current-doc",
					"https://docs.example/current",
					"2026-09-04T12:01:04.000Z",
				);
				yield* store.recordDiscord(second, "300", "400", "2026-09-04T12:01:05.000Z");
				const final = yield* store.markPublished(second, "2026-09-04T12:01:06.000Z");
				return {
					expired,
					oldAttempt,
					second,
					stale: [google, discord, failure, published].map((outcome) => outcome._tag === "Failure"),
					beforeItem,
					afterItem,
					beforeBytes,
					afterBytes,
					current,
					final,
				};
			}),
		);

		expect(Result.isFailure(result.expired)).toBe(true);
		expect(Result.isFailure(result.oldAttempt)).toBe(true);
		expect(result.second.attempts).toBe(2);
		expect(result.stale).toEqual([true, true, true, true]);
		expect(result.afterItem).toEqual(result.beforeItem);
		expect(result.afterBytes).toEqual(result.beforeBytes);
		expect(result.current).toEqual(result.second);
		expect(result.final).toMatchObject({
			status: "published",
			googleDocId: "current-doc",
			googleSourceHash: "1".repeat(64),
			discordChannelId: "300",
			discordMessageId: "400",
		});
	});

	it("rejects a prior source revision after hash change and reapproval", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const firstSource = yield* insertApproved(root, "1".repeat(64));
				const first = yield* store.claim("2026-09-04T12:00:02.000Z", "2026-09-04T12:01:02.000Z");
				if (first === null) return yield* Effect.die("missing first claim");
				const changed = note(root, "2".repeat(64));
				yield* store.upsert(changed, "2026-09-04T12:00:03.000Z");
				yield* store.approve(changed.itemId, changed.sourceHash, null, "2026-09-04T12:00:04.000Z");
				const second = yield* store.claim("2026-09-04T12:00:05.000Z", "2026-09-04T12:01:05.000Z");
				if (second === null) return yield* Effect.die("missing revised claim");
				const stale = yield* Effect.result(
					store.recordGoogle(first, "stale", "https://docs.example/stale", "2026-09-04T12:00:06.000Z"),
				);
				return { firstSource, first, second, stale, current: yield* store.get(changed.itemId) };
			}),
		);

		expect(result.first.sourceHash).toBe(result.firstSource.sourceHash);
		expect(result.second).toMatchObject({
			attempts: 2,
			sourceHash: "2".repeat(64),
			approvedHash: "2".repeat(64),
		});
		expect(Result.isFailure(result.stale)).toBe(true);
		expect(result.current).toEqual(result.second);
	});

	it("independently rejects every altered claim binding without mutation", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const result = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const source = yield* insertApproved(root, "1".repeat(64));
				const current = yield* store.claim("2026-09-04T12:00:02.000Z", "2026-09-04T12:01:02.000Z");
				if (current === null) return yield* Effect.die("missing current claim");
				const now = "2026-09-04T12:00:03.000Z";
				const exact = yield* store.getClaim(current, now);
				const beforeItem = yield* store.get(source.itemId);
				const beforeBytes = readFileSync(store.dbPath);
				const changedHash = "2".repeat(64);
				const cases = [
					["status", new MeetingPublicationItem({ ...current, status: "approved" }), now],
					["safe attempt", new MeetingPublicationItem({ ...current, attempts: current.attempts + 1 }), now],
					["source hash", new MeetingPublicationItem({ ...current, sourceHash: changedHash }), now],
					["approved hash", new MeetingPublicationItem({ ...current, approvedHash: changedHash }), now],
					["null approved hash", new MeetingPublicationItem({ ...current, approvedHash: null }), now],
					[
						"source and approved hash",
						new MeetingPublicationItem({ ...current, sourceHash: changedHash, approvedHash: changedHash }),
						now,
					],
					[
						"different future lease",
						new MeetingPublicationItem({ ...current, leaseUntil: "2026-09-04T12:02:02.000Z" }),
						now,
					],
					["null lease", new MeetingPublicationItem({ ...current, leaseUntil: null }), now],
					[
						"noncanonical lease",
						new MeetingPublicationItem({ ...current, leaseUntil: "2026-09-04T12:01:02Z" }),
						now,
					],
					["invalid now", current, "2026-09-04T12:00:03Z"],
				] as const;
				const outcomes = [];
				for (const [name, claim, checkedAt] of cases) {
					outcomes.push({ name, result: yield* Effect.result(store.getClaim(claim, checkedAt)) });
				}
				return {
					exact,
					current,
					outcomes,
					beforeItem,
					afterItem: yield* store.get(source.itemId),
					beforeBytes,
					afterBytes: readFileSync(store.dbPath),
				};
			}),
		);

		expect(result.exact).toEqual(result.current);
		for (const { name, result: outcome } of result.outcomes) {
			expect(Result.isFailure(outcome), name).toBe(true);
			if (Result.isFailure(outcome)) {
				expect(outcome.failure, name).toBeInstanceOf(MeetingPublicationTransitionError);
				expect(outcome.failure, name).toMatchObject({ event: "claim" });
			}
		}
		expect(result.afterItem).toEqual(result.beforeItem);
		expect(result.afterBytes).toEqual(result.beforeBytes);
	});

	it("rejects noncanonical leases, nonpositive intervals, and unsafe attempt increments without mutation", async () => {
		const root = makeRoot();
		const config = makeConfig(root);
		const initialized = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const source = yield* insertApproved(root, "1".repeat(64));
				const before = yield* store.get(source.itemId);
				const beforeBytes = readFileSync(store.dbPath);
				const malformed = yield* Effect.result(store.claim("2026-09-04T12:00:02Z", "2026-09-04T12:01:02.000Z"));
				const nonpositive = yield* Effect.result(
					store.claim("2026-09-04T12:00:02.000Z", "2026-09-04T12:00:02.000Z"),
				);
				return {
					dbPath: store.dbPath,
					itemId: source.itemId,
					before,
					after: yield* store.get(source.itemId),
					beforeBytes,
					afterBytes: readFileSync(store.dbPath),
					malformed,
					nonpositive,
				};
			}),
		);

		expect(Result.isFailure(initialized.malformed)).toBe(true);
		expect(Result.isFailure(initialized.nonpositive)).toBe(true);
		expect(initialized.after).toEqual(initialized.before);
		expect(initialized.afterBytes).toEqual(initialized.beforeBytes);

		const database = new DatabaseSync(initialized.dbPath);
		database
			.prepare("UPDATE publication_items SET attempts=? WHERE item_id=?")
			.run(Number.MAX_SAFE_INTEGER, initialized.itemId);
		database.close();
		const beforeUnsafeClaim = readFileSync(initialized.dbPath);
		const unsafe = await runStore(
			config,
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const claim = yield* Effect.result(store.claim("2026-09-04T12:00:02.000Z", "2026-09-04T12:01:02.000Z"));
				return { claim, item: yield* store.get(initialized.itemId) };
			}),
		);
		expect(Result.isFailure(unsafe.claim)).toBe(true);
		expect(unsafe.item?.attempts).toBe(Number.MAX_SAFE_INTEGER);
		expect(readFileSync(initialized.dbPath)).toEqual(beforeUnsafeClaim);
	});
});
