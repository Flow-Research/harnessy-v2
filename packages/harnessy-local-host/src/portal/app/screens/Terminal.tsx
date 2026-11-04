import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { StatusDot, type Tone } from "../components/primitives.tsx";
import type { SessionClient } from "../lib/session.ts";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

interface SessionItem {
	id: string;
	state: string;
	title?: string;
	external?: boolean;
}

/** The tone of each session state the backend reports: a dot plus the word, never colour alone. */
const SESSION_TONE: Readonly<Record<string, Tone>> = {
	running: "ok",
	starting: "attention",
	interrupted: "attention",
	failed: "danger",
	exited: "idle",
};

export const TerminalScreen = ({
	client,
	initialSelected,
}: {
	client: Pick<SessionClient, "get" | "terminalAction">;
	initialSelected?: string;
}) => {
	const host = useRef<HTMLDivElement>(null);
	const [sessions, setSessions] = useState<SessionItem[]>([]);
	const [tmuxSessions, setTmuxSessions] = useState<{ key: string; name: string }[]>([]);
	const [tmuxKey, setTmuxKey] = useState("");
	const [selected, setSelected] = useState("");
	const [cwd, setCwd] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [state, setState] = useState("");
	const [persistent, setPersistent] = useState(false);
	const [controlling, setControlling] = useState(false);
	const takeover = useRef(false);
	const [attachment, setAttachment] = useState(0);
	const sendKey = useRef<(data: string) => void>(() => undefined);
	useEffect(() => {
		let cancelled = false;
		void client.get("/v1/terminal/sessions").then((result) => {
			if (cancelled) return;
			if (result.kind !== "ok") {
				setError("Could not read terminals. Open Harnessy again if your sign-in expired.");
				return;
			}
			const body = result.body as {
				sessions: SessionItem[];
				cwd: string;
				persistent?: boolean;
				tmuxSessions?: { key: string; name: string }[];
			};
			setTmuxSessions(body.tmuxSessions ?? []);
			setPersistent(body.persistent === true);
			setSessions(body.sessions);
			setCwd(body.cwd);
			let remembered: string | null = null;
			try {
				remembered = sessionStorage.getItem("harnessy.terminal.selected");
			} catch {
				/* Storage is optional. */
			}
			setSelected(
				body.sessions.find((item) => item.id === (initialSelected || remembered))?.id ?? body.sessions[0]?.id ?? "",
			);
		});
		return () => {
			cancelled = true;
		};
	}, [client, initialSelected]);
	useEffect(() => {
		if (!selected || !host.current) return;
		const viewerId = `${crypto.randomUUID()}:${attachment}`;
		try {
			sessionStorage.setItem("harnessy.terminal.selected", selected);
		} catch {
			/* Storage is optional. */
		}
		let cancelled = false;
		let inputBlocked = persistent;
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
				const result = await client.terminalAction({
					...body,
					id: selected,
					...(persistent ? { viewer: viewerId } : {}),
				});
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
			if (inputBlocked) return;
			send({ action: "resize", cols: Math.min(500, terminal.cols), rows: Math.min(200, terminal.rows) });
		};
		const observer = new ResizeObserver(resize);
		observer.observe(host.current);
		if (!persistent) resize();
		terminal.focus();
		const acceptInput = (data: string) => {
			// Historical escape sequences must not send old terminal-query replies into the current shell.
			if (replaying || inputBlocked) return;
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
		};
		sendKey.current = acceptInput;
		const input = terminal.onData(acceptInput);
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
				terminal.options.disableStdin = inputBlocked;
			}
			if (!cancelled && (body.state === "running" || body.data))
				timer = setTimeout(() => void poll(), body.data ? 30 : 120);
		};
		setError("");
		setState("running");
		if (persistent) {
			const action = takeover.current ? "takeover" : "attach";
			takeover.current = false;
			void client.terminalAction({ action, id: selected, viewer: viewerId }).then((result) => {
				if (cancelled) return;
				if (result.kind !== "ok") {
					setError(result.kind === "error" ? result.message : "Sign in again.");
					return;
				}
				const control = (result.body as { controlling: boolean }).controlling;
				setControlling(control);
				inputBlocked = !control;
				if (control) resize();
				void poll();
			});
		} else void poll();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			observer.disconnect();
			input.dispose();
			terminal.dispose();
			sendKey.current = () => undefined;
			if (persistent)
				void queue.then(() => client.terminalAction({ action: "detach", id: selected, viewer: viewerId }));
		};
	}, [client, selected, persistent, attachment]);
	const action = async (close: boolean) => {
		if (
			close &&
			persistent &&
			!sessions.find((s) => s.id === selected)?.external &&
			!window.confirm("End this session and stop its running processes?")
		)
			return;
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
	const current = sessions.find((s) => s.id === selected);
	return (
		<section className="terminal-screen">
			<h1 className="screen-title">Terminal</h1>
			<p className="text-2">
				Runs as you in {cwd || "your workspace"}.{" "}
				{persistent
					? "Closing this view leaves sessions running, including across portal restarts."
					: "Sessions stay open when you switch views. A portal restart ends them."}
			</p>
			{tmuxSessions.length ? (
				<div className="terminal-controls terminal-attach">
					<label className="terminal-inline-field">
						<span>Existing tmux session</span>
						<span className="select">
							<select
								aria-label="Existing tmux session"
								value={tmuxKey}
								onChange={(e) => setTmuxKey(e.target.value)}
							>
								<option value="">Choose a session</option>
								{tmuxSessions.map((s) => (
									<option key={s.key} value={s.key}>
										{s.name}
									</option>
								))}
							</select>
						</span>
					</label>
					<button
						type="button"
						className="button"
						disabled={!tmuxKey || busy}
						onClick={() => {
							setBusy(true);
							void client
								.terminalAction({ action: "import-tmux", tmuxKey })
								.then(async (result) => {
									if (result.kind !== "ok") {
										setError(result.kind === "error" ? result.message : "Sign in again.");
										return;
									}
									const listed = await client.get("/v1/terminal/sessions");
									if (listed.kind === "ok") setSessions((listed.body as { sessions: SessionItem[] }).sessions);
									setSelected((result.body as { id: string }).id);
								})
								.finally(() => setBusy(false));
						}}
					>
						Attach existing session
					</button>
					<p className="field-hint terminal-attach-hint">
						Uses its existing permissions. Removing it here disconnects Harnessy; the tmux process keeps running.
					</p>
				</div>
			) : null}
			<div className="terminal-controls">
				<button
					type="button"
					className="button button-primary"
					aria-busy={busy}
					disabled={busy || sessions.length >= (persistent ? 16 : 4)}
					onClick={() => void action(false)}
				>
					New terminal
				</button>
				{sessions.length > 0 ? (
					<>
						<div className="select terminal-session-picker">
							<select
								aria-label="Terminal session"
								value={selected}
								onChange={(event) => setSelected(event.target.value)}
							>
								{sessions.map((item, index) => (
									<option key={item.id} value={item.id}>
										{item.title || `Terminal ${index + 1}`}
									</option>
								))}
							</select>
						</div>
						{/* Detaching keeps the process; ending a session stops it, so only that is a danger action. */}
						<button
							type="button"
							className={current?.external ? "button" : "button button-danger"}
							disabled={busy}
							onClick={() => void action(true)}
						>
							{current?.external ? "Remove attachment" : persistent ? "End session" : "Close terminal"}
						</button>
						{persistent && (state === "interrupted" || state === "failed") ? (
							<button
								type="button"
								className="button button-primary"
								onClick={() => {
									void client.terminalAction({ action: "resume", id: selected }).then((result) => {
										if (result.kind !== "ok") {
											setError(result.kind === "error" ? result.message : "Sign in again.");
											return;
										}
										setSelected("");
										setTimeout(() => setSelected(selected), 0);
									});
								}}
							>
								Resume saved conversation
							</button>
						) : null}
						{persistent ? (
							<button
								type="button"
								className="button button-quiet"
								onClick={() => {
									const title = window.prompt(
										"Session name",
										sessions.find((s) => s.id === selected)?.title ?? "",
									);
									if (title?.trim())
										void client.terminalAction({ action: "rename", id: selected, title }).then((result) => {
											if (result.kind === "ok") {
												setSessions((items) => items.map((s) => (s.id === selected ? { ...s, title } : s)));
												setError("");
											} else setError(result.kind === "error" ? result.message : "Sign in again.");
										});
								}}
							>
								Rename
							</button>
						) : null}
						{persistent && !controlling ? (
							<button
								type="button"
								className="button"
								onClick={() => {
									takeover.current = true;
									setAttachment((value) => value + 1);
								}}
							>
								Take control
							</button>
						) : null}
					</>
				) : null}
			</div>
			{selected ? (
				<p className="terminal-status" aria-live="polite">
					<StatusDot tone={SESSION_TONE[state] ?? "idle"} label={state || "connecting"} />
					{persistent ? (
						<span className="muted">
							{controlling ? "This view controls input." : "Viewing only. Another view controls input."}
						</span>
					) : null}
				</p>
			) : null}
			{error ? (
				<p className="form-error" role="alert">
					{error}
				</p>
			) : null}
			{selected ? (
				<div className="terminal-controls terminal-keys" role="toolbar" aria-label="Terminal keys">
					{[
						["Esc", "\u001b"],
						["Tab", "\t"],
						["Ctrl-C", "\u0003"],
						["Up", "\u001b[A"],
						["Down", "\u001b[B"],
					].map(([label, data]) => (
						<button
							type="button"
							className="button button-sm mono"
							key={label}
							disabled={persistent && !controlling}
							onClick={() => sendKey.current(data!)}
						>
							{label}
						</button>
					))}
				</div>
			) : null}
			{selected ? (
				<div ref={host} className="terminal-host" />
			) : (
				<p className="muted">Start a terminal to run shell commands and interactive programs.</p>
			)}
		</section>
	);
};
