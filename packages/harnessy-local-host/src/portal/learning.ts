/**
 * Read-only learning library summary: counts from the wiki catalog.
 *
 * `statusWiki` returns every source and `WikiStore(root, true)` opens SQLite
 * without a timeout or file checks. This reader uses the bounded read-only
 * snapshot instead and returns counts only: no titles, URIs or text.
 */
import { join } from "node:path";

import {
	type LearningCatalogData,
	okTile,
	ReadModelStateError,
	readSqliteSnapshot,
	stateTile,
	type TileResult,
} from "@harnessy/core/read-model";

/** The newest wiki catalog schema this reader understands (`wiki/store.ts`). */
export const WIKI_CATALOG_SUPPORTED_SCHEMA = 1;
const STATUSES = ["processed", "pending", "failed"] as const;

export interface LearningReadOptions {
	/** The wiki vault, normally `<home>/.harnessy/jarvis/wiki/learning`. */
	readonly root: string;
	readonly now: Date;
	readonly timeoutMs: number;
}

export const readLearningSummary = (options: LearningReadOptions): TileResult<LearningCatalogData> => {
	const snapshot = readSqliteSnapshot(
		join(options.root, "catalog.sqlite3"),
		{ timeoutMs: options.timeoutMs },
		(database) => {
			// `PRAGMA user_version` always returns one row.
			const schemaVersion = Number(database.prepare("PRAGMA user_version").get()!.user_version);
			if (schemaVersion === 0) throw new ReadModelStateError("missing", "catalog_uninitialized");
			if (schemaVersion > WIKI_CATALOG_SUPPORTED_SCHEMA)
				throw new ReadModelStateError("unsupported", "schema_newer");
			const sources = { processed: 0, pending: 0, failed: 0, other: 0, total: 0 };
			for (const row of database.prepare("SELECT status, COUNT(*) AS count FROM sources GROUP BY status").all()) {
				const status = String(row.status);
				const value = Number(row.count);
				if ((STATUSES as ReadonlyArray<string>).includes(status))
					sources[status as (typeof STATUSES)[number]] = value;
				else sources.other += value;
				sources.total += value;
			}
			const pages = Number(database.prepare("SELECT COUNT(*) AS count FROM pages").get()!.count);
			return { schemaVersion, sources, pages };
		},
	);
	return snapshot.state === "ok"
		? okTile(snapshot.value, options.now)
		: stateTile(snapshot.state, snapshot.reason, options.now);
};
