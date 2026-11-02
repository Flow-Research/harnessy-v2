import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { SessionClient } from "../lib/session.ts";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

interface SessionItem {
	id: string;
	state: string;
}

export const TerminalScreen = ({ client }: { client: Pick<SessionClient, "get" | "terminalAction"> }) => {
	const host = useRef<HTMLDivElement>(null);
	const [sessions, setSessions] = useState<SessionItem[]>([]);
	const [selected, setSelected] = useState("");
	const [cwd, setCwd] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [state, setState] = useState("");
	useEffect(() => {
		let cancelled = false;
		void client.get("/v1/terminal/sessions").then((result) => {
			if (cancelled) return;
			if (result.kind !== "ok") {
				setError("Could not read terminals. Open Harnessy again if your sign-in expired.");
				return;
			}
			const body = result.body as { sessions: SessionItem[]; cwd: string };
			setSessions(body.sessions);
			setCwd(body.cwd);
			let remembered: string | null = null;
			try {
				remembered = sessionStorage.getItem("harnessy.terminal.selected");
			} catch {
				/* Storage is optional. */
			}
			setSelected(body.sessions.find((item) => item.id === remembered)?.id ?? body.sessions[0]?.id ?? "");
		});
		return () => {
			cancelled = true;
		};
	}, [client]);
	useEffect(() => {
		if (!selected || !host.current) return;
		try {
			sessionStorage.setItem("harnessy.terminal.selected", selected);
		} catch {
			/* Storage is optional. */
		}
		let cancelled = false;
		let inputBlocked = false;
		let replaying = true;
		let cursor = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let queue = Promise.resolve();
		let queued = 0;
		const terminal = new Terminal({
			cursorBlink: true,
			disableStdin: true,
			scrollback: 5000,
			fontSize: 14,
			fontFamily: "monospace",
			screenReaderMode: true,
			theme: { background: "#101218", foreground: "#e6e8ef" },
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host.current);
		const send = (body: Record<string, unknown>) => {
			queue = queue.then(async () => {
				// Finish input already accepted before navigation; otherwise a command can be cut in half.
				if (inputBlocked) return;
				const result = await client.terminalAction({ ...body, id: selected });
				if (result.kind !== "ok") {
					inputBlocked = true;
					if (!cancelled)
						setError(result.kind === "error" ? result.message : "Sign-in expired. Open Harnessy again.");
				}
			});
		};
		const resize = () => {
			if (cancelled) return;
			fit.fit();
			send({ action: "resize", cols: Math.min(500, terminal.cols), rows: Math.min(200, terminal.rows) });
		};
		const observer = new ResizeObserver(resize);
		observer.observe(host.current);
		resize();
		terminal.focus();
		const input = terminal.onData((data) => {
			// Historical escape sequences must not send old terminal-query replies into the current shell.
			if (replaying) return;
			if (queued + data.length > 65536) {
				setError("Paste is too large. Paste less than 64 KB at a time.");
				return;
			}
			queued += data.length;
			const chars = Array.from(data);
			for (let index = 0; index < chars.length; index += 64)
				send({ action: "input", data: chars.slice(index, index + 64).join("") });
			queue = queue.then(() => {
				queued -= data.length;
			});
		});
		const poll = async () => {
			const result = await client.get(`/v1/terminal/output/${selected}/${cursor}`);
			if (cancelled) return;
			if (result.kind !== "ok") {
				setError(result.kind === "signed_out" ? "Sign-in expired. Open Harnessy again." : result.message);
				timer = setTimeout(() => void poll(), 2000);
				return;
			}
			const body = result.body as {
				data: string;
				cursor: number;
				endCursor: number;
				truncated: boolean;
				state: string;
			};
			if (body.truncated) {
				terminal.reset();
				setError("Older output was discarded. The most recent 1 MB is shown.");
			}
			cursor = body.cursor;
			setState(body.state);
			await new Promise<void>((resolve) =>
				// oxlint-disable-next-line eslint-js/no-restricted-syntax -- xterm.write parses terminal bytes, never HTML or document.write.
				terminal.write(
					Uint8Array.from(atob(body.data), (char) => char.charCodeAt(0)),
					resolve,
				),
			);
			if (replaying && body.cursor === body.endCursor) {
				replaying = false;
				terminal.options.disableStdin = false;
			}
			if (!cancelled && (body.state === "running" || body.data))
				timer = setTimeout(() => void poll(), body.data ? 30 : 120);
		};
		setError("");
		setState("running");
		void poll();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			observer.disconnect();
			input.dispose();
			terminal.dispose();
		};
	}, [client, selected]);
	const action = async (close: boolean) => {
		setBusy(true);
		setError("");
		try {
			const result = await client.terminalAction(close ? { action: "close", id: selected } : { action: "create" });
			if (result.kind !== "ok") {
				setError(result.kind === "error" ? result.message : "Sign-in expired. Open Harnessy again.");
				return;
			}
			if (close) {
				const remaining = sessions.filter((item) => item.id !== selected);
				setSessions(remaining);
				setSelected(remaining[0]?.id ?? "");
			} else {
				const id = (result.body as { id: string }).id;
				setSessions((items) => [...items, { id, state: "running" }]);
				setSelected(id);
			}
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="terminal-screen">
			<h1 className="screen-title">Terminal</h1>
			<p className="text-2">
				Runs as you in {cwd || "your workspace"}. Sessions stay open when you switch views. A portal restart ends
				them.
			</p>
			<div className="terminal-controls">
				<button type="button" disabled={busy || sessions.length >= 4} onClick={() => void action(false)}>
					New terminal
				</button>
				{sessions.length > 0 ? (
					<>
						<select
							aria-label="Terminal session"
							value={selected}
							onChange={(event) => setSelected(event.target.value)}
						>
							{sessions.map((item, index) => (
								<option key={item.id} value={item.id}>
									Terminal {index + 1}
								</option>
							))}
						</select>
						<button type="button" disabled={busy} onClick={() => void action(true)}>
							Close terminal
						</button>
						<output>{state}</output>
					</>
				) : null}
			</div>
			{error ? <p role="alert">{error}</p> : null}
			{selected ? (
				<div ref={host} className="terminal-host" />
			) : (
				<p>Start a terminal to run shell commands and interactive programs.</p>
			)}
		</section>
	);
};
