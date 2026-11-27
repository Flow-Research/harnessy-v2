/**
 * Tasks: today's brief items and native store items first; reminders, the
 * first-week register and project status.md lists sit behind Other sources.
 * Follow-ups (things waiting on someone, or owed to someone) have their own
 * tabs: open follow-ups by priority then due date, and the overdue ones.
 * Completion, add, insert, reorder, priority, outcomes and resolving a
 * follow-up write only to the local store. Source Markdown and notes files are
 * never written from here.
 */
import { type FormEvent, useState } from "react";

import { CommandChip } from "../components/actions.tsx";
import { EmptyState, StatusDot, type TabItem, Tabs, type Tone, WithTile } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { Task, TasksResponse } from "../lib/api-types.ts";
import { useResource } from "../lib/data.tsx";
import { dayLabel, visibleTitle } from "../lib/format.ts";
import { usePhoneLayout } from "../lib/media.ts";
import { routeHref } from "../lib/router.ts";
import type { SessionClient } from "../lib/session.ts";
import "./tasks.css";

export type TaskTab = "mine" | "waiting" | "followups" | "overdue" | "project" | "done";

export const TASK_TABS: ReadonlyArray<TaskTab> = ["mine", "waiting", "followups", "overdue", "project", "done"];

const STATUS_TONE: Readonly<Record<Task["status"], Tone>> = {
	todo: "idle",
	doing: "attention",
	waiting: "idle",
	done: "ok",
	dropped: "idle",
};

const open = (task: Task) => task.status !== "done" && task.status !== "dropped";

/** Today's calendar date in Lagos, as YYYY-MM-DD; due dates are Lagos days. */
export const lagosToday = (now: Date = new Date()): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Lagos",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);

const isOverdue = (task: Task, today: string): boolean =>
	task.kind === "followup" && open(task) && task.due !== null && task.due < today;

/** Open follow-ups: priority first, then the earliest due date (undated last), then list order. */
const byPriorityThenDue = (tasks: ReadonlyArray<Task>): Task[] =>
	tasks
		.map((task, index) => ({ task, index }))
		.sort(
			(a, b) =>
				a.task.priority - b.task.priority ||
				(a.task.due ?? "9999-99-99").localeCompare(b.task.due ?? "9999-99-99") ||
				a.index - b.index,
		)
		.map((entry) => entry.task);

/** The tasks a tab shows, before the Other sources filter. */
export const tasksForTab = (
	tasks: ReadonlyArray<Task>,
	tab: TaskTab,
	today: string = lagosToday(),
): ReadonlyArray<Task> => {
	switch (tab) {
		case "mine":
			return tasks.filter((task) => open(task) && task.mine && task.status !== "waiting");
		case "waiting":
			return tasks.filter((task) => open(task) && (!task.mine || task.status === "waiting"));
		case "followups":
			return byPriorityThenDue(tasks.filter((task) => task.kind === "followup" && open(task)));
		case "overdue":
			return byPriorityThenDue(tasks.filter((task) => isOverdue(task, today)));
		case "project":
			return tasks
				.filter(open)
				.sort((a, b) =>
					a.project === b.project
						? 0
						: a.project === null
							? 1
							: b.project === null
								? -1
								: a.project.localeCompare(b.project),
				);
		case "done":
			return tasks.filter((task) => !open(task));
	}
};

/** Apply the Other sources filter: off shows only the primary group. */
export const tasksForView = (
	tasks: ReadonlyArray<Task>,
	tab: TaskTab,
	otherSources: boolean,
	today: string = lagosToday(),
): ReadonlyArray<Task> => {
	const shown = tasksForTab(tasks, tab, today);
	// Follow-ups come from your list and from reminders; both views show every one.
	if (tab === "followups" || tab === "overdue") return shown;
	// In-store done or dropped items stay visible on Done without the Other sources filter.
	return otherSources ? shown : shown.filter((task) => task.group === "primary" || (!open(task) && task.inStore));
};

const TABS: ReadonlyArray<TabItem<TaskTab>> = [
	{ id: "mine", label: "Mine" },
	{ id: "waiting", label: "Waiting on others" },
	{ id: "followups", label: "Follow-ups" },
	{ id: "overdue", label: "Overdue" },
	{ id: "project", label: "By project" },
	{ id: "done", label: "Done" },
];

