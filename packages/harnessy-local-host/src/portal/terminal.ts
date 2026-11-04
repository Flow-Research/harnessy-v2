import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { PTY_BRIDGE } from "./pty-bridge.ts";

export class TerminalError extends Error {}

interface TerminalSession {
	id: string;
	child: ChildProcessWithoutNullStreams;
	output: Buffer;
	offset: number;
	state: "running" | "exited" | "failed";
}

/** No process starts until an authenticated user explicitly creates a session. */
export class PortalTerminal {
	readonly #sessions = new Map<string, TerminalSession>();
	readonly #cwd: string;
	readonly #env: NodeJS.ProcessEnv;
	readonly #shell: string;
	constructor(cwd: string, env: NodeJS.ProcessEnv = process.env, shell = userInfo().shell || "/bin/sh") {
		this.#cwd = cwd;
		this.#env = env;
		this.#shell = shell;
	}
	list() {
		return { cwd: this.#cwd, sessions: [...this.#sessions.values()].map(({ id, state }) => ({ id, state })) };
	}
	read(id: string, cursor: number) {
		const session = this.#sessions.get(id);
		if (!session || !Number.isSafeInteger(cursor) || cursor < 0) throw new TerminalError("terminal_not_found");
		const start = Math.max(session.offset, Math.min(cursor, session.offset + session.output.length));
		const bytes = session.output.subarray(start - session.offset, start - session.offset + 65536);
		return {
			data: bytes.toString("base64"),
			cursor: start + bytes.length,
			endCursor: session.offset + session.output.length,
			truncated: cursor < session.offset,
			state: session.state,
		};
	}
	action(value: unknown, _actor?: string) {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new TerminalError("invalid_terminal_action");
		const body = value as Record<string, unknown>;
		const allowed =
			body.action === "create"
				? ["action"]
				: body.action === "input"
					? ["action", "id", "data"]
					: body.action === "resize"
						? ["action", "id", "cols", "rows"]
						: ["action", "id"];
		if (Object.keys(body).some((key) => !allowed.includes(key))) throw new TerminalError("invalid_terminal_action");
		if (body.action === "create") {
			if (this.#sessions.size >= 4) throw new TerminalError("terminal_session_limit");
			const child = spawn("/usr/bin/python3", ["-u", "-c", PTY_BRIDGE, this.#shell, this.#cwd], {
				env: this.#env,
				stdio: "pipe",
			});
			const session: TerminalSession = {
				id: randomUUID(),
				child,
				output: Buffer.alloc(0),
				offset: 0,
				state: "running",
			};
			this.#sessions.set(session.id, session);
			child.stdout.on("data", (data: Buffer) => {
				const output = Buffer.concat([session.output, data]);
				const removed = Math.max(0, output.length - 1024 * 1024);
				session.offset += removed;
				session.output = Buffer.from(output.subarray(removed));
			});
			child.stderr.resume();
			child.stdin.on("error", () => {
				session.state = "failed";
			});
			child.once("error", () => {
				session.state = "failed";
			});
			child.once("close", (code) => {
				session.state = code === 0 ? "exited" : "failed";
			});
			return { id: session.id };
		}
		const session = typeof body.id === "string" ? this.#sessions.get(body.id) : undefined;
		if (!session) throw new TerminalError("terminal_not_found");
		if (body.action === "close") {
			session.child.kill("SIGTERM");
			this.#sessions.delete(session.id);
			return { closed: true };
		}
		if (session.state !== "running") throw new TerminalError("terminal_exited");
		if (body.action === "input") {
			if (typeof body.data !== "string" || Buffer.byteLength(body.data) > 256)
				throw new TerminalError("invalid_terminal_input");
			if (session.child.stdin.writableLength > 8192) throw new TerminalError("terminal_input_busy");
			session.child.stdin.write(
				`${JSON.stringify({ action: "input", data: Buffer.from(body.data).toString("base64") })}\n`,
			);
		} else if (body.action === "resize") {
			if (
				!Number.isInteger(body.cols) ||
				!Number.isInteger(body.rows) ||
				Number(body.cols) < 2 ||
				Number(body.cols) > 500 ||
				Number(body.rows) < 2 ||
				Number(body.rows) > 200
			)
				throw new TerminalError("invalid_terminal_size");
			session.child.stdin.write(`${JSON.stringify({ action: "resize", cols: body.cols, rows: body.rows })}\n`);
		} else throw new TerminalError("invalid_terminal_action");
		return { ok: true };
	}
	close() {
		for (const session of this.#sessions.values()) session.child.kill("SIGTERM");
		this.#sessions.clear();
	}
}
