import { execFileSync } from "node:child_process";

export interface TmuxSession {
	key: string;
	id: string;
	name: string;
}

/** Discover only the existing launcher's socket. Reading never starts a tmux server. */
export class TmuxSessions {
	readonly env: NodeJS.ProcessEnv;
	readonly socket: string;
	constructor(env: NodeJS.ProcessEnv) {
		this.env = env;
		this.socket = env.TMUX_AGENT_LAUNCHER_TMUX_SOCKET_NAME ?? "harnessy-agents";
	}
	args() {
		return this.socket === "default" ? [] : ["-L", this.socket];
	}
	list(): TmuxSession[] {
		try {
			const output = execFileSync(
				"tmux",
				// tmux replaces literal control-character separators in the C locale.
				[...this.args(), "list-sessions", "-F", "#{pid}|#{session_created}|#{session_id}|#{session_name}"],
				{ env: this.env, encoding: "utf8", timeout: 2000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] },
			);
			return output
				.trim()
				.split("\n")
				.flatMap((line) => {
					// The name is the remainder, so it may contain the delimiter too.
					const match = /^(\d+)\|(\d+)\|(\$\d+)\|(.+)$/u.exec(line);
					return match ? [{ key: `${match[1]}:${match[2]}:${match[3]}`, id: match[3]!, name: match[4]! }] : [];
				});
		} catch {
			return [];
		}
	}
}
