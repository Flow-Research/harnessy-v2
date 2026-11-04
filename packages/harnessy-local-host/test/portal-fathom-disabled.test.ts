import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createPortalSources } from "../src/portal/sources.ts";
import { buildPortalHome, cleanupPortalFixtures, FIXTURE_NOW } from "./support/portal-fixture.ts";

afterEach(cleanupPortalFixtures);

it("keeps disabled accounts visible without overdue alerts and retains scheduled account alerts", async () => {
	const fixture = await buildPortalHome("disabled-fathom");
	const config = readFileSync(fixture.configPath, "utf8");
	const sources = createPortalSources({
		homeRoot: fixture.home,
		env: {},
		probe: () => "unsupported",
		timeoutMs: 250,
		clock: () => FIXTURE_NOW,
		probePort: async () => false,
	});
	expect(JSON.stringify(await sources.inbox())).toContain("Fathom (research) has not polled recently");
	writeFileSync(
		fixture.configPath,
		config.replace("poll_accounts: [personal, research]", "poll_accounts: [personal]"),
	);
	expect(sources.connections().fathom).toMatchObject({
		data: {
			connections: [
				{ id: "fathom.personal", status: "connected" },
				{ id: "fathom.research", status: "not_tracked", detail: "Automatic polling disabled" },
			],
		},
	});
	expect(JSON.stringify(await sources.inbox())).not.toContain("Fathom (research) has not polled recently");
	expect((await sources.jobs()).fathomAccounts).toMatchObject({
		data: {
			accounts: [
				{ account: "personal", pending: 1 },
				{ account: "research", stale: false },
			],
		},
	});
	writeFileSync(fixture.configPath, config);
	expect(JSON.stringify(await sources.inbox())).toContain("Fathom (research) has not polled recently");
});