/** Open tasks in project groups, in the order `tasksForTab` sorted them; `null` is "No project". */
export const projectGroups = (
	tasks: ReadonlyArray<Task>,
): ReadonlyArray<{ readonly project: string | null; readonly tasks: ReadonlyArray<Task> }> => {
	const groups: Array<{ project: string | null; tasks: Task[] }> = [];
	for (const task of tasks) {
		const last = groups[groups.length - 1];
		if (last !== undefined && last.project === task.project) last.tasks.push(task);
		else groups.push({ project: task.project, tasks: [task] });
	}
	return groups;
};

const TaskTitle = ({ task, expanded, onToggle }: { task: Task; expanded: boolean; onToggle: () => void }) => (
	<>
		<button type="button" className="link-button task-title-button" aria-expanded={expanded} onClick={onToggle}>
			{visibleTitle(task.title)}
		</button>
		{task.kind === "followup" ? <span className="pill">follow-up</span> : null}
		{isOverdue(task, lagosToday()) ? <span className="pill pill-attention">overdue</span> : null}
		{task.kind === "followup" && open(task) && task.waitingOn !== null ? (
			<span className="task-previous muted">waiting on {task.waitingOn}</span>
		) : null}
		{!open(task) && task.resolution !== null ? (
			<span className="task-previous muted">resolved: {task.resolution}</span>
		) : null}
		{task.raw ? <span className="pill">unparsed line</span> : null}
		{task.outcome === "carried" && task.carriedFrom !== null ? (
			<span className="pill">carried from {task.carriedFrom}</span>
		) : null}
		{task.sourceChanged ? (
			<span className="pill pill-attention" title="The line in the source file changed since an earlier read.">
				source changed
			</span>
		) : null}
		{task.sourceChanged && task.previousTitle !== null ? (
			<span className="task-previous muted">was: {visibleTitle(task.previousTitle)}</span>
		) : null}
	</>
);

const TaskDetail = ({
	task,
	client,
	onAct,
	busy,
	error,
}: {
	task: Task;
	client: SessionClient | undefined;
	onAct: (body: Record<string, unknown>) => void;
	busy: boolean;
	error: string | undefined;
}) => {
	const [owner, setOwner] = useState("");
	const [note, setNote] = useState("");
	return (
		<>
			{task.link !== null && /^https?:\/\//iu.test(task.link) ? (
				<p>
					<a href={task.link} target="_blank" rel="noopener noreferrer">
						Open the link
					</a>{" "}
					<span className="muted mono">{task.link}</span>
				</p>
			) : null}
			{task.resolvedAt !== null ? (
				<p className="muted">
					Resolved {dayLabel(lagosToday(new Date(task.resolvedAt)))}
					{task.resolution !== null ? `: ${task.resolution}` : ""}
				</p>
			) : null}
			{task.source.kind !== "native" ? (
				<>
					<p className="label">Open the source</p>
					<CommandChip
						command={`${task.source.path}:${task.source.line}`}
						note="Path and line; open it in your editor."
					/>
				</>
			) : (
				<p className="muted">This task lives in the local store. It is not a line in a source file.</p>
			)}
			<p className="label">Copy the task</p>
			<CommandChip command={task.title} />
			{client !== undefined && open(task) ? (
				<div className="task-actions">
					{task.kind === "followup" ? (
						<div className="task-action-row">
							<label className="task-field">
								<span className="label">Resolution note (optional)</span>
								<input
									className="input"
									value={note}
									onChange={(event) => setNote(event.target.value)}
									maxLength={500}
								/>
							</label>
							<button
								type="button"
								className="button button-sm"
								disabled={busy}
								onClick={() =>
									onAct(
										note.trim() === ""
											? { action: "resolve", id: task.id }
											: { action: "resolve", id: task.id, note: note.trim() },
									)
								}
							>
								Resolve
							</button>
						</div>
					) : null}
					<p className="label">Record an outcome</p>
					<div className="task-action-row">
						<button
							type="button"
							className="button button-sm"
							disabled={busy}
							onClick={() => onAct({ action: "outcome", id: task.id, outcome: "done" })}
						>
							Done
						</button>
						<button
							type="button"
							className="button button-sm"
							disabled={busy}
							onClick={() => onAct({ action: "outcome", id: task.id, outcome: "carried" })}
						>
							Carry
						</button>
						<button
							type="button"
							className="button button-sm"
							disabled={busy}
							onClick={() => onAct({ action: "outcome", id: task.id, outcome: "dropped" })}
						>
							Drop
						</button>
					</div>
					<div className="task-action-row">
						<label className="task-field">
							<span className="label">Delegate to</span>
							<input
								className="input"
								value={owner}
								onChange={(event) => setOwner(event.target.value)}
								maxLength={64}
							/>
						</label>
						<button
							type="button"
							className="button button-sm"
							disabled={busy || owner.trim() === ""}
							onClick={() =>
								onAct({ action: "outcome", id: task.id, outcome: "delegated", owner: owner.trim() })
							}
						>
							Delegate
						</button>
					</div>
					{error !== undefined ? <p className="tone-danger">{error}</p> : null}
				</div>
			) : null}
		</>
	);
};

