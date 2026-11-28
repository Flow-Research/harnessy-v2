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

/** Calendar importer state is small. A larger file is refused, not parsed. */
export const OWNER_FILE_MAX_BYTES = 4 * 1024 * 1024;

const ownedByMe = (uid: number) => process.geteuid === undefined || uid === process.geteuid();

/** Create the directory as 0700 and refuse an existing directory that others can read or that is a link. */
export function ensureOwnerDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = lstatSync(directory);
	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || !ownedByMe(stat.uid))
		throw new Error("Calendar importer state directory must be an owner-only directory");
}

/** Read an owner-only (0600) regular file without following a link. Returns undefined when it does not exist. */
export function readOwnerFile(path: string): string | undefined {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
		throw new Error("Calendar importer state file could not be opened");
	}
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile() || (stat.mode & 0o077) !== 0 || !ownedByMe(stat.uid))
			throw new Error("Calendar importer state file must be an owner-only regular file");
		if (stat.size > OWNER_FILE_MAX_BYTES) throw new Error("Calendar importer state file is too large");
		return readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}

/** Write an owner-only (0600) file atomically inside an owner-only directory. */
export function writeOwnerFile(path: string, content: string): void {
	ensureOwnerDirectory(dirname(path));
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
	renameSync(temporary, path);
}

/** The local HMAC key for opaque event keys. It is created once and never leaves the Mac. */
export function readOrCreateSalt(path: string): Buffer {
	const existing = readOwnerFile(path);
	if (existing !== undefined) {
		const value = Buffer.from(existing.trim(), "hex");
		if (value.length !== 32) throw new Error("Calendar importer salt is damaged");
		return value;
	}
	const salt = randomBytes(32);
	ensureOwnerDirectory(dirname(path));
	// "wx" refuses to replace a salt that another run created after the read above.
	writeFileSync(path, `${salt.toString("hex")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	return salt;
}
