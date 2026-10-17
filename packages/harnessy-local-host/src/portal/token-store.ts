/**
 * The portal's own state directory and install token.
 *
 * The directory must be a real directory owned by this user with no group or
 * other access. The token file is created once with `O_EXCL|O_NOFOLLOW` and
 * mode 0600. The portal never reads another service's token or bootstrap file.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const PORTAL_TOKEN_FILE = "portal.token";
export const PORTAL_LOG_DIRECTORY = "logs";
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_TOKEN_FILE_BYTES = 128;

/** A refusal to start or to read portal state. `code` is fixed and content-free. */
export class PortalStateError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "PortalStateError";
		this.code = code;
	}
}

const currentUid = (): number => {
	const uid = process.geteuid?.();
	if (uid === undefined) throw new PortalStateError("unsupported_platform");
	return uid;
};

const assertPrivateDirectory = (path: string, uid: number): void => {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) throw new PortalStateError("state_dir_missing");
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PortalStateError("state_dir_unsafe");
	if (stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new PortalStateError("state_dir_unsafe");
};

/** A new random token: 32 bytes as base64url (43 characters). */
export const newPortalSecret = (): string => randomBytes(32).toString("base64url");

/**
 * Check, and with `create` make, the state directory and its log directory.
 * Only the last path component is created; its parent must already exist.
 */
export const preparePortalStateDir = (stateDir: string, options: { readonly create: boolean }): string => {
	if (!isAbsolute(stateDir)) throw new PortalStateError("state_dir_not_absolute");
	const root = resolve(stateDir);
	const uid = currentUid();
	if (options.create && lstatSync(root, { throwIfNoEntry: false }) === undefined) {
		try {
			mkdirSync(root, { mode: 0o700 });
		} catch {
			throw new PortalStateError("state_dir_missing");
		}
	}
	assertPrivateDirectory(root, uid);
	if (options.create) {
		const logs = join(root, PORTAL_LOG_DIRECTORY);
		if (lstatSync(logs, { throwIfNoEntry: false }) === undefined) mkdirSync(logs, { mode: 0o700 });
		assertPrivateDirectory(logs, uid);
	}
	return root;
};

const readTokenFile = (path: string, uid: number): string | undefined => {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new PortalStateError("token_unsafe");
	}
	try {
		const stat = fstatSync(descriptor);
		if (
			!stat.isFile() ||
			stat.uid !== uid ||
			(stat.mode & 0o077) !== 0 ||
			stat.nlink !== 1 ||
			stat.size > MAX_TOKEN_FILE_BYTES
		)
			throw new PortalStateError("token_unsafe");
		const bytes = Buffer.alloc(stat.size);
		const read = readSync(descriptor, bytes, 0, stat.size, 0);
		const token = bytes.subarray(0, read).toString("utf8").trim();
		if (!TOKEN.test(token)) throw new PortalStateError("token_invalid");
		return token;
	} finally {
		closeSync(descriptor);
	}
};

/** Read the install token of a prepared state directory. */
export const readPortalInstallToken = (stateDir: string): string => {
	const uid = currentUid();
	assertPrivateDirectory(resolve(stateDir), uid);
	const token = readTokenFile(join(resolve(stateDir), PORTAL_TOKEN_FILE), uid);
	if (token === undefined) throw new PortalStateError("token_missing");
	return token;
};

/** Read the install token, or create it once (mode 0600, exclusive, never through a symlink). */
export const readOrCreatePortalInstallToken = (stateDir: string): string => {
	const uid = currentUid();
	const path = join(resolve(stateDir), PORTAL_TOKEN_FILE);
	const existing = readTokenFile(path, uid);
	if (existing !== undefined) return existing;
	const token = newPortalSecret();
	let descriptor: number;
	try {
		descriptor = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
	} catch {
		throw new PortalStateError("token_unsafe");
	}
	try {
		writeSync(descriptor, `${token}\n`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	return token;
};
