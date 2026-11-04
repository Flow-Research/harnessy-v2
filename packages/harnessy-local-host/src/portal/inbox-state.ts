import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import type { InboxItemData } from "@harnessy/core/read-model";
import { type InboxSelection, inboxRevision } from "./inbox-revision.ts";

/** Shared by the local and remote listeners. Only Inbox visibility is written. */
export class InboxState {
	readonly file: string;
	constructor(file: string) {
		this.file = file;
	}
	read(): Map<string, string> {
		let fd: number;
		try {
			fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("invalid_inbox_state");
			const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
			if (
				!Array.isArray(value) ||
				value.length > 1000 ||
				value.some(
					(row) =>
						!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || typeof row[1] !== "string",
				)
			)
				throw new Error("invalid_inbox_state");
			return new Map(value);
		} finally {
			closeSync(fd);
		}
	}
	update(action: "archive" | "restore", selections: InboxSelection[], current: readonly InboxItemData[]) {
		const entries = this.read();
		// Validate the whole batch before writing. A stale tab must not hide a changed alert.
		for (const selection of selections) {
			if (action === "archive") {
				const item = current.find((candidate) => candidate.key === selection.key);
				if (!item || inboxRevision(item) !== selection.revision) throw new Error("inbox_changed");
			} else if (entries.has(selection.key) && entries.get(selection.key) !== selection.revision)
				throw new Error("inbox_changed");
		}
		for (const { key, revision } of selections) {
			if (action === "archive") {
				entries.delete(key);
				entries.set(key, revision);
			} else entries.delete(key);
		}
		let encoded = JSON.stringify([...entries]);
		// The source can be incomplete or capped. Absence is not proof of resolution.
		// At capacity, expire oldest non-visible records only; never drop a visible
		// archive or this request's new selection. Expiry can only resurface alerts.
		const protectedKeys = new Set([...current.map((item) => item.key), ...selections.map((item) => item.key)]);
		for (const key of entries.keys()) {
			if (entries.size <= 1000 && Buffer.byteLength(encoded) <= 8 * 1024 * 1024) break;
			if (protectedKeys.has(key)) continue;
			entries.delete(key);
			encoded = JSON.stringify([...entries]);
		}
		if (entries.size > 1000 || Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error("inbox_archive_full");
		const temp = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, encoded, { mode: 0o600, flag: "wx" });
			renameSync(temp, this.file);
		} finally {
			try {
				unlinkSync(temp);
			} catch {
				/* Renamed or not created. */
			}
		}
	}
}
