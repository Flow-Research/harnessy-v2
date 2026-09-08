import { type BigIntStats, chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	createDrizzleRuntimeSchemaFromTables,
	createDrizzleRuntimeSchemaSqlFromTables,
} from "@executor-js/fumadb/adapters/drizzle";
import {
	type ExecutorDb,
	type FumaTables,
	isStorageFailure,
	StorageError,
	type StorageFailure,
} from "@executor-js/sdk/core";
import { createExecutorFumaDb } from "@executor-js/sdk/host-internal";
import { type Client, createClient, type ResultSet } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Effect } from "effect";

import {
	acquireDataDirOwnership,
	findDataDirOwnershipHeld,
} from "../../../../executor/apps/local/src/db/data-dir-ownership.ts";

const DATABASE_FILENAME = "data.db";
const OWNER_LOCK_FILENAME = "data.db.owner-lock";
const MIGRATION_JOURNAL_FILENAME = "data.db.v1-v2-migration.json";
const EXECUTOR_NAMESPACE = "executor_local";
const EXECUTOR_SCHEMA_VERSION = "1.0.0";

/** The complete append-only local-v2 ledger accepted by this existing-only host. */
export const CURRENT_EXECUTOR_DATA_MIGRATIONS = [
	"2026-06-11-local-v1-to-v2",
	"2026-06-05-auth-config-placements",
	"2026-06-11-openapi-output-envelope-unwrap",
	"2026-06-12-openapi-spec-to-blob",
	"2026-06-12-graphql-introspection-to-blob",
	"2026-06-20-google-openapi-ownership",
	"2026-07-08-provider-service-split",
	"2026-07-02-gc-dead-dcr-oauth-clients",
	"2026-07-09-openapi-ndjson-output-arrays",
] as const;

type ExistingMeetingEngineStoreFailureCode =
	| "unsupported_platform"
	| "invalid_path"
	| "unsafe_binding"
	| "migration_incomplete"
	| "legacy_store"
	| "invalid_integrity"
	| "invalid_ledger"
	| "schema_drift"
	| "ownership_held"
	| "open_failed";

interface ExistingMeetingEngineStoreFailureCause {
	readonly code: ExistingMeetingEngineStoreFailureCode;
}

export interface ExistingMeetingEngineStoreInput {
	/** Canonical, absolute, already-authorized path whose final component is `data.db`. */
	readonly sqlitePath: string;
	/** The exact current table contract handed to an Executor DB factory. */
	readonly tables: FumaTables;
	/** @internal Deterministic interruption seam for source-level tests only. */
	readonly testHooks?: {
		readonly afterOwnershipAcquired?: () => Promise<void>;
	};
}

const rejection = (code: ExistingMeetingEngineStoreFailureCode): StorageError =>
	new StorageError({
		message: "Existing Executor store rejected",
		cause: { code } satisfies ExistingMeetingEngineStoreFailureCause,
	});

const reject = (code: ExistingMeetingEngineStoreFailureCode): never => {
	throw rejection(code);
};

const permissionBits = (stats: BigIntStats): number => Number(stats.mode & 0o7777n);

const sameFile = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino;

const currentEffectiveUserId = (): bigint => {
	if (process.platform === "win32" || typeof process.geteuid !== "function") {
		return reject("unsupported_platform");
	}
	return BigInt(process.geteuid());
};

const assertPrivateDirectory = (path: string, expectedUserId: bigint): BigIntStats => {
	const stats = lstatSync(path, { bigint: true });
	if (
		!stats.isDirectory() ||
		stats.isSymbolicLink() ||
		stats.uid !== expectedUserId ||
		permissionBits(stats) !== 0o700
	) {
		return reject("unsafe_binding");
	}
	return stats;
};

const assertPrivateRegularFile = (path: string, expectedUserId: bigint): BigIntStats => {
	const stats = lstatSync(path, { bigint: true });
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		stats.uid !== expectedUserId ||
		stats.nlink !== 1n ||
		permissionBits(stats) !== 0o600
	) {
		return reject("unsafe_binding");
	}
	return stats;
};

