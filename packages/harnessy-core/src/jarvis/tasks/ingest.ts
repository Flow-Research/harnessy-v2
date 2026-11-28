/**
 * Ingest today's brief (or another derived source) into the local task store
 * and optionally write a sidecar next to the brief so later scrapes can keep
 * the same UUIDs.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import type { TaskData } from "../../read-model/app-schemas.ts";
import { type ExtractedTask, extractBriefTasks } from "../../read-model/followups.ts";
import {
	defaultTasksFile,
	type IngestCandidate,
	type StoredTask,
	type StoredTaskSourceKind,
	TaskRefused,
	type TaskSidecar,
	TasksState,
	taskFingerprint,
} from "./store.ts";

const MAX_BRIEF_BYTES = 256 * 1024;

const textOf = (task: ExtractedTask): string => `${task.ref ?? ""} ${task.title}`.trim();

/** Candidates for `TasksState.ingest`, with fingerprints unique within the batch. */
export const candidatesFromExtracted = (
	kind: Exclude<StoredTaskSourceKind, "native">,
	extracted: ReadonlyArray<ExtractedTask>,
	displayRef: string,
): ReadonlyArray<IngestCandidate> => {
	const seen = new Map<string, number>();
	return extracted.map((task) => {
		const text = textOf(task);
		const normalised = text.toLowerCase();
		const occurrence = seen.get(normalised) ?? 0;
		seen.set(normalised, occurrence + 1);
		return {
			title: task.title,
			status: task.status,
			owner: task.owner,
			due: task.due,
			line: task.line,
			fingerprint: taskFingerprint(kind, text, occurrence),
			displayRef: task.ref === undefined ? displayRef : `${displayRef} ${task.ref}`.slice(0, 96),
			// A brief's "Delegated or Waiting" items are follow-ups that wait on the person named.
			...(kind === "brief" && task.followup === true
				? { kind: "followup" as const, waitingOn: task.owner === null ? null : task.owner.slice(0, 120) }
				: {}),
		};
	});
};

/** Sidecar path beside a daily brief: `DD-daily-brief.tasks.json`. */
export const briefTasksSidecarPath = (briefPath: string): string => {
	if (briefPath.endsWith("-daily-brief.md")) return `${briefPath.slice(0, -3)}.tasks.json`;
	return join(dirname(briefPath), `${briefPath.split("/").pop() ?? "brief"}.tasks.json`);
};

export interface IngestBriefResult {
	readonly items: readonly StoredTask[];
	readonly created: number;
	readonly matched: number;
	readonly sidecar: TaskSidecar;
	readonly sidecarPath: string;
}

/** Read a brief, ingest its action items, and write the sidecar next to it. */
export const ingestBriefFile = (
	state: TasksState,
	briefPath: string,
	options: { readonly date: string; readonly displayRef?: string },
): IngestBriefResult => {
	const path = realpathSync(briefPath);
	const buffer = readFileSync(path);
	if (buffer.byteLength > MAX_BRIEF_BYTES) throw new Error("brief_too_large");
	const extracted = extractBriefTasks(buffer.toString("utf8"));
	const displayRef = options.displayRef ?? `brief ${options.date}`;
	const candidates = candidatesFromExtracted("brief", extracted, displayRef);
	const sidecarPath = briefTasksSidecarPath(path);
	const result = state.ingest(
		candidates,
		{ kind: "brief", path, displayRef, briefDate: options.date },
		{ date: options.date, path: sidecarPath },
	);
	return {
		items: result.items,
		created: result.created,
		matched: result.matched,
		sidecar: result.sidecar!,
		sidecarPath,
	};
};

/** Ingest today's published brief into the store under `homeRoot` (or `HARNESSY_TASKS_FILE`). */
export const ingestPublishedBrief = (
	homeRoot: string,
	briefPath: string,
	date: string,
	clock?: () => Date,
	tasksFile?: string,
): (IngestBriefResult & { readonly tasksFile: string; readonly path: string; readonly markdown: string }) | null => {
	if (!existsSync(briefPath)) return null;
	const file = tasksFile ?? (process.env.HARNESSY_TASKS_FILE?.trim() || defaultTasksFile(homeRoot));
	const state = new TasksState(file, clock);
	const result = ingestBriefFile(state, briefPath, { date });
	const path = realpathSync(briefPath);
	return { ...result, tasksFile: file, path, markdown: readFileSync(path, "utf8") };
};

/** Find or ingest one derived task so an action can use a stable UUID. */
export const ensureStoredTask = (state: TasksState, task: TaskData, briefDate: string | null = null): StoredTask => {
	const store = state.read();
	const byId = store.items.find((item) => item.id === task.id);
	if (byId !== undefined) return byId;
	if (task.fingerprint !== null) {
		const byFingerprint = store.items.find(
			(item) => item.fingerprint === task.fingerprint && item.status !== "done" && item.status !== "dropped",
		);
		if (byFingerprint !== undefined) return byFingerprint;
	}
	if (task.source.kind === "native") throw new TaskRefused("task_missing");
	const kind = task.source.kind;
	const text = task.title;
	const fingerprint = task.fingerprint ?? taskFingerprint(kind, text);
	const result = state.ingest(
		[
			{
				title: task.title,
				status: task.status,
				owner: task.owner,
				due: task.due,
				line: task.source.line,
				fingerprint,
				displayRef: task.source.displayRef,
			},
		],
		{
			kind,
			path: task.source.path,
			displayRef: task.source.displayRef,
			briefDate: kind === "brief" ? briefDate : null,
		},
	);
	const created = result.items[0];
	if (created === undefined) throw new TaskRefused("task_missing");
	return created;
};