const dueText = (task: Task): string => (task.due === null ? "–" : dayLabel(task.due));

const TaskRow = ({
	task,
	expanded,
	onToggle,
	client,
	onAct,
	onMove,
	busy,
	error,
	canMove,
}: {
	task: Task;
	expanded: boolean;
	onToggle: () => void;
	client: SessionClient | undefined;
	onAct: (body: Record<string, unknown>) => void;
	onMove: (id: string, direction: -1 | 1) => void;
	busy: boolean;
	error: string | undefined;
	canMove: boolean;
}) => (
	<>
		<tr className={task.raw ? "task-raw" : undefined}>
			<td className="task-check-cell">
				{client !== undefined && open(task) ? (
					<button
						type="button"
						className="task-check"
						aria-label={`Mark ${visibleTitle(task.title)} done`}
						disabled={busy}
						onClick={() => onAct({ action: "complete", id: task.id })}
					/>
				) : (
					<span className="task-check task-check-static" aria-hidden="true" />
				)}
			</td>
			<td>
				<TaskTitle task={task} expanded={expanded} onToggle={onToggle} />
			</td>
			<td className="text-2">{task.owner ?? "Julian"}</td>
			<td className="text-2">{dueText(task)}</td>
			<td>
				<StatusDot tone={STATUS_TONE[task.status]} label={task.status} />
			</td>
			<td>
				{client !== undefined && task.inStore ? (
					<label className="task-priority">
						<span className="visually-hidden">Priority</span>
						<input
							// Remount when the stored priority changes (a move can change it), so the shown value follows.
							key={task.priority}
							className="input task-priority-input"
							type="number"
							min={0}
							max={10000}
							defaultValue={task.priority}
							disabled={busy}
							onBlur={(event) => {
								const value = Number(event.target.value);
								if (Number.isInteger(value) && value !== task.priority)
									onAct({ action: "setPriority", id: task.id, priority: value });
							}}
						/>
					</label>
				) : (
					<span className="text-2">{task.priority}</span>
				)}
			</td>
			<td>
				<span className="source-chip">{task.source.displayRef}</span>
			</td>
			<td>
				{canMove ? (
					<div className="task-reorder">
						<button
							type="button"
							className="button button-sm"
							disabled={busy}
							aria-label="Move up"
							onClick={() => onMove(task.id, -1)}
						>
							Up
						</button>
						<button
							type="button"
							className="button button-sm"
							disabled={busy}
							aria-label="Move down"
							onClick={() => onMove(task.id, 1)}
						>
							Down
						</button>
					</div>
				) : null}
			</td>
		</tr>
		{expanded ? (
			<tr className="task-detail">
				<td colSpan={8}>
					<TaskDetail task={task} client={client} onAct={onAct} busy={busy} error={error} />
				</td>
			</tr>
		) : null}
	</>
);

