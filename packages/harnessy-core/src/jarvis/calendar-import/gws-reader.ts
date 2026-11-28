import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Why a read failed. The provider message is never kept: it can echo request or account data. */
export type ReadFailure = "auth" | "scope" | "failed";

export class CalendarReadError extends Error {
	readonly reason: ReadFailure;
	constructor(reason: ReadFailure) {
		super(`Google calendar read failed (${reason}); provider output withheld`);
		this.reason = reason;
	}
}

/** One read call. `args` exclude the executable and `--format json`. */
export type CalendarRead = (args: readonly string[]) => Promise<Record<string, unknown>>;

// The only methods this importer may call. Every write, watch, ACL and settings
// method is absent, so a coding error cannot reach one.
const READ_ONLY_METHODS = new Set(["events list", "calendars get"]);

/** Refuse anything other than `calendar <read-only method> --params <json>`. */
export function assertReadOnlyCall(args: readonly string[]): void {
	if (
		args.length !== 5 ||
		args[0] !== "calendar" ||
		!READ_ONLY_METHODS.has(`${args[1]} ${args[2]}`) ||
		args[3] !== "--params"
	)
		throw new Error("Refused: the calendar importer allows only read-only calendar calls");
	const params: unknown = JSON.parse(args[4] ?? "");
	if (typeof params !== "object" || params === null || Array.isArray(params))
		throw new Error("Refused: calendar call parameters must be an object");
	if ((params as Record<string, unknown>).calendarId !== "primary")
		throw new Error("Refused: the calendar importer reads only the primary calendar");
}

const failureOf = (stdout: unknown): ReadFailure => {
	try {
		const value: unknown = JSON.parse(String(stdout ?? ""));
		const code =
			typeof value === "object" && value !== null && "error" in value
				? (value.error as { code?: unknown }).code
				: undefined;
		return code === 401 ? "auth" : code === 403 ? "scope" : "failed";
	} catch {
		return "failed";
	}
};

/**
 * A read-only runner for one gws configuration folder. It reuses the hardening of
 * `calendar/gws-provider.ts`: absolute pinned executable, owner-only configuration
 * folder, ambient token overrides removed, no login, and output withheld on failure.
 */
export function gwsCalendarReader(executable: string, configDirectory: string): CalendarRead {
	if (!isAbsolute(executable) || !isAbsolute(configDirectory))
		throw new Error("Explicit absolute Google executable and configuration directory required");
	const command = realpathSync(executable);
	const config = realpathSync(configDirectory);
	const directory = lstatSync(config);
	if (
		!directory.isDirectory() ||
		(directory.mode & 0o077) !== 0 ||
		(process.geteuid !== undefined && directory.uid !== process.geteuid())
	)
		throw new Error("Google configuration directory must be owner-only");
	const bytes = readFileSync(command);
	// The npm `gws` entry (`#!/usr/bin/env node`) finds Node on PATH and starts a second
	// binary. A pin on that launcher would not cover the code that runs, so it is refused.
	if (bytes.subarray(0, 14).toString("latin1") === "#!/usr/bin/env")
		throw new Error("Google executable must be the native gws binary, not the npm launcher");
	const digest = createHash("sha256").update(bytes).digest("hex");
	return async (args) => {
		assertReadOnlyCall(args);
		if (createHash("sha256").update(readFileSync(command)).digest("hex") !== digest)
			throw new Error("Google executable changed");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			GOOGLE_WORKSPACE_CLI_CONFIG_DIR: config,
			GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: process.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND ?? "file",
		};
		delete env.GOOGLE_WORKSPACE_CLI_TOKEN;
		delete env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE;
		let stdout: string;
		try {
			const result = await execute(command, [...args, "--format", "json"], {
				env,
				timeout: 60_000,
				maxBuffer: 16 * 1024 * 1024,
				encoding: "utf8",
				shell: false,
			});
			stdout = result.stdout;
		} catch (cause) {
			throw new CalendarReadError(
				failureOf(typeof cause === "object" && cause !== null && "stdout" in cause ? cause.stdout : undefined),
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(stdout);
		} catch {
			throw new CalendarReadError("failed");
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CalendarReadError("failed");
		if ("error" in value) throw new CalendarReadError(failureOf(stdout));
		return value as Record<string, unknown>;
	};
}
