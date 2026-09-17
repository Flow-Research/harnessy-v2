import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectFathomStatus, listFathomInbox, planFathomImport } from "../src/jarvis/fathom/status.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fathom status", () => {
	it("inspects configured accounts and inbox metadata without providers", () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-status-"));
		roots.push(root);
		const source = join(root, "private");
		const state = join(root, "state");
		mkdirSync(join(source, "meeting-inbox", "fathom", "personal", "processed"), { recursive: true });
		mkdirSync(state, { recursive: true });
		writeFileSync(
			join(source, "meeting-inbox", "fathom", "personal", "processed", "one.json"),
			JSON.stringify({ verified: true, payload: { recording_id: 123, meeting_title: "Example" } }),
		);
		writeFileSync(join(state, "poll-state.json"), JSON.stringify({ accounts: {} }));
		const config = join(root, "config.yaml");
		writeFileSync(
			config,
			`community_briefing:\n  source_path: ${source}\nfathom:\n  default_account: personal\n  accounts:\n    personal:\n      api_key_env_var: FATHOM_API_KEY_PERSONAL\n`,
		);
		const result = inspectFathomStatus({ configPath: config, stateRoot: state });
		expect(result.ready).toBe(true);
		expect(result.accounts).toEqual(["personal"]);
		expect(result.inboxCounts.personal?.processed).toBe(1);
		const entries = listFathomInbox({ configPath: config, stateRoot: state, limit: 1 });
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ account: "personal", bucket: "processed" });
		expect(entries[0]?.bytes).toBeGreaterThan(0);
		expect(entries[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
		const plan = planFathomImport({ configPath: config, stateRoot: state, limit: 1 });
		expect(plan[0]).toMatchObject({ eligible: true, recordingId: "123", title: "Example" });
	});
});
