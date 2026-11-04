import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { TmuxSessions } from "../src/portal/tmux-sessions.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("reads the default socket without a socket override and discards malformed identities", () => {
	const run = vi.mocked(execFileSync);
	run.mockReturnValue("123|456|$7|research|one\nnot-a-record\n123|not-a-time|$8|bad\n123|456|$9|\n");
	const sessions = new TmuxSessions({ TMUX_AGENT_LAUNCHER_TMUX_SOCKET_NAME: "default", LANG: "C" });
	expect(sessions.list()).toEqual([{ key: "123:456:$7", id: "$7", name: "research|one" }]);
	expect(run).toHaveBeenCalledWith(
		"tmux",
		["list-sessions", "-F", "#{pid}|#{session_created}|#{session_id}|#{session_name}"],
		expect.objectContaining({ env: sessions.env }),
	);
	expect(sessions.env.LANG).toBe("C");
});

it("uses the launcher socket by default and returns no sessions when it is absent", () => {
	const sessions = new TmuxSessions({});
	expect(sessions.args()).toEqual(["-L", "harnessy-agents"]);
	vi.mocked(execFileSync).mockImplementation(() => {
		throw new Error("no server running");
	});
	expect(sessions.list()).toEqual([]);
});
