import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
	decodeFixtureBackupRequest,
	FIXTURE_BACKUP_ROLES,
	type FixtureBackupEntry,
	type FixtureBackupRequest,
	fixtureCanonicalJson,
	fixtureSha256,
	formatFixtureBackupEvidenceEnvelope,
	formatFixtureBackupRequestEnvelope,
	makeFixtureBackupRequestEnvelope,
	verifyFixtureBackupEvidenceEnvelope,
	verifyFixtureBackupRequestEnvelope,
} from "./support/backup-contract.ts";
import {
	assertNoFixtureBackupDebris,
	FixtureBackupRuntimeError,
	runFixtureBackupRestore,
	verifyPublishedFixtureBackup,
} from "./support/backup-runtime.ts";

const roots: Array<string> = [];
const createdAt = "2026-09-05T12:00:00.000Z";
const completedAt = "2026-09-05T12:00:01.000Z";

const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-backup-fixture-"));
	chmodSync(root, 0o700);
	const sourceBoundary = join(root, "source");
	const outputParent = join(root, "backups");
	mkdirSync(sourceBoundary, { mode: 0o700 });
	mkdirSync(outputParent, { mode: 0o700 });
	chmodSync(sourceBoundary, 0o700);
	chmodSync(outputParent, 0o700);
	roots.push(root);
	return { root, sourceBoundary, outputParent };
};

afterEach(() => {
	for (const root of roots.splice(0)) {
		if (existsSync(root)) {
			chmodSync(root, 0o700);
			rmSync(root, { recursive: true, force: true });
		}
	}
});

const makeScope = (entries: ReadonlyArray<FixtureBackupEntry>) =>
	FIXTURE_BACKUP_ROLES.map((role) => {
		const entryIds = entries.filter((entry) => entry.role === role).map((entry) => entry.id);
		return { role, disposition: entryIds.length > 0 ? ("included" as const) : ("not_configured" as const), entryIds };
	});

const makeRequest = (
	paths: ReturnType<typeof makeRoot>,
	entries: ReadonlyArray<FixtureBackupEntry>,
	reviewTokenPath: string | null,
) => {
	const request: FixtureBackupRequest = {
		kind: "harnessy.local-host.fixture-backup.request",
		schemaVersion: 1,
		fixtureOnly: true,
		operationalEvidence: false,
		createdAt,
		platformPolicy: "posix-local-filesystem-only",
		fixtureRoot: paths.root,
		sourceBoundary: paths.sourceBoundary,
		outputParent: paths.outputParent,
		scope: makeScope(entries),
		entries,
		reviewToken: {
			sourcePath: reviewTokenPath,
			disposition: "exclude_and_regenerate_after_authorized_activation",
			accessAllowed: false,
		},
		restorePolicy: { target: "ephemeral_new_empty_directory", overwrite: false, removeAfterVerification: true },
		publicationPolicy: { strategy: "same_parent_atomic_rename", overwrite: false },
	};
	return makeFixtureBackupRequestEnvelope(request);
};

const runtimeOptions = () => ({ now: () => completedAt });

const formatForgedEvidence = (receipt: unknown) =>
	`${fixtureCanonicalJson({
		receipt,
		receiptSha256: fixtureSha256(fixtureCanonicalJson(receipt)),
	})}\n`;

const createSqlite = (path: string, rows = 2) => {
	const database = new DatabaseSync(path);
	database.exec(
		"PRAGMA user_version = 3; CREATE TABLE evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;",
	);
	const insert = database.prepare("INSERT INTO evidence (value) VALUES (?)");
	for (let index = 0; index < rows; index += 1) insert.run(`row-${index}-${"x".repeat(512)}`);
	database.close();
	chmodSync(path, 0o600);
};

const basicEntries = (sourceBoundary: string) => {
	const configPath = join(sourceBoundary, "config.json");
	const sqlitePath = join(sourceBoundary, "meeting-publication.sqlite3");
	writeFileSync(configPath, '{"enabled":false}\n', { mode: 0o600 });
	createSqlite(sqlitePath);
	return {
		configPath,
		sqlitePath,
		entries: [
			{
				id: "entry_0000000000000001",
				role: "jarvis_config",
				sourcePath: configPath,
				archivePath: "config/jarvis.json",
			},
			{
				id: "entry_0000000000000002",
				role: "meeting_publication_sqlite",
				sourcePath: sqlitePath,
				archivePath: "meeting/meeting-publication.sqlite3",
			},
		] as const satisfies ReadonlyArray<FixtureBackupEntry>,
	};
};

