import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";
import type { CalendarProvider, CalendarReceiptReader } from "./apply.ts";

const execute = promisify(execFile);

/** Reuse the existing configured Google CLI; never export tokens or initiate login. */
export const gwsCalendarProvider = (
	executable: string,
	configDirectory: string,
	account: string,
): CalendarProvider & CalendarReceiptReader => {
	if (!isAbsolute(executable) || !isAbsolute(configDirectory) || !/^[^\s@]+@[^\s@]+$/.test(account))
		throw new Error("Explicit Google executable, configuration directory and account required");
	const command = realpathSync(executable);
	const config = realpathSync(configDirectory);
	const directory = lstatSync(config);
	if (
		!directory.isDirectory() ||
		(directory.mode & 0o077) !== 0 ||
		(process.geteuid !== undefined && directory.uid !== process.geteuid())
	)
		throw new Error("Google configuration directory must be owner-only");
	const digest = createHash("sha256").update(readFileSync(command)).digest("hex");
	const call = async (args: Array<string>): Promise<Record<string, unknown>> => {
		if (createHash("sha256").update(readFileSync(command)).digest("hex") !== digest)
			throw new Error("Google executable changed");
		return Effect.runPromise(
			Effect.tryPromise({
				try: async () => {
					// These overrides take precedence over CONFIG_DIR in gws. The
					// approved binding must use that directory, not an ambient login.
					const env: NodeJS.ProcessEnv = { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config };
					delete env.GOOGLE_WORKSPACE_CLI_TOKEN;
					delete env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
					const result = await execute(command, [...args, "--format", "json"], {
						env,
						timeout: 30_000,
						maxBuffer: 1_048_576,
						encoding: "utf8",
						shell: false,
					});
					const value: unknown = JSON.parse(result.stdout);
					if (typeof value !== "object" || value === null || Array.isArray(value))
						throw new Error("Invalid result");
					return value as Record<string, unknown>;
				},
				catch: () => new Error("Google calendar command failed; provider output withheld"),
			}),
		);
	};
	return {
		binding: JSON.stringify({ kind: "gws-primary-calendar", command, digest, config, account }),
		verifyIdentity: async () => {
			const result = await call([
				"calendar",
				"calendars",
				"get",
				"--params",
				JSON.stringify({ calendarId: "primary" }),
			]);
			if (result.id !== account) throw new Error("Google primary calendar does not match the approved account");
		},
		createEvent: async (block, requestId) => {
			const result = await call([
				"calendar",
				"events",
				"insert",
				"--params",
				JSON.stringify({ calendarId: account }),
				"--json",
				JSON.stringify({
					id: requestId,
					summary: `Jarvis: ${block.task_title}`,
					start: { dateTime: block.start },
					end: { dateTime: block.end },
					description: `Task ID: ${block.task_id}\nReason: ${block.reason}`,
				}),
			]);
			if (result.id !== requestId) throw new Error("Google did not confirm the exact requested event identity");
			return requestId;
		},
		verifyEvent: async (block, requestId) => {
			const result = await call([
				"calendar",
				"events",
				"get",
				"--params",
				JSON.stringify({ calendarId: account, eventId: requestId }),
			]);
			const start = result.start;
			const end = result.end;
			return (
				result.id === requestId &&
				result.status === "confirmed" &&
				result.summary === `Jarvis: ${block.task_title}` &&
				result.description === `Task ID: ${block.task_id}\nReason: ${block.reason}` &&
				typeof start === "object" &&
				start !== null &&
				"dateTime" in start &&
				typeof start.dateTime === "string" &&
				typeof end === "object" &&
				end !== null &&
				"dateTime" in end &&
				typeof end.dateTime === "string" &&
				Date.parse(start.dateTime) === Date.parse(block.start) &&
				Date.parse(end.dateTime) === Date.parse(block.end)
			);
		},
	};
};
