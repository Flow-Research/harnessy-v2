import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import * as Result from "effect/Result";
import { CalendarImportError } from "./keys.ts";

/**
 * One size limit for every importer file, on read and on write. The writer refuses
 * a larger file before it replaces anything, so a run cannot leave a file that the
 * next run is unable to read.
 */
export const OWNER_FILE_MAX_BYTES = 16 * 1024 * 1024;

const ownedByMe = (uid: number) => process.geteuid === undefined || uid === process.geteuid();

/** Return the value, or throw the fixed importer error when the call threw. */
const orFail = <A>(result: Result.Result<A, unknown>, message: string): A => {
	if (Result.isFailure(result)) throw new CalendarImportError(message);
	return result.success;
};

/** Create the directory as 0700 and refuse an existing directory that others can read or that is a link. */
export function ensureOwnerDirectory(directory: string): void {
	orFail(
		Result.try(() => mkdirSync(directory, { recursive: true, mode: 0o700 })),
		"Calendar importer state directory could not be created",
	);
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || !ownedByMe(stat.uid))
		throw new CalendarImportError("Calendar importer state directory must be an owner-only directory");
}

/**
 * Read an owner-only (0600) regular file without following a link. Returns
 * undefined when it does not exist. `role` names the file in fixed error text.
 */
export function readOwnerFile(path: string, role: string): string | undefined {
	const opened = Result.try(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW));
	if (Result.isFailure(opened)) {
		if ((opened.failure as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new CalendarImportError(`Calendar importer ${role} could not be opened`);
	}
	const descriptor = opened.success;
	const loaded = Result.try(() => {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || !ownedByMe(stat.uid))
			throw new CalendarImportError(`Calendar importer ${role} must be an owner-only regular file`);
		if (stat.size > OWNER_FILE_MAX_BYTES) throw new CalendarImportError(`Calendar importer ${role} is too large`);
		return readFileSync(descriptor, "utf8");
	});
	closeSync(descriptor);
	if (Result.isFailure(loaded)) {
		if (loaded.failure instanceof CalendarImportError) throw loaded.failure;
		throw new CalendarImportError(`Calendar importer ${role} could not be read`);
	}
	return loaded.success;
}

/** Read and validate an owner-only JSON file. Parse and schema errors become fixed text. */
export function readOwnerJson<T>(path: string, role: string, parse: (value: unknown) => T): T | undefined {
	const text = readOwnerFile(path, role);
	if (text === undefined) return undefined;
	return orFail(
		Result.try(() => parse(JSON.parse(text))),
		`Calendar importer ${role} is not valid`,
	);
}

/** Write an owner-only (0600) file atomically inside an owner-only directory. */
export function writeOwnerFile(path: string, content: string, role: string): void {
	if (Buffer.byteLength(content, "utf8") > OWNER_FILE_MAX_BYTES)
		throw new CalendarImportError(`Calendar importer ${role} would be too large; the previous file is kept`);
	ensureOwnerDirectory(dirname(path));
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	orFail(
		Result.try(() => {
			writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			renameSync(temporary, path);
		}),
		`Calendar importer ${role} could not be written`,
	);
}

/** The local HMAC key for opaque keys. It is created once and never leaves the Mac. */
export function readOrCreateSalt(path: string): Buffer {
	const existing = readSalt(path);
	if (existing !== undefined) return existing;
	const salt = randomBytes(32);
	ensureOwnerDirectory(dirname(path));
	// "wx" refuses to replace a salt that another run created after the read above.
	orFail(
		Result.try(() => writeFileSync(path, `${salt.toString("hex")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })),
		"Calendar importer salt could not be created",
	);
	return salt;
}

export function readSalt(path: string): Buffer | undefined {
	const existing = readOwnerFile(path, "salt");
	if (existing === undefined) return undefined;
	const value = Buffer.from(existing.trim(), "hex");
	if (value.length !== 32) throw new CalendarImportError("Calendar importer salt is damaged");
	return value;
}
