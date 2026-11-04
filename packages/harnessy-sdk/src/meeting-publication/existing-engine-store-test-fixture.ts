import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { collectTables, runSqliteDataMigrations } from "@executor-js/sdk/core";
import { Effect } from "effect";

import { createSqliteTestFumaDb } from "../../../../executor/packages/core/sdk/src/sqlite-test-db.ts";
import { CURRENT_EXECUTOR_DATA_MIGRATIONS } from "./existing-engine-store.ts";

/**
 * Source-only fixture for tests that need a real, fully stamped local-v2 store.
 * It is unreachable from both SDK package entries and is never bundled.
 */
export const seedExistingMeetingEngineStore = async (sqlitePath: string): Promise<void> => {
	const dataDirectory = dirname(sqlitePath);
	mkdirSync(dataDirectory, { mode: 0o700, recursive: true });
	chmodSync(dataDirectory, 0o700);

	const seeded = await createSqliteTestFumaDb({
		tables: collectTables(),
		namespace: "executor_local",
		version: "1.0.0",
		path: sqlitePath,
	});
	try {
		await Effect.runPromise(
			runSqliteDataMigrations(
				seeded.client,
				CURRENT_EXECUTOR_DATA_MIGRATIONS.map((name) => ({ name, run: () => Effect.void })),
			),
		);
	} finally {
		await seeded.close();
	}

	chmodSync(sqlitePath, 0o600);
	for (const suffix of ["-wal", "-shm", "-journal"] as const) {
		const sidecar = `${sqlitePath}${suffix}`;
		if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
	}
};
