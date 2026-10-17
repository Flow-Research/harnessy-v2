/** Bounded, no-follow file and directory reads for the portal read model. */
import { closeSync, constants, type Dirent, fstatSync, lstatSync, opendirSync, openSync, readSync } from "node:fs";

import { ReadModelStateError } from "./tile.ts";

export interface BoundedFile {
	readonly bytes: Buffer;
	readonly size: number;
	readonly modifiedAt: Date;
	readonly truncated: boolean;
}

/**
 * Read at most `maxBytes` of a regular file, from its start or (with `tail`) its end.
 * An absent file is `missing`; a symbolic link or a non-file is `unsafe`.
 */
export const readBoundedFile = (path: string, maxBytes: number, tail = false): BoundedFile => {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) throw new ReadModelStateError("missing", "file_missing");
	if (stat.isSymbolicLink() || !stat.isFile()) throw new ReadModelStateError("unsafe", "file_not_regular");
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(descriptor);
		if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new ReadModelStateError("unsafe", "file_replaced");
		const length = Math.min(opened.size, maxBytes);
		const bytes = Buffer.alloc(length);
		const read = readSync(descriptor, bytes, 0, length, tail ? opened.size - length : 0);
		return {
			bytes: bytes.subarray(0, read),
			size: opened.size,
			modifiedAt: opened.mtime,
			truncated: opened.size > maxBytes,
		};
	} finally {
		closeSync(descriptor);
	}
};

export interface BoundedDirectory {
	readonly entries: ReadonlyArray<Dirent>;
	/** More entries exist than were read. */
	readonly truncated: boolean;
}

/** List at most `maxEntries` entries of a real directory without sorting the whole directory in memory. */
export const readBoundedDirectory = (path: string, maxEntries: number, followRoot = false): BoundedDirectory => {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	if (stat === undefined) throw new ReadModelStateError("missing", "directory_missing");
	if (stat.isSymbolicLink() && !followRoot) throw new ReadModelStateError("unsafe", "directory_symlink");
	const directory = opendirSync(path);
	try {
		const entries: Dirent[] = [];
		for (let next = directory.readSync(); next !== null; next = directory.readSync()) {
			if (entries.length >= maxEntries) return { entries, truncated: true };
			entries.push(next);
		}
		return { entries, truncated: false };
	} finally {
		directory.closeSync();
	}
};
