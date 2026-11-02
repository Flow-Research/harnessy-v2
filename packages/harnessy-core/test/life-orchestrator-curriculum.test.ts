import { describe, expect, it } from "@effect/vitest";

import {
	DEEPINFER_CURRICULUM,
	findLifeReadingCurriculum,
	GITCOIN_FUNDING_MECHANISMS_CURRICULUM,
	nextLifeCurriculumReadings,
} from "../src/jarvis/life-orchestrator/curriculum.ts";
import { readingIdentity } from "../src/jarvis/life-orchestrator/identity.ts";

const selection = {
	curriculum: GITCOIN_FUNDING_MECHANISMS_CURRICULUM,
	maxPerBrief: 2,
};

describe("Life Orchestrator reading curricula", () => {
	it("offers DeepInfer as an additive ordered track with no repeated URLs", () => {
		expect(findLifeReadingCurriculum("deepinfer-inference-systems")).toBe(DEEPINFER_CURRICULUM);
		expect(findLifeReadingCurriculum("gitcoin-funding-mechanisms")).toBe(GITCOIN_FUNDING_MECHANISMS_CURRICULUM);
		const track = { curriculum: DEEPINFER_CURRICULUM, maxPerBrief: 1 };
		const delivered: Array<{ identity: string; canonicalUrl: string; status: "delivered" }> = [];
		for (const item of DEEPINFER_CURRICULUM.items) {
			const next = nextLifeCurriculumReadings(track, delivered);
			expect(next).toHaveLength(1);
			expect(next[0]!.url).toBe(item.url);
			expect(new URL(item.url).protocol).toBe("https:");
			delivered.push({ ...readingIdentity(next[0]!), status: "delivered" });
		}
		expect(nextLifeCurriculumReadings(track, delivered)).toEqual([]);
	});
	it("ships every Gitcoin mechanism once with a canonical HTTPS link", () => {
		const items = GITCOIN_FUNDING_MECHANISMS_CURRICULUM.items;
		expect(items).toHaveLength(78);
		expect(new Set(items.map((item) => item.url)).size).toBe(items.length);
		for (const item of items) {
			expect(item.url).toMatch(/^https:\/\/gitcoin\.co\/mechanisms\/[a-z0-9-]+$/);
			expect(item.question.endsWith("?")).toBe(true);
		}
	});

	it("keeps the current pair until delivery and then advances in order", () => {
		const first = nextLifeCurriculumReadings(selection, []);
		expect(first.map((item) => item.title)).toEqual(["Direct Grants", "Bounties"]);
		expect(nextLifeCurriculumReadings(selection, []).map((item) => item.title)).toEqual([
			"Direct Grants",
			"Bounties",
		]);

		const deliveredFirst = {
			...readingIdentity(first[0]!),
			status: "delivered" as const,
		};
		expect(nextLifeCurriculumReadings(selection, [deliveredFirst]).map((item) => item.title)).toEqual([
			"Bounties",
			"Milestone-Based Funding",
		]);
	});

	it("skips a curriculum link whose canonical URL was delivered from another source", () => {
		const [first] = nextLifeCurriculumReadings(selection, []);
		const deliveredFromRss = {
			...readingIdentity({
				url: `${first!.url}?utm_source=rss`,
				title: first!.title,
				topic: "Feed item",
				publishedAt: null,
				sourceName: "Gitcoin blog",
				sourceKind: "rss",
			}),
			status: "delivered" as const,
		};
		expect(deliveredFromRss.identity).not.toBe(readingIdentity(first!).identity);
		expect(nextLifeCurriculumReadings(selection, [deliveredFromRss]).map((item) => item.title)).toEqual([
			"Bounties",
			"Milestone-Based Funding",
		]);
	});
});
