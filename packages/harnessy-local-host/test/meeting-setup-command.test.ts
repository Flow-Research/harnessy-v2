import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("meeting setup command boundary", () => {
	for (const args of [[], ["--token", "SECRET_CANARY"], ["--resume-google"], ["--resume-google", "--resume-google"]]) {
		it(`rejects malformed input without credentials, state writes or a consent link: ${JSON.stringify(args)}`, () => {
			const packageRoot = join(import.meta.dirname, "..");
			const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-setup-command-"));
			try {
				const result = spawnSync(
					process.execPath,
					[
						"--import",
						join(packageRoot, "test/support/fixture-network-guard.mjs"),
						"--import",
						"tsx",
						join(packageRoot, "src/meeting-setup-cli.ts"),
						...args,
					],
					{
						cwd: packageRoot,
						encoding: "utf8",
						timeout: 10_000,
						env: { HOME: root, NODE_NO_WARNINGS: "1" },
					},
				);
				expect(result.error).toBeUndefined();
				expect(result.signal).toBeNull();
				expect(result.status).toBe(1);
				expect(result.stdout).toBe("");
				expect(JSON.parse(result.stderr)).toEqual({
					error: "meeting_setup_failed",
					next: "Inspect preserved setup state before retrying; no activation occurred.",
				});
				expect(readdirSync(root)).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}
});
