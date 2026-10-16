import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { correctJarvisPlanningSource } from "../src/runtime/jarvis-planning-correction.ts";

it("corrects only the known source while keeping the oracle unchanged", () => {
	const root = dirname(createRequire(import.meta.url).resolve("@harnessy/capability-harnessy-v1-full/package.json"));
	const path = join(root, "resources/source/jarvis-cli/src/jarvis/services/planning_service.py");
	const source = readFileSync(path, "utf8");
	const corrected = correctJarvisPlanningSource(source);
	expect(corrected).toContain("b.start < day_end and b.end > day_start");
	expect(corrected).toContain("free_slots.sort(key=lambda slot: slot[0])");
	expect(readFileSync(path, "utf8")).toBe(source);
	expect(() => correctJarvisPlanningSource(`${source}\n# changed`)).toThrow("Unknown");
	expect(() => correctJarvisPlanningSource(corrected)).toThrow("Unknown");
});
