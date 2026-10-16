import { describe, expect, it } from "@effect/vitest";

import {
	extractWorthReadingUrls,
	replaceWorthReadingSection,
	validateWorthReadingSection,
} from "../src/jarvis/life-orchestrator/artifact.ts";
import { LifeReadingCandidate } from "../src/jarvis/life-orchestrator/models.ts";

const candidate = new LifeReadingCandidate({
	identity: "doi:10.1000/new",
	canonicalUrl: "https://doi.org/10.1000/new",
	title: "A useful paper",
	topic: "Local-first systems",
	publishedAt: "2025-09-08T00:00:00.000Z",
	discoveredAt: "2026-09-08T04:15:00.000Z",
	sourceName: "Crossref",
	sourceKind: "crossref",
	sourceId: "doi:10.1000/new",
	status: "reserved",
	reservedFor: "daily:2026-09-08",
	reservedAt: "2026-09-08T05:30:00.000Z",
	deliveredAt: null,
	deliveredBrief: null,
});

describe("Life Orchestrator brief artifact", () => {
	it("replaces model recommendations and preserves following sections", () => {
		const draft =
			"# Daily Brief\n\n## Worth Reading\n\n- [Repeated](https://example.com/old)\n\n## Reflection\n\nStay focused.\n";
		const rewritten = replaceWorthReadingSection(draft, [candidate], new Date("2026-09-08T06:00:00.000Z"));

		expect(extractWorthReadingUrls(rewritten)).toEqual([candidate.canonicalUrl]);
		expect(rewritten).toContain("Reading shortage: only one unseen verified source");
		expect(rewritten).toContain("## Reflection\n\nStay focused.");
		validateWorthReadingSection(rewritten, [candidate], new Set());
	});

	it("publishes an honest empty section without recycling links", () => {
		const rewritten = replaceWorthReadingSection("# Daily Brief\n", [], new Date("2026-09-08T06:00:00.000Z"));
		expect(extractWorthReadingUrls(rewritten)).toEqual([]);
		expect(rewritten).toContain("no unseen verified sources");
	});

	it("rejects a candidate already present in the permanent delivery ledger", () => {
		const rewritten = replaceWorthReadingSection(
			"# Daily Brief\n",
			[candidate],
			new Date("2026-09-08T06:00:00.000Z"),
		);
		expect(() => validateWorthReadingSection(rewritten, [candidate], new Set([candidate.identity]))).toThrow(
			"Previously delivered reading",
		);
	});

	it("escapes untrusted feed metadata without creating extra Markdown links", () => {
		const hostile = new LifeReadingCandidate({
			...candidate,
			title: "Foo](https://title.example) [Bar",
			topic: "[Topic](https://topic.example)",
			sourceName: "Source [name](https://source.example)",
		});
		const rewritten = replaceWorthReadingSection("# Daily Brief\n", [hostile], new Date("2026-09-08T06:00:00.000Z"));

		expect(extractWorthReadingUrls(rewritten)).toEqual([candidate.canonicalUrl]);
		expect(rewritten).not.toContain("(https://title.example)");
		expect(rewritten).not.toContain("(https://topic.example)");
		expect(rewritten).not.toContain("(https://source.example)");
		validateWorthReadingSection(rewritten, [hostile], new Set());
	});

	it("round-trips URL parentheses and ignores malformed historical links", () => {
		const parenthesized = new LifeReadingCandidate({
			...candidate,
			identity: "url:parenthesized",
			canonicalUrl: "https://en.wikipedia.org/wiki/Foo_(bar)",
		});
		const rewritten = replaceWorthReadingSection(
			"# Daily Brief\n",
			[parenthesized],
			new Date("2026-09-08T06:00:00Z"),
		);

		expect(extractWorthReadingUrls(rewritten)).toEqual([parenthesized.canonicalUrl]);
		expect(extractWorthReadingUrls("## Worth Reading\n\n- [Bad](https://%)\n")).toEqual([]);
		validateWorthReadingSection(rewritten, [parenthesized], new Set());
	});
});