describe("fixture-only backup and isolated restore evidence", () => {
	it("atomically publishes canonical content-free evidence for explicit file and SQLite entries", async () => {
		const paths = makeRoot();
		const { configPath, entries } = basicEntries(paths.sourceBoundary);
		const tokenPath = join(paths.sourceBoundary, "review.token");
		writeFileSync(tokenPath, "must-never-be-read", { mode: 0o000 });
		const tokenBefore = lstatSync(tokenPath, { bigint: true });
		const request = makeRequest(paths, entries, tokenPath);
		const requestText = formatFixtureBackupRequestEnvelope(request);
		expect(verifyFixtureBackupRequestEnvelope(requestText)).toEqual(request);

		const published = await runFixtureBackupRestore(request, runtimeOptions());
		const verified = verifyPublishedFixtureBackup(published.finalRoot, request.requestSha256);
		expect(() => verifyPublishedFixtureBackup(published.finalRoot, "0".repeat(64))).toThrowError(
			expect.objectContaining({ code: "publication_failed" }),
		);
		expect(verified.envelope).toEqual(published.envelope);
		expect(verified.evidenceText).toBe(formatFixtureBackupEvidenceEnvelope(published.envelope));
		expect(published.envelope.receipt.fixtureOnly).toBe(true);
		expect(published.envelope.receipt.operationalEvidence).toBe(false);
		expect(published.envelope.receipt.reviewToken).toEqual({
			sourcePath: tokenPath,
			disposition: "exclude_and_regenerate_after_authorized_activation",
			accessed: false,
			copied: false,
		});
		expect(published.envelope.receipt.restoreRehearsal).toMatchObject({
			completed: true,
			temporaryRootRemoved: true,
		});
		expect(published.envelope.receipt.entries.map((entry) => entry.captureMethod)).toEqual([
			"stable_descriptor_copy",
			"node_sqlite_online_backup",
		]);
		expect(readFileSync(join(published.finalRoot, "payload/config/jarvis.json"), "utf8")).toBe(
			readFileSync(configPath, "utf8"),
		);
		const copiedDatabase = new DatabaseSync(
			join(published.finalRoot, "payload/meeting/meeting-publication.sqlite3"),
			{ readOnly: true },
		);
		expect(copiedDatabase.prepare("SELECT count(*) AS count FROM evidence").get()).toEqual({ count: 2 });
		copiedDatabase.close();
		const tokenAfter = lstatSync(tokenPath, { bigint: true });
		expect({
			atimeNs: tokenAfter.atimeNs,
			mtimeNs: tokenAfter.mtimeNs,
			ctimeNs: tokenAfter.ctimeNs,
			size: tokenAfter.size,
		}).toEqual({
			atimeNs: tokenBefore.atimeNs,
			mtimeNs: tokenBefore.mtimeNs,
			ctimeNs: tokenBefore.ctimeNs,
			size: tokenBefore.size,
		});
		expect(verified.evidenceText).not.toContain("must-never-be-read");
		assertNoFixtureBackupDebris(paths.outputParent);
	});

	it("rejects noncanonical, tampered, incomplete, and token-copy request shapes", async () => {
		const paths = makeRoot();
		const { entries } = basicEntries(paths.sourceBoundary);
		const tokenPath = join(paths.sourceBoundary, "review.token");
		writeFileSync(tokenPath, "excluded", { mode: 0o600 });
		const envelope = makeRequest(paths, entries, tokenPath);
		const canonical = formatFixtureBackupRequestEnvelope(envelope);
		expect(() => verifyFixtureBackupRequestEnvelope(`${canonical}\n`)).toThrow();
		expect(() =>
			verifyFixtureBackupRequestEnvelope(
				canonical.replace('"operationalEvidence":false', '"operationalEvidence":true'),
			),
		).toThrow();
		const missingRole = { ...envelope.request, scope: envelope.request.scope.slice(1) };
		expect(() => decodeFixtureBackupRequest(missingRole)).toThrow();
		const tokenEntry = [
			...entries,
			{
				id: "entry_0000000000000003",
				role: "meeting_review_log" as const,
				sourcePath: tokenPath,
				archivePath: "review.token",
			},
		].sort((left, right) => left.archivePath.localeCompare(right.archivePath));
		expect(() => makeRequest(paths, tokenEntry, tokenPath)).toThrow();
		const tokenAliasEntry = [
			{
				id: "entry_0000000000000003",
				role: "meeting_review_log" as const,
				sourcePath: join(paths.sourceBoundary, "REVIEW.TOKEN"),
				archivePath: "logs/review.log",
			},
		] satisfies ReadonlyArray<FixtureBackupEntry>;
		expect(() => makeRequest(paths, tokenAliasEntry, null)).toThrow();

		const published = await runFixtureBackupRestore(envelope, runtimeOptions());
		const evidenceText = formatFixtureBackupEvidenceEnvelope(published.envelope);
		expect(() =>
			verifyFixtureBackupEvidenceEnvelope(
				evidenceText.replace('"operationalEvidence":false', '"operationalEvidence":true'),
			),
		).toThrow();
		const firstEntry = published.envelope.receipt.entries[0];
		if (firstEntry === undefined) throw new Error("fixture entry missing");
		for (const restoreArtifact of [
			{ ...firstEntry.restoreArtifact, sha256: "0".repeat(64) },
			{ ...firstEntry.restoreArtifact, sizeBytes: String(Number(firstEntry.restoreArtifact.sizeBytes) + 1) },
			{ ...firstEntry.restoreArtifact, mode: firstEntry.restoreArtifact.mode === "0400" ? "0600" : "0400" },
		]) {
			const forgedReceipt = {
				...published.envelope.receipt,
				entries: [{ ...firstEntry, restoreArtifact }, ...published.envelope.receipt.entries.slice(1)],
			};
			expect(() => verifyFixtureBackupEvidenceEnvelope(formatForgedEvidence(forgedReceipt))).toThrow();
		}
		const forgedRestoreInventory = {
			...published.envelope.receipt,
			restoreRehearsal: {
				...published.envelope.receipt.restoreRehearsal,
				inventorySha256: "0".repeat(64),
			},
		};
		expect(() => verifyFixtureBackupEvidenceEnvelope(formatForgedEvidence(forgedRestoreInventory))).toThrow();
		const forgedPayloadInventory = {
			...published.envelope.receipt,
			payloadInventorySha256: "0".repeat(64),
			restoreRehearsal: {
				...published.envelope.receipt.restoreRehearsal,
				inventorySha256: "0".repeat(64),
			},
		};
		expect(() => verifyFixtureBackupEvidenceEnvelope(formatForgedEvidence(forgedPayloadInventory))).toThrow();
		const forgedSidecarSource = {
			...published.envelope.receipt,
			entries: [
				{ ...firstEntry, sourcePath: `${firstEntry.sourcePath}-wal` },
				...published.envelope.receipt.entries.slice(1),
			],
		};
		expect(() => verifyFixtureBackupEvidenceEnvelope(formatForgedEvidence(forgedSidecarSource))).toThrow();
		const forgedOrdinarySourceDigest = {
			...published.envelope.receipt,
			entries: [
				{
					...firstEntry,
					sourceObservation: { ...firstEntry.sourceObservation, sourceBytesSha256: "0".repeat(64) },
				},
				...published.envelope.receipt.entries.slice(1),
			],
		};
		expect(() => verifyFixtureBackupEvidenceEnvelope(formatForgedEvidence(forgedOrdinarySourceDigest))).toThrow();
		const secondEntry = published.envelope.receipt.entries[1];
		if (secondEntry === undefined) throw new Error("second fixture entry missing");
		const forgedDuplicateSource = {
			...published.envelope.receipt,
			entries: [firstEntry, { ...secondEntry, sourcePath: firstEntry.sourcePath }],
		};
		expect(() => verifyFixtureBackupEvidenceEnvelope(formatForgedEvidence(forgedDuplicateSource))).toThrow();
	});

	it("rejects unsafe source modes, hard links, and lexical boundary escapes before publication", async () => {
		const unsafeModePaths = makeRoot();
		const unsafeModeFile = join(unsafeModePaths.sourceBoundary, "config.json");
		writeFileSync(unsafeModeFile, "{}\n", { mode: 0o644 });
		const unsafeModeEntries = [
			{
				id: "entry_0000000000000001",
				role: "jarvis_config",
				sourcePath: unsafeModeFile,
				archivePath: "config/jarvis.json",
			},
		] as const satisfies ReadonlyArray<FixtureBackupEntry>;
		await expect(
			runFixtureBackupRestore(makeRequest(unsafeModePaths, unsafeModeEntries, null), runtimeOptions()),
		).rejects.toMatchObject({
			code: "unsafe_mode",
		});

		const hardlinkPaths = makeRoot();
		const linked = join(hardlinkPaths.sourceBoundary, "config.json");
		writeFileSync(linked, "{}\n", { mode: 0o600 });
		linkSync(linked, join(hardlinkPaths.sourceBoundary, "alias.json"));
		const linkedEntries = [
			{
				id: "entry_0000000000000001",
				role: "jarvis_config",
				sourcePath: linked,
				archivePath: "config/jarvis.json",
			},
		] as const satisfies ReadonlyArray<FixtureBackupEntry>;
		await expect(
			runFixtureBackupRestore(makeRequest(hardlinkPaths, linkedEntries, null), runtimeOptions()),
		).rejects.toMatchObject({
			code: "unsafe_link",
		});

		const escaped = {
			...makeRequest(hardlinkPaths, [], null).request,
			outputParent: join(hardlinkPaths.sourceBoundary, "nested"),
		};
		expect(() => decodeFixtureBackupRequest(escaped)).toThrow();
		for (const suffix of ["-wal", "-shm", "-journal"]) {
			for (const role of ["jarvis_config", "meeting_publication_sqlite"] as const) {
				const sidecarEntry = [
					{
						id: "entry_0000000000000001",
						role,
						sourcePath: join(hardlinkPaths.sourceBoundary, `database.sqlite3${suffix}`),
						archivePath: "database.sqlite3",
					},
				] as const satisfies ReadonlyArray<FixtureBackupEntry>;
				expect(() => makeRequest(hardlinkPaths, sidecarEntry, null)).toThrow();
			}
		}

		const mislabeledPaths = makeRoot();
		const mislabeledSqlite = join(mislabeledPaths.sourceBoundary, "state.bin");
		createSqlite(mislabeledSqlite);
		const mislabeledEntry = [
			{
				id: "entry_0000000000000001",
				role: "jarvis_config" as const,
				sourcePath: mislabeledSqlite,
				archivePath: "config/state.bin",
			},
		] satisfies ReadonlyArray<FixtureBackupEntry>;
		await expect(
			runFixtureBackupRestore(makeRequest(mislabeledPaths, mislabeledEntry, null), runtimeOptions()),
		).rejects.toMatchObject({ code: "source_role_mismatch" });
	});

	it("rejects an observed ordinary-file replacement and removes only owned partial output", async () => {
		const paths = makeRoot();
		const { configPath, entries } = basicEntries(paths.sourceBoundary);
		const request = makeRequest(paths, [entries[0]], null);
		let replaced = false;
		await expect(
			runFixtureBackupRestore(request, {
				...runtimeOptions(),
				hooks: {
					beforeSourceFinalValidation: (entry) => {
						if (entry.sourcePath !== configPath || replaced) return;
						replaced = true;
						renameSync(configPath, `${configPath}.old`);
						writeFileSync(configPath, '{"changed":true}\n', { mode: 0o600 });
					},
				},
			}),
		).rejects.toMatchObject({ code: "source_replaced" });
		expect(replaced).toBe(true);
		expect(readdirSync(paths.outputParent)).toEqual([]);
	});

	it("rejects candidate replacement before publication without following the injected symlink", async () => {
		const paths = makeRoot();
		const { entries } = basicEntries(paths.sourceBoundary);
		const target = join(paths.sourceBoundary, "target.json");
		writeFileSync(target, "do-not-touch\n", { mode: 0o600 });
		const before = readFileSync(target, "utf8");
		await expect(
			runFixtureBackupRestore(makeRequest(paths, [entries[0]], null), {
				...runtimeOptions(),
				hooks: {
					beforePublish: ({ stagingRoot }) => {
						const candidate = join(stagingRoot, "payload/config/jarvis.json");
						unlinkSync(candidate);
						symlinkSync(target, candidate);
					},
				},
			}),
		).rejects.toBeInstanceOf(FixtureBackupRuntimeError);
		expect(readFileSync(target, "utf8")).toBe(before);
		expect(readdirSync(paths.outputParent)).toEqual([]);
	});

	it("fails closed on lock contention and never overwrites a published bundle", async () => {
		const lockPaths = makeRoot();
		const { entries: lockEntries } = basicEntries(lockPaths.sourceBoundary);
		const lockedRequest = makeRequest(lockPaths, [lockEntries[0]], null);
		const backupId = `backup_${lockedRequest.requestSha256.slice(0, 32)}`;
		const lockPath = join(lockPaths.outputParent, `.${backupId}.lock`);
		writeFileSync(lockPath, "held\n", { mode: 0o600 });
		await expect(runFixtureBackupRestore(lockedRequest, runtimeOptions())).rejects.toMatchObject({
			code: "lock_unavailable",
		});
		expect(readFileSync(lockPath, "utf8")).toBe("held\n");

		const outputPaths = makeRoot();
		const { entries: outputEntries } = basicEntries(outputPaths.sourceBoundary);
		const request = makeRequest(outputPaths, [outputEntries[0]], null);
		const first = await runFixtureBackupRestore(request, runtimeOptions());
		const before = readFileSync(first.evidencePath, "utf8");
		await expect(runFixtureBackupRestore(request, runtimeOptions())).rejects.toMatchObject({ code: "output_exists" });
		expect(readFileSync(first.evidencePath, "utf8")).toBe(before);
	});

	it("rejects lock permission drift before publication", async () => {
		const paths = makeRoot();
		const { entries } = basicEntries(paths.sourceBoundary);
		const request = makeRequest(paths, [entries[0]], null);
		const backupId = `backup_${request.requestSha256.slice(0, 32)}`;
		await expect(
			runFixtureBackupRestore(request, {
				...runtimeOptions(),
				hooks: {
					beforePublish: () => chmodSync(join(paths.outputParent, `.${backupId}.lock`), 0o644),
				},
			}),
		).rejects.toBeInstanceOf(FixtureBackupRuntimeError);
		expect(readdirSync(paths.outputParent)).toEqual([]);
	});

	it("rejects payload-directory permission drift before publication", async () => {
		const paths = makeRoot();
		const { entries } = basicEntries(paths.sourceBoundary);
		await expect(
			runFixtureBackupRestore(makeRequest(paths, [entries[0]], null), {
				...runtimeOptions(),
				hooks: {
					beforePublish: ({ stagingRoot }) => chmodSync(join(stagingRoot, "payload/config"), 0o755),
				},
			}),
		).rejects.toBeInstanceOf(FixtureBackupRuntimeError);
		expect(readdirSync(paths.outputParent)).toEqual([]);
	});

	it("rejects an unexpected path in the independently observed restore inventory", async () => {
		const paths = makeRoot();
		const { entries } = basicEntries(paths.sourceBoundary);
		await expect(
			runFixtureBackupRestore(makeRequest(paths, [entries[0]], null), {
				...runtimeOptions(),
				hooks: {
					beforeRestoreValidation: ({ restoreRoot }) =>
						writeFileSync(join(restoreRoot, "unexpected.txt"), "not-in-request\n", { mode: 0o600 }),
				},
			}),
		).rejects.toMatchObject({ code: "restore_failed" });
		expect(readdirSync(paths.outputParent)).toEqual([]);
	});

	it("uses SQLite online backup against a concurrent WAL writer and emits a standalone valid snapshot", async () => {
		const paths = makeRoot();
		const sqlitePath = join(paths.sourceBoundary, "meeting.sqlite3");
		createSqlite(sqlitePath, 2_000);
		const writer = new DatabaseSync(sqlitePath);
		writer.exec("PRAGMA journal_mode = WAL");
		const entries = [
			{
				id: "entry_0000000000000001",
				role: "meeting_publication_sqlite",
				sourcePath: sqlitePath,
				archivePath: "meeting/meeting.sqlite3",
			},
		] as const satisfies ReadonlyArray<FixtureBackupEntry>;
		let wroteDuringBackup = false;
		const published = await runFixtureBackupRestore(makeRequest(paths, entries, null), {
			...runtimeOptions(),
			hooks: {
				onSqliteProgress: () => {
					if (wroteDuringBackup) return;
					wroteDuringBackup = true;
					writer.prepare("INSERT INTO evidence (value) VALUES (?)").run("concurrent-commit");
				},
			},
		});
		writer.close();
		expect(wroteDuringBackup).toBe(true);
		const snapshotPath = join(published.finalRoot, "payload/meeting/meeting.sqlite3");
		expect(existsSync(`${snapshotPath}-wal`)).toBe(false);
		expect(existsSync(`${snapshotPath}-shm`)).toBe(false);
		const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
		expect(snapshot.prepare("PRAGMA quick_check(1)").get()).toEqual({ quick_check: "ok" });
		expect(snapshot.prepare("SELECT count(*) AS count FROM evidence").get()).toEqual({ count: 2_001 });
		snapshot.close();
	});

	it("rejects unsupported Windows before touching nonexistent fixture paths", async () => {
		const paths = makeRoot();
		const request = makeRequest(paths, [], null);
		rmSync(paths.root, { recursive: true, force: true });
		roots.splice(roots.indexOf(paths.root), 1);
		await expect(
			runFixtureBackupRestore(request, {
				now: () => completedAt,
				platform: "win32",
				getuid: () => undefined,
			}),
		).rejects.toMatchObject({ code: "platform_unsupported" });
	});

	it("detects a published payload checksum change", async () => {
		const paths = makeRoot();
		const { entries } = basicEntries(paths.sourceBoundary);
		const request = makeRequest(paths, [entries[0]], null);
		const published = await runFixtureBackupRestore(request, runtimeOptions());
		writeFileSync(join(published.finalRoot, "payload/config/jarvis.json"), "tampered\n", { mode: 0o600 });
		expect(() => verifyPublishedFixtureBackup(published.finalRoot, request.requestSha256)).toThrowError(
			expect.objectContaining({ code: "publication_failed" }),
		);
	});

	it("binds published owner evidence to the executing POSIX uid", async () => {
		const paths = makeRoot();
		const { entries } = basicEntries(paths.sourceBoundary);
		const request = makeRequest(paths, [entries[0]], null);
		const published = await runFixtureBackupRestore(request, runtimeOptions());
		const actualUid = process.getuid?.();
		if (actualUid === undefined) throw new Error("POSIX uid unavailable in fixture test");
		const forgedUid = String(actualUid + 1);
		const forgedReceipt = {
			...published.envelope.receipt,
			platform: { ...published.envelope.receipt.platform, uid: forgedUid },
			entries: published.envelope.receipt.entries.map((entry) => ({
				...entry,
				sourceObservation: { ...entry.sourceObservation, uid: forgedUid },
			})),
		};
		const forgedEvidence = formatForgedEvidence(forgedReceipt);
		expect(() => verifyFixtureBackupEvidenceEnvelope(forgedEvidence)).not.toThrow();
		writeFileSync(published.evidencePath, forgedEvidence, { mode: 0o600 });
		expect(() => verifyPublishedFixtureBackup(published.finalRoot, request.requestSha256)).toThrowError(
			expect.objectContaining({ code: "publication_failed" }),
		);
	});
});

it("keeps request canonicalization deterministic and rejects extra keys", () => {
	const paths = makeRoot();
	const envelope = makeRequest(paths, [], null);
	expect(formatFixtureBackupRequestEnvelope(envelope)).toBe(
		`${fixtureCanonicalJson({ request: envelope.request, requestSha256: envelope.requestSha256 })}\n`,
	);
	expect(() => decodeFixtureBackupRequest({ ...envelope.request, activate: true })).toThrow();
});
