import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import * as Result from "effect/Result";
import { relocationTreeDigest } from "./workspace-relocation.ts";

const contracts = {
	meeting: { table: "publication_items", id: "item_id", columns: ["note_path"] },
	community: {
		table: "community_briefings",
		id: "briefing_id",
		columns: ["artifact_dir", "briefing_path", "discord_path", "provenance_path"],
	},
} as const;
export type WorkspaceStateKind = keyof typeof contracts;
interface PathChange {
	readonly id: string;
	readonly column: string;
	readonly from: string;
	readonly to: string;
	readonly artifactDigest: string;
}
export interface WorkspaceStateMigration {
	readonly version: 1;
	readonly kind: WorkspaceStateKind;
	readonly databasePath: string;
	readonly beforeDigest: string;
	readonly afterDigest: string;
	readonly changes: ReadonlyArray<PathChange>;
}
type Row = Record<string, SQLOutputValue>;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const digest = (value: unknown): string =>
	createHash("sha256")
		.update(
			JSON.stringify(value, (_key, item: unknown) =>
				typeof item === "bigint"
					? { bigint: item.toString() }
					: item instanceof Uint8Array
						? { bytes: Buffer.from(item).toString("hex") }
						: item,
			),
		)
		.digest("hex");

const open = (path: string, readOnly: boolean): DatabaseSync => {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(path) !== resolve(path))
		throw new Error("Migration database must be a regular file without links");
	if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())))
		throw new Error("Migration database must be owner-private");
	return new DatabaseSync(path, { readOnly, allowExtension: false, timeout: 10000 });
};
const databaseSnapshot = (
	database: DatabaseSync,
): { readonly schema: Row[]; readonly tables: Record<string, Row[]> } => {
	const schema = database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
	if (
		schema.some(
			(entry) => entry.type === "trigger" || entry.type === "view" || String(entry.sql).includes("VIRTUAL TABLE"),
		)
	)
		throw new Error("Unsupported migration database schema");
	const tables: Record<string, Row[]> = {};
	for (const entry of schema) {
		if (entry.type !== "table") continue;
		const name = String(entry.name);
		tables[name] = database
			.prepare(`SELECT * FROM ${quote(name)}`)
			.all()
			.sort((a, b) => digest(a).localeCompare(digest(b)));
	}
	return { schema, tables };
};
const normalizedPath = (path: string): void => {
	if (!isAbsolute(path) || resolve(path) !== path || path === sep)
		throw new Error("Expected a normalized absolute migration prefix");
};

/** Capture every database value. Only the declared path columns may differ after migration. */
export const planWorkspaceStateMigration = (
	databasePath: string,
	kind: WorkspaceStateKind,
	from: string,
	to: string,
): WorkspaceStateMigration => {
	normalizedPath(from);
	normalizedPath(to);
	if (from === to || from.startsWith(`${to}${sep}`) || to.startsWith(`${from}${sep}`))
		throw new Error("Overlapping database path prefixes");
	const contract = contracts[kind];
	if (!contract) throw new Error("Unsupported state migration kind");
	const database = open(databasePath, true);
	try {
		const before = databaseSnapshot(database);
		const rows = before.tables[contract.table];
		if (!rows) throw new Error("Missing expected state table");
		if (
			rows.some((row) => row.status === "publishing" || (row.lease_until !== null && row.lease_until !== undefined))
		)
			throw new Error("Quiesce publication leases before migration");
		const changes: PathChange[] = [];
		const updated = rows
			.map((row) => {
				const next = { ...row };
				for (const column of contract.columns) {
					const value = row[column];
					if (typeof value !== "string") throw new Error("Invalid state path column");
					if (value !== from && !value.startsWith(`${from}${sep}`)) continue;
					const target = `${to}${value.slice(from.length)}`;
					normalizedPath(value);
					normalizedPath(target);
					if (realpathSync(value) !== value) throw new Error("State artifact cannot traverse links");
					changes.push({
						id: String(row[contract.id]),
						column,
						from: value,
						to: target,
						artifactDigest: relocationTreeDigest(value),
					});
					next[column] = target;
				}
				return next;
			})
			.sort((a, b) => digest(a).localeCompare(digest(b)));
		if (!changes.length) throw new Error("No state paths match migration prefix");
		return {
			version: 1,
			kind,
			databasePath: realpathSync(databasePath),
			beforeDigest: digest(before),
			afterDigest: digest({ ...before, tables: { ...before.tables, [contract.table]: updated } }),
			changes,
		};
	} finally {
		database.close();
	}
};

/** Offline operator operation. Does not approve, regenerate, enqueue or publish anything. */
export const applyWorkspaceStateMigration = (
	plan: WorkspaceStateMigration,
	backupPath: string,
	rollback = false,
): { readonly changedPaths: number; readonly digest: string } => {
	const contract = contracts[plan.kind];
	if (plan.version !== 1 || !contract || !plan.changes.length) throw new Error("Invalid state migration plan");
	const backup = open(backupPath, true);
	try {
		if (digest(databaseSnapshot(backup)) !== plan.beforeDigest)
			throw new Error("Database backup does not match migration plan");
	} finally {
		backup.close();
	}
	if (realpathSync(backupPath) === realpathSync(plan.databasePath))
		throw new Error("An independent database backup is required");
	const database = open(plan.databasePath, false);
	let transaction = false;
	try {
		database.exec("BEGIN IMMEDIATE");
		transaction = true;
		const current = digest(databaseSnapshot(database));
		const expected = rollback ? plan.afterDigest : plan.beforeDigest;
		const result = rollback ? plan.beforeDigest : plan.afterDigest;
		if (current !== expected && current !== result)
			throw new Error("Database changed since migration planning; refusing to overwrite approvals or receipts");
		for (const change of plan.changes) {
			if (!(contract.columns as readonly string[]).includes(change.column))
				throw new Error("Unapproved database migration column");
			const source = rollback ? change.to : change.from;
			const target = rollback ? change.from : change.to;
			normalizedPath(source);
			normalizedPath(target);
			if (realpathSync(target) !== target || relocationTreeDigest(target) !== change.artifactDigest)
				throw new Error("Relocated artifact content differs from the original");
			if (current === result) continue;
			const update = database
				.prepare(
					`UPDATE ${quote(contract.table)} SET ${quote(change.column)}=? WHERE ${quote(contract.id)}=? AND ${quote(change.column)}=?`,
				)
				.run(target, change.id, source);
			if (Number(update.changes) !== 1) throw new Error("State migration row no longer matches");
		}
		if (digest(databaseSnapshot(database)) !== result)
			throw new Error("Migration changed values outside the approved path mapping");
		const integrity = database.prepare("PRAGMA quick_check").all();
		if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok")
			throw new Error("Database integrity check failed");
		database.exec("COMMIT");
		transaction = false;
		return { changedPaths: current === result ? 0 : plan.changes.length, digest: result };
	} finally {
		if (transaction) Result.try(() => database.exec("ROLLBACK"));
		database.close();
	}
};
