import { describe, expect, it } from "@effect/vitest";

import { canonicalizeReadingUrl, readingIdentity } from "../src/jarvis/life-orchestrator/identity.ts";

describe("Life Orchestrator reading identity", () => {
	it("collapses tracking variants, fragments, and host casing", () => {
		expect(canonicalizeReadingUrl("http://WWW.Example.com/article/?utm_source=daily&b=2&a=1#top")).toBe(
			"http://example.com/article?a=1&b=2",
		);
	});

	it("uses permanent DOI and arXiv identities across URL variants", () => {
		const base = {
			title: "Paper",
			topic: "Research",
			publishedAt: null,
			sourceName: "Test",
			sourceKind: "crossref" as const,
		};
		expect(readingIdentity({ ...base, url: "http://dx.doi.org/10.1000/ABC" })).toMatchObject({
			identity: "doi:10.1000/abc",
			canonicalUrl: "https://doi.org/10.1000/abc",
		});
		expect(readingIdentity({ ...base, url: "https://arxiv.org/pdf/2401.12345v3.pdf" })).toMatchObject({
			identity: "arxiv:2401.12345",
			canonicalUrl: "https://arxiv.org/abs/2401.12345",
		});
	});
});
