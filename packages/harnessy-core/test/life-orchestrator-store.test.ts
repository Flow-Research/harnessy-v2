import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { LifeReadingLedger } from "../src/jarvis/life-orchestrator/store.ts";

const roots: Array<string> = [];
const makeDatabasePath = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-life-"));
	roots.push(root);
	return join(root, "state", "life-orchestrator.sqlite3");
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LifeReadingLedger", () => {
	it("reconciles legacy scheme-normalized delivery using evidenced original history after reopen", async () => {
		const databasePath = makeDatabasePath();
		const historical = {
			briefPath: "/synthetic/brief.md",
			deliveredAt: "2026-09-07T05:30:00.000Z",
		};
		const legacy = await Effect.runPromise(LifeReadingLedger.open(databasePath));
		try {
			// The old normalizer persisted HTTPS even when the original source was HTTP.
			await Effect.runPromise(legacy.backfillDelivered([{ ...historical, url: "https://example.test/article" }]));
		} finally {
			legacy.close();
		}
		const ledger = await Effect.runPromise(LifeReadingLedger.open(databasePath));
		try {
			const preserved = await Effect.runPromise(ledger.list("delivered"));
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						{
							url: "http://example.test/article",
							title: "Rediscovered article",
							topic: "Migration",
							publishedAt: null,
							sourceName: "Synthetic feed",
							sourceKind: "rss",
						},
					],
					"2026-09-08T04:15:00.000Z",
				),
			);
			// Opening schema v1 alone cannot recover the discarded original scheme.
			expect(await Effect.runPromise(ledger.counts())).toMatchObject({ delivered: 1, available: 1 });
			const evidence = [{ ...historical, url: "http://example.test/article" }];
			expect(await Effect.runPromise(ledger.backfillDelivered(evidence))).toMatchObject({ deliveredInserted: 1 });
			expect(await Effect.runPromise(ledger.backfillDelivered(evidence))).toMatchObject({ deliveredInserted: 0 });
			expect(await Effect.runPromise(ledger.reserve("after-upgrade", "2026-09-08T05:30:00.000Z"))).toEqual([]);
			expect(await Effect.runPromise(ledger.list("delivered"))).toEqual(expect.arrayContaining([...preserved]));
		} finally {
			ledger.close();
		}
		const reopened = await Effect.runPromise(LifeReadingLedger.open(databasePath));
		try {
			expect(await Effect.runPromise(reopened.counts())).toMatchObject({ delivered: 2, available: 0, reserved: 0 });
			expect(await Effect.runPromise(reopened.reserve("next-day", "2026-09-09T05:30:00.000Z"))).toEqual([]);
		} finally {
			reopened.close();
		}
	});

	it("does not infer HTTP delivery from an unrelated HTTPS delivery", async () => {
		const ledger = await Effect.runPromise(LifeReadingLedger.open(makeDatabasePath()));
		try {
			await Effect.runPromise(
				ledger.backfillDelivered([
					{
						url: "https://example.test/distinct",
						briefPath: "/synthetic/https-only.md",
						deliveredAt: "2026-09-07T05:30:00.000Z",
					},
				]),
			);
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						{
							url: "http://example.test/distinct",
							title: "Different resource",
							topic: "Migration",
							publishedAt: null,
							sourceName: "Synthetic feed",
							sourceKind: "rss",
						},
					],
					"2026-09-08T04:15:00.000Z",
				),
			);
			const selected = await Effect.runPromise(ledger.reserve("distinct", "2026-09-08T05:30:00.000Z"));
			expect(selected.map((item) => item.canonicalUrl)).toEqual(["http://example.test/distinct"]);
		} finally {
			ledger.close();
		}
	});

	it("backfills historical delivery and never makes that URL available again", async () => {
		const ledger = await Effect.runPromise(LifeReadingLedger.open(makeDatabasePath()));
		try {
			const inserted = await Effect.runPromise(
				ledger.upsertCandidates(
					[
						{
							url: "https://example.com/article?utm_source=newsletter",
							title: "Article",
							topic: "Knowledge systems",
							publishedAt: "2026-09-01T00:00:00.000Z",
							sourceName: "Example",
							sourceKind: "rss",
						},
					],
					"2026-09-08T04:15:00.000Z",
				),
			);
			expect(inserted).toBe(1);

			await Effect.runPromise(
				ledger.backfillDelivered([
					{
						url: "https://www.example.com/article/#read",
						briefPath: "/briefs/07-daily-brief.md",
						deliveredAt: "2026-09-07T05:30:00.000Z",
					},
				]),
			);
			const reserved = await Effect.runPromise(
				ledger.reserve("daily:2026-09-08", "2026-09-08T05:30:00.000Z", 3, "2026-09-08T04:00:00.000Z"),
			);
			expect(reserved).toEqual([]);
			expect(await Effect.runPromise(ledger.counts())).toMatchObject({ delivered: 1, available: 0 });
		} finally {
			ledger.close();
		}
	});

	it("reserves atomically and records delivery only after publication", async () => {
		const ledger = await Effect.runPromise(LifeReadingLedger.open(makeDatabasePath()));
		try {
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						{
							url: "https://example.com/new",
							title: "New",
							topic: "Operations",
							publishedAt: null,
							sourceName: "Example",
							sourceKind: "rss",
						},
					],
					"2026-09-08T04:15:00.000Z",
				),
			);
			const first = await Effect.runPromise(
				ledger.reserve("run-one", "2026-09-08T05:30:00.000Z", 3, "2026-09-08T04:00:00.000Z"),
			);
			const second = await Effect.runPromise(
				ledger.reserve("run-two", "2026-09-08T05:31:00.000Z", 3, "2026-09-08T04:00:00.000Z"),
			);
			expect(first).toHaveLength(1);
			expect(second).toHaveLength(0);
			expect(await Effect.runPromise(ledger.markDelivered("run-one", "/brief.md", "2026-09-08T05:40:00.000Z"))).toBe(
				1,
			);
			expect(await Effect.runPromise(ledger.reserve("run-three", "2026-09-09T05:30:00.000Z", 3))).toEqual([]);
		} finally {
			ledger.close();
		}
	});

	it("honours per-source brief caps while preserving newest-first selection", async () => {
		const ledger = await Effect.runPromise(LifeReadingLedger.open(makeDatabasePath()));
		try {
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						...(["one", "two"] as const).map((slug, index) => ({
							url: `https://herdr.test/${slug}`,
							title: `Herdr ${slug}`,
							topic: "Local-first AI",
							publishedAt: `2026-09-0${8 - index}T00:00:00.000Z`,
							sourceName: "Herdr releases",
							sourceKind: "rss" as const,
						})),
						{
							url: "https://pair.test/one",
							title: "PAIR one",
							topic: "Local-first AI",
							publishedAt: "2026-09-06T00:00:00.000Z",
							sourceName: "NVIDIA PAIR releases",
							sourceKind: "rss",
						},
					],
					"2026-09-08T04:15:00.000Z",
				),
			);
			const reserved = await Effect.runPromise(
				ledger.reserve(
					"daily:2026-09-08",
					"2026-09-08T05:30:00.000Z",
					3,
					"2026-09-08T04:00:00.000Z",
					new Map([
						["Herdr releases", 1],
						["NVIDIA PAIR releases", 1],
					]),
				),
			);
			expect(reserved.map((candidate) => candidate.title)).toEqual(["Herdr one", "PAIR one"]);
			expect(await Effect.runPromise(ledger.counts())).toMatchObject({ available: 1, reserved: 2 });
		} finally {
			ledger.close();
		}
	});

	it("reserves a capped curriculum before the general research queue", async () => {
		const ledger = await Effect.runPromise(LifeReadingLedger.open(makeDatabasePath()));
		try {
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						...(["direct-grants", "bounties", "milestones"] as const).map((slug, index) => ({
							url: `https://gitcoin.co/mechanisms/${slug}`,
							title: slug,
							topic: "Funding",
							publishedAt: null,
							sourceName: "Gitcoin funding mechanisms",
							sourceKind: "curated" as const,
							sourceId: `curriculum:gitcoin-funding-mechanisms:00${index + 1}`,
						})),
						{
							url: "https://example.com/current",
							title: "Current research",
							topic: "Current research",
							publishedAt: "2026-09-13T00:00:00.000Z",
							sourceName: "Research Press",
							sourceKind: "rss",
						},
					],
					"2026-09-13T04:15:00.000Z",
				),
			);
			const reserved = await Effect.runPromise(
				ledger.reserve(
					"daily:2026-09-13",
					"2026-09-13T05:30:00.000Z",
					3,
					"2026-09-13T04:00:00.000Z",
					new Map([["Gitcoin funding mechanisms", 2]]),
					new Set(["Gitcoin funding mechanisms"]),
				),
			);
			expect(reserved.map((candidate) => candidate.sourceName)).toEqual([
				"Gitcoin funding mechanisms",
				"Gitcoin funding mechanisms",
				"Research Press",
			]);
			expect(reserved.map((candidate) => candidate.title)).toEqual([
				"direct-grants",
				"bounties",
				"Current research",
			]);
		} finally {
			ledger.close();
		}
	});

	it("migrates the version-one ledger before accepting curated readings", async () => {
		const path = makeDatabasePath();
		mkdirSync(dirname(path), { recursive: true });
		const database = new DatabaseSync(path);
		database.exec(`CREATE TABLE reading_candidates (
  identity TEXT PRIMARY KEY, canonical_url TEXT NOT NULL, title TEXT NOT NULL, topic TEXT NOT NULL,
  published_at TEXT, discovered_at TEXT NOT NULL, source_name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('rss','crossref','agent','backfill')),
  source_id TEXT, status TEXT NOT NULL CHECK(status IN ('available','reserved','delivered')),
  reserved_for TEXT, reserved_at TEXT, delivered_at TEXT, delivered_brief TEXT
);
CREATE INDEX reading_candidates_status_order ON reading_candidates(status, published_at DESC, discovered_at DESC);
CREATE TABLE life_runs (
  run_id TEXT PRIMARY KEY, job TEXT NOT NULL, effective_date TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT, detail_json TEXT NOT NULL
);
PRAGMA user_version = 1;`);
		database.close();

		const ledger = await Effect.runPromise(LifeReadingLedger.open(path));
		try {
			expect(
				await Effect.runPromise(
					ledger.upsertCandidates(
						[
							{
								url: "https://gitcoin.co/mechanisms/direct-grants",
								title: "Direct Grants",
								topic: "Funding",
								publishedAt: null,
								sourceName: "Gitcoin funding mechanisms",
								sourceKind: "curated",
							},
						],
						"2026-09-13T04:15:00.000Z",
					),
				),
			).toBe(1);
			expect((await Effect.runPromise(ledger.list()))[0]?.sourceKind).toBe("curated");
		} finally {
			ledger.close();
		}
	});

	it("does not reclaim fresh reservations when callers omit the stale cutoff", async () => {
		const ledger = await Effect.runPromise(LifeReadingLedger.open(makeDatabasePath()));
		try {
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						{
							url: "https://example.com/fresh-reservation",
							title: "Fresh reservation",
							topic: "Operations",
							publishedAt: null,
							sourceName: "Example",
							sourceKind: "rss",
						},
					],
					"2026-09-08T05:00:00.000Z",
				),
			);
			expect(await Effect.runPromise(ledger.reserve("run-one", "2026-09-08T05:30:00.000Z"))).toHaveLength(1);
			expect(await Effect.runPromise(ledger.reserve("run-two", "2026-09-08T05:31:00.000Z"))).toEqual([]);
		} finally {
			ledger.close();
		}
	});
});
