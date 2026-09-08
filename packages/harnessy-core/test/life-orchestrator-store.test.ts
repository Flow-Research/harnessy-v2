import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
