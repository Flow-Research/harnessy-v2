/**
 * Every screen and component of the app has its own coverage floor. A glob
 * threshold is an aggregate over its files, so one weak file could hide behind
 * strong ones; a per-file entry cannot.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import config from "../vitest.config.ts";

const appDir = new URL("../src/portal/app/", import.meta.url);
const tsxFiles = (sub: string): string[] =>
	readdirSync(new URL(sub, appDir))
		.filter((name) => name.endsWith(".tsx"))
		.map((name) => `src/portal/app/${sub}${name}`);

describe("app coverage floors", () => {
	it("gives each screen and component its own per-file threshold, with no aggregate glob over them", () => {
		const thresholds =
			(config.test?.coverage as { thresholds?: Record<string, unknown> } | undefined)?.thresholds ?? {};
		const files = [...tsxFiles("screens/"), ...tsxFiles("components/"), "src/portal/app/App.tsx"];
		expect(files.length).toBeGreaterThan(10);
		for (const file of files) {
			expect(thresholds[file], `no coverage floor for ${file}`).toMatchObject({
				statements: expect.any(Number),
				branches: expect.any(Number),
				functions: expect.any(Number),
				lines: expect.any(Number),
			});
		}
		expect(Object.keys(thresholds).filter((key) => key.includes("*") && key.startsWith("src/portal/app/"))).toEqual(
			[],
		);
	});
});
