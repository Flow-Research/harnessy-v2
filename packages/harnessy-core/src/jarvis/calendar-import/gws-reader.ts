import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { CalendarImportError } from "./keys.ts";

const execute = promisify(execFile);

/** Why a read failed. The provider message is never kept: it can echo request or account data. */
export type ReadFailure = "auth" | "scope" | "failed";

export class CalendarReadError extends CalendarImportError {
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

/** Refuse anything other than `calendar <read-only method> --params <json>` on `primary`. */
export function assertReadOnlyCall(args: readonly string[]): void {
	if (
		args.length !== 5 ||
		args[0] !== "calendar" ||
		!READ_ONLY_METHODS.has(`${args[1]} ${args[2]}`) ||
		args[3] !== "--params"
	)
		throw new CalendarImportError("Refused: the calendar importer allows only read-only calendar calls");
	let params: unknown;
	try {
		params = JSON.parse(args[4] ?? "");
	} catch {
		throw new CalendarImportError("Refused: calendar call parameters must be JSON");
	}
	if (typeof params !== "object" || params === null || Array.isArray(params))
		throw new CalendarImportError("Refused: calendar call parameters must be an object");
	if ((params as Record<string, unknown>).calendarId !== "primary")
		throw new CalendarImportError("Refused: the calendar importer reads only the primary calendar");
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

// Mach-O (thin and fat, both byte orders) and ELF headers. A script of any kind
// starts another program that the digest does not cover, so it is refused.
const NATIVE_MAGIC = ["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "bebafeca", "7f454c46"];
const SHA256 = /^[a-f0-9]{64}$/u;

const digestOf = (path: string) => {
	const bytes = readFileSync(path);
	return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
};

/**
 * A read-only runner for one gws configuration folder. The caller supplies the
 * approved SHA-256 of the native gws binary, recorded by a person when the job is
 * installed. The file is compared with that digest when the reader is built and
 * again before every execution, so a replacement between runs is refused.
 */
export function gwsCalendarReader(executable: string, approvedSha256: string, configDirectory: string): CalendarRead {
	if (!isAbsolute(executable) || !isAbsolute(configDirectory))
		throw new CalendarImportError("Explicit absolute Google executable and configuration directory required");
	if (!SHA256.test(approvedSha256))
		throw new CalendarImportError("The approved Google executable SHA-256 must be 64 lowercase hex characters");
	let command: string;
	let config: string;
	try {
		command = realpathSync(executable);
		config = realpathSync(configDirectory);
	} catch {
		throw new CalendarImportError("Google executable or configuration directory does not exist");
	}
	const directory = lstatSync(config);
	if (
		!directory.isDirectory() ||
		(directory.mode & 0o077) !== 0 ||
		(process.geteuid !== undefined && directory.uid !== process.geteuid())
	)
		throw new CalendarImportError("Google configuration directory must be owner-only");
	const first = digestOf(command);
	if (!NATIVE_MAGIC.includes(first.bytes.subarray(0, 4).toString("hex")))
		throw new CalendarImportError("Google executable must be the native gws binary");
	if (first.digest !== approvedSha256)
		throw new CalendarImportError("Google executable does not match the approved SHA-256");
	return async (args) => {
		assertReadOnlyCall(args);
		if (digestOf(command).digest !== approvedSha256)
			throw new CalendarImportError("Google executable does not match the approved SHA-256");
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