const TaskCard = ({
	task,
	expanded,
	onToggle,
	client,
	onAct,
	onMove,
	busy,
	error,
	canMove,
}: {
	task: Task;
	expanded: boolean;
	onToggle: () => void;
	client: SessionClient | undefined;
	onAct: (body: Record<string, unknown>) => void;
	onMove: (id: string, direction: -1 | 1) => void;
	busy: boolean;
	error: string | undefined;
	canMove: boolean;
}) => (
	<li className={task.raw ? "stack-card task-raw" : "stack-card"}>
		<div className="stack-card-title">
			<TaskTitle task={task} expanded={expanded} onToggle={onToggle} />
		</div>
		<div className="stack-card-meta">
			{client !== undefined && open(task) ? (
				<button
					type="button"
					className="task-check"
					aria-label={`Mark ${visibleTitle(task.title)} done`}
					disabled={busy}
					onClick={() => onAct({ action: "complete", id: task.id })}
				/>
			) : null}
			<span className="text-2">{task.owner ?? "Julian"}</span>
			<span className="text-2">Due {dueText(task)}</span>
			<StatusDot tone={STATUS_TONE[task.status]} label={task.status} />
			<span className="source-chip">{task.source.displayRef}</span>
		</div>
		{canMove ? (
			<div className="task-reorder">
				<button type="button" className="button button-sm" disabled={busy} onClick={() => onMove(task.id, -1)}>
					Up
				</button>
				<button type="button" className="button button-sm" disabled={busy} onClick={() => onMove(task.id, 1)}>
					Down
				</button>
			</div>
		) : null}
		{expanded ? (
			<div className="stack-card-detail">
				<TaskDetail task={task} client={client} onAct={onAct} busy={busy} error={error} />
			</div>
		) : null}
	</li>
);

