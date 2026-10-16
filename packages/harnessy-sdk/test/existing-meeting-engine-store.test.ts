import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { collectTables, createExecutor, type ExecutorDb, StorageError, Subject, Tenant } from "@executor-js/sdk/core";
import { type Client, createClient } from "@libsql/client";
import { Effect, Fiber } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	CURRENT_EXECUTOR_DATA_MIGRATIONS,
	openExistingMeetingEngineStore,
} from "../src/meeting-publication/existing-engine-store.ts";
import { seedExistingMeetingEngineStore } from "../src/meeting-publication/existing-engine-store-test-fixture.ts";

const fixtures = new Set<string>();
const tables = collectTables();

const makeDataDirectory = (): { readonly dataDirectory: string; readonly sqlitePath: string } => {
	const dataDirectory = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-existing-executor-"));
	chmodSync(dataDirectory, 0o700);
	fixtures.add(dataDirectory);
	return { dataDirectory, sqlitePath: join(dataDirectory, "data.db") };
};

const closeClient = (client: Client): void => {
	client.close();
};

const closeStore = async (store: ExecutorDb): Promise<void> => {
	const close = store.close?.();
	if (close === undefined) return;
	if (Effect.isEffect(close)) {
		await Effect.runPromise(close);
		return;
	}
	await close;
};

const makePrivate = (sqlitePath: string): void => {
	chmodSync(sqlitePath, 0o600);
	for (const suffix of ["-wal", "-shm", "-journal"] as const) {
		const sidecar = `${sqlitePath}${suffix}`;
		if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
	}
};

const seedCurrentStore = (sqlitePath: string): Promise<void> => seedExistingMeetingEngineStore(sqlitePath);

const failureCode = async (sqlitePath: string): Promise<unknown> => {
	const error = await Effect.runPromise(Effect.flip(openExistingMeetingEngineStore({ sqlitePath, tables })));
	expect(error).toBeInstanceOf(StorageError);
	return error.cause && typeof error.cause === "object" && "code" in error.cause ? error.cause.code : undefined;
};

const persistedTableNames = async (sqlitePath: string): Promise<readonly string[]> => {
	const client = createClient({ url: pathToFileURL(sqlitePath).href });
	try {
		const result = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
		return result.rows.map((row) => String(row.name));
	} finally {
		closeClient(client);
	}
};

afterEach(() => {
	for (const fixture of fixtures) rmSync(fixture, { force: true, recursive: true });
	fixtures.clear();
});

