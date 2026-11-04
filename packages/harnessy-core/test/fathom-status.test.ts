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
	it.each([
		["", false, []],
		["  poll_accounts: []\n", false, []],
		["  poll_accounts: research\n", false, []],
		["  poll_accounts: [research, ' research ']\n", true, ["research"]],
		["  poll_accounts: [unknown]\n", false, ["unknown"]],
		["  poll_accounts: ['../research', 12, '']\n", false, []],
	] as const)("reports polling configuration separately: %s", (selection, configured, accounts) => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-poll-status-"));
		roots.push(root);
		const configPath = join(root, "config.yaml");
		writeFileSync(
			configPath,
			`fathom:\n${selection}  accounts:\n    research:\n      api_key_env_var: RESEARCH_KEY\n`,
		);
		const status = inspectFathomStatus({ configPath, stateRoot: join(root, "state") });
		expect(status.ready).toBe(true);
		expect(status.polling.configured).toBe(configured);
		expect(status.polling.accounts).toEqual(accounts);
		expect(status.polling.issues.length === 0).toBe(configured);
	});

	it("uses an explicit project-private source root when community source is unset", () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-source-root-"));
		roots.push(root);
		const source = join(root, "project-private");
		const state = join(root, "state");
		mkdirSync(join(source, "meeting-inbox", "fathom"), { recursive: true });
		mkdirSync(state, { recursive: true });
		const config = join(root, "config.yaml");
		writeFileSync(
			config,
			`fathom:\n  default_account: personal\n  accounts:\n    personal:\n      api_key_env_var: FATHOM_API_KEY_PERSONAL\n`,
		);
		const result = inspectFathomStatus({ configPath: config, stateRoot: state, sourceRoot: source });
		expect(result.inboxPath).toBe(join(source, "meeting-inbox", "fathom"));
	});

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
		mkdirSync(join(source, "meeting-inbox", "fathom", "personal", "pending"), { recursive: true });
		writeFileSync(
			join(source, "meeting-inbox", "fathom", "personal", "pending", "two.json"),
			JSON.stringify({ verified: true, payload: { recording_id: 456, meeting_title: "Pending example" } }),
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
		const entries = listFathomInbox({ configPath: config, stateRoot: state, limit: 2 });
		expect(entries).toHaveLength(2);
		expect(result.polling.configured).toBe(false);
		expect(entries.find((entry) => entry.bucket === "processed")).toMatchObject({
			account: "personal",
			bucket: "processed",
		});
		expect(entries[0]?.bytes).toBeGreaterThan(0);
		expect(entries[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
		const plan = planFathomImport({ configPath: config, stateRoot: state, limit: 2 });
		expect(plan.find((entry) => entry.bucket === "pending")).toMatchObject({
			eligible: true,
			recordingId: "456",
			title: "Pending example",
		});
		expect(plan.find((entry) => entry.bucket === "processed")).toMatchObject({
			eligible: false,
			reason: "envelope is not pending",
		});
	});
});
