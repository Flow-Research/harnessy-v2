import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { jarvisLifeScheduleCommand, parseResearchDate } from "../src/cli/jarvis.ts";

describe("Life Orchestrator CLI", () => {
	it("rejects a relative LaunchAgents override before plan or apply can write", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-life-cli-"));
		try {
			const target = join(root, "LaunchAgents");
			for (const apply of [[], ["--apply"]]) {
				await expect(
					Effect.runPromise(
						Command.runWith(jarvisLifeScheduleCommand, { version: "test" })([
							"--target",
							root,
							"--home-root",
							root,
							"--compatibility-root",
							root,
							"--cli-entry",
							process.execPath,
							"--launch-agents-directory",
							relative(process.cwd(), target),
							...apply,
						]).pipe(Effect.provide(NodeServices.layer)),
					),
				).rejects.toThrow("not an absolute path");
				expect(existsSync(target)).toBe(false);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("accepts real calendar dates and rejects normalized overflow dates", () => {
		expect(parseResearchDate("2028-02-29").toISOString()).toBe("2028-02-29T11:00:00.000Z");
		expect(() => parseResearchDate("2026-02-31")).toThrow("Invalid date: 2026-02-31");
		expect(() => parseResearchDate("2026-04-31")).toThrow("Invalid date: 2026-04-31");
	});
});