const assertSafeExistingControlFile = (path: string, expectedUserId: bigint): void => {
	if (!existsSync(path)) return;
	const stats = lstatSync(path, { bigint: true });
	const mode = permissionBits(stats);
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		stats.uid !== expectedUserId ||
		stats.nlink !== 1n ||
		(mode & 0o7133) !== 0 ||
		(mode & 0o600) !== 0o600
	) {
		reject("unsafe_binding");
	}
};

const assertSafeSqliteSidecars = (sqlitePath: string, expectedUserId: bigint): void => {
	for (const suffix of ["-wal", "-shm", "-journal"] as const) {
		const sidecar = `${sqlitePath}${suffix}`;
		if (existsSync(sidecar)) assertPrivateRegularFile(sidecar, expectedUserId);
	}
};

interface BoundStorePath {
	readonly dataDirectory: string;
	readonly directoryStats: BigIntStats;
	readonly databaseStats: BigIntStats;
}

const assertInitialBinding = (sqlitePath: string, expectedUserId: bigint): BoundStorePath => {
	if (!isAbsolute(sqlitePath) || resolve(sqlitePath) !== sqlitePath || basename(sqlitePath) !== DATABASE_FILENAME) {
		return reject("invalid_path");
	}

	const dataDirectory = dirname(sqlitePath);
	const directoryStats = assertPrivateDirectory(dataDirectory, expectedUserId);
	if (realpathSync(dataDirectory) !== dataDirectory) return reject("unsafe_binding");

	const databaseStats = assertPrivateRegularFile(sqlitePath, expectedUserId);
	if (realpathSync(sqlitePath) !== sqlitePath) return reject("unsafe_binding");

	assertSafeExistingControlFile(join(dataDirectory, OWNER_LOCK_FILENAME), expectedUserId);
	if (existsSync(join(dataDirectory, MIGRATION_JOURNAL_FILENAME))) {
		return reject("migration_incomplete");
	}
	assertSafeSqliteSidecars(sqlitePath, expectedUserId);

	return { dataDirectory, directoryStats, databaseStats };
};

const rowsOf = <T>(result: ResultSet): readonly T[] => result.rows as unknown as readonly T[];

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

interface TableInfoRow {
	readonly name: string;
	readonly type: string;
	readonly notnull: number | bigint;
	readonly pk: number | bigint;
}

interface IndexListRow {
	readonly name: string;
	readonly unique: number | bigint;
}

interface IndexInfoRow {
	readonly seqno: number | bigint;
	readonly name: string;
}

interface ForeignKeyRow {
	readonly id: number | bigint;
	readonly seq: number | bigint;
	readonly table: string;
	readonly from: string;
	readonly to: string;
	readonly on_update: string;
	readonly on_delete: string;
}

const tableNames = async (client: Client): Promise<ReadonlySet<string>> =>
	new Set(
		rowsOf<{ readonly name: string }>(
			await client.execute("SELECT name FROM sqlite_master WHERE type = 'table'"),
		).map((row) => row.name),
	);

const tableInfo = async (client: Client, table: string): Promise<readonly TableInfoRow[]> =>
	rowsOf<TableInfoRow>(await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`));

const normalizedType = (value: string): string => value.trim().toUpperCase();
const numericFlag = (value: number | bigint): number => Number(value);

const uniqueIndexSignatures = async (client: Client, table: string): Promise<ReadonlySet<string>> => {
	const indexes = rowsOf<IndexListRow>(await client.execute(`PRAGMA index_list(${quoteIdentifier(table)})`)).filter(
		(row) => numericFlag(row.unique) === 1,
	);
	const signatures = await Promise.all(
		indexes.map(async (index) => {
			const columns = [
				...rowsOf<IndexInfoRow>(await client.execute(`PRAGMA index_info(${quoteIdentifier(index.name)})`)),
			]
				.sort((left, right) => numericFlag(left.seqno) - numericFlag(right.seqno))
				.map((row) => row.name);
			return JSON.stringify(columns);
		}),
	);
	return new Set(signatures);
};

const foreignKeySignatures = async (client: Client, table: string): Promise<ReadonlySet<string>> =>
	new Set(
		[...rowsOf<ForeignKeyRow>(await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`))]
			.sort(
				(left, right) =>
					numericFlag(left.id) - numericFlag(right.id) || numericFlag(left.seq) - numericFlag(right.seq),
			)
			.map((row) => JSON.stringify([row.table, row.from, row.to, row.on_update, row.on_delete])),
	);

