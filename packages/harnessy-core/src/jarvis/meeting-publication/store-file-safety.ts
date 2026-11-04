import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";

import * as Result from "effect/Result";

export class MeetingPublicationStoreFileSafetyError extends Error {
	readonly code: "unsafe_state" | "schema_invalid";

	constructor(code: "unsafe_state" | "schema_invalid") {
		super("Meeting publication store file safety contract failed");
		this.name = "MeetingPublicationStoreFileSafetyError";
		this.code = code;
	}
}

export const meetingPublicationModeOf = (mode: number) => (process.platform === "win32" ? null : mode & 0o777);

export const meetingPublicationSqliteSidecarPaths = (dbPath: string) =>
	[`${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`] as const;

export const assertMeetingPublicationSqliteSidecarsAbsent = (dbPath: string) => {
	for (const path of meetingPublicationSqliteSidecarPaths(dbPath)) {
		const entry = Result.try({ try: () => lstatSync(path), catch: (cause) => cause as NodeJS.ErrnoException });
		if (Result.isSuccess(entry) || entry.failure.code !== "ENOENT") {
			throw new MeetingPublicationStoreFileSafetyError("unsafe_state");
		}
	}
};

const sameStableIdentity = (left: BigIntStats, right: BigIntStats) =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.nlink === right.nlink &&
	left.mode === right.mode &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs &&
	left.ctimeNs === right.ctimeNs;

export const assertMeetingPublicationDatabasePathStable = (dbPath: string, expected?: BigIntStats) => {
	const pathStat = lstatSync(dbPath, { bigint: true });
	if (
		!pathStat.isFile() ||
		pathStat.isSymbolicLink() ||
		pathStat.nlink !== 1n ||
		realpathSync(dbPath) !== dbPath ||
		(meetingPublicationModeOf(Number(pathStat.mode)) !== null &&
			meetingPublicationModeOf(Number(pathStat.mode)) !== 0o600) ||
		(expected !== undefined && !sameStableIdentity(pathStat, expected))
	) {
		throw new MeetingPublicationStoreFileSafetyError("unsafe_state");
	}
	return pathStat;
};

/**
 * Validate a clean, owner-only rollback-journal SQLite file without opening it
 * through SQLite. Access time is intentionally excluded from stable identity.
 */
export const assertMeetingPublicationRollbackDatabaseFile = (dbPath: string, expected?: BigIntStats) => {
	assertMeetingPublicationSqliteSidecarsAbsent(dbPath);
	const pathStat = assertMeetingPublicationDatabasePathStable(dbPath, expected);

	let descriptor: number | null = null;
	try {
		descriptor = openSync(dbPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const descriptorStat = fstatSync(descriptor, { bigint: true });
		if (!descriptorStat.isFile() || descriptorStat.nlink !== 1n || !sameStableIdentity(descriptorStat, pathStat)) {
			throw new MeetingPublicationStoreFileSafetyError("unsafe_state");
		}
		const header = Buffer.alloc(100);
		if (readSync(descriptor, header, 0, header.byteLength, 0) !== header.byteLength) {
			throw new MeetingPublicationStoreFileSafetyError("schema_invalid");
		}
		if (!header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
			throw new MeetingPublicationStoreFileSafetyError("schema_invalid");
		}
		if (header[18] !== 1 || header[19] !== 1) {
			throw new MeetingPublicationStoreFileSafetyError("unsafe_state");
		}
	} finally {
		if (descriptor !== null) closeSync(descriptor);
	}
	return pathStat;
};
