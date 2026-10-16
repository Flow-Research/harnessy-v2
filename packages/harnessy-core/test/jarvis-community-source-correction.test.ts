import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctJarvisCommunitySource } from "../src/runtime/jarvis-community-source-correction.ts";

describe("V2 community collector installation correction", () => {
	it("corrects the exact preserved source and accepts the canonical corrected source idempotently", () => {
		const path = new URL(
			"../../capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/community_briefing/collector.py",
			import.meta.url,
		);
		const source = readFileSync(path, "utf8");
		const marker = "\n\ndef iter_content_files(";
		const preserved = source
			.slice(0, source.indexOf(marker))
			.replace("import stat\n", "")
			.replace(
				'sorted(path for path in iter_content_files(root) if path.suffix == ".md")',
				'sorted(root.rglob("*.md"))',
			);
		const corrected = correctJarvisCommunitySource(preserved);
		expect(corrected).toBe(source);
		expect(corrected).not.toContain('root.rglob("*.md")');
		expect(corrected).toContain("def iter_content_files(");
		expect(corrected).toContain("path for path in iter_content_files(root)");
		expect(readFileSync(path, "utf8")).toBe(source);
		expect(correctJarvisCommunitySource(corrected)).toBe(corrected);
		expect(() => correctJarvisCommunitySource(`${source}\n`)).toThrow("Unknown Jarvis community collector");
	});
});
