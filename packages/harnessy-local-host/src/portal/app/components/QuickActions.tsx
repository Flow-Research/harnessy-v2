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
	const dialog = useRef<HTMLDivElement>(null);
	const opener = useRef<HTMLElement | null>(null);
	const selection = useRef<BriefContext>({ text: "", source: "", title: "" });
	const close = () => {
		setView("closed");
		opener.current?.focus();
	};
	const compose = (value: BriefContext) => {
		opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setContext(value);
		setTitle(value.title || "New task");
		setInstructions("");
		setError("");
		requestId.current = crypto.randomUUID();
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
		dialog.current?.querySelector<HTMLElement>("button,input,textarea")?.focus();
		if (view !== "compose") return;
		void client.get("/v1/terminal/sessions").then((result) => {
			if (result.kind === "ok") setOptions(result.body as typeof options);
			else setError("Could not load agents and projects. Sign in again if needed.");
		});
	}, [view, client]);
	const start = async () => {
		setBusy(true);
		setError("");
		try {
			const result = await client.terminalAction({
				action: "launch",
				requestId: requestId.current,
				title,
				instructions,
				runner,
				project,
				isolation,
				context: context.text,
				source: context.source,
			});
			if (result.kind !== "ok") {
				setError(result.kind === "error" ? result.message : "Sign in again to launch this task.");
				return;
			}
			setSelected((result.body as { id: string }).id);
			setView("terminal");
		} finally {
			setBusy(false);
		}
	};
	return (
		<Actions.Provider value={compose}>
			{children}
			{view === "closed" ? (
				<button
					type="button"
					className="quick-actions-fab"
					aria-label="Quick actions"
					onClick={() => {
						opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
						setView("menu");
					}}
				>
					<Plus size={22} />
					<span>Actions</span>
				</button>
			) : null}
			{view !== "closed" ? (
				<div className="quick-actions-backdrop">
					<div
						ref={dialog}
						className={`quick-actions-panel quick-actions-${view}`}
						role="dialog"
						aria-modal="true"
						aria-label={view === "compose" ? "Start agent task" : "Quick actions"}
						onKeyDown={(event) => {
							if (
								event.key === "Escape" &&
								!(event.target instanceof Element && event.target.closest(".terminal-host"))
							)
								close();
							else trapTab(event, dialog.current);
						}}
					>
						<header>
							<h2>
								{view === "compose" ? "Start agent task" : view === "terminal" ? "Terminals" : "Quick actions"}
							</h2>
							<button type="button" aria-label="Close view" onClick={close}>
								<X size={20} />
							</button>
						</header>
						{view === "menu" ? (
							<div className="quick-actions-menu">
								<button type="button" onClick={() => compose(selection.current)}>
									<Plus size={18} />
									Start agent task{selection.current.text ? " with selection" : ""}
								</button>
								<button type="button" onClick={() => setView("terminal")}>
									<TerminalSquare size={18} />
									Open terminals
								</button>
								{window.location.protocol !== "https:" ? <PairDevice client={client} /> : null}
							</div>
						) : null}
						{view === "compose" ? (
							<form
								onSubmit={(event) => {
									event.preventDefault();
									void start();
								}}
							>
								<label>
									Task title
									<input required maxLength={160} value={title} onChange={(e) => setTitle(e.target.value)} />
								</label>
								<label>
									Instructions
									<textarea
										required
										rows={4}
										value={instructions}
										onChange={(e) => setInstructions(e.target.value)}
										placeholder="What should the agent do?"
									/>
								</label>
								{context.text ? (
									<details open>
										<summary>Briefing context · {context.source}</summary>
										<pre>{context.text}</pre>
										<p>This snapshot stays with the task even if the brief changes.</p>
									</details>
								) : null}
								<label>
									Agent
									<select value={runner} onChange={(e) => setRunner(e.target.value)}>
										{options.runners.map((r) => (
											<option key={r.id} value={r.id} disabled={!r.available}>
												{r.id}
												{r.available ? "" : " — not installed"}
											</option>
										))}
									</select>
								</label>
								<label>
									Project
									<select required value={project} onChange={(e) => setProject(e.target.value)}>
										<option value="">Choose a project</option>
										{options.projects.map((p) => (
											<option key={p.id} value={p.id}>
												{p.id}
											</option>
										))}
									</select>
								</label>
								<label>
									Working copy
									<select value={isolation} onChange={(e) => setIsolation(e.target.value)}>
										<option value="worktree">Separate Git worktree</option>
										<option value="existing">Existing checkout</option>
									</select>
								</label>
								<p>
									{isolation === "worktree"
										? "Starts from the current commit; uncommitted changes are not copied."
										: "The agent can change the selected checkout alongside your other work."}
								</p>
								<p>
									{runner === "hsy"
										? "Harnessy runs with your host-user permissions; project trust remains separate."
										: "Uses normal agent permissions. Approval prompts appear in the terminal."}
								</p>
								{error ? <p role="alert">{error}</p> : null}
								<button
									type="submit"
									disabled={busy || !project || !options.runners.find((r) => r.id === runner)?.available}
								>
									{busy ? "Starting…" : "Start agent"}
								</button>
							</form>
						) : null}
						{view === "terminal" ? (
							<>
								<a href={`#/terminal/${selected}`} onClick={close}>
									Expand to Terminal <ArrowUpRight size={16} />
								</a>
								<TerminalScreen client={client} initialSelected={selected} />
							</>
						) : null}
					</div>
				</div>
			) : null}
		</Actions.Provider>
	);
};
