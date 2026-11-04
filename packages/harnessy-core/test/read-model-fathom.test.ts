import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { FathomFileStore } from "../src/jarvis/fathom/file-store.ts";
import { inspectFathomStatus } from "../src/jarvis/fathom/status.ts";
import { fathomV2CheckpointPath, PortalSchemas, readFathomSummary } from "../src/read-model.ts";
import { cleanupReadModelFixtures, tempHome, treeListing } from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T12:00:00.000Z");

const setup = (prefix: string) => {
	const home = tempHome(prefix);
	const source = join(home, "private");
	const configPath = join(home, ".jarvis", "config.yaml");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		configPath,
		`community_briefing:\n  source_path: ${source}\nfathom:\n  default_account: personal\n  poll_accounts: [personal, research]\n  accounts:\n    personal:\n      api_key_env_var: FATHOM_PERSONAL\n    research:\n      api_key_env_var: FATHOM_RESEARCH\n`,
	);
	const inbox = join(source, "meeting-inbox", "fathom");
	for (const [account, bucket, count] of [
		["personal", "pending", 2],
		["personal", "processed", 3],
		["research", "invalid", 1],
	] as const) {
		mkdirSync(join(inbox, account, bucket), { recursive: true });
		for (let index = 0; index < count; index += 1)
			writeFileSync(join(inbox, account, bucket, `${index}.json`), '{"transcript":"private words"}');
	}
	return { home, configPath, inbox };
};

/** Write checkpoints with the real V2 poller store at the path the CLI host uses. */
const saveCheckpoints = async (home: string, checkpoints: Record<string, string | null>) => {
	for (const [account, updatedAt] of Object.entries(checkpoints)) {
		const store = new FathomFileStore({
			inboxRoot: join(home, "unused-inbox"),
			stateRoot: join(home, ".harnessy", "jarvis", "state", "fathom"),
		});
		await store.loadCheckpoint(account);
		await store.saveCheckpoint(account, { cursor: null, seen: {}, updatedAt });
	}
};

describe("Fathom read model", () => {
	it("sees V2 poll evidence that the existing status misses", async () => {
		const { home, configPath } = setup("fathom-v2");
		await saveCheckpoints(home, {
			personal: "2026-10-17T11:58:00.000Z",
			research: "2026-10-17T11:00:00.000Z",
			retired: "2026-10-01T00:00:00.000Z",
		});
		// The existing status reads the V1 file name in the V1 directory (its default for this home),
		// so it reports no poll state although the V2 poller has written one.
		const legacy = inspectFathomStatus({ configPath, stateRoot: join(home, ".jarvis", "state", "fathom") });
		expect(legacy.pollStatePresent).toBe(false);

		const summary = readFathomSummary({ homeRoot: home, now: NOW });
		expect(Value.Check(PortalSchemas.FathomSummary, summary)).toBe(true);
		expect(summary.checkpoint).toMatchObject({
			state: "ok",
			data: {
				intervalSeconds: 300,
				unknownAccounts: 1,
				accounts: [
					{ account: "personal", updatedAt: "2026-10-17T11:58:00.000Z", ageSeconds: 120, stale: false },
					{ account: "research", updatedAt: "2026-10-17T11:00:00.000Z", ageSeconds: 3_600, stale: true },
				],
			},
		});
	});

	it("returns configuration and inbox counts only and changes nothing", async () => {
		const { home, inbox } = setup("fathom-counts");
		await saveCheckpoints(home, { personal: null });
		const before = treeListing(home);
		const summary = readFathomSummary({ homeRoot: home, now: NOW, sourceRoot: join(home, "private") });
		expect(treeListing(home)).toEqual(before);
		expect(summary.config).toMatchObject({
			state: "ok",
			data: {
				accounts: ["personal", "research"],
				defaultAccount: "personal",
				pollingConfigured: true,
				pollAccounts: ["personal", "research"],
				issueCount: 0,
			},
		});
		expect(summary.inbox).toMatchObject({
			state: "ok",
			data: {
				accounts: {
					personal: { pending: 2, processed: 3, invalid: 0 },
					research: { pending: 0, processed: 0, invalid: 1 },
				},
				totals: { pending: 2, processed: 3, invalid: 1 },
			},
		});
		expect(summary.checkpoint.data?.accounts[0]).toEqual({
			account: "personal",
			updatedAt: null,
			ageSeconds: null,
			stale: true,
		});
		expect(JSON.stringify(summary)).not.toContain("private words");
		expect(JSON.stringify(summary)).not.toContain(inbox);
	});

	it("expands a `~` source path against homeRoot rather than HOME", () => {
		const { home, configPath, inbox } = setup("fathom-tilde");
		writeFileSync(
			configPath,
			"community_briefing:\n  source_path: ~/private\nfathom:\n  accounts:\n    personal: {}\n",
		);
		const previous = process.env.HOME;
		process.env.HOME = tempHome("fathom-other-home");
		try {
			expect(readFathomSummary({ homeRoot: home, now: NOW }).inbox).toMatchObject({
				state: "ok",
				data: { totals: { pending: 2, processed: 3, invalid: 1 } },
			});
			expect(inspectFathomStatus({ homeRoot: home })).toMatchObject({
				configPath,
				inboxPath: inbox,
				statePath: join(home, ".jarvis", "state", "fathom"),
			});
		} finally {
			process.env.HOME = previous;
		}
	});

	it("reports missing, invalid and oversize sources as degraded tiles", async () => {
		const missing = tempHome("fathom-missing");
		expect(readFathomSummary({ homeRoot: missing, now: NOW })).toMatchObject({
			config: { state: "missing", reason: "config_missing" },
			inbox: { state: "missing", reason: "config_unavailable" },
			checkpoint: { state: "missing", reason: "config_unavailable" },
		});

		const { home, configPath } = setup("fathom-degraded");
		const noInbox = readFathomSummary({ homeRoot: home, now: NOW, sourceRoot: join(home, "absent") });
		expect(noInbox.inbox).toMatchObject({ state: "missing", reason: "inbox_missing" });
		expect(noInbox.checkpoint).toMatchObject({ state: "missing", reason: "file_missing" });

		const checkpoint = fathomV2CheckpointPath(home);
		mkdirSync(dirname(checkpoint), { recursive: true });
		writeFileSync(checkpoint, '{"version":2}');
		expect(readFathomSummary({ homeRoot: home, now: NOW }).checkpoint).toMatchObject({
			state: "error",
			reason: "checkpoint_invalid",
		});
		writeFileSync(checkpoint, " ".repeat(1024 * 1024 + 1));
		expect(readFathomSummary({ homeRoot: home, now: NOW }).checkpoint).toMatchObject({
			state: "unsafe",
			reason: "checkpoint_oversize",
		});

		writeFileSync(configPath, "fathom: [unclosed\n");
		const invalid = readFathomSummary({ homeRoot: home, configPath, now: NOW });
		expect(invalid.config).toMatchObject({ state: "error", reason: "config_invalid" });
		expect(Value.Check(PortalSchemas.FathomSummary, invalid)).toBe(true);
	});
});
