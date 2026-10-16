import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Life Orchestrator configuration", () => {
	it("skips malformed HTTP source URLs without rejecting the full configuration", () => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-life-config-"));
		roots.push(root);
		const lifeDirectory = join(root, ".agents", "life");
		mkdirSync(lifeDirectory, { recursive: true });
		writeFileSync(
			join(lifeDirectory, "config.json"),
			JSON.stringify({
				reading: {
					sources: [
						{ url: "https://%", name: "Broken" },
						{ url: "https://example.com/feed.xml", name: "Valid" },
					],
				},
			}),
		);

		const settings = resolveLifeOrchestratorSettings({ projectRoot: root, homeRoot: root });
		expect(settings.sources.map((source) => source.name)).toEqual(["Valid"]);
	});
});
