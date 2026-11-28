/**
 * A lock file owned by one process.
 *
 * The file holds the owner's process id, host name and a random token. Age
 * alone never makes a lock free: another process takes it over only when the
 * owner's process on this host has exited. A release removes the file only
 * while it still carries the owner's token, so an old owner never removes a
 * newer lock. A lock from another host is never taken over automatically.
 *
 * A lock file without a readable owner (an older version wrote empty files,
 * or a writer stopped before it wrote the owner) is treated as left over when
 * it is older than `unreadableAfterMs`.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import process from "node:process";

import * as Result from "effect/Result";

export interface LockOwner {
	readonly pid: number;
	readonly host: string;
	readonly token: string;
	readonly takenAt: string;
}

export type ReleaseLock = () => void;

const DEFAULT_UNREADABLE_AFTER_MS = 10 * 60 * 1000;

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** The owner in a lock file, or null when the file is missing, empty or not an owner record. */
export const readLockOwner = (lockPath: string): LockOwner | null => {
	const text = Result.try(() => readFileSync(lockPath, "utf8"));
	if (Result.isFailure(text)) return null;
	const parsed = Result.try((): unknown => JSON.parse(text.success));
	if (Result.isFailure(parsed)) return null;
	const value = parsed.success as Partial<LockOwner> | null;
	return value !== null &&
		typeof value === "object" &&
		Number.isSafeInteger(value.pid) &&
		typeof value.host === "string" &&
		typeof value.token === "string" &&
		typeof value.takenAt === "string"
		? (value as LockOwner)
		: null;
};

/** True only when the owner's process is known to have exited. */
export const lockOwnerExited = (owner: LockOwner): boolean => {
	if (owner.host !== hostname()) return false;
	if (owner.pid === process.pid) return false;
	const probe = Result.try(() => process.kill(owner.pid, 0));
	return Result.isFailure(probe) && errorCode(probe.failure) === "ESRCH";
};

const writeOwner = (lockPath: string, owner: LockOwner): boolean => {
	const opened = Result.try(() => openSync(lockPath, "wx", 0o600));
	if (Result.isFailure(opened)) {
		if (errorCode(opened.failure) === "EEXIST") return false;
		throw opened.failure;
	}
	try {
		writeFileSync(opened.success, `${JSON.stringify(owner)}\n`);
		fsyncSync(opened.success);
	} finally {
		closeSync(opened.success);
	}
	return true;
};

/**
 * Move a left-over lock aside. Only one process can rename it. When the moved
 * file is not the one judged left over (another process replaced it between
 * the read and the rename), it is put back.
 */
const clearLeftOver = (lockPath: string, judged: LockOwner | null): void => {
	const aside = `${lockPath}.stale-${randomUUID()}`;
	const moved = Result.try(() => renameSync(lockPath, aside));
	if (Result.isFailure(moved)) return;
	const owner = readLockOwner(aside);
	if ((owner?.token ?? null) !== (judged?.token ?? null)) Result.try(() => linkSync(aside, lockPath));
	Result.try(() => unlinkSync(aside));
};

/**
 * Take the lock, or return null when a live process holds it. The release
 * function removes the file only while it still names this owner.
 */
export const tryProcessLock = (
	lockPath: string,
	options: { readonly unreadableAfterMs?: number; readonly now?: () => number } = {},
): ReleaseLock | null => {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	const now = options.now ?? Date.now;
	const unreadableAfterMs = options.unreadableAfterMs ?? DEFAULT_UNREADABLE_AFTER_MS;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const owner: LockOwner = {
			pid: process.pid,
			host: hostname(),
			token: randomUUID(),
			takenAt: new Date(now()).toISOString(),
		};
		if (writeOwner(lockPath, owner))
			return () => {
				if (readLockOwner(lockPath)?.token === owner.token) Result.try(() => unlinkSync(lockPath));
			};
		const holder = readLockOwner(lockPath);
		if (holder !== null) {
			if (!lockOwnerExited(holder)) return null;
		} else {
			const age = Result.try(() => now() - statSync(lockPath).mtimeMs);
			if (Result.isFailure(age)) continue;
			if (age.success < unreadableAfterMs) return null;
		}
		clearLeftOver(lockPath, holder);
	}
	return null;
};
