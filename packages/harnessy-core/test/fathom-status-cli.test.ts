import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { FathomFileStore } from "../src/jarvis/fathom/file-store.ts";
import { fathomV2CheckpointPath } from "../src/read-model/fathom-checkpoint.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliEntry = join(packageRoot, "src", "cli.ts");

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An isolated home root with a Fathom configuration; the CLI sees it through HOME only. */
const isolatedHome = (): string => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-fathom-status-cli-")));
	roots.push(home);
	mkdirSync(join(home, ".jarvis"), { recursive: true });
	writeFileSync(
		join(home, ".jarvis", "config.yaml"),
		"fathom:\n  default_account: personal\n  poll_accounts: [personal, research]\n  accounts:\n    personal:\n      api_key_env_var: SYNTHETIC_PERSONAL\n    research:\n      api_key_env_var: SYNTHETIC_RESEARCH\n",
	);
	return home;
};

const status = (home: string) => {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", cliEntry, "jarvis", "meeting", "fathom", "status", "--json"],
		{
			cwd: packageRoot,
			env: {
				PI_AUTH_ENCRYPTION: "off",
				HSY_AUTH_ENCRYPTION: "off",
				HOME: home,
				USERPROFILE: home,
				NODE_NO_WARNINGS: "1",
			},
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	expect(result.status, result.stderr).toBe(0);
	return { stdout: result.stdout, json: JSON.parse(result.stdout) };
};

describe("harnessy jarvis meeting fathom status --json", () => {
	it("reports per-account updatedAt from the V2 poll checkpoint", async () => {
		const home = isolatedHome();
		// Write the checkpoint with the real V2 poller store at the path the poll command uses.
		const store = new FathomFileStore({
			inboxRoot: join(home, "unused-inbox"),
			stateRoot: join(home, ".harnessy", "jarvis", "state", "fathom"),
		});
		await store.loadCheckpoint("personal");
		await store.saveCheckpoint("personal", { cursor: null, seen: {}, updatedAt: "2026-10-17T11:58:00.000Z" });

		const { json } = status(home);
		expect(json).toMatchObject({
			command: "jarvis meeting fathom status",
			ok: true,
			pollCheckpoint: {
				path: fathomV2CheckpointPath(home),
				state: "ok",
				data: {
					intervalSeconds: 300,
					unknownAccounts: 0,
					accounts: [
						{ account: "personal", updatedAt: "2026-10-17T11:58:00.000Z" },
						{ account: "research", updatedAt: null, ageSeconds: null, stale: true },
					],
				},
			},
			legacyPollState: { path: join(home, ".jarvis", "state", "fathom", "poll-state.json"), present: false },
			// The existing V1 fields keep their meaning.
			pollStatePresent: false,
			pollStateValid: true,
		});
		expect(json.issues).toEqual([]);
	});

	it("reports a missing V2 checkpoint as missing without failing readiness", () => {
		const home = isolatedHome();
		const { json } = status(home);
		expect(json.ok).toBe(true);
		expect(json.pollCheckpoint).toMatchObject({
			path: fathomV2CheckpointPath(home),
			state: "missing",
			reason: "file_missing",
		});
		expect(json.pollCheckpoint).not.toHaveProperty("data");
	});

	it.each([
		["truncated JSON", '{"version":1,"accounts":'],
		["wrong version", '{"version":2,"accounts":{}}'],
		["invalid timestamp", '{"version":1,"accounts":{"k":{"cursor":null,"seen":{},"updatedAt":"PRIVATE_SENTINEL"}}}'],
	])("rejects a malformed V2 checkpoint safely: %s", (_label, content) => {
		const home = isolatedHome();
		const path = fathomV2CheckpointPath(home);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
		const { stdout, json } = status(home);
		expect(json.ok).toBe(false);
		expect(json.pollCheckpoint).toMatchObject({ state: "error", reason: "checkpoint_invalid" });
		expect(json.pollCheckpoint).not.toHaveProperty("data");
		expect(json.issues).toContain("V2 Fathom poll checkpoint was rejected (checkpoint_invalid)");
		expect(stdout).not.toContain("PRIVATE_SENTINEL");
	});

	it.skipIf(process.platform === "win32")("refuses a symbolic-link V2 checkpoint", () => {
		const home = isolatedHome();
		const real = join(home, "elsewhere", "poll-state-v2.json");
		mkdirSync(dirname(real), { recursive: true });
		writeFileSync(real, '{"version":1,"accounts":{}}');
		const path = fathomV2CheckpointPath(home);
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(real, path);
		const { json } = status(home);
		expect(json.ok).toBe(false);
		expect(json.pollCheckpoint).toMatchObject({ state: "unsafe", reason: "file_not_regular" });
	});
});
