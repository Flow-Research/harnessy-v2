/**
 * `harnessy jarvis tasks` — non-interactive JSON commands for the local task
 * store. The 18:30 Africa/Lagos close-out routine can call `closeout`.
 *
 * These commands never write brief, reminder, register or status Markdown.
 * `--write-note` is the only way a note file is appended, and only from the CLI.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

import { Console } from "effect";
import { Command, Flag as Options } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
	appendCloseoutNote,
	type CloseoutEntry,
	defaultTasksFile,
	ingestBriefFile,
	lagosCalendarDate,
	type TaskOutcome,
	TaskRefused,
	TasksState,
	validateCloseoutNote,
} from "../jarvis/tasks/index.ts";
import { targetOption } from "./shared.ts";

const homeRootOption = Options.String("home-root").pipe(
	Options.optional,
	Options.withDescription("Home-like root that holds ~/.harnessy/portal/tasks.json. Defaults to the user home."),
);
const stateDirOption = Options.String("state-dir").pipe(
	Options.optional,
	Options.withDescription("Portal state directory containing tasks.json. Overrides the default under home-root."),
);
const tasksFileOption = Options.String("tasks-file").pipe(
	Options.optional,
	Options.withDescription("Explicit tasks.json path. Overrides --state-dir and --home-root."),
);

const resolveFile = (
	homeRoot: Option.Option<string>,
	stateDir: Option.Option<string>,
	tasksFile: Option.Option<string>,
): string => {
	const explicit = Option.getOrUndefined(tasksFile) ?? process.env.HARNESSY_TASKS_FILE?.trim();
	if (explicit) return resolve(explicit);
	const dir = Option.getOrUndefined(stateDir);
	if (dir !== undefined) return resolve(dir, "tasks.json");
	return defaultTasksFile(resolve(Option.getOrUndefined(homeRoot) ?? homedir()));
};

const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const fail = (error: unknown): Effect.Effect<never> => {
	const code = error instanceof TaskRefused ? error.code : error instanceof Error ? error.message : "failed";
	return print({ ok: false, error: code }).pipe(
		Effect.flatMap(() => Effect.die(error instanceof Error ? error : new Error(code))),
	);
};

const run = <T>(body: () => T): Effect.Effect<void> =>
	Effect.try({
		try: () => body(),
		catch: (cause) => (cause instanceof Error ? cause : new Error("failed")),
	}).pipe(
		Effect.flatMap((value) => print({ ok: true, ...value })),
		Effect.catch((error) => fail(error)),
	);

const shared = {
	homeRoot: homeRootOption,
	stateDir: stateDirOption,
	tasksFile: tasksFileOption,
};

export const jarvisTasksListCommand = Command.make(
	"list",
	{
		...shared,
		includeDone: Options.Boolean("include-done").pipe(
			Options.withDefault(false),
			Options.withDescription("Include done and dropped tasks."),
		),
	},
	({ homeRoot, stateDir, tasksFile, includeDone }) =>
		run(() => {
			const items = new TasksState(resolveFile(homeRoot, stateDir, tasksFile))
				.read()
				.items.filter((item) => includeDone || (item.status !== "done" && item.status !== "dropped"));
			return { items };
		}),
);

export const jarvisTasksIngestCommand = Command.make(
	"ingest",
	{
		...shared,
		brief: Options.String("brief").pipe(Options.withDescription("Path of the daily brief Markdown to ingest.")),
		date: Options.String("date").pipe(
			Options.optional,
			Options.withDescription("Brief calendar date (YYYY-MM-DD). Defaults to today in Africa/Lagos."),
		),
	},
	({ homeRoot, stateDir, tasksFile, brief, date }) =>
		run(() => {
			const day = Option.getOrUndefined(date) ?? lagosCalendarDate(new Date());
			const result = ingestBriefFile(new TasksState(resolveFile(homeRoot, stateDir, tasksFile)), resolve(brief), {
				date: day,
			});
			return {
				created: result.created,
				matched: result.matched,
				sidecarPath: result.sidecarPath,
				items: result.sidecar.items,
			};
		}),
);

export const jarvisTasksAddCommand = Command.make(
	"add",
	{
		...shared,
		title: Options.String("title").pipe(Options.withDescription("Task title.")),
		owner: Options.String("owner").pipe(Options.optional, Options.withDescription("Optional owner name.")),
		due: Options.String("due").pipe(Options.optional, Options.withDescription("Optional due date (YYYY-MM-DD).")),
		project: Options.String("project").pipe(Options.optional, Options.withDescription("Optional project name.")),
		priority: Options.Int("priority").pipe(
			Options.optional,
			Options.withDescription("Sort priority; lower numbers come first (0–10000)."),
		),
		index: Options.Int("index").pipe(
			Options.optional,
			Options.withDescription("Insert at this 0-based position. Omit to append."),
		),
	},
	({ homeRoot, stateDir, tasksFile, title, owner, due, project, priority, index }) =>
		run(() => {
			const item = new TasksState(resolveFile(homeRoot, stateDir, tasksFile)).add({
				title,
				owner: Option.getOrUndefined(owner) ?? null,
				due: Option.getOrUndefined(due) ?? null,
				project: Option.getOrUndefined(project) ?? null,
				...(Option.isSome(priority) ? { priority: Option.getOrUndefined(priority) } : {}),
				...(Option.isSome(index) ? { index: Option.getOrUndefined(index) } : {}),
			});
			return { item };
		}),
);

export const jarvisTasksOutcomeCommand = Command.make(
	"outcome",
	{
		...shared,
		id: Options.String("id").pipe(Options.withDescription("Store UUID of the task.")),
		outcome: Options.String("outcome").pipe(
			Options.withDescription("Outcome: done, carried, dropped, or delegated."),
		),
		owner: Options.String("owner").pipe(
			Options.optional,
			Options.withDescription("Required when --outcome delegated: the person now waiting."),
		),
		date: Options.String("date").pipe(
			Options.optional,
			Options.withDescription("carriedFrom date (YYYY-MM-DD). Defaults to today in Africa/Lagos."),
		),
	},
	({ homeRoot, stateDir, tasksFile, id, outcome, owner, date }) =>
		run(() => {
			const value = outcome.trim().toLowerCase();
			if (value !== "done" && value !== "carried" && value !== "dropped" && value !== "delegated")
				throw new TaskRefused("invalid_outcome");
			const item = new TasksState(resolveFile(homeRoot, stateDir, tasksFile)).applyOutcome(id, value, {
				owner: Option.getOrUndefined(owner) ?? null,
				date: Option.getOrUndefined(date),
			});
			return { item };
		}),
);

const readCloseoutInput = (
	input: string,
): { readonly date?: string; readonly outcomes: CloseoutEntry[]; readonly note?: string } => {
	const raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(input), "utf8");
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskRefused("invalid_body");
	const body = value as Record<string, unknown>;
	if (body.date !== undefined && (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(body.date)))
		throw new TaskRefused("invalid_due");
	if (!Array.isArray(body.outcomes)) throw new TaskRefused("invalid_body");
	const outcomes: CloseoutEntry[] = body.outcomes.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TaskRefused("invalid_body");
		const row = entry as Record<string, unknown>;
		if (typeof row.id !== "string" || typeof row.outcome !== "string") throw new TaskRefused("invalid_body");
		const outcome = row.outcome as TaskOutcome;
		if (outcome !== "done" && outcome !== "carried" && outcome !== "dropped" && outcome !== "delegated")
			throw new TaskRefused("invalid_outcome");
		return {
			id: row.id,
			outcome,
			...(typeof row.owner === "string" ? { owner: row.owner } : {}),
		};
	});
	return {
		outcomes,
		...(typeof body.date === "string" ? { date: body.date } : {}),
		...(typeof body.note === "string" ? { note: body.note } : {}),
	};
};

export const jarvisTasksCloseoutCommand = Command.make(
	"closeout",
	{
		...shared,
		input: Options.String("input").pipe(
			Options.withDescription('JSON file of { "outcomes": [...], "date"?, "note"? }. Use - to read stdin.'),
		),
		writeNote: Options.Boolean("write-note").pipe(
			Options.withDefault(false),
			Options.withDescription("Append options.note (or the JSON note) as a jarvis followup note. Off by default."),
		),
		note: Options.String("note").pipe(
			Options.optional,
			Options.withDescription("Optional narrative. Used only with --write-note."),
		),
		target: targetOption,
	},
	({ homeRoot, stateDir, tasksFile, input, writeNote, note, target }) =>
		run(() => {
			const payload = readCloseoutInput(input);
			const narrative = Option.getOrUndefined(note) ?? payload.note;
			let noteBody: string | undefined;
			if (writeNote) {
				const validated = Result.try(() => validateCloseoutNote(narrative ?? ""));
				if (Result.isFailure(validated)) {
					const error = validated.failure;
					const code = error instanceof Error && error.message === "empty_note" ? "empty_note" : "invalid_note";
					throw new TaskRefused(code);
				}
				noteBody = validated.success;
			}
			const result = new TasksState(resolveFile(homeRoot, stateDir, tasksFile)).closeout(
				payload.outcomes,
				payload.date,
			);
			// Outcomes are already committed here, so a note failure is reported beside
			// them (ok stays true) rather than as a failed command a retry would hide.
			let notePath: string | undefined;
			let noteError: string | undefined;
			if (writeNote && noteBody !== undefined) {
				const user = process.env.FLOW_USER ?? process.env.USER ?? "default";
				const body = noteBody;
				const appended = Result.try(() => appendCloseoutNote(resolve(target, ".jarvis/context"), user, body));
				if (Result.isSuccess(appended)) notePath = appended.success;
				else noteError = "note_unwritable";
			}
			return {
				updated: result.updated,
				unchanged: result.unchanged,
				...(notePath === undefined ? {} : { notePath }),
				...(noteError === undefined ? {} : { noteError }),
			};
		}),
);

export const jarvisTasksCommand = Command.make("tasks").pipe(
	Command.withDescription(
		"List, ingest, add and close out local portal tasks (JSON in/out). Never writes source Markdown.",
	),
	Command.withSubcommands([
		jarvisTasksListCommand,
		jarvisTasksIngestCommand,
		jarvisTasksAddCommand,
		jarvisTasksOutcomeCommand,
		jarvisTasksCloseoutCommand,
	] as const),
);