describe("existing meeting Executor store", () => {
	it("persists through the current Executor facade and reopens after close", async () => {
		const { dataDirectory, sqlitePath } = makeDataDirectory();
		await seedCurrentStore(sqlitePath);
		writeFileSync(join(dataDirectory, "auth.json"), "not readable by this boundary", {
			mode: 0o000,
		});

		const firstStore = await Effect.runPromise(openExistingMeetingEngineStore({ sqlitePath, tables }));
		const first = await Effect.runPromise(
			createExecutor({
				tenant: Tenant.make("meeting-publication"),
				subject: Subject.make("reviewer"),
				db: firstStore,
				onElicitation: "accept-all",
			}),
		);
		await Effect.runPromise(
			first.policies.create({
				owner: "org",
				pattern: "google-meeting-publication.*",
				action: "block",
			}),
		);
		await Effect.runPromise(first.close());

		const secondStore = await Effect.runPromise(openExistingMeetingEngineStore({ sqlitePath, tables }));
		const second = await Effect.runPromise(
			createExecutor({
				tenant: Tenant.make("meeting-publication"),
				subject: Subject.make("reviewer"),
				db: secondStore,
				onElicitation: "accept-all",
			}),
		);
		expect(await Effect.runPromise(second.policies.list())).toMatchObject([
			{
				owner: "org",
				pattern: "google-meeting-publication.*",
				action: "block",
			},
		]);
		await Effect.runPromise(second.close());
	});

	it("rejects a missing store without creating the database or owner lock", async () => {
		const { dataDirectory, sqlitePath } = makeDataDirectory();

		expect(await failureCode(sqlitePath)).toBe("open_failed");
		expect(existsSync(sqlitePath)).toBe(false);
		expect(existsSync(join(dataDirectory, "data.db.owner-lock"))).toBe(false);
	});

	it("rejects a malformed database without replacing it", async () => {
		const { sqlitePath } = makeDataDirectory();
		const malformed = Buffer.from("not a sqlite database", "utf8");
		writeFileSync(sqlitePath, malformed, { mode: 0o600 });

		expect(await failureCode(sqlitePath)).toBe("open_failed");
		expect(readFileSync(sqlitePath)).toEqual(malformed);
	});

	it("rejects legacy state without migrating or adding current tables", async () => {
		const { sqlitePath } = makeDataDirectory();
		const client = createClient({ url: pathToFileURL(sqlitePath).href });
		await client.execute("CREATE TABLE source (scope_id TEXT NOT NULL)");
		closeClient(client);
		makePrivate(sqlitePath);

		expect(await failureCode(sqlitePath)).toBe("legacy_store");
		expect(await persistedTableNames(sqlitePath)).toEqual(["source"]);
	});

	it("rejects schema drift without repairing the missing table", async () => {
		const { sqlitePath } = makeDataDirectory();
		await seedCurrentStore(sqlitePath);
		const client = createClient({ url: pathToFileURL(sqlitePath).href });
		await client.execute("DROP TABLE connection");
		closeClient(client);
		makePrivate(sqlitePath);

		expect(await failureCode(sqlitePath)).toBe("schema_drift");
		expect(await persistedTableNames(sqlitePath)).not.toContain("connection");
	});

	it("rejects persisted triggers that could retarget later writes", async () => {
		const { sqlitePath } = makeDataDirectory();
		await seedCurrentStore(sqlitePath);
		const client = createClient({ url: pathToFileURL(sqlitePath).href });
		await client.execute(
			"CREATE TRIGGER retarget_policy AFTER INSERT ON tool_policy BEGIN DELETE FROM tool_policy; END",
		);
		closeClient(client);
		makePrivate(sqlitePath);

		expect(await failureCode(sqlitePath)).toBe("schema_drift");
		const verifier = createClient({ url: pathToFileURL(sqlitePath).href });
		const triggers = await verifier.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'");
		closeClient(verifier);
		expect(triggers.rows.map((row) => row.name)).toEqual(["retarget_policy"]);
	});

	it("rejects an incomplete ledger without stamping it", async () => {
		const { sqlitePath } = makeDataDirectory();
		await seedCurrentStore(sqlitePath);
		const client = createClient({ url: pathToFileURL(sqlitePath).href });
		const missing = CURRENT_EXECUTOR_DATA_MIGRATIONS.at(-1);
		await client.execute({
			sql: "DELETE FROM data_migration WHERE name = ?",
			args: [missing ?? ""],
		});
		closeClient(client);
		makePrivate(sqlitePath);

		expect(await failureCode(sqlitePath)).toBe("invalid_ledger");
		const verifier = createClient({ url: pathToFileURL(sqlitePath).href });
		const stamped = await verifier.execute({
			sql: "SELECT name FROM data_migration WHERE name = ?",
			args: [missing ?? ""],
		});
		closeClient(verifier);
		expect(stamped.rows).toHaveLength(0);
	});

	it("rejects unsafe database and sidecar bindings before opening state", async () => {
		const unsafeDatabase = makeDataDirectory();
		await seedCurrentStore(unsafeDatabase.sqlitePath);
		chmodSync(unsafeDatabase.sqlitePath, 0o640);
		expect(await failureCode(unsafeDatabase.sqlitePath)).toBe("unsafe_binding");
		expect(existsSync(join(unsafeDatabase.dataDirectory, "data.db.owner-lock"))).toBe(false);

		const unsafeSidecar = makeDataDirectory();
		await seedCurrentStore(unsafeSidecar.sqlitePath);
		const sidecarTarget = join(unsafeSidecar.dataDirectory, "sidecar-target");
		writeFileSync(sidecarTarget, "not a sqlite sidecar", { mode: 0o600 });
		symlinkSync(sidecarTarget, `${unsafeSidecar.sqlitePath}-wal`);
		expect(await failureCode(unsafeSidecar.sqlitePath)).toBe("unsafe_binding");
		expect(existsSync(join(unsafeSidecar.dataDirectory, "data.db.owner-lock"))).toBe(false);
	});

	it("rejects a symlinked data.db and a pending V1 migration journal", async () => {
		const target = makeDataDirectory();
		await seedCurrentStore(target.sqlitePath);
		const linked = makeDataDirectory();
		symlinkSync(target.sqlitePath, linked.sqlitePath);
		expect(await failureCode(linked.sqlitePath)).toBe("unsafe_binding");

		const journaled = makeDataDirectory();
		await seedCurrentStore(journaled.sqlitePath);
		writeFileSync(join(journaled.dataDirectory, "data.db.v1-v2-migration.json"), "{}", {
			mode: 0o600,
		});
		expect(await failureCode(journaled.sqlitePath)).toBe("migration_incomplete");
	});

	it("fences concurrent owners for the full handle lifetime and releases on close", async () => {
		const { sqlitePath } = makeDataDirectory();
		await seedCurrentStore(sqlitePath);

		const first = await Effect.runPromise(openExistingMeetingEngineStore({ sqlitePath, tables }));
		expect(await failureCode(sqlitePath)).toBe("ownership_held");
		await closeStore(first);

		const reopened = await Effect.runPromise(openExistingMeetingEngineStore({ sqlitePath, tables }));
		await closeStore(reopened);
		expect(lstatSync(join(sqlitePath, "..", "data.db.owner-lock")).isFile()).toBe(true);
	});

	it("releases the native client and owner lock when acquisition is interrupted", async () => {
		const { sqlitePath } = makeDataDirectory();
		await seedCurrentStore(sqlitePath);
		let signalOwnershipAcquired: (() => void) | undefined;
		const ownershipAcquired = new Promise<void>((resolve) => {
			signalOwnershipAcquired = resolve;
		});
		let unblockAcquisition: (() => void) | undefined;
		const acquisitionBlocked = new Promise<void>((resolve) => {
			unblockAcquisition = resolve;
		});
		const fiber = Effect.runFork(
			openExistingMeetingEngineStore({
				sqlitePath,
				tables,
				testHooks: {
					afterOwnershipAcquired: async () => {
						signalOwnershipAcquired?.();
						await acquisitionBlocked;
					},
				},
			}),
		);
		await ownershipAcquired;
		await Effect.runPromise(Fiber.interrupt(fiber));
		unblockAcquisition?.();

		let reopened: ExecutorDb | undefined;
		for (let attempt = 0; attempt < 20 && reopened === undefined; attempt += 1) {
			try {
				reopened = await Effect.runPromise(openExistingMeetingEngineStore({ sqlitePath, tables }));
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		expect(reopened).toBeDefined();
		if (reopened !== undefined) await closeStore(reopened);
	});

	it("requires the exact canonical data.db path", async () => {
		const { dataDirectory, sqlitePath } = makeDataDirectory();
		await seedCurrentStore(sqlitePath);
		const alternatePath = join(dataDirectory, "executor.sqlite");
		writeFileSync(alternatePath, "not used", { mode: 0o600 });

		expect(await failureCode(alternatePath)).toBe("invalid_path");
		expect(readdirSync(dataDirectory)).not.toContain("data.db.owner-lock");
	});
});
