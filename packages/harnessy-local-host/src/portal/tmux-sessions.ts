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
				[...this.args(), "list-sessions", "-F", "#{pid}\t#{session_created}\t#{session_id}\t#{session_name}"],
				{ env: this.env, encoding: "utf8", timeout: 2000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] },
			);
			return output
				.trim()
				.split("\n")
				.flatMap((line) => {
					const [pid, created, id, name, ...extra] = line.split("\t");
					return pid &&
						/^\d+$/u.test(pid) &&
						created &&
						/^\d+$/u.test(created) &&
						id &&
						/^\$\d+$/u.test(id) &&
						name &&
						!extra.length
						? [{ key: `${pid}:${created}:${id}`, id, name }]
						: [];
				});
		} catch {
			return [];
		}
	}
}