const AddForm = ({
	onAdd,
	busy,
	error,
}: {
	onAdd: (body: Record<string, unknown>) => void;
	busy: boolean;
	error: string | undefined;
}) => {
	const [openForm, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [owner, setOwner] = useState("");
	const [due, setDue] = useState("");
	const [priority, setPriority] = useState("0");
	const [index, setIndex] = useState("");
	const [followup, setFollowup] = useState(false);
	const [waitingOn, setWaitingOn] = useState("");
	const [link, setLink] = useState("");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const body: Record<string, unknown> = { action: "add", title: title.trim() };
		if (owner.trim() !== "") body.owner = owner.trim();
		if (due.trim() !== "") body.due = due.trim();
		if (followup) {
			body.kind = "followup";
			if (waitingOn.trim() !== "") body.waitingOn = waitingOn.trim();
			if (link.trim() !== "") body.link = link.trim();
		}
		const priorityValue = Number(priority);
		if (Number.isInteger(priorityValue)) body.priority = priorityValue;
		if (index.trim() !== "") {
			const value = Number(index);
			if (Number.isInteger(value)) {
				body.action = "insert";
				body.index = value;
			}
		}
		onAdd(body);
		// Start the next add clean, so an owner, due date or position is never reused unseen.
		setTitle("");
		setOwner("");
		setDue("");
		setPriority("0");
		setIndex("");
		setFollowup(false);
		setWaitingOn("");
		setLink("");
		setOpen(false);
	};
	if (!openForm)
		return (
			<button type="button" className="button" onClick={() => setOpen(true)}>
				Add task
			</button>
		);
	return (
		<form className="task-add" onSubmit={submit}>
			<label className="task-field">
				<span className="label">Title</span>
				<input
					className="input"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					required
					maxLength={300}
				/>
			</label>
			<label className="task-filter">
				<input type="checkbox" checked={followup} onChange={(event) => setFollowup(event.target.checked)} />
				Follow-up
			</label>
			<label className="task-field">
				<span className="label">{followup ? "Who it is with (optional)" : "Owner (optional)"}</span>
				<input className="input" value={owner} onChange={(event) => setOwner(event.target.value)} maxLength={64} />
			</label>
			<label className="task-field">
				<span className="label">Due (YYYY-MM-DD)</span>
				<input className="input" value={due} onChange={(event) => setDue(event.target.value)} />
			</label>
			{followup ? (
				<>
					<label className="task-field">
						<span className="label">Waiting on (optional)</span>
						<input
							className="input"
							value={waitingOn}
							onChange={(event) => setWaitingOn(event.target.value)}
							maxLength={120}
						/>
					</label>
					<label className="task-field">
						<span className="label">Link (optional, https://…)</span>
						<input
							className="input"
							type="url"
							value={link}
							onChange={(event) => setLink(event.target.value)}
							maxLength={2048}
						/>
					</label>
				</>
			) : null}
			<label className="task-field">
				<span className="label">Priority (lower first)</span>
				<input
					className="input"
					type="number"
					min={0}
					max={10000}
					value={priority}
					onChange={(event) => setPriority(event.target.value)}
				/>
			</label>
			<label className="task-field">
				<span className="label">Insert at position (optional)</span>
				<input
					className="input"
					inputMode="numeric"
					value={index}
					onChange={(event) => setIndex(event.target.value)}
				/>
			</label>
			<div className="task-action-row">
				<button type="submit" className="button" disabled={busy || title.trim() === ""}>
					Save
				</button>
				<button type="button" className="button button-sm" onClick={() => setOpen(false)}>
					Cancel
				</button>
			</div>
			{error !== undefined ? <p className="tone-danger">{error}</p> : null}
		</form>
	);
};

export const TasksScreen = ({ rest, client }: { rest: ReadonlyArray<string>; client?: SessionClient }) => {
	const tasks = useResource<TasksResponse>("/v1/tasks");
	const tab: TaskTab = TASK_TABS.find((id) => id === rest[0]) ?? "mine";
	const [expanded, setExpanded] = useState<string | undefined>(undefined);
	const [otherSources, setOtherSources] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const toggle = (id: string) => setExpanded(expanded === id ? undefined : id);
	const phone = usePhoneLayout();
	const tile = tasks.data?.tiles.tasks;
	const all = tile?.state === "ok" ? (tile.data?.tasks ?? []) : [];
	/** Send each change in order, stopping at the first refusal; refresh after any success. */
	const actAll = (bodies: ReadonlyArray<Record<string, unknown>>) => {
		if (client === undefined) return;
		setBusy(true);
		setError(undefined);
		const run = async () => {
			let changed = false;
			for (const body of bodies) {
				const result = await client.taskAction(body);
				if (result.kind === "error") {
					setError(result.message);
					break;
				}
				changed = true;
			}
			setBusy(false);
			if (changed) tasks.refresh();
		};
		void run();
	};
	const act = (body: Record<string, unknown>) => actAll([body]);
	const move = (id: string, direction: -1 | 1) => {
		const stored = all.filter((task) => task.inStore);
		const index = stored.findIndex((task) => task.id === id);
		if (index < 0) return;
		const next = index + direction;
		if (next < 0 || next >= stored.length) return;
		const ids = stored.map((task) => task.id);
		const [item] = ids.splice(index, 1);
		if (item === undefined) return;
		ids.splice(next, 0, item);
		// The list sorts by priority before stored order, so a move past a task of
		// another priority takes that task's priority; otherwise it would not show.
		const moving = stored[index]!;
		const neighbour = stored[next]!;
		actAll(
			moving.priority === neighbour.priority
				? [{ action: "reorder", ids }]
				: [
						{ action: "setPriority", id: moving.id, priority: neighbour.priority },
						{ action: "reorder", ids },
					],
		);
	};
	return (
		<div className="screen">
			<ScreenHeader title="Tasks">
				{client !== undefined ? <AddForm onAdd={act} busy={busy} error={error} /> : null}
			</ScreenHeader>
			<Tabs
				label="Task views"
				items={TABS.map((item) => ({ ...item, count: tasksForView(all, item.id, otherSources).length }))}
				current={tab}
				hrefOf={(id) => routeHref("tasks", id)}
			/>
			<div className="task-toolbar">
				<label className="task-filter">
					<input
						type="checkbox"
						checked={otherSources}
						onChange={(event) => setOtherSources(event.target.checked)}
					/>
					Other sources
				</label>
				<p className="banner">
					Today&apos;s brief and your list come first. Reminders, the first-week register and project status files
					are under Other sources. Outcomes write only to the local store, never to those files.
				</p>
			</div>
			{tasks.status === "loading" ? <p className="muted">Loading</p> : null}
			<WithTile tile={tile}>
				{(data) => {
					const shown = tasksForView(data.tasks, tab, otherSources);
					const canReorder = tab === "mine" || tab === "waiting";
					return (
						<>
							{shown.length === 0 ? (
								<EmptyState
									title={
										tab === "overdue"
											? "No overdue follow-ups."
											: tab === "followups"
												? "No open follow-ups."
												: "No tasks here."
									}
								/>
							) : phone ? (
								<div className="stack-groups">
									{tab === "project" ? (
										projectGroups(shown).map((group) => (
											<section key={group.project === null ? "no-project" : `project:${group.project}`}>
												<h2 className="stack-group-title">
													{group.project ?? "No project"}
													<span className="tab-count"> {group.tasks.length}</span>
												</h2>
												<ul className="stack-cards" aria-label={group.project ?? "No project"}>
													{group.tasks.map((task) => (
														<TaskCard
															key={task.id}
															task={task}
															expanded={expanded === task.id}
															onToggle={() => toggle(task.id)}
															client={client}
															onAct={act}
															onMove={move}
															busy={busy}
															error={expanded === task.id ? error : undefined}
															canMove={false}
														/>
													))}
												</ul>
											</section>
										))
									) : (
										<ul className="stack-cards" aria-label="Tasks">
											{shown.map((task) => (
												<TaskCard
													key={task.id}
													task={task}
													expanded={expanded === task.id}
													onToggle={() => toggle(task.id)}
													client={client}
													onAct={act}
													onMove={move}
													busy={busy}
													error={expanded === task.id ? error : undefined}
													canMove={canReorder && task.inStore}
												/>
											))}
										</ul>
									)}
								</div>
							) : (
								<div className="table-scroll card">
									<table className="table">
										<thead>
											<tr>
												<th scope="col">
													<span className="visually-hidden">Done</span>
												</th>
												<th scope="col">Task</th>
												<th scope="col">Owner</th>
												<th scope="col">Due</th>
												<th scope="col">Status</th>
												<th scope="col">Priority</th>
												<th scope="col">Source</th>
												<th scope="col">
													<span className="visually-hidden">Order</span>
												</th>
											</tr>
										</thead>
										{tab === "project" ? (
											projectGroups(shown).map((group) => (
												<tbody key={group.project === null ? "no-project" : `project:${group.project}`}>
													<tr className="group-row">
														<th scope="colgroup" colSpan={8}>
															{group.project ?? "No project"}
															<span className="tab-count"> {group.tasks.length}</span>
														</th>
													</tr>
													{group.tasks.map((task) => (
														<TaskRow
															key={task.id}
															task={task}
															expanded={expanded === task.id}
															onToggle={() => toggle(task.id)}
															client={client}
															onAct={act}
															onMove={move}
															busy={busy}
															error={expanded === task.id ? error : undefined}
															canMove={false}
														/>
													))}
												</tbody>
											))
										) : (
											<tbody>
												{shown.map((task) => (
													<TaskRow
														key={task.id}
														task={task}
														expanded={expanded === task.id}
														onToggle={() => toggle(task.id)}
														client={client}
														onAct={act}
														onMove={move}
														busy={busy}
														error={expanded === task.id ? error : undefined}
														canMove={canReorder && task.inStore}
													/>
												))}
											</tbody>
										)}
									</table>
								</div>
							)}
							<details className="sources">
								<summary>Sources ({data.sources.length})</summary>
								<ul className="plain-list">
									{data.sources.map((source) => (
										<li key={`${source.kind}-${source.displayRef}`} className="split-line">
											<span className="mono">{source.displayRef}</span>
											<StatusDot
												tone={source.state === "ok" ? "ok" : source.state === "missing" ? "idle" : "danger"}
												label={
													source.state === "ok" ? `${source.count} found` : (source.reason ?? source.state)
												}
											/>
										</li>
									))}
								</ul>
								{data.omitted > 0 ? <p className="fine-print">{data.omitted} more not shown.</p> : null}
							</details>
						</>
					);
				}}
			</WithTile>
		</div>
	);
};
