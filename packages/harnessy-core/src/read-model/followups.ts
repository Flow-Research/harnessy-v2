/**
 * Derived, read-only follow-ups and tasks for the portal.
 *
 * Tasks are gathered from Markdown that people write by hand: the Life
 * reminders file, today's brief, the founder-office action register and the
 * "this week" section of each project's `status.md`. None of these has IDs or a
 * shared schema, so each task's identity is a content hash of its source kind,
 * path and normalised text. A line inside a task section that does not parse is
 * kept as a raw task rather than dropped.
 *
 * Every file is read bounded and without following a final symbolic link. No
 * source file is ever written: completion state arrives in Phase B in a store of
 * its own.
 */
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import * as Result from "effect/Result";
import type { TaskData, TaskListData, TaskSourceData } from "./app-schemas.ts";
import { readBoundedDirectory, readBoundedFile } from "./files.ts";
import { guardTile, okTile, ReadModelStateError, type TileResult } from "./tile.ts";

export type TaskSourceKind = TaskData["source"]["kind"];
export type TaskStatus = TaskData["status"];

/** Each source file is read up to this size; a longer file is parsed up to the limit. */
export const MAX_TASK_SOURCE_BYTES = 256 * 1024;
/** Tasks returned at most; the rest are counted in `omitted`. */
export const MAX_TASKS = 500;
/** Project directories scanned for `status.md` at most. */
export const MAX_TASK_PROJECTS = 200;
const MAX_TITLE = 300;

/** One task found in a source text, before identity and file metadata are added. */
export interface ExtractedTask {
	readonly title: string;
	readonly status: TaskStatus;
	readonly owner: string | null;
	readonly due: string | null;
	/** 1-based line in the source text. */
	readonly line: number;
	/** The line could not be parsed and is shown as written. */
	readonly raw: boolean;
	/** Short reference, for example `FW-03`. */
	readonly ref?: string;
}

