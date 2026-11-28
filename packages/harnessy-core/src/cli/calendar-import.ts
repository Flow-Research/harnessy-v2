import { homedir } from "node:os";
import { join } from "node:path";
import { Console, Option } from "effect";
import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";
import { gwsCalendarReader } from "../jarvis/calendar-import/gws-reader.ts";
import { CalendarImportError } from "../jarvis/calendar-import/keys.ts";
import { recordAccountConsent, runCalendarImport } from "../jarvis/calendar-import/run.ts";
import { renderCalendarImportPlist } from "../jarvis/calendar-import/schedule.ts";

/**
 * Only fixed importer messages pass through. A parser, file system or provider
 * message could quote file content or an address, and this command's output and
 * errors go to the launchd log.
 */
const safeFailure = (fallback: string) => (cause: unknown) =>
	cause instanceof CalendarImportError ? new CalendarImportError(cause.message) : new CalendarImportError(fallback);

const executableFlags = {
	googleExecutable: Flag.String("google-executable").pipe(
		Flag.withDescription("Absolute path of the native gws binary (not the npm launcher)."),
	),
	googleExecutableSha256: Flag.String("google-executable-sha256").pipe(
		Flag.withDescription("SHA-256 of that binary, approved when the job was installed."),
	),
};

export const calendarImportCommand = Command.make(
	"import",
	{
		...executableFlags,
		accounts: Flag.String("account").pipe(
			Flag.between(0, 12),
			Flag.withDescription("Opaque account label to read (dry run only). Repeat for more."),
		),
		dryRun: Flag.Boolean("dry-run").pipe(
			Flag.withDefault(false),
			Flag.withDescription("Read and print counts only. Write no importer state."),
		),
		actions: Flag.String("actions").pipe(
			Flag.optional,
			Flag.withDescription("Owner-only JSON of action descriptors for candidates and task links."),
		),
	},
	({ googleExecutable, googleExecutableSha256, accounts, dryRun, actions }) =>
		Effect.tryPromise({
			try: () =>
				runCalendarImport({
					home: homedir(),
					googleExecutable,
					googleExecutableSha256,
					...(accounts.length > 0 ? { accounts } : {}),
					dryRun,
					...(Option.isSome(actions) ? { descriptorsPath: actions.value } : {}),
				}),
			catch: safeFailure("Calendar import failed"),
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
		slug: Flag.String("slug").pipe(Flag.withDescription("gws folder name. It is stored only as a keyed hash.")),
		consentedAt: Flag.String("consented-at"),
		consentedBy: Flag.Literals("consented-by", ["julian"]),
		method: Flag.Literals("method", ["voice", "written"]),
		approvedIdentityPrefix: Flag.String("approved-identity-sha256-prefix").pipe(
			Flag.optional,
			Flag.withDescription(
				"SHA-256 prefix of the primary calendar ID from the approved read-permission check. Without it the account stays unbound.",
			),
		),
		googleExecutable: executableFlags.googleExecutable.pipe(Flag.optional),
		googleExecutableSha256: executableFlags.googleExecutableSha256.pipe(Flag.optional),
	},
	({ slug, consentedAt, consentedBy, method, approvedIdentityPrefix, googleExecutable, googleExecutableSha256 }) =>
		Effect.tryPromise({
			try: () => {
				const home = homedir();
				if (Option.isNone(approvedIdentityPrefix))
					return recordAccountConsent(home, slug, { consentedAt, consentedBy, method });
				if (Option.isNone(googleExecutable) || Option.isNone(googleExecutableSha256))
					throw new CalendarImportError(
						"Binding an identity needs --google-executable and --google-executable-sha256",
					);
				const read = gwsCalendarReader(
					googleExecutable.value,
					googleExecutableSha256.value,
					join(home, ".config", `gws-${slug}`),
				);
				return recordAccountConsent(
					home,
					slug,
					{ consentedAt, consentedBy, method },
					{
						read,
						approvedIdentityPrefix: approvedIdentityPrefix.value,
					},
				);
			},
			catch: safeFailure("Calendar consent could not be recorded"),
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
		...executableFlags,
	},
	({ nodePath, cliPath, googleExecutable, googleExecutableSha256 }) =>
		Effect.try({
			try: () =>
				renderCalendarImportPlist({ nodePath, cliPath, googleExecutable, googleExecutableSha256, home: homedir() }),
			catch: safeFailure("Calendar import schedule could not be rendered"),
		}).pipe(Effect.flatMap((plist) => Console.log(plist))),
).pipe(Command.withDescription("Print the launchd job definition for the importer. It writes and loads nothing"));
