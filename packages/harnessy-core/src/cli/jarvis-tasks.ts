/**
 * `harnessy jarvis tasks` — non-interactive JSON commands for the local task
 * store. The 18:30 Africa/Lagos close-out routine can call `closeout`.
 *
 * `followup add|list|resolve` serve the 8:00, 13:00 and 18:30 check-ins.
 *
 * These commands never write brief, reminder, register or status Markdown.
 * `--write-note` is the only way a note file is appended, and only from the CLI.
 */
import { randomUUID } from "node:crypto";
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
	applyMutation,
	type CloseoutEntry,
	defaultTasksFile,
	type FollowupInput,
	type FollowupView,
	followupsForView,
	ingestBriefFile,
	lagosCalendarDate,
	type ResolveEntry,
	resolveSyncConfig,
	syncTasks,
	type TaskOutcome,
	TaskRefused,
	TasksState,
	validateCloseoutNote,
} from "../jarvis/tasks/index.ts";
import { defaultLocalMeetingFile, isLocalMeetingStore } from "../jarvis/tasks/sync.ts";
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
const endpointOption = Options.String("endpoint").pipe(
	Options.optional,
	Options.withDescription(
		"Hosted tasks URL. Defaults to HARNESSY_TASKS_ENDPOINT or ~/.config/harnessy/tasks-sync.json.",
	),
);
const tokenFileOption = Options.String("token-file").pipe(
	Options.optional,
	Options.withDescription(
		"Path of the bearer token file (mode 0600). Defaults to HARNESSY_TASKS_TOKEN_FILE or the path in the sync config.",
	),
);
const syncConfigOption = Options.String("sync-config").pipe(
	Options.optional,
	Options.withDescription("Path of the sync config JSON (endpoint and tokenFile)."),
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

const syncOptions = {
	endpoint: endpointOption,
	tokenFile: tokenFileOption,
	syncConfig: syncConfigOption,
};

const configFrom = (
	endpoint: Option.Option<string>,
	tokenFile: Option.Option<string>,
	syncConfig: Option.Option<string>,
) =>
	resolveSyncConfig({
		endpoint: Option.getOrUndefined(endpoint),
		tokenFile: Option.getOrUndefined(tokenFile),
		configFile: Option.getOrUndefined(syncConfig),
	});

const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const fail = (error: unknown): Effect.Effect<never> => {
	const code = error instanceof TaskRefused ? error.code : error instanceof Error ? error.message : "failed";
	return print({ ok: false, error: code }).pipe(
		Effect.flatMap(() => Effect.die(error instanceof Error ? error : new Error(code))),
	);
};

const runAsync = <T>(body: () => Promise<T>): Effect.Effect<void> =>
	Effect.tryPromise({
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
	...syncOptions,
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
	({ homeRoot, stateDir, tasksFile, includeDone, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
			const file = resolveFile(homeRoot, stateDir, tasksFile);
			const config = configFrom(endpoint, tokenFile, syncConfig);
			if (config !== undefined) {
				await Effect.runPromise(
					Effect.tryPromise({
						try: () => syncTasks({ tasksFile: file, config }),
						catch: (error) => error,
					}).pipe(Effect.result, Effect.asVoid),
				);
			}
			const items = new TasksState(file)
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
	({ homeRoot, stateDir, tasksFile, brief, date, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
			const day = Option.getOrUndefined(date) ?? lagosCalendarDate(new Date());
			const file = resolveFile(homeRoot, stateDir, tasksFile);
			const briefPath = resolve(brief);
			const markdown = readFileSync(briefPath, "utf8");
			const mutation = { op: "ingest" as const, markdown, date: day, path: briefPath, displayRef: `brief ${day}` };
			const applied = await applyMutation({
				tasksFile: file,
				config: configFrom(endpoint, tokenFile, syncConfig),
				mutation,
				applyLocal: (state) => ingestBriefFile(state, briefPath, { date: day }),
				mutationForQueue: (result) => ({
					...mutation,
					allocations: (
						(result as { items?: ReadonlyArray<{ id: string; fingerprint: string | null }> }).items ?? []
					)
						.filter((item) => item.fingerprint !== null)
						.map((item) => ({ id: item.id, fingerprint: item.fingerprint as string })),
				}),
			});
			if (applied.mode === "queued") {
				const result = applied.result as {
					created: number;
					matched: number;
					sidecarPath: string;
					sidecar: { items: unknown };
				};
				return {
					created: result.created,
					matched: result.matched,
					sidecarPath: result.sidecarPath,
					items: result.sidecar.items,
					mode: applied.mode,
					revision: applied.revision,
				};
			}
			// Remote ingest does not write a local sidecar; a later local ingest can.
			return {
				created: (applied.result as { created?: number }).created ?? 0,
				matched: (applied.result as { matched?: number }).matched ?? 0,
				items: (applied.result as { items?: unknown }).items ?? [],
				mode: applied.mode,
				revision: applied.revision,
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
	({ homeRoot, stateDir, tasksFile, title, owner, due, project, priority, index, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
			const file = resolveFile(homeRoot, stateDir, tasksFile);
			const fields = {
				id: randomUUID(),
				title,
				owner: Option.getOrUndefined(owner) ?? null,
				due: Option.getOrUndefined(due) ?? null,
				project: Option.getOrUndefined(project) ?? null,
				...(Option.isSome(priority) ? { priority: Option.getOrUndefined(priority) } : {}),
				...(Option.isSome(index) ? { index: Option.getOrUndefined(index) } : {}),
			};
			const applied = await applyMutation({
				tasksFile: file,
				config: configFrom(endpoint, tokenFile, syncConfig),
				mutation: { op: "add", fields },
				applyLocal: (state) => state.add(fields),
			});
			const item =
				applied.mode === "queued"
					? applied.result
					: new TasksState(file).read().items.find((row) => row.id === fields.id);
			return { item, mode: applied.mode, revision: applied.revision };
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
	({ homeRoot, stateDir, tasksFile, id, outcome, owner, date, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
			const value = outcome.trim().toLowerCase();
			if (value !== "done" && value !== "carried" && value !== "dropped" && value !== "delegated")
				throw new TaskRefused("invalid_outcome");
			const file = resolveFile(homeRoot, stateDir, tasksFile);
			const applied = await applyMutation({
				tasksFile: file,
				config: configFrom(endpoint, tokenFile, syncConfig),
				mutation: {
					op: "outcome",
					id,
					outcome: value,
					owner: Option.getOrUndefined(owner) ?? null,
					date: Option.getOrUndefined(date),
				},
				applyLocal: (state) =>
					state.applyOutcome(id, value, {
						owner: Option.getOrUndefined(owner) ?? null,
						date: Option.getOrUndefined(date),
					}),
			});
			const item =
				applied.mode === "queued" ? applied.result : new TasksState(file).read().items.find((row) => row.id === id);
			return { item, mode: applied.mode, revision: applied.revision };
		}),
);

const readCloseoutInput = (
	input: string,
): {
	readonly date?: string;
	readonly outcomes: CloseoutEntry[];
	readonly followups: FollowupInput[];
	readonly resolve: ResolveEntry[];
	readonly note?: string;
} => {
	const raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(input), "utf8");
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskRefused("invalid_body");
	const body = value as Record<string, unknown>;
	if (body.date !== undefined && (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(body.date)))
		throw new TaskRefused("invalid_due");
	if (body.outcomes === undefined && (body.followups !== undefined || body.resolve !== undefined)) body.outcomes = [];
	if (!Array.isArray(body.outcomes)) throw new TaskRefused("invalid_body");
	if (body.followups !== undefined && !Array.isArray(body.followups)) throw new TaskRefused("invalid_body");
	if (body.resolve !== undefined && !Array.isArray(body.resolve)) throw new TaskRefused("invalid_body");
	const text = (row: Record<string, unknown>, key: string): string | null | undefined => {
		const value = row[key];
		if (value === undefined || value === null) return value;
		if (typeof value !== "string") throw new TaskRefused("invalid_body");
		return value;
	};
	const rowOf = (entry: unknown): Record<string, unknown> => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TaskRefused("invalid_body");
		return entry as Record<string, unknown>;
	};
	const followups: Array<FollowupInput & { id: string }> = ((body.followups ?? []) as unknown[]).map((entry) => {
		const row = rowOf(entry);
		const title = text(row, "title");
		if (typeof title !== "string") throw new TaskRefused("invalid_title");
		if (row.priority !== undefined && !Number.isInteger(row.priority)) throw new TaskRefused("invalid_priority");
		return {
			title,
			id: typeof row.id === "string" ? row.id : randomUUID(),
			owner: text(row, "owner") ?? null,
			waitingOn: text(row, "waitingOn") ?? null,
			due: text(row, "due") ?? null,
			link: text(row, "link") ?? null,
			project: text(row, "project") ?? null,
			...(row.priority === undefined ? {} : { priority: row.priority as number }),
		};
	});
	const resolveEntries: ResolveEntry[] = ((body.resolve ?? []) as unknown[]).map((entry) => {
		const row = rowOf(entry);
		if (typeof row.id !== "string") throw new TaskRefused("invalid_body");
		return { id: row.id, note: text(row, "note") ?? null };
	});
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
		followups,
		resolve: resolveEntries,
		...(typeof body.date === "string" ? { date: body.date } : {}),
		...(typeof body.note === "string" ? { note: body.note } : {}),
	};
};

export const jarvisTasksCloseoutCommand = Command.make(
	"closeout",
	{
		...shared,
		input: Options.String("input").pipe(
			Options.withDescription(
				'JSON file of { "outcomes": [...], "followups"?: [...], "resolve"?: [...], "date"?, "note"? }. Use - to read stdin.',
			),
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
	({ homeRoot, stateDir, tasksFile, input, writeNote, note, target, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
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
			const file = resolveFile(homeRoot, stateDir, tasksFile);
			const applied = await applyMutation({
				tasksFile: file,
				config: configFrom(endpoint, tokenFile, syncConfig),
				mutation: {
					op: "closeout",
					outcomes: payload.outcomes,
					followups: payload.followups,
					resolve: payload.resolve,
					date: payload.date,
				},
				applyLocal: (state) =>
					state.closeout(payload.outcomes, payload.date, {
						followups: payload.followups,
						resolve: payload.resolve,
					}),
			});
			const result =
				applied.mode === "queued"
					? (applied.result as {
							readonly updated: unknown;
							readonly unchanged: number;
							readonly created: unknown;
						})
					: {
							updated: (applied.result as { updated?: unknown }).updated ?? [],
							unchanged: (applied.result as { unchanged?: number }).unchanged ?? 0,
							created: (applied.result as { created?: unknown }).created ?? [],
						};
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
				created: result.created,
				...(notePath === undefined ? {} : { notePath }),
				...(noteError === undefined ? {} : { noteError }),
			};
		}),
);

const FOLLOWUP_VIEWS: ReadonlyArray<FollowupView> = ["open", "overdue", "resolved", "all"];

const localMeetingsOption = Options.Boolean("local-meetings").pipe(
	Options.withDefault(false),
	Options.withDescription(
		"Use the local-only meeting store beside the task store (tasks.meeting-local.json). It never syncs: no request, no queue.",
	),
);

/** The follow-up store for a command: the local meeting store with `--local-meetings`. */
const followupFile = (
	homeRoot: Option.Option<string>,
	stateDir: Option.Option<string>,
	tasksFile: Option.Option<string>,
	localMeetings: boolean,
): string => {
	const file = resolveFile(homeRoot, stateDir, tasksFile);
	return localMeetings && !isLocalMeetingStore(file) ? defaultLocalMeetingFile(file) : file;
};

export const jarvisFollowupAddCommand = Command.make(
	"add",
	{
		...shared,
		title: Options.String("title").pipe(Options.withDescription("What is owed, by or to whom.")),
		owner: Options.String("owner").pipe(
			Options.optional,
			Options.withDescription("Counterparty: the person this follow-up is with."),
		),
		waitingOn: Options.String("waiting-on").pipe(
			Options.optional,
			Options.withDescription("What or whom it is waiting on. Set, the follow-up starts as waiting."),
		),
		due: Options.String("due").pipe(Options.optional, Options.withDescription("Due date (YYYY-MM-DD).")),
		priority: Options.Int("priority").pipe(
			Options.optional,
			Options.withDescription("Sort priority; lower numbers come first (0–10000). Default 100."),
		),
		link: Options.String("link").pipe(
			Options.optional,
			Options.withDescription("http(s) link to the source (thread, doc, ticket)."),
		),
		project: Options.String("project").pipe(Options.optional, Options.withDescription("Optional project name.")),
	},
	({
		homeRoot,
		stateDir,
		tasksFile,
		title,
		owner,
		waitingOn,
		due,
		priority,
		link,
		project,
		endpoint,
		tokenFile,
		syncConfig,
	}) =>
		runAsync(async () => {
			const file = resolveFile(homeRoot, stateDir, tasksFile);
			const fields = {
				id: randomUUID(),
				title,
				owner: Option.getOrUndefined(owner) ?? null,
				waitingOn: Option.getOrUndefined(waitingOn) ?? null,
				due: Option.getOrUndefined(due) ?? null,
				link: Option.getOrUndefined(link) ?? null,
				project: Option.getOrUndefined(project) ?? null,
				...(Option.isSome(priority) ? { priority: Option.getOrUndefined(priority) } : {}),
			};
			const applied = await applyMutation({
				tasksFile: file,
				config: configFrom(endpoint, tokenFile, syncConfig),
				mutation: { op: "addFollowup", fields },
				applyLocal: (state) => state.addFollowup(fields),
			});
			const item =
				applied.mode === "queued"
					? applied.result
					: new TasksState(file).read().items.find((row) => row.id === fields.id);
			return { item, mode: applied.mode, revision: applied.revision };
		}),
);

export const jarvisFollowupListCommand = Command.make(
	"list",
	{
		...shared,
		view: Options.String("view").pipe(
			Options.withDefault("open"),
			Options.withDescription("open (default), overdue, resolved, or all. Open views sort by priority, then due."),
		),
		today: Options.String("today").pipe(
			Options.optional,
			Options.withDescription("Today for the overdue check (YYYY-MM-DD). Defaults to today in Africa/Lagos."),
		),
		localMeetings: localMeetingsOption,
	},
	({ homeRoot, stateDir, tasksFile, view, today, localMeetings, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
			const chosen = FOLLOWUP_VIEWS.find((entry) => entry === view.trim().toLowerCase());
			if (chosen === undefined) throw new TaskRefused("invalid_view");
			const day = Option.getOrUndefined(today) ?? lagosCalendarDate(new Date());
			if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new TaskRefused("invalid_due");
			const file = followupFile(homeRoot, stateDir, tasksFile, localMeetings);
			const config = configFrom(endpoint, tokenFile, syncConfig);
			// A pull would replace the local-only meeting store, so it is read as it is.
			if (config !== undefined && !isLocalMeetingStore(file)) {
				await Effect.runPromise(
					Effect.tryPromise({
						try: () => syncTasks({ tasksFile: file, config }),
						catch: (error) => error,
					}).pipe(Effect.result, Effect.asVoid),
				);
			}
			const items = followupsForView(new TasksState(file).read().items, chosen, day);
			const overdue = items.filter(
				(item) => item.status !== "done" && item.status !== "dropped" && item.due !== null && item.due < day,
			).length;
			return { view: chosen, today: day, count: items.length, overdue, items };
		}),
);

export const jarvisFollowupResolveCommand = Command.make(
	"resolve",
	{
		...shared,
		id: Options.String("id").pipe(Options.withDescription("Store UUID of the follow-up.")),
		note: Options.String("note").pipe(
			Options.optional,
			Options.withDescription("Resolution note, up to 500 characters."),
		),
		localMeetings: localMeetingsOption,
	},
	({ homeRoot, stateDir, tasksFile, id, note, localMeetings, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
			// `applyMutation` never syncs or queues the local-only meeting store.
			const file = followupFile(homeRoot, stateDir, tasksFile, localMeetings);
			const applied = await applyMutation({
				tasksFile: file,
				config: configFrom(endpoint, tokenFile, syncConfig),
				mutation: { op: "resolve", id, note: Option.getOrUndefined(note) ?? null },
				applyLocal: (state) => state.resolve(id, Option.getOrUndefined(note) ?? null),
			});
			const item =
				applied.mode === "queued" ? applied.result : new TasksState(file).read().items.find((row) => row.id === id);
			return { item, mode: applied.mode, revision: applied.revision };
		}),
);

export const jarvisFollowupCommand = Command.make("followup").pipe(
	Command.withDescription("Add, list (open, overdue, resolved) and resolve follow-ups in the local task store."),
	Command.withSubcommands([
		jarvisFollowupAddCommand,
		jarvisFollowupListCommand,
		jarvisFollowupResolveCommand,
	] as const),
);

export const jarvisTasksSyncCommand = Command.make(
	"sync",
	{ ...shared },
	({ homeRoot, stateDir, tasksFile, endpoint, tokenFile, syncConfig }) =>
		runAsync(async () => {
			const file = resolveFile(homeRoot, stateDir, tasksFile);
			const config = configFrom(endpoint, tokenFile, syncConfig);
			if (config === undefined) throw new TaskRefused("sync_unconfigured");
			return syncTasks({ tasksFile: file, config });
		}),
);

export const jarvisTasksCommand = Command.make("tasks").pipe(
	Command.withDescription(
		"List, ingest, add and close out local portal tasks (JSON in/out), and sync them with a hosted primary. Never writes source Markdown.",
	),
	Command.withSubcommands([
		jarvisTasksListCommand,
		jarvisTasksIngestCommand,
		jarvisTasksAddCommand,
		jarvisTasksOutcomeCommand,
		jarvisTasksCloseoutCommand,
		jarvisFollowupCommand,
		jarvisTasksSyncCommand,
	] as const),
);
