import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ManagedTerminal } from "../src/portal/managed-terminal.ts";

it("attaches the exact existing tmux session and leaves it running when removed", async () => {
	const root = mkdtempSync(join(tmpdir(), "hsy-tmux-"));
	const socket = `hsy-test-${randomUUID()}`;
	const tmux = (...args: string[]) =>
		execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const manager = new ManagedTerminal(root, root, { ...process.env, TMUX_AGENT_LAUNCHER_TMUX_SOCKET_NAME: socket });
	try {
		expect(manager.list().tmuxSessions).toEqual([]);
		tmux("-f", "/dev/null", "new-session", "-d", "-s", "existing", "/bin/sh");
		const external = manager.list().tmuxSessions[0]!;
		const [created, concurrent] = (await Promise.all([
			manager.action({ action: "import-tmux", tmuxKey: external.key }),
			manager.action({ action: "import-tmux", tmuxKey: external.key }),
		])) as { id: string }[];
		expect(concurrent).toEqual(created);
		expect(created).toBeDefined();
		if (!created) throw new Error("Missing attachment");
		expect(await manager.action({ action: "import-tmux", tmuxKey: external.key })).toEqual(created);
		expect(manager.list().sessions[0]?.external).toBe(true);
		await manager.action({ action: "attach", id: created.id }, "fixture");
		await new Promise((done) => setTimeout(done, 2000));
		await manager.action({ action: "input", id: created.id, data: "printf 'attached_%s\\n' yes\n" }, "fixture");
		await expect
			.poll(() => tmux("capture-pane", "-p", "-t", external.id), { timeout: 8000 })
			.toContain("attached_yes");
		await manager.action({ action: "close", id: created.id });
		expect(tmux("list-sessions", "-F", "#{session_name}").trim()).toBe("existing");
		await expect(manager.action({ action: "import-tmux", tmuxKey: "stale:identity" })).rejects.toThrow(
			"tmux_session_unavailable",
		);
	} finally {
		manager.close();
		try {
			execFileSync("herdr", ["--session", manager.session, "server", "stop"], { stdio: "ignore" });
		} catch {
			/* Fixture already stopped. */
		}
		try {
			tmux("kill-server");
		} catch {
			/* Fixture already stopped. */
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);
