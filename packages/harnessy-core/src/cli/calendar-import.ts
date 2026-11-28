import { homedir } from "node:os";
import { Console, Option } from "effect";
import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";
import { recordConsent } from "../jarvis/calendar-import/consent.ts";
import { calendarImportPaths, runCalendarImport } from "../jarvis/calendar-import/run.ts";
import { renderCalendarImportPlist } from "../jarvis/calendar-import/schedule.ts";

const failure = (message: string) => (cause: unknown) => (cause instanceof Error ? cause : new Error(message));

export const calendarImportCommand = Command.make(
	"import",
	{
		googleExecutable: Flag.String("google-executable").pipe(
			Flag.withDescription("Absolute path of the native gws binary (not the npm launcher)."),
		),
		accounts: Flag.String("account").pipe(
			Flag.between(0, 12),
			Flag.withDescription("gws slug to read. Repeat for more. Default: every consented slug."),
		),
		dryRun: Flag.Boolean("dry-run").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Read and print counts only. Write no importer state."),
		),
		actions: Flag.String("actions").pipe(
			Flag.optional,
			Flag.withDescription("Owner-only JSON of action descriptors for candidate proposals."),
		),
	},
	({ googleExecutable, accounts, dryRun, actions }) =>
		Effect.tryPromise({
			try: () =>
				runCalendarImport({
					home: homedir(),
					googleExecutable,
					...(accounts.length > 0 ? { accounts } : {}),
					dryRun,
					...(Option.isSome(actions) ? { descriptorsPath: actions.value } : {}),
				}),
			catch: failure("Calendar import failed"),
		}).pipe(
			Effect.flatMap((report) =>
				Console.log(JSON.stringify({ command: "jarvis calendar import", ...report }, null, 2)),
			),
		),
).pipe(
	Command.withDescription(
		"Read consented Google calendars read-only and store only opaque keys, flags and timestamps",
	),
);

export const calendarConsentCommand = Command.make(
	"import-consent",
	{
		slugs: Flag.String("slug").pipe(Flag.between(1, 12)),
		consentedAt: Flag.String("consented-at"),
		consentedBy: Flag.Literals("consented-by", ["julian"]),
		method: Flag.Literals("method", ["voice", "written"]),
	},
	({ slugs, consentedAt, consentedBy, method }) =>
		Effect.try({
			try: () => {
				const records = slugs.map((slug) => ({
					slug,
					scope: "calendar.read" as const,
					consentedAt,
					consentedBy,
					method,
				}));
				const all = recordConsent(calendarImportPaths(homedir()).consent, records);
				return { recorded: records.length, consented: [...all.keys()].sort() };
			},
			catch: failure("Calendar consent could not be recorded"),
		}).pipe(
			Effect.flatMap((result) =>
				Console.log(JSON.stringify({ command: "jarvis calendar import-consent", ...result }, null, 2)),
			),
		),
).pipe(Command.withDescription("Record a person's per-account consent for the read-only calendar importer"));

export const calendarImportScheduleCommand = Command.make(
	"import-schedule",
	{
		nodePath: Flag.String("node"),
		cliPath: Flag.String("cli"),
		googleExecutable: Flag.String("google-executable"),
	},
	({ nodePath, cliPath, googleExecutable }) =>
		Effect.try({
			try: () => renderCalendarImportPlist({ nodePath, cliPath, googleExecutable, home: homedir() }),
			catch: failure("Calendar import schedule could not be rendered"),
		}).pipe(Effect.flatMap((plist) => Console.log(plist))),
).pipe(Command.withDescription("Print the launchd job definition for the importer. It writes and loads nothing"));
