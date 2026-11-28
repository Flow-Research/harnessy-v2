import { homedir } from "node:os";
import { join } from "node:path";
import { Console } from "effect";
import { Command, Flag } from "effect/cli";
import * as Effect from "effect/Effect";
import { gwsCalendarReader } from "../jarvis/calendar-import/gws-reader.ts";
import { CalendarImportError } from "../jarvis/calendar-import/keys.ts";
import {
	enrollAccount,
	readExpectedPrimaryId,
	recordAccountConsent,
	runCalendarImport,
} from "../jarvis/calendar-import/run.ts";
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
	},
	// Action descriptors always come from the owner-only `actions.json` in the state
	// folder, so a scheduled refresh uses the same input as a manual run.
	({ googleExecutable, googleExecutableSha256, accounts, dryRun }) =>
		Effect.tryPromise({
			try: () =>
				runCalendarImport({
					home: homedir(),
					googleExecutable,
					googleExecutableSha256,
					...(accounts.length > 0 ? { accounts } : {}),
					dryRun,
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

const consentFlags = {
	slug: Flag.String("slug").pipe(Flag.withDescription("gws folder name. It is stored only as a keyed hash.")),
	consentedAt: Flag.String("consented-at"),
	consentedBy: Flag.Literals("consented-by", ["julian"]),
	method: Flag.Literals("method", ["voice", "written"]),
};

export const calendarEnrollCommand = Command.make(
	"import-enroll",
	{
		...consentFlags,
		expectedIdFile: Flag.String("expected-id-file").pipe(
			Flag.withDescription(
				"Owner-only (0600) file with the intended primary calendar ID, or - for standard input. Never pass the ID itself as an argument.",
			),
		),
		...executableFlags,
	},
	// One metadata call. The ID read from Google is compared in memory with the
	// intended ID; consent is bound only on equality. Neither ID is printed or stored.
	({ slug, consentedAt, consentedBy, method, expectedIdFile, googleExecutable, googleExecutableSha256 }) =>
		Effect.tryPromise({
			try: () => {
				const home = homedir();
				const expected = readExpectedPrimaryId(expectedIdFile);
				const read = gwsCalendarReader(
					googleExecutable,
					googleExecutableSha256,
					join(home, ".config", `gws-${slug}`),
				);
				return enrollAccount(home, slug, { consentedAt, consentedBy, method }, read, expected);
			},
			catch: safeFailure("Calendar enrollment failed"),
		}).pipe(
			Effect.flatMap((result) =>
				result.matches
					? Console.log(JSON.stringify({ command: "jarvis calendar import-enroll", ...result }, null, 2))
					: Effect.fail(
							new CalendarImportError(
								`The primary calendar does not match the intended ID; nothing was recorded (account ${result.account})`,
							),
						),
			),
		),
).pipe(
	Command.withDescription(
		"Bind consent to an account only when its primary calendar equals the intended ID that the operator supplies privately",
	),
);

export const calendarConsentCommand = Command.make(
	"import-consent",
	consentFlags,
	// Records consent without an identity. The account stays unbound, and is never
	// read, until import-enroll binds it.
	({ slug, consentedAt, consentedBy, method }) =>
		Effect.try({
			try: () => recordAccountConsent(homedir(), slug, { consentedAt, consentedBy, method }),
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