const assertCurrentSchema = async (client: Client, tables: FumaTables): Promise<void> => {
	const triggers = rowsOf<{ readonly name: string }>(
		await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'"),
	);
	if (triggers.length !== 0) return reject("schema_drift");

	const expected = createClient({ url: ":memory:" });
	try {
		for (const statement of createDrizzleRuntimeSchemaSqlFromTables({
			tables,
			namespace: EXECUTOR_NAMESPACE,
			version: EXECUTOR_SCHEMA_VERSION,
			provider: "sqlite",
		})) {
			await expected.execute(statement);
		}

		const expectedNames = await tableNames(expected);
		const actualNames = await tableNames(client);
		for (const table of expectedNames) {
			if (!actualNames.has(table)) return reject("schema_drift");

			const expectedColumns = await tableInfo(expected, table);
			const actualColumns = new Map(
				(await tableInfo(client, table)).map((column) => [column.name, column] as const),
			);
			for (const expectedColumn of expectedColumns) {
				const actualColumn = actualColumns.get(expectedColumn.name);
				if (
					actualColumn === undefined ||
					normalizedType(actualColumn.type) !== normalizedType(expectedColumn.type) ||
					numericFlag(actualColumn.notnull) !== numericFlag(expectedColumn.notnull) ||
					numericFlag(actualColumn.pk) !== numericFlag(expectedColumn.pk)
				) {
					return reject("schema_drift");
				}
			}

			const expectedIndexes = await uniqueIndexSignatures(expected, table);
			const actualIndexes = await uniqueIndexSignatures(client, table);
			for (const index of expectedIndexes) {
				if (!actualIndexes.has(index)) return reject("schema_drift");
			}

			const expectedForeignKeys = await foreignKeySignatures(expected, table);
			const actualForeignKeys = await foreignKeySignatures(client, table);
			for (const foreignKey of expectedForeignKeys) {
				if (!actualForeignKeys.has(foreignKey)) return reject("schema_drift");
			}
		}
	} finally {
		expected.close();
	}
};

const assertCurrentLedger = async (client: Client): Promise<void> => {
	const names = await tableNames(client);
	if (names.has("source")) {
		const legacyColumns = await tableInfo(client, "source");
		if (legacyColumns.some((column) => column.name === "scope_id")) {
			return reject("legacy_store");
		}
	}
	if (!names.has("data_migration")) return reject("invalid_ledger");

	const completed = new Set(
		rowsOf<{ readonly name: unknown }>(await client.execute("SELECT name FROM data_migration"))
			.map((row) => row.name)
			.filter((name): name is string => typeof name === "string"),
	);
	for (const migration of CURRENT_EXECUTOR_DATA_MIGRATIONS) {
		if (!completed.has(migration)) return reject("invalid_ledger");
	}
};

const assertDatabaseIntegrity = async (client: Client): Promise<void> => {
	const integrity = rowsOf<Record<string, unknown>>(await client.execute("PRAGMA integrity_check"));
	if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
		return reject("invalid_integrity");
	}
	if (rowsOf<Record<string, unknown>>(await client.execute("PRAGMA foreign_key_check")).length !== 0) {
		return reject("invalid_integrity");
	}
};

