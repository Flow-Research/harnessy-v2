import { ArrowUpRight, Plus, TerminalSquare, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { trapTab } from "../lib/keys.tsx";
import type { SessionClient } from "../lib/session.ts";
import { TerminalScreen } from "../screens/Terminal.tsx";
import { PairDevice } from "./PairDevice.tsx";
import "./quick-actions.css";
import type { BriefSelection } from "../../terminal-contract.ts";

type BriefContext = BriefSelection;
const Actions = createContext<(value: BriefContext) => void>(() => undefined);
export const useBriefAction = () => useContext(Actions);

export const QuickActions = ({ client, children }: { client: SessionClient; children: ReactNode }) => {
	const [view, setView] = useState<"closed" | "menu" | "compose" | "terminal">("closed");
	const [context, setContext] = useState<BriefContext>({ text: "", source: "", title: "" });
	const [title, setTitle] = useState("");
	const [instructions, setInstructions] = useState("");
	const [project, setProject] = useState("");
	const [runner, setRunner] = useState("hsy");
	const [isolation, setIsolation] = useState("worktree");
	const [selected, setSelected] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [options, setOptions] = useState<{
		runners: { id: string; available: boolean }[];
		projects: { id: string; path: string }[];
	}>({ runners: [], projects: [] });
	const requestId = useRef(crypto.randomUUID());
	const viewIntent = useRef(0);
	const dialog = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const selection = useRef<BriefContext>({ text: "", source: "", title: "" });
	const close = () => {
		viewIntent.current += 1;
		setView("closed");
		opener.current?.focus();
	};
	/** Remember where focus was, unless it is inside the drawer (a menu item that is about to unmount). */
	const rememberOpener = () => {
		const active = document.activeElement;
		if (active instanceof HTMLElement && !dialog.current?.contains(active)) opener.current = active;
	};
	/**
	 * Open the composer for `value`. A draft for the same briefing source is kept, so closing
	 * the drawer by mistake does not lose typed instructions; a new source starts a new draft.
	 */
	const compose = (value: BriefContext) => {
		viewIntent.current += 1;
		rememberOpener();
		const sameDraft = value.source === context.source && value.text === context.text && title !== "";
		if (!sameDraft) {
			setContext(value);
			setTitle(value.title || "New task");
			setInstructions("");
			requestId.current = crypto.randomUUID();
		}
		setError("");
		setView("compose");
	};
	useEffect(() => {
		const capture = () => {
			const value = window.getSelection();
			const element = value?.anchorNode?.parentElement?.closest<HTMLElement>("[data-brief-source]");
			if (element && value?.toString().trim() && element.contains(value.focusNode))
				selection.current = {
					text: value.toString(),
					source: element.dataset.briefSource ?? "",
					title: "Selected briefing text",
				};
		};
		document.addEventListener("selectionchange", capture);
		return () => document.removeEventListener("selectionchange", capture);
	}, []);
	useEffect(() => {
		if (view === "closed") return;
		// The composer starts at its first field; the menu and terminal views at their first body control.
		// (A selector list matches in document order, so the body is queried on its own, before Close.)
		const body = dialog.current?.querySelector<HTMLElement>(".quick-actions-body");
		const first =
			view === "compose"
				? body?.querySelector<HTMLElement>("input,textarea,select")
				: body?.querySelector<HTMLElement>("button,a");
		(first ?? dialog.current?.querySelector<HTMLElement>("button"))?.focus();
		if (view !== "compose") return;
		void client.get("/v1/terminal/sessions").then((result) => {
			if (result.kind === "ok") setOptions(result.body as typeof options);
			else setError("Could not load agents and projects. Sign in again if needed.");
		});
	}, [view, client]);
	/** Set synchronously, so a double click or a repeated Enter cannot send a second launch before React re-renders. */
	const launching = useRef(false);
	const start = async () => {
		if (launching.current) return;
		launching.current = true;
		const intent = viewIntent.current;
		const launchedRequest = requestId.current;
		setBusy(true);
		setError("");
		try {
			const result = await client.terminalAction({
				action: "launch",
				requestId: launchedRequest,
				title,
				instructions,
				runner,
				project,
				isolation: project ? isolation : "existing",
				context: context.text,
				source: context.source,
			});
			if (result.kind !== "ok") {
				if (requestId.current === launchedRequest)
					setError(result.kind === "error" ? result.message : "Sign in again to launch this task.");
				return;
			}
			// A successful task is no longer a draft. Retain retry keys only for uncertain or failed launches.
			if (requestId.current === launchedRequest) {
				requestId.current = crypto.randomUUID();
				setTitle("");
				setInstructions("");
			}
			if (viewIntent.current === intent) {
				setSelected((result.body as { id: string }).id);
				setView("terminal");
			}
		} finally {
			launching.current = false;
			setBusy(false);
		}
	};
	const agentReady = options.runners.find((r) => r.id === runner)?.available === true;
	return (
		<Actions.Provider value={compose}>
			{children}
			{/* Stays mounted while the drawer is open, so closing returns focus to it. */}
			<button
				type="button"
				className="quick-actions-fab"
				aria-haspopup="dialog"
				aria-expanded={view !== "closed"}
				onClick={() => {
					viewIntent.current += 1;
					rememberOpener();
					setView("menu");
				}}
			>
				<Plus size={20} aria-hidden="true" />
				<span>Actions</span>
			</button>
			{view !== "closed" ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click is a mouse shortcut; Escape and the close button are the keyboard paths
				<div
					className="quick-actions-backdrop"
					onMouseDown={(event) => {
						if (event.target === event.currentTarget) close();
					}}
				>
					<div
						ref={dialog}
						className={`quick-actions-panel quick-actions-panel-${view}`}
						role="dialog"
						aria-modal="true"
						aria-labelledby="quick-actions-title"
						onKeyDown={(event) => {
							if (
								event.key === "Escape" &&
								!(event.target instanceof Element && event.target.closest(".terminal-host"))
							)
								close();
							else trapTab(event, dialog.current);
						}}
					>
						<header className="quick-actions-header">
							<h2 id="quick-actions-title">
								{view === "compose" ? "Start agent task" : view === "terminal" ? "Terminals" : "Quick actions"}
							</h2>
							<button type="button" className="icon-button" aria-label="Close" onClick={close}>
								<X size={18} aria-hidden="true" />
							</button>
						</header>
						<div className="quick-actions-body">
							{view === "menu" ? (
								<div className="quick-actions-menu">
									<button
										type="button"
										className="quick-actions-item"
										onClick={() => compose(selection.current)}
									>
										<Plus size={18} aria-hidden="true" />
										<span>Start agent task{selection.current.text ? " with selection" : ""}</span>
										<span className="quick-actions-item-hint">
											{selection.current.text
												? "Uses the briefing text you selected as context."
												: "Describe the work and choose an agent. A project is optional."}
										</span>
									</button>
									<button type="button" className="quick-actions-item" onClick={() => setView("terminal")}>
										<TerminalSquare size={18} aria-hidden="true" />
										<span>Open terminals</span>
										<span className="quick-actions-item-hint">
											Watch or control running sessions. Closing this view leaves them running.
										</span>
									</button>
									{window.location.protocol !== "https:" ? <PairDevice client={client} /> : null}
								</div>
							) : null}
							{view === "compose" ? (
								<form
									className="quick-actions-form"
									onSubmit={(event) => {
										event.preventDefault();
										void start();
									}}
								>
									<label className="field">
										Task title
										<input
											className="input"
											required
											maxLength={160}
											value={title}
											onChange={(e) => setTitle(e.target.value)}
										/>
									</label>
									<label className="field">
										Instructions
										<textarea
											className="textarea"
											required
											rows={4}
											value={instructions}
											onChange={(e) => setInstructions(e.target.value)}
											placeholder="What should the agent do?"
										/>
									</label>
									{context.text ? (
										<details className="quick-actions-context" open>
											<summary>Briefing context · {context.source}</summary>
											<pre>{context.text}</pre>
											<p className="field-hint">
												This snapshot stays with the task even if the brief changes.
											</p>
										</details>
									) : null}
									<div className="quick-actions-row">
										<label className="field">
											Agent
											<span className="select">
												<select value={runner} onChange={(e) => setRunner(e.target.value)}>
													{options.runners.map((r) => (
														<option key={r.id} value={r.id} disabled={!r.available}>
															{r.id}
															{r.available ? "" : " — not installed"}
														</option>
													))}
												</select>
											</span>
										</label>
										<label className="field">
											Project (optional)
											<span className="select">
												<select value={project} onChange={(e) => setProject(e.target.value)}>
													<option value="">Workspace task — no project</option>
													{options.projects.map((p) => (
														<option key={p.id} value={p.id}>
															{p.id}
														</option>
													))}
												</select>
											</span>
										</label>
									</div>
									{project ? (
										<label className="field">
											Working copy
											<span className="select">
												<select value={isolation} onChange={(e) => setIsolation(e.target.value)}>
													<option value="worktree">Separate Git worktree</option>
													<option value="existing">Existing checkout</option>
												</select>
											</span>
											<span className="field-hint">
												{isolation === "worktree"
													? "Starts from the current commit; uncommitted changes are not copied."
													: "The agent can change the selected checkout alongside your other work."}
											</span>
										</label>
									) : (
										<p className="field-hint">
											Workspace task: starts in the configured workspace directory. No Git worktree is
											created.
										</p>
									)}
									<p className="field-hint">
										{runner === "hsy"
											? "Harnessy runs with your host-user permissions; project trust remains separate."
											: "Uses normal agent permissions. Approval prompts appear in the terminal."}
									</p>
									{error ? (
										<p className="form-error" role="alert">
											{error}
										</p>
									) : null}
									<div className="quick-actions-footer">
										<button type="button" className="button button-quiet" onClick={close}>
											Keep draft and close
										</button>
										<button
											type="submit"
											className="button button-primary quick-actions-submit"
											aria-busy={busy}
											disabled={busy || !agentReady}
										>
											{busy ? "Starting…" : "Start agent"}
										</button>
									</div>
								</form>
							) : null}
							{view === "terminal" ? (
								<>
									<a className="button button-quiet" href={`#/terminal/${selected}`} onClick={close}>
										Expand to Terminal <ArrowUpRight size={16} aria-hidden="true" />
									</a>
									<TerminalScreen client={client} initialSelected={selected} />
								</>
							) : null}
						</div>
					</div>
				</div>
			) : null}
		</Actions.Provider>
	);
};
