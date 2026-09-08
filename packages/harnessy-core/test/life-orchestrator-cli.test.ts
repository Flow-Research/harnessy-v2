import { describe, expect, it } from "@effect/vitest";

import { parseResearchDate } from "../src/cli/jarvis.ts";

describe("Life Orchestrator CLI", () => {
	it("accepts real calendar dates and rejects normalized overflow dates", () => {
		expect(parseResearchDate("2028-02-29").toISOString()).toBe("2028-02-29T11:00:00.000Z");
		expect(() => parseResearchDate("2026-02-31")).toThrow("Invalid date: 2026-02-31");
		expect(() => parseResearchDate("2026-04-31")).toThrow("Invalid date: 2026-04-31");
	});
});
