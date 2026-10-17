import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	readCommunitySummary,
	readFathomSummary,
	readServiceHealth,
	readSkillsSummary,
	readWorkspaceSummary,
} from "../src/read-model.ts";
import { initializeWorkspace } from "../src/workspace.ts";
import { cleanupReadModelFixtures, tempHome } from "./support/read-model-fixture.ts";

const saved = { HOME: process.env.HOME, HARNESSY_WORKSPACE_ROOT: process.env.HARNESSY_WORKSPACE_ROOT };

afterEach(async () => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await cleanupReadModelFixtures();
});

describe("read-model defaults", () => {
	it("resolve the home directory, configuration and workspace from the environment", () => {
		const home = tempHome("defaults");
		process.env.HOME = home;
		const workspace = initializeWorkspace(join(home, "workspace"));
		process.env.HARNESSY_WORKSPACE_ROOT = workspace.root;
		mkdirSync(join(home, ".agents", "skills", "alpha"), { recursive: true });
		mkdirSync(join(home, ".jarvis"));
		writeFileSync(join(home, ".jarvis", "config.yaml"), "community_briefing:\n  discord_channel_id: '1'\n");

		expect(readSkillsSummary()).toMatchObject({ state: "ok", data: { count: 1, truncated: false } });
		expect(readWorkspaceSummary()).toMatchObject({ state: "ok", data: { id: workspace.manifest.id } });
		expect(readCommunitySummary().config).toMatchObject({ state: "ok", data: { configured: false } });
		expect(readCommunitySummary().queue).toMatchObject({ state: "missing", reason: "database_missing" });
		expect(readFathomSummary().config).toMatchObject({ state: "ok", data: { accounts: [] } });
		expect(readServiceHealth(["org.harnessy.portal"], () => "unsupported")["org.harnessy.portal"]?.state).toBe(
			"unsupported",
		);
	});
});
