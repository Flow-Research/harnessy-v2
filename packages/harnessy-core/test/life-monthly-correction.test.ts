import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { correctLifeInstructions } from "../src/runtime/life-monthly-correction.ts";

for (const file of ["SKILL.md", "commands/life.md"] as const) {
	it(`corrects only known monthly instructions in ${file}`, () => {
		const source = readFileSync(
			new URL(
				`../../capability-harnessy-v1-full/resources/source/tools/flow-install/skills/life-orchestrator/${file}`,
				import.meta.url,
			),
			"utf8",
		);
		const corrected = correctLifeInstructions(file, source);
		expect(corrected).not.toContain("goal-agent");
		expect(corrected).toContain("supervised native Codex");
		expect(() => correctLifeInstructions(file, `${source}\nchanged`)).toThrow("Unknown Life instructions");
		if (file === "commands/life.md") {
			expect(corrected).toContain("$OUTPUT_DIR/monthly-review.md");
			expect(corrected).toContain("preserve\n   owner-authored edits");
			const weekly = corrected.slice(corrected.indexOf("### `weekly`"), corrected.indexOf("### `daily`"));
			const daily = corrected.slice(corrected.indexOf("### `daily`"), corrected.indexOf("### `status`"));
			expect(weekly).toContain("harnessy jarvis life draft --kind weekly");
			expect(daily).toContain("harnessy jarvis life draft --kind daily");
			expect(`${weekly}${daily}`).not.toContain("python3");
			expect(`${weekly}${daily}`).not.toContain("jarvis journal write");
			expect(`${weekly}${daily}`).not.toContain("osascript");
		}
	});
}
