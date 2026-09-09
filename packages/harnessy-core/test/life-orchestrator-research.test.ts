import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
	chooseLifeResearchTopic,
	discoverLifeReadings,
	parseCrossrefWorks,
	parseHnSearch,
	parseLifeFeed,
	parseLifeResearchTopics,
} from "../src/jarvis/life-orchestrator/research.ts";

const rss = `<?xml version="1.0"?>
<rss><channel>
  <item><title>Fresh systems paper</title><link>https://example.test/fresh</link><pubDate>Mon, 07 Sep 2026 12:00:00 GMT</pubDate><description>measurement</description></item>
  <item><title>Old governance reference</title><link>https://example.test/old</link><pubDate>Mon, 07 Sep 2020 12:00:00 GMT</pubDate><description>validator governance and trust</description></item>
</channel></rss>`;

const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Preview build 123</title><link rel="alternate" href="https://example.test/preview"/><updated>2026-09-08T09:00:00Z</updated></entry>
  <entry><title>Herdr</title><link rel="alternate" href="https://example.test/herdr"/><updated>2026-09-07T19:21:31Z</updated><summary>A local coding agent runtime</summary></entry>
  <entry><title>Hosted database</title><link rel="alternate" href="https://example.test/database"/><updated>2026-09-07T18:00:00Z</updated><summary>A cloud data service</summary></entry>
