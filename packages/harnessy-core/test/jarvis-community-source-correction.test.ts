import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctJarvisCommunitySource } from "../src/runtime/jarvis-community-source-correction.ts";

describe("V2 community collector installation correction", () => {
	it("uses the shared bounded traversal only for the exact preserved source", () => {
		const path = new URL(
			"../../capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/community_briefing/collector.py",
			import.meta.url,
		);
		const source = readFileSync(path, "utf8");
		const corrected = correctJarvisCommunitySource(source);
		expect(corrected).not.toContain('root.rglob("*.md")');
		expect(corrected).toContain("def iter_content_files(");
		expect(corrected).toContain("path for path in iter_content_files(root)");
		expect(readFileSync(path, "utf8")).toBe(source);
		expect(() => correctJarvisCommunitySource(`${source}\n`)).toThrow("Unknown Jarvis community collector");
		expect(() => correctJarvisCommunitySource(corrected)).toThrow("Unknown Jarvis community collector");
	});
});
