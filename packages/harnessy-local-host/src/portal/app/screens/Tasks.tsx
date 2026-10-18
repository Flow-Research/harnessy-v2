/**
 * Tasks: follow-ups and tasks derived, read-only, from briefs, reminders, the
 * action register and project status files. Completion arrives in Phase B in a
 * store of its own; source Markdown is never edited from here.
 */
import { useState } from "react";

import { CommandChip } from "../components/actions.tsx";
import { EmptyState, StatusDot, type TabItem, Tabs, type Tone, WithTile } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { Task, TasksResponse } from "../lib/api-types.ts";
import { useResource } from "../lib/data.tsx";
import { dayLabel } from "../lib/format.ts";
import { routeHref } from "../lib/router.ts";

export type TaskTab = "mine" | "waiting" | "project" | "done";

const STATUS_TONE: Readonly<Record<Task["status"], Tone>> = {
	todo: "idle",
	doing: "attention",
	waiting: "idle",
	done: "ok",
	dropped: "idle",
};

const open = (task: Task) => task.status !== "done" && task.status !== "dropped";

/** The tasks a tab shows. */
export const tasksForTab = (tasks: ReadonlyArray<Task>, tab: TaskTab): ReadonlyArray<Task> => {
	switch (tab) {
		case "mine":
			return tasks.filter((task) => open(task) && task.mine && task.status !== "waiting");
		case "waiting":
			return tasks.filter((task) => open(task) && (!task.mine || task.status === "waiting"));
		case "project":
			// Grouped by project; tasks without a project come last.
			return tasks.filter(open).sort((a, b) =>
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

const TABS: ReadonlyArray<TabItem<TaskTab>> = [
	{ id: "mine", label: "Mine" },
	{ id: "waiting", label: "Waiting on others" },
	{ id: "project", label: "By project" },
	{ id: "done", label: "Done" },
];

const TaskRow = ({ task, expanded, onToggle }: { task: Task; expanded: boolean; onToggle: () => void }) => (
	<>
		<tr className={task.raw ? "task-raw" : undefined}>
			<td>
				<button type="button" className="link-button" aria-expanded={expanded} onClick={onToggle}>
					{task.title}
				</button>
				{task.raw ? <span className="pill">unparsed line</span> : null}
				{task.sourceChanged ? <span className="pill pill-attention">source changed</span> : null}
			</td>
			<td className="text-2">{task.owner ?? "Julian"}</td>
			<td className="text-2">{task.due === null ? "–" : dayLabel(task.due)}</td>
			<td>
				<StatusDot tone={STATUS_TONE[task.status]} label={task.status} />
			</td>
			<td>
				<span className="source-chip">{task.source.displayRef}</span>
			</td>
		</tr>
		{expanded ? (
			<tr className="task-detail">
				<td colSpan={5}>
					<p className="label">Open the source</p>
					<CommandChip
						command={`${task.source.path}:${task.source.line}`}
						note="Path and line; open it in your editor."
					/>
					<p className="label">Copy the task</p>
					<CommandChip command={task.title} />
				</td>
			</tr>
		) : null}
	</>
);

export const TasksScreen = ({ rest }: { rest: ReadonlyArray<string> }) => {
	const tasks = useResource<TasksResponse>("/v1/tasks");
	const tab: TaskTab = (["mine", "waiting", "project", "done"] as const).find((id) => id === rest[0]) ?? "mine";
	const [expanded, setExpanded] = useState<string | undefined>(undefined);
	const tile = tasks.data?.tiles.tasks;
	const all = tile?.state === "ok" ? (tile.data?.tasks ?? []) : [];
	return (
		<div className="screen">
			<ScreenHeader title="Tasks" />
			<Tabs
				label="Task views"
				items={TABS.map((item) => ({ ...item, count: tasksForTab(all, item.id).length }))}
				current={tab}
				onSelect={(id) => {
					window.location.hash = routeHref("tasks", id);
				}}
			/>
			<p className="banner">
				Derived, not tracked: these come from your briefs, reminders, action register and project status files.
				Completion arrives in Phase B.
			</p>
			{tasks.status === "loading" ? <p className="muted">Loading</p> : null}
			<WithTile tile={tile}>
				{(data) => {
					const shown = tasksForTab(data.tasks, tab);
					return (
						<>
							{shown.length === 0 ? (
								<EmptyState title="No tasks here." />
							) : (
								<div className="table-scroll card">
									<table className="table">
										<thead>
											<tr>
												<th scope="col">Task</th>
												<th scope="col">Owner</th>
												<th scope="col">Due</th>
												<th scope="col">Status</th>
												<th scope="col">Source</th>
											</tr>
										</thead>
										<tbody>
											{shown.map((task) => (
												<TaskRow
													key={task.id}
													task={task}
													expanded={expanded === task.id}
													onToggle={() => setExpanded(expanded === task.id ? undefined : task.id)}
												/>
											))}
										</tbody>
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
