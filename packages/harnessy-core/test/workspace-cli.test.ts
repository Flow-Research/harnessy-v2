import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { expect, it } from "vitest";
import { workspaceCommand } from "../src/cli/workspace.ts";

it("initializes, registers, lists and validates through the actual CLI parser", async () => {
	const root = mkdtempSync(join(tmpdir(), "workspace-cli "));
	const run = (args: ReadonlyArray<string>) =>
		Effect.runPromise(
			Command.runWith(workspaceCommand, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
		);
	try {
		await run(["init", root, "--json"]);
		mkdirSync(join(root, "app/dev/.jarvis/context"), { recursive: true });
		await run(["add", join(root, "app/dev"), "--workspace-root", root, "--id", "app", "--json"]);
		await run(["list", "--workspace-root", root, "--json"]);
		await run(["doctor", "--workspace-root", root, "--json"]);
		const manifest = JSON.parse(readFileSync(join(root, ".harnessy/workspace.json"), "utf8"));
		expect(manifest.projects[0].path).toBe("app/dev");
		await expect(
			run(["add", join(root, "app/dev"), "--workspace-root", root, "--id", "duplicate"]),
		).rejects.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("plans, applies and rolls back through the migration CLI with private backup metadata", async () => {
	const root = mkdtempSync(join(tmpdir(), "workspace-migration-cli-"));
	const run = (args: ReadonlyArray<string>) =>
		Effect.runPromise(
			Command.runWith(workspaceCommand, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
		);
	try {
		mkdirSync(join(root, "old"));
		writeFileSync(join(root, "old/file"), "preserved");
		cpSync(join(root, "old"), join(root, "backup"), { recursive: true });
		const moves = join(root, "moves.json");
		const plan = join(root, "plan.json");
		const backups = join(root, "backups.json");
		writeFileSync(moves, JSON.stringify([{ from: "old", to: "new/dev" }]));
		writeFileSync(backups, JSON.stringify([{ from: "old", backupPath: join(root, "backup") }]));
		await run(["migrate", "plan", "--root", root, "--moves", moves, "--output", plan]);
		await run(["migrate", "apply", "--plan", plan, "--backups", backups]);
		expect(readFileSync(join(root, "new/dev/file"), "utf8")).toBe("preserved");
		await run(["migrate", "rollback", "--plan", plan]);
		expect(existsSync(join(root, "new/dev"))).toBe(false);
		expect(readFileSync(join(root, "old/file"), "utf8")).toBe("preserved");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