const openExistingStore = async (input: ExistingMeetingEngineStoreInput, signal: AbortSignal): Promise<ExecutorDb> => {
	const expectedUserId = currentEffectiveUserId();
	const initial = assertInitialBinding(input.sqlitePath, expectedUserId);
	let ownership: Awaited<ReturnType<typeof acquireDataDirOwnership>> | null = null;
	let client: Client | null = null;
	let clientClosed = false;
	let ownershipReleased = false;
	const release = async (): Promise<void> => {
		try {
			if (client !== null && !clientClosed) {
				clientClosed = true;
				client.close();
			}
		} finally {
			if (ownership !== null && !ownershipReleased) {
				ownershipReleased = true;
				await ownership.release();
			}
		}
	};
	const releaseAfterInterruption = (): void => {
		void release().catch(() => undefined);
	};
	signal.addEventListener("abort", releaseAfterInterruption, { once: true });

	try {
		if (signal.aborted) return reject("open_failed");
		ownership = await acquireDataDirOwnership(initial.dataDirectory);
		if (signal.aborted) return reject("open_failed");
		await input.testHooks?.afterOwnershipAcquired?.();
		if (signal.aborted) return reject("open_failed");

		const lockedDataDirectory = dirname(ownership.lockPath);
		if (
			lockedDataDirectory !== initial.dataDirectory ||
			join(lockedDataDirectory, DATABASE_FILENAME) !== input.sqlitePath
		) {
			return reject("unsafe_binding");
		}

		const lockedDirectoryStats = assertPrivateDirectory(lockedDataDirectory, expectedUserId);
		const lockedDatabaseStats = assertPrivateRegularFile(input.sqlitePath, expectedUserId);
		if (
			!sameFile(initial.directoryStats, lockedDirectoryStats) ||
			!sameFile(initial.databaseStats, lockedDatabaseStats)
		) {
			return reject("unsafe_binding");
		}

		chmodSync(ownership.lockPath, 0o600);
		assertPrivateRegularFile(ownership.lockPath, expectedUserId);
		if (existsSync(join(lockedDataDirectory, MIGRATION_JOURNAL_FILENAME))) {
			return reject("migration_incomplete");
		}
		assertSafeSqliteSidecars(input.sqlitePath, expectedUserId);

		// @libsql/client has no read-only local-open flag. The preflight therefore
		// performs query-only statements under the lifetime owner lock; it never
		// calls the local app's schema ensure, data migrations, or V1 migration.
		client = createClient({ url: pathToFileURL(input.sqlitePath).href });
		await assertDatabaseIntegrity(client);
		if (signal.aborted) return reject("open_failed");
		await assertCurrentLedger(client);
		if (signal.aborted) return reject("open_failed");
		await assertCurrentSchema(client, input.tables);
		if (signal.aborted) return reject("open_failed");

		// Only after the existing store passes every gate may the serving connection
		// select WAL and expose a writable Executor facade.
		await client.execute("PRAGMA foreign_keys = ON");
		await client.execute("PRAGMA journal_mode = WAL");
		await client.execute("PRAGMA busy_timeout = 5000");
		assertSafeSqliteSidecars(input.sqlitePath, expectedUserId);

		const schema = createDrizzleRuntimeSchemaFromTables({
			tables: input.tables,
			namespace: EXECUTOR_NAMESPACE,
			version: EXECUTOR_SCHEMA_VERSION,
			provider: "sqlite",
		});
		const drizzleDb = drizzle({ client, schema });
		const { db } = createExecutorFumaDb(drizzleDb, {
			tables: input.tables,
			namespace: EXECUTOR_NAMESPACE,
			version: EXECUTOR_SCHEMA_VERSION,
			provider: "sqlite",
		});

		let closed = false;
		return {
			db,
			close: async () => {
				if (closed) return;
				closed = true;
				await release();
			},
		};
	} catch (cause) {
		await release();
		throw cause;
	}
};

/**
 * Open an already-provisioned current local-v2 Executor database.
 *
 * This is an internal host-composition boundary, not a bootstrap path: it never
 * creates `data.db`, repairs schema, runs migrations, or reads credentials.
 * Platforms without the pinned native libSQL binding are rejected; there is no
 * memory or alternate-driver fallback.
 */
export const openExistingMeetingEngineStore = (
	input: ExistingMeetingEngineStoreInput,
): Effect.Effect<ExecutorDb, StorageFailure> =>
	Effect.tryPromise({
		try: (signal) => openExistingStore(input, signal),
		catch: (cause) =>
			isStorageFailure(cause)
				? cause
				: findDataDirOwnershipHeld(cause) === null
					? rejection("open_failed")
					: rejection("ownership_held"),
	});