const DATE = /\b(20\d{2}-\d{2}-\d{2})\b/u;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/u;
const BULLET = /^(?:[-*+]|\d{1,3}[.)])\s+(.*)$/u;
const CHECKBOX = /^\[([ xX])\]\s+(.*)$/u;
const OWNER_LEAD = /^([A-Z][\p{L}.,'&+ ]{0,48}?)\s+[—–]\s+(.+)$/u;

/** Plain text from one Markdown line: emphasis, code ticks and link targets removed. */
export const plainText = (value: string): string =>
	value
		.replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
		.replace(/(\*\*|__)(.+?)\1/gu, "$2")
		.replace(/(^|[\s(])([*_])(\S(?:.*?\S)?)\2(?=[\s).,;:!?]|$)/gu, "$1$3")
		.replace(/`([^`]*)`/gu, "$1")
		.replace(/\s+/gu, " ")
		.trim();

const bounded = (value: string): string => (value.length > MAX_TITLE ? `${value.slice(0, MAX_TITLE - 1)}…` : value);

/** The text a task's identity hashes: lower case, Markdown and whitespace removed. */
export const normaliseTaskText = (value: string): string => plainText(value).toLowerCase();

/** `sha256(kind, path, normalised text)` as 64 hex characters. */
export const taskId = (kind: TaskSourceKind, path: string, text: string): string =>
	createHash("sha256")
		.update(`${kind}\0${path}\0${normaliseTaskText(text)}`)
		.digest("hex");

/** The lines of the section under the first heading that matches `title`, with their 1-based numbers. */
const section = (
	text: string,
	title: RegExp,
): ReadonlyArray<{ readonly line: number; readonly text: string }> | undefined => {
	const lines = text.split(/\r?\n/u);
	let level = 0;
	let found: Array<{ line: number; text: string }> | undefined;
	for (const [index, line] of lines.entries()) {
		const heading = HEADING.exec(line);
		if (found !== undefined) {
			if (heading !== null && heading[1]!.length <= level) return found;
			found.push({ line: index + 1, text: line });
		} else if (heading !== null && title.test(heading[2]!)) {
			level = heading[1]!.length;
			found = [];
		}
	}
	return found;
};

/**
 * The top-level list items of a section. Indented continuation lines belong to
 * the item above. A non-empty, non-heading line outside any item is returned raw.
 */
const listItems = (
	lines: ReadonlyArray<{ readonly line: number; readonly text: string }>,
): ReadonlyArray<{ readonly line: number; readonly text: string; readonly raw: boolean }> => {
	const items: Array<{ line: number; text: string; raw: boolean }> = [];
	for (const entry of lines) {
		if (entry.text.trim() === "" || HEADING.test(entry.text)) continue;
		if (/^\s/u.test(entry.text)) continue;
		const bullet = BULLET.exec(entry.text);
		if (bullet !== null) items.push({ line: entry.line, text: bullet[1]!, raw: false });
		else if (!/^(?:\||-{3,}|>)/u.test(entry.text))
			items.push({ line: entry.line, text: entry.text.trim(), raw: true });
	}
	return items;
};

/** A bold lead such as `**Settle the mandate.** More text` gives `Settle the mandate`. */
const boldLead = (value: string): string | undefined => {
	const match = /^\*\*(.+?)\*\*/u.exec(value.trim());
	return match === null ? undefined : plainText(match[1]!).replace(/[.:]\s*$/u, "");
};

const dueOf = (value: string): string | null => DATE.exec(value)?.[1] ?? null;

const checkbox = (value: string): { readonly done: boolean; readonly text: string } => {
	const match = CHECKBOX.exec(value);
	return match === null ? { done: false, text: value } : { done: match[1] !== " ", text: match[2]! };
};

const rawTask = (item: { readonly line: number; readonly text: string }): ExtractedTask => ({
	title: bounded(item.text),
	status: "todo",
	owner: null,
	due: null,
	line: item.line,
	raw: true,
});

/** `## Current Follow-Ups` in the Life reminders file. A checked box is done. */
export const extractReminderTasks = (text: string): ReadonlyArray<ExtractedTask> =>
	listItems(section(text, /^current follow-?ups$/iu) ?? []).map((item) => {
		if (item.raw) return rawTask(item);
		const box = checkbox(item.text);
		const lead = OWNER_LEAD.exec(plainText(box.text));
		return {
			title: bounded(lead?.[2] ?? plainText(box.text)),
			status: box.done ? "done" : "todo",
			owner: lead?.[1] ?? null,
			due: dueOf(box.text),
			line: item.line,
			raw: false,
		};
	});

/**
 * The brief's two action sections. "Decisions and Actions for You" items are the
 * owner's own; "Delegated or Waiting" items wait on the people named before the dash.
 */
export const extractBriefTasks = (text: string): ReadonlyArray<ExtractedTask> => {
	const mine = listItems(section(text, /^decisions and actions for you$/iu) ?? []).map(
		(item): ExtractedTask =>
			item.raw
				? rawTask(item)
				: {
						title: bounded(boldLead(item.text) ?? plainText(item.text)),
						status: "todo",
						owner: null,
						due: dueOf(item.text),
						line: item.line,
						raw: false,
					},
	);
	const waiting = listItems(section(text, /^delegated or waiting$/iu) ?? []).map((item): ExtractedTask => {
		if (item.raw) return rawTask(item);
		const lead = boldLead(item.text) ?? plainText(item.text);
		const named = OWNER_LEAD.exec(lead);
		return {
			title: bounded(named?.[2] ?? lead),
			status: "waiting",
			owner: named?.[1] ?? null,
			due: dueOf(item.text),
			line: item.line,
			raw: false,
		};
	});
	return [...mine, ...waiting];
};

const REGISTER_STATUS: ReadonlyArray<readonly [RegExp, TaskStatus | null]> = [
	[/^(?:done|complete|completed|closed)$/iu, null],
	[/^parked$/iu, null],
	[/^(?:in progress|doing|started|active)$/iu, "doing"],
	[/^(?:blocked|waiting|on hold)$/iu, "waiting"],
	[/^(?:dropped|cancelled|canceled)$/iu, "dropped"],
];

const cells = (line: string): ReadonlyArray<string> =>
	line
		.trim()
		.replace(/^\|/u, "")
		.replace(/\|$/u, "")
		.split("|")
		.map((cell) => cell.trim());

/**
 * Rows of every Markdown table with ID, Action, Owner and Status columns.
 * Done and Parked rows are left out. A row with too few cells is kept raw.
 */
export const extractRegisterTasks = (text: string): ReadonlyArray<ExtractedTask> => {
	const tasks: ExtractedTask[] = [];
	let columns: ReadonlyMap<string, number> | undefined;
	for (const [index, line] of text.split(/\r?\n/u).entries()) {
		if (!line.trim().startsWith("|")) {
			columns = undefined;
			continue;
		}
		const row = cells(line);
		if (columns === undefined) {
			const names = new Map(row.map((name, column) => [name.toLowerCase(), column]));
			if (["id", "action", "owner", "status"].every((name) => names.has(name))) columns = names;
			continue;
		}
		if (row.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
		const at = (name: string) => {
			const column = columns!.get(name);
			return column === undefined ? "" : (row[column] ?? "");
		};
		if (row.length < columns.size) {
			tasks.push(rawTask({ line: index + 1, text: plainText(line) }));
			continue;
		}
		const statusText = plainText(at("status"));
		const mapped = REGISTER_STATUS.find(([pattern]) => pattern.test(statusText));
		if (mapped !== undefined && mapped[1] === null) continue;
		const id = plainText(at("id"));
		tasks.push({
			title: bounded(plainText(at("action"))),
			status: mapped?.[1] ?? "todo",
			owner: plainText(at("owner")) || null,
			due: dueOf(at("due")),
			line: index + 1,
			raw: false,
			...(id === "" ? {} : { ref: id.slice(0, 32) }),
		});
	}
	return tasks;
};

/** The list under a project's "this week" heading. `Owner — text` names the owner. */
export const extractStatusTasks = (text: string): ReadonlyArray<ExtractedTask> =>
	listItems(section(text, /\bthis week\b/iu) ?? []).map((item) => {
		if (item.raw) return rawTask(item);
		const box = checkbox(item.text);
		const plain = plainText(box.text);
		const lead = OWNER_LEAD.exec(plain);
		return {
			title: bounded(lead?.[2] ?? plain),
			status: box.done ? "done" : "todo",
			owner: lead?.[1] ?? null,
			due: dueOf(box.text),
			line: item.line,
			raw: false,
		};
	});

export interface TaskReadOptions {
	readonly now: Date;
	/** The Life directory (`~/.agents/life`): `reminders.md` lives here. */
	readonly lifeDirectory: string;
	/** Today's canonical brief, or `null` when there is none. */
	readonly briefPath: string | null;
	/** The workspace's private context directory for the user, or `null` when no workspace is known. */
	readonly privateContextDirectory: string | null;
	/** Shown in place of the home directory in display paths. */
	readonly homeRoot: string;
	/** Lower-case names that count as the owner's own tasks. */
	readonly ownerNames: ReadonlyArray<string>;
}

interface SourceFile {
	readonly kind: TaskSourceKind;
	readonly path: string;
	readonly displayRef: string;
	readonly project: string | null;
	readonly extract: (text: string) => ReadonlyArray<ExtractedTask>;
}

const displayPath = (path: string, homeRoot: string): string => {
	const fromHome = relative(homeRoot, path);
	return fromHome.startsWith("..") || fromHome === path ? path : `~/${fromHome}`;
};

const projectFiles = (
	directory: string,
): { readonly files: ReadonlyArray<SourceFile>; readonly truncated: boolean } => {
	const listing = Result.try(() => readBoundedDirectory(directory, MAX_TASK_PROJECTS));
	if (Result.isFailure(listing)) return { files: [], truncated: false };
	return {
		files: listing.success.entries
			.filter((entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.map((project) => ({
				kind: "status-md" as const,
				path: join(directory, project, "status.md"),
				displayRef: `status.md · ${project}`,
				project,
				extract: extractStatusTasks,
			})),
		truncated: listing.success.truncated,
	};
};

const sourceState = (error: unknown): { readonly state: TaskSourceData["state"]; readonly reason: string } =>
	error instanceof ReadModelStateError
		? { state: error.state, reason: error.reason }
		: { state: "error", reason: "read_failed" };

/**
 * Every derived task, ordered by source. A missing or unreadable source is
 * reported in `sources` and never fails the tile.
 */
export const readTasks = (options: TaskReadOptions): TileResult<TaskListData> =>
	guardTile(options.now, () => {
		const owners = options.ownerNames.map((name) => name.toLowerCase()).filter((name) => name.length > 0);
		const files: SourceFile[] = [
			{
				kind: "reminders",
				path: join(options.lifeDirectory, "reminders.md"),
				displayRef: "reminders.md",
				project: null,
				extract: extractReminderTasks,
			},
		];
		if (options.briefPath !== null)
			files.push({
				kind: "brief",
				path: options.briefPath,
				displayRef: `brief ${options.briefPath.replace(/^.*\/(\d{4})\/([A-Za-z]{3})\/(\d{2})-daily-brief\.md$/u, "$3 $2")}`,
				project: null,
				extract: extractBriefTasks,
			});
		let projectsTruncated = false;
		if (options.privateContextDirectory !== null) {
			files.push({
				kind: "register",
				path: join(options.privateContextDirectory, "founder-office", "first-week-action-register.md"),
				displayRef: "register",
				project: "founder-office",
				extract: extractRegisterTasks,
			});
			const projects = projectFiles(options.privateContextDirectory);
			projectsTruncated = projects.truncated;
			files.push(...projects.files);
		}
		const tasks: TaskData[] = [];
		const sources: TaskSourceData[] = [];
		let omitted = 0;
		for (const file of files) {
			const read = Result.try(() => readBoundedFile(file.path, MAX_TASK_SOURCE_BYTES));
			if (Result.isFailure(read)) {
				const failed = sourceState(read.failure);
				// A project without a status file is not a finding.
				if (file.kind === "status-md" && failed.reason === "file_missing") continue;
				sources.push({ kind: file.kind, displayRef: file.displayRef, ...failed, count: 0, truncated: false });
				continue;
			}
			const text = new TextDecoder("utf-8", { fatal: false }).decode(read.success.bytes);
			const extracted = file.extract(text);
			if (file.kind === "status-md" && extracted.length === 0) continue;
			const path = displayPath(file.path, options.homeRoot);
			sources.push({
				kind: file.kind,
				displayRef: file.displayRef,
				state: "ok",
				reason: null,
				count: extracted.length,
				truncated: read.success.truncated,
			});
			for (const task of extracted) {
				if (tasks.length >= MAX_TASKS) {
					omitted += 1;
					continue;
				}
				const owner = task.owner === null ? null : task.owner.slice(0, 64);
				tasks.push({
					id: taskId(file.kind, file.path, `${task.ref ?? ""} ${task.title}`),
					title: task.title,
					status: task.status,
					owner,
					due: task.due,
					project: file.project,
					mine: owner === null || owners.some((name) => owner.toLowerCase().includes(name)),
					raw: task.raw,
					sourceChanged: false,
					source: {
						kind: file.kind,
						path,
						line: task.line,
						revision: read.success.modifiedAt.toISOString(),
						displayRef: (task.ref === undefined ? file.displayRef : `${file.displayRef} ${task.ref}`).slice(
							0,
							96,
						),
					},
				});
			}
		}
		return okTile({ tasks, sources, omitted, projectsTruncated }, options.now);
	});
