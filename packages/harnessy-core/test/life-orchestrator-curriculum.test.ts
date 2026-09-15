import { describe, expect, it } from "@effect/vitest";

import {
	GITCOIN_FUNDING_MECHANISMS_CURRICULUM,
	nextLifeCurriculumReadings,
} from "../src/jarvis/life-orchestrator/curriculum.ts";
import { readingIdentity } from "../src/jarvis/life-orchestrator/identity.ts";

const selection = {
	curriculum: GITCOIN_FUNDING_MECHANISMS_CURRICULUM,
	maxPerBrief: 2,
};

describe("Life Orchestrator reading curricula", () => {
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
			identity: readingIdentity(first[0]!).identity,
			status: "delivered" as const,
		};
		expect(nextLifeCurriculumReadings(selection, [deliveredFirst]).map((item) => item.title)).toEqual([
			"Bounties",
			"Milestone-Based Funding",
		]);
	});
});
