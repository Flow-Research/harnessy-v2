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
import { dayLabel, visibleText } from "../lib/format.ts";
import { usePhoneLayout } from "../lib/media.ts";
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

const TABS: ReadonlyArray<TabItem<TaskTab>> = [
	{ id: "mine", label: "Mine" },
	{ id: "waiting", label: "Waiting on others" },
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

/** The task's title as a toggle for its detail, with its markers. */
const TaskTitle = ({ task, expanded, onToggle }: { task: Task; expanded: boolean; onToggle: () => void }) => (
	<>
		<button type="button" className="link-button" aria-expanded={expanded} onClick={onToggle}>
			{visibleText(task.title)}
		</button>
		{task.raw ? <span className="pill">unparsed line</span> : null}
		{task.sourceChanged ? (
			<span className="pill pill-attention" title="The line in the source file changed since an earlier read.">
				source changed
			</span>
		) : null}
		{task.sourceChanged && task.previousTitle !== null ? (
			<span className="task-previous muted">was: {visibleText(task.previousTitle)}</span>
		) : null}
	</>
);

const TaskDetail = ({ task }: { task: Task }) => (
	<>
		<p className="label">Open the source</p>
		<CommandChip command={`${task.source.path}:${task.source.line}`} note="Path and line; open it in your editor." />
		<p className="label">Copy the task</p>
		<CommandChip command={task.title} />
	</>
);

const dueText = (task: Task): string => (task.due === null ? "–" : dayLabel(task.due));

const TaskRow = ({ task, expanded, onToggle }: { task: Task; expanded: boolean; onToggle: () => void }) => (
	<>
		<tr className={task.raw ? "task-raw" : undefined}>
			<td>
				<TaskTitle task={task} expanded={expanded} onToggle={onToggle} />
			</td>
			<td className="text-2">{task.owner ?? "Julian"}</td>
			<td className="text-2">{dueText(task)}</td>
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
					<TaskDetail task={task} />
				</td>
			</tr>
		) : null}
	</>
);

/** At phone width a task is a stacked card: the title on top, then owner, due, status and source. */
const TaskCard = ({ task, expanded, onToggle }: { task: Task; expanded: boolean; onToggle: () => void }) => (
	<li className={task.raw ? "stack-card task-raw" : "stack-card"}>
		<div className="stack-card-title">
			<TaskTitle task={task} expanded={expanded} onToggle={onToggle} />
		</div>
		<div className="stack-card-meta">
			<span className="text-2">{task.owner ?? "Julian"}</span>
			<span className="text-2">Due {dueText(task)}</span>
			<StatusDot tone={STATUS_TONE[task.status]} label={task.status} />
			<span className="source-chip">{task.source.displayRef}</span>
		</div>
		{expanded ? (
			<div className="stack-card-detail">
				<TaskDetail task={task} />
			</div>
		) : null}
	</li>
);

const TaskCards = ({
	tasks,
	grouped,
	expanded,
	onToggle,
}: {
	tasks: ReadonlyArray<Task>;
	grouped: boolean;
	expanded: string | undefined;
	onToggle: (id: string) => void;
}) => {
	const cards = (list: ReadonlyArray<Task>, label: string) => (
		<ul className="stack-cards" aria-label={label}>
			{list.map((task) => (
				<TaskCard key={task.id} task={task} expanded={expanded === task.id} onToggle={() => onToggle(task.id)} />
			))}
		</ul>
	);
	if (!grouped) return cards(tasks, "Tasks");
	return (
		<div className="stack-groups">
			{projectGroups(tasks).map((group) => (
				<section key={group.project === null ? "no-project" : `project:${group.project}`}>
					<h2 className="stack-group-title">
						{group.project ?? "No project"}
						<span className="tab-count"> {group.tasks.length}</span>
					</h2>
					{cards(group.tasks, group.project ?? "No project")}
				</section>
			))}
		</div>
	);
};

export const TasksScreen = ({ rest }: { rest: ReadonlyArray<string> }) => {
	const tasks = useResource<TasksResponse>("/v1/tasks");
	const tab: TaskTab = (["mine", "waiting", "project", "done"] as const).find((id) => id === rest[0]) ?? "mine";
	const [expanded, setExpanded] = useState<string | undefined>(undefined);
	const toggle = (id: string) => setExpanded(expanded === id ? undefined : id);
	const phone = usePhoneLayout();
	const tile = tasks.data?.tiles.tasks;
	const all = tile?.state === "ok" ? (tile.data?.tasks ?? []) : [];
	return (
		<div className="screen">
			<ScreenHeader title="Tasks" />
			<Tabs
				label="Task views"
				items={TABS.map((item) => ({ ...item, count: tasksForTab(all, item.id).length }))}
				current={tab}
				hrefOf={(id) => routeHref("tasks", id)}
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
							) : phone ? (
								<TaskCards tasks={shown} grouped={tab === "project"} expanded={expanded} onToggle={toggle} />
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
										{tab === "project" ? (
											projectGroups(shown).map((group) => (
												<tbody key={group.project === null ? "no-project" : `project:${group.project}`}>
													<tr className="group-row">
														<th scope="colgroup" colSpan={5}>
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