</feed>`;

describe("Life Orchestrator research", () => {
	it("parses ordered steering topics and rotates deterministically", () => {
		const topics = parseLifeResearchTopics(
			"# Research\n\n## Current Topics\n\n- Alpha\n- Beta\n\n## Rules\n\nText\n",
		);
		expect(topics).toEqual(["Alpha", "Beta"]);
		expect(topics).toContain(chooseLifeResearchTopic(topics, new Date("2026-09-08T00:00:00.000Z")));
	});

	it("parses RSS metadata and Crossref DOI records", () => {
		expect(parseLifeFeed(rss)).toHaveLength(2);
		expect(parseLifeFeed(atom).map((entry) => entry.title)).toEqual([
			"Preview build 123",
			"Herdr",
			"Hosted database",
		]);
		expect(
			parseCrossrefWorks(
				{
					message: {
						items: [
							{
								DOI: "10.1000/TEST",
								title: ["Measured inference"],
								publisher: "Research Press",
								published: { "date-parts": [[2025, 2, 3]] },
							},
						],
					},
				},
				"Inference",
			),
		).toMatchObject([{ sourceId: "doi:10.1000/TEST", publishedAt: "2025-02-03T00:00:00.000Z" }]);
	});

	it("parses technology discoveries from Hacker News search", () => {
		expect(
			parseHnSearch({
				hits: [
					{
						title: "A local agent runtime",
						url: "https://project.example/runtime",
						created_at: "2026-09-08T09:00:00Z",
					},
					{ title: "Ask HN without a project URL", created_at: "2026-09-08T08:00:00Z" },
				],
			}),
		).toMatchObject([
			{
				title: "A local agent runtime",
				url: "https://project.example/runtime",
				publishedAt: "2026-09-08T09:00:00.000Z",
			},
		]);
	});

	it("applies technology-radar inclusion and noise filters", async () => {
		const fakeFetch: typeof globalThis.fetch = async (input) =>
			String(input).includes("crossref")
				? new Response(JSON.stringify({ message: { items: [] } }), { status: 200 })
				: new Response(atom, { status: 200 });
		const result = await Effect.runPromise(
			discoverLifeReadings({
				topic: "Local-first AI",
				now: new Date("2026-09-08T12:00:00.000Z"),
				lookbackDays: 21,
				maximum: 6,
				fetch: fakeFetch,
				sources: [
					{
						name: "Herdr releases",
						url: "https://example.test/releases.atom",
						topic: "Local-first AI and personal compute",
						enabled: true,
						maxItemsPerPoll: 2,
						evergreenEnabled: false,
						maxEvergreenPerPoll: 0,
						evergreenKeywords: [],
						includeKeywords: ["agent runtime"],
						excludeTitlePatterns: ["preview build"],
					},
				],
			}),
		);
		expect(result.candidates.map((candidate) => candidate.title)).toEqual(["Herdr"]);
		const titleOnly = await Effect.runPromise(
			discoverLifeReadings({
				topic: "Local-first AI",
				now: new Date("2026-09-08T12:00:00.000Z"),
				lookbackDays: 21,
				maximum: 6,
				fetch: fakeFetch,
				sources: [
					{
						name: "Technology radar",
						url: "https://example.test/radar.atom",
						topic: "Local-first AI",
						enabled: true,
						maxItemsPerPoll: 2,
						evergreenEnabled: false,
						maxEvergreenPerPoll: 0,
						evergreenKeywords: [],
						includeKeywords: ["agent runtime"],
						includeScope: "title",
					},
				],
			}),
		);
		expect(titleOnly.candidates).toEqual([]);
	});

	it("isolates a failing source while returning RSS and Crossref candidates", async () => {
		const fakeFetch: typeof globalThis.fetch = async (input) => {
			const url = String(input);
			if (url.includes("broken")) throw new Error("offline");
			if (url.includes("crossref")) {
				return new Response(
					JSON.stringify({
						message: { items: [{ DOI: "10.1000/NEW", title: ["New paper"], publisher: "Press" }] },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
		};
		const result = await Effect.runPromise(
			discoverLifeReadings({
				topic: "Inference",
				now: new Date("2026-09-08T00:00:00.000Z"),
				lookbackDays: 21,
				maximum: 6,
				fetch: fakeFetch,
				sources: [
					{
						name: "Feed",
						url: "https://example.test/feed.xml",
						topic: "Systems",
						enabled: true,
						maxItemsPerPoll: 5,
						evergreenEnabled: true,
						maxEvergreenPerPoll: 1,
						evergreenKeywords: ["governance"],
					},
					{
						name: "Broken",
						url: "https://broken.test/feed.xml",
						topic: "Systems",
						enabled: true,
						maxItemsPerPoll: 5,
						evergreenEnabled: false,
						maxEvergreenPerPoll: 0,
						evergreenKeywords: [],
					},
				],
			}),
		);
		expect(result.sourcesAttempted).toBe(3);
		expect(result.sourceFailures).toEqual(["Broken: offline"]);
		expect(result.candidates.map((candidate) => candidate.title)).toEqual([
			"Fresh systems paper",
			"New paper",
			"Old governance reference",
		]);
	});

	it("serializes requests to the same feed host", async () => {
		let active = 0;
		let maximumActive = 0;
		const fakeFetch: typeof globalThis.fetch = async (input) => {
			if (String(input).includes("crossref")) {
				return new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
			}
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await Promise.resolve();
			active -= 1;
			return new Response(rss, { status: 200 });
		};
		const source = (path: string) => ({
			name: path,
			url: `https://feeds.example.test/${path}`,
			topic: "Local-first AI",
			enabled: true,
			maxItemsPerPoll: 1,
			evergreenEnabled: false,
			maxEvergreenPerPoll: 0,
			evergreenKeywords: [],
		});
		await Effect.runPromise(
			discoverLifeReadings({
				topic: "Local-first AI",
				now: new Date("2026-09-08T12:00:00.000Z"),
				lookbackDays: 21,
				maximum: 6,
				fetch: fakeFetch,
				sources: [source("one"), source("two")],
			}),
		);
		expect(maximumActive).toBe(1);
	});

	it("isolates malformed source URLs before request grouping", async () => {
		const fakeFetch: typeof globalThis.fetch = async () =>
			new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
		const result = await Effect.runPromise(
			discoverLifeReadings({
				topic: "Local-first AI",
				now: new Date("2026-09-08T12:00:00.000Z"),
				lookbackDays: 21,
				maximum: 3,
				fetch: fakeFetch,
				sources: [
					{
						name: "Malformed",
						url: "https://%",
						topic: "Systems",
						enabled: true,
						maxItemsPerPoll: 1,
						evergreenEnabled: false,
						maxEvergreenPerPoll: 0,
						evergreenKeywords: [],
					},
				],
			}),
		);

		expect(result.sourcesAttempted).toBe(2);
		expect(result.sourceFailures).toEqual(["Malformed: invalid URL"]);
	});

	it("rejects oversized external responses without aborting other sources", async () => {
		const fakeFetch: typeof globalThis.fetch = async (input) =>
			String(input).includes("large")
				? new Response("x".repeat(2_097_153), { status: 200 })
				: new Response(JSON.stringify({ message: { items: [] } }), { status: 200 });
		const result = await Effect.runPromise(
			discoverLifeReadings({
				topic: "Local-first AI",
				now: new Date("2026-09-08T12:00:00.000Z"),
				lookbackDays: 21,
				maximum: 3,
				fetch: fakeFetch,
				sources: [
					{
						name: "Large feed",
						url: "https://large.example/feed.xml",
						topic: "Systems",
						enabled: true,
						maxItemsPerPoll: 1,
						evergreenEnabled: false,
						maxEvergreenPerPoll: 0,
						evergreenKeywords: [],
					},
				],
			}),
		);

		expect(result.sourceFailures).toEqual(["Large feed: response exceeds 2097152 bytes"]);
	});
});
