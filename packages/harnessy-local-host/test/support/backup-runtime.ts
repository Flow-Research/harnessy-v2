import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
	assertFixtureAbsolutePath,
	decodeFixtureBackupRequest,
	type FixtureBackupArtifactEvidence,
	type FixtureBackupEntry,
	type FixtureBackupEntryEvidence,
	type FixtureBackupEvidenceEnvelope,
	type FixtureBackupEvidenceReceipt,
	type FixtureBackupRequestEnvelope,
	type FixtureBackupRestoreArtifactEvidence,
	type FixtureBackupSourceObservation,
	type FixtureBackupSqliteValidation,
	fixtureCanonicalJson,
	fixturePayloadInventorySha256,
	fixtureSha256,
	formatFixtureBackupEvidenceEnvelope,
	formatFixtureBackupRequestEnvelope,
	isSqliteBackupRole,
	makeFixtureBackupEvidenceEnvelope,
	verifyFixtureBackupEvidenceEnvelope,
	verifyFixtureBackupRequestEnvelope,
} from "./backup-contract.ts";

const MAX_FILE_BYTES = 256n * 1024n * 1024n;
const MAX_TOTAL_BYTES = 1024n * 1024n * 1024n;
const MAX_SQLITE_PROGRESS_CALLBACKS = 100_000;
const COPY_BUFFER_BYTES = 64 * 1024;
const SQLITE_FILE_HEADER = Buffer.from("SQLite format 3\0", "utf8");

type SupportedPlatform = "darwin" | "linux";

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

interface CapturedEntry {
	readonly request: FixtureBackupEntry;
	readonly sourceObservation: FixtureBackupSourceObservation;
	readonly backupArtifact: FixtureBackupArtifactEvidence;
	readonly sqliteValidation: FixtureBackupSqliteValidation | null;
	readonly candidatePath: string;
}

export interface FixtureBackupRuntimeHooks {
	readonly beforeSourceFinalValidation?: (entry: FixtureBackupEntry) => void;
	readonly onSqliteProgress?: (
		entry: FixtureBackupEntry,
		progress: { readonly totalPages: number; readonly remainingPages: number },
	) => void;
	readonly beforeRestoreEntry?: (entry: FixtureBackupEntry, candidatePath: string) => void;
	readonly beforeRestoreValidation?: (input: { readonly restoreRoot: string }) => void;
	readonly beforePublish?: (input: {
		readonly stagingRoot: string;
		readonly finalRoot: string;
		readonly evidencePath: string;
	}) => void;
}

export interface FixtureBackupRuntimeOptions {
	readonly now: () => string;
	readonly platform?: string;
	readonly arch?: string;
	readonly nodeVersion?: string;
	readonly getuid?: () => number | undefined;
	readonly hooks?: FixtureBackupRuntimeHooks;
}

export interface PublishedFixtureBackup {
	readonly finalRoot: string;
	readonly evidencePath: string;
	readonly evidenceText: string;
	readonly envelope: FixtureBackupEvidenceEnvelope;
}

export class FixtureBackupRuntimeError extends Error {
	readonly code:
		| "platform_unsupported"
		| "unsafe_fixture_root"
		| "unsafe_path"
		| "unsafe_owner"
		| "unsafe_mode"
		| "unsafe_link"
		| "source_role_mismatch"
		| "source_replaced"
		| "file_too_large"
		| "backup_too_large"
		| "output_exists"
		| "lock_unavailable"
		| "sqlite_backup_failed"
		| "sqlite_invalid"
		| "restore_failed"
		| "publication_failed"
		| "unsafe_cleanup";

	constructor(code: FixtureBackupRuntimeError["code"], options?: ErrorOptions) {
		super("Fixture backup runtime failed", options);
		this.name = "FixtureBackupRuntimeError";
		this.code = code;
	}
}

const isWithin = (parent: string, child: string) => {
	const path = relative(parent, child);
	return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
};

const modeText = (mode: bigint) =>
	Number(mode & 0o777n)
		.toString(8)
		.padStart(4, "0");

const sameIdentity = (left: FileIdentity, right: FileIdentity) => left.dev === right.dev && left.ino === right.ino;

const sameStableFile = (left: BigIntStats, right: BigIntStats) =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.uid === right.uid &&
	left.mode === right.mode &&
	left.nlink === right.nlink &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs &&
	left.ctimeNs === right.ctimeNs;

const pathStatOrNull = (path: string): BigIntStats | null => {
	try {
		return lstatSync(path, { bigint: true });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw cause;
	}
};

const requireSupportedPlatform = (options: FixtureBackupRuntimeOptions) => {
	const platform = options.platform ?? process.platform;
	if (platform !== "darwin" && platform !== "linux") throw new FixtureBackupRuntimeError("platform_unsupported");
	const uid = (options.getuid ?? process.getuid)?.();
	if (!Number.isSafeInteger(uid) || uid === undefined || uid < 0) {
		throw new FixtureBackupRuntimeError("platform_unsupported");
	}
	return { platform: platform as SupportedPlatform, uid };
};

const assertOwnedDirectory = (path: string, uid: number, exactMode?: "0700"): BigIntStats => {
	const stat = lstatSync(path, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
		throw new FixtureBackupRuntimeError("unsafe_path");
	}
	if (stat.uid !== BigInt(uid)) throw new FixtureBackupRuntimeError("unsafe_owner");
	const mode = modeText(stat.mode);
	if (Number(stat.mode & 0o077n) !== 0 || (exactMode !== undefined && mode !== exactMode)) {
		throw new FixtureBackupRuntimeError("unsafe_mode");
	}
	return stat;
};

const setAndSyncDirectoryMode = (path: string) => {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		fchmodSync(descriptor, 0o700);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
};

const assertSafeAncestors = (fixtureRoot: string, path: string, uid: number) => {
	const relativePath = relative(fixtureRoot, dirname(path));
	if (relativePath === "" || relativePath === ".") return;
	if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
		throw new FixtureBackupRuntimeError("unsafe_path");
	}
	let current = fixtureRoot;
	for (const segment of relativePath.split(sep)) {
		current = join(current, segment);
		assertOwnedDirectory(current, uid);
	}
};

const assertFixtureRoot = (fixtureRoot: string, uid: number) => {
	const temporaryRoot = realpathSync(tmpdir());
	if (
		!isWithin(temporaryRoot, fixtureRoot) ||
		!basename(fixtureRoot).startsWith("harnessy-backup-fixture-") ||
		realpathSync(fixtureRoot) !== fixtureRoot
	) {
		throw new FixtureBackupRuntimeError("unsafe_fixture_root");
	}
	return assertOwnedDirectory(fixtureRoot, uid, "0700");
};

const assertSourceFile = (fixtureRoot: string, path: string, uid: number): BigIntStats => {
	assertSafeAncestors(fixtureRoot, path, uid);
	const stat = lstatSync(path, { bigint: true });
	if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
		throw new FixtureBackupRuntimeError("unsafe_path");
	}
	if (stat.nlink !== 1n) throw new FixtureBackupRuntimeError("unsafe_link");
	if (stat.uid !== BigInt(uid)) throw new FixtureBackupRuntimeError("unsafe_owner");
	const mode = modeText(stat.mode);
	if (mode !== "0400" && mode !== "0600") throw new FixtureBackupRuntimeError("unsafe_mode");
	if (stat.size > MAX_FILE_BYTES) throw new FixtureBackupRuntimeError("file_too_large");
	return stat;
};

const assertStableAgainst = (path: string, before: BigIntStats, opened?: BigIntStats) => {
	const after = lstatSync(path, { bigint: true });
	if (!sameStableFile(before, after) || (opened !== undefined && !sameStableFile(before, opened))) {
		throw new FixtureBackupRuntimeError("source_replaced");
	}
	return after;
};

const openExclusiveFile = (path: string) =>
	openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);

const descriptorHasSqliteHeader = (descriptor: number) => {
	const header = Buffer.alloc(SQLITE_FILE_HEADER.length);
	const bytesRead = readSync(descriptor, header, 0, header.length, 0);
	return bytesRead === header.length && header.equals(SQLITE_FILE_HEADER);
};

const bytesHaveSqliteHeader = (bytes: Uint8Array) =>
	bytes.length >= SQLITE_FILE_HEADER.length &&
	Buffer.from(bytes.subarray(0, SQLITE_FILE_HEADER.length)).equals(SQLITE_FILE_HEADER);

const writeCanonicalFile = (path: string, text: string) => {
	const descriptor = openExclusiveFile(path);
	try {
		fchmodSync(descriptor, 0o600);
		const bytes = Buffer.from(text, "utf8");
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
};

const hashDescriptorCopy = (sourceDescriptor: number, targetDescriptor: number, maximumBytes: bigint) => {
	const hash = createHash("sha256");
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	let size = 0n;
	for (;;) {
		const count = readSync(sourceDescriptor, buffer, 0, buffer.length, null);
		if (count === 0) break;
		size += BigInt(count);
		if (size > maximumBytes) throw new FixtureBackupRuntimeError("file_too_large");
		hash.update(buffer.subarray(0, count));
		let written = 0;
		while (written < count) written += writeSync(targetDescriptor, buffer, written, count - written);
	}
	return { sha256: hash.digest("hex"), size };
};

const readOwnedFile = (path: string, uid: number, allowedModes: ReadonlyArray<string>) => {
	const before = lstatSync(path, { bigint: true });
	if (
		!before.isFile() ||
		before.isSymbolicLink() ||
		before.nlink !== 1n ||
		before.uid !== BigInt(uid) ||
		!allowedModes.includes(modeText(before.mode)) ||
		realpathSync(path) !== path
	) {
		throw new FixtureBackupRuntimeError("unsafe_path");
	}
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		if (!sameStableFile(before, opened)) throw new FixtureBackupRuntimeError("source_replaced");
		const bytes = readFileSync(descriptor);
		const finalOpened = fstatSync(descriptor, { bigint: true });
		if (!sameStableFile(opened, finalOpened)) throw new FixtureBackupRuntimeError("source_replaced");
		assertStableAgainst(path, before, finalOpened);
		return { bytes, stat: before, sha256: fixtureSha256(bytes) };
	} finally {
		closeSync(descriptor);
	}
};

const makeArchiveParents = (payloadRoot: string, archivePath: string, uid: number) => {
	const parent = dirname(archivePath);
	if (parent === ".") return;
	let current = payloadRoot;
	for (const segment of parent.split("/")) {
		current = join(current, segment);
		if (!existsSync(current)) {
			mkdirSync(current, { mode: 0o700 });
			setAndSyncDirectoryMode(current);
		}
		assertOwnedDirectory(current, uid, "0700");
	}
};

const sqliteScalar = (database: DatabaseSync, sql: string) => {
	const row = database.prepare(sql).get();
	if (row === undefined) throw new FixtureBackupRuntimeError("sqlite_invalid");
	const values = Object.values(row);
	if (values.length !== 1) throw new FixtureBackupRuntimeError("sqlite_invalid");
	return values[0];
};

const validateSqlite = (path: string): FixtureBackupSqliteValidation => {
	const database = new DatabaseSync(path, {
		readOnly: true,
		allowExtension: false,
		enableForeignKeyConstraints: false,
		timeout: 1_000,
	});
	try {
		if (sqliteScalar(database, "PRAGMA quick_check(1)") !== "ok") {
			throw new FixtureBackupRuntimeError("sqlite_invalid");
		}
		const userVersion = sqliteScalar(database, "PRAGMA user_version");
		const pageCount = sqliteScalar(database, "PRAGMA page_count");
		if (!Number.isSafeInteger(userVersion) || (userVersion as number) < 0) {
			throw new FixtureBackupRuntimeError("sqlite_invalid");
		}
		if (!Number.isSafeInteger(pageCount) || (pageCount as number) < 0) {
			throw new FixtureBackupRuntimeError("sqlite_invalid");
		}
		return { quickCheck: "ok", userVersion: userVersion as number, pageCount: String(pageCount) };
	} finally {
		database.close();
	}
};

const makeSqliteSnapshotStandalone = (path: string) => {
	const database = new DatabaseSync(path, {
		allowExtension: false,
		enableForeignKeyConstraints: false,
		timeout: 1_000,
	});
	try {
		if (sqliteScalar(database, "PRAGMA journal_mode = DELETE") !== "delete") {
			throw new FixtureBackupRuntimeError("sqlite_invalid");
		}
	} finally {
		database.close();
	}
	for (const suffix of ["-journal", "-shm", "-wal"]) {
		if (pathStatOrNull(`${path}${suffix}`) !== null) {
			throw new FixtureBackupRuntimeError("sqlite_invalid");
		}
	}
};

const sourceObservation = (stat: BigIntStats, sourceBytesSha256: string | null): FixtureBackupSourceObservation => {
	const mode = modeText(stat.mode);
	if (mode !== "0400" && mode !== "0600") throw new FixtureBackupRuntimeError("unsafe_mode");
	return {
		dev: String(stat.dev),
		ino: String(stat.ino),
		uid: String(stat.uid),
		mode,
		nlink: "1",
		sizeBytes: String(stat.size),
		mtimeNs: String(stat.mtimeNs),
		ctimeNs: String(stat.ctimeNs),
		pathnameStableObserved: true,
		sourceBytesSha256,
	};
};

const finalizeCandidate = (path: string, uid: number) => {
	const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
	try {
		fchmodSync(descriptor, 0o600);
		fsyncSync(descriptor);
		const opened = fstatSync(descriptor, { bigint: true });
		const pathname = lstatSync(path, { bigint: true });
		if (
			!opened.isFile() ||
			!pathname.isFile() ||
			opened.uid !== BigInt(uid) ||
			opened.nlink !== 1n ||
			modeText(opened.mode) !== "0600" ||
			!sameStableFile(opened, pathname)
		) {
			throw new FixtureBackupRuntimeError("source_replaced");
		}
		return opened;
	} finally {
		closeSync(descriptor);
	}
};

const captureOrdinaryFile = (
	fixtureRoot: string,
	entry: FixtureBackupEntry,
	candidatePath: string,
	uid: number,
	hooks: FixtureBackupRuntimeHooks | undefined,
): CapturedEntry => {
	const before = assertSourceFile(fixtureRoot, entry.sourcePath, uid);
	const sourceDescriptor = openSync(entry.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let targetDescriptor: number | undefined;
	try {
		const opened = fstatSync(sourceDescriptor, { bigint: true });
		if (!sameStableFile(before, opened)) throw new FixtureBackupRuntimeError("source_replaced");
		if (descriptorHasSqliteHeader(sourceDescriptor)) {
			throw new FixtureBackupRuntimeError("source_role_mismatch");
		}
		targetDescriptor = openExclusiveFile(candidatePath);
		const copied = hashDescriptorCopy(sourceDescriptor, targetDescriptor, MAX_FILE_BYTES);
		fchmodSync(targetDescriptor, 0o600);
		fsyncSync(targetDescriptor);
		hooks?.beforeSourceFinalValidation?.(entry);
		const finalSource = fstatSync(sourceDescriptor, { bigint: true });
		assertStableAgainst(entry.sourcePath, before, finalSource);
		const finalTarget = fstatSync(targetDescriptor, { bigint: true });
		const targetPath = lstatSync(candidatePath, { bigint: true });
		if (
			!finalTarget.isFile() ||
			finalTarget.uid !== BigInt(uid) ||
			finalTarget.nlink !== 1n ||
			modeText(finalTarget.mode) !== "0600" ||
			!sameStableFile(finalTarget, targetPath) ||
			finalTarget.size !== copied.size
		) {
			throw new FixtureBackupRuntimeError("source_replaced");
		}
		return {
			request: entry,
			sourceObservation: sourceObservation(before, copied.sha256),
			backupArtifact: {
				relativePath: `payload/${entry.archivePath}`,
				sha256: copied.sha256,
				sizeBytes: String(copied.size),
				mode: "0600",
				nlink: "1",
			},
			sqliteValidation: null,
			candidatePath,
		};
	} finally {
		if (targetDescriptor !== undefined) closeSync(targetDescriptor);
		closeSync(sourceDescriptor);
	}
};

const captureSqliteFile = async (
	fixtureRoot: string,
	entry: FixtureBackupEntry,
	candidatePath: string,
	uid: number,
	hooks: FixtureBackupRuntimeHooks | undefined,
): Promise<CapturedEntry> => {
	const before = assertSourceFile(fixtureRoot, entry.sourcePath, uid);
	let progressCallbacks = 0;
	const database = new DatabaseSync(entry.sourcePath, {
		readOnly: true,
		allowExtension: false,
		enableForeignKeyConstraints: false,
		timeout: 1_000,
	});
	try {
		await backup(database, candidatePath, {
			rate: 1,
			progress: (progress) => {
				progressCallbacks += 1;
				if (progressCallbacks > MAX_SQLITE_PROGRESS_CALLBACKS) {
					throw new FixtureBackupRuntimeError("sqlite_backup_failed");
				}
				hooks?.onSqliteProgress?.(entry, progress);
			},
		});
	} catch (cause) {
		if (cause instanceof FixtureBackupRuntimeError) throw cause;
		throw new FixtureBackupRuntimeError("sqlite_backup_failed", { cause });
	} finally {
		database.close();
	}
	makeSqliteSnapshotStandalone(candidatePath);
	finalizeCandidate(candidatePath, uid);
	hooks?.beforeSourceFinalValidation?.(entry);
	assertStableAgainst(entry.sourcePath, before);
	const artifact = readOwnedFile(candidatePath, uid, ["0600"]);
	if (artifact.stat.size > MAX_FILE_BYTES) throw new FixtureBackupRuntimeError("file_too_large");
	return {
		request: entry,
		sourceObservation: sourceObservation(before, null),
		backupArtifact: {
			relativePath: `payload/${entry.archivePath}`,
			sha256: artifact.sha256,
			sizeBytes: String(artifact.stat.size),
			mode: "0600",
			nlink: "1",
		},
		sqliteValidation: validateSqlite(candidatePath),
		candidatePath,
	};
};

const copyForRestore = (
	captured: CapturedEntry,
	restorePath: string,
	uid: number,
): FixtureBackupRestoreArtifactEvidence => {
	const source = readOwnedFile(captured.candidatePath, uid, ["0600"]);
	if (
		source.sha256 !== captured.backupArtifact.sha256 ||
		String(source.stat.size) !== captured.backupArtifact.sizeBytes
	) {
		throw new FixtureBackupRuntimeError("restore_failed");
	}
	const sourceDescriptor = openSync(captured.candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
	const targetDescriptor = openExclusiveFile(restorePath);
	try {
		const copied = hashDescriptorCopy(sourceDescriptor, targetDescriptor, MAX_FILE_BYTES);
		const restoredMode = captured.sourceObservation.mode === "0400" ? 0o400 : 0o600;
		fchmodSync(targetDescriptor, restoredMode);
		fsyncSync(targetDescriptor);
		if (copied.sha256 !== source.sha256 || String(copied.size) !== captured.backupArtifact.sizeBytes) {
			throw new FixtureBackupRuntimeError("restore_failed");
		}
	} finally {
		closeSync(targetDescriptor);
		closeSync(sourceDescriptor);
	}
	const restored = readOwnedFile(restorePath, uid, [captured.sourceObservation.mode]);
	if (
		restored.sha256 !== captured.backupArtifact.sha256 ||
		String(restored.stat.size) !== captured.backupArtifact.sizeBytes
	) {
		throw new FixtureBackupRuntimeError("restore_failed");
	}
	let sqliteQuickCheck: "ok" | null = null;
	if (isSqliteBackupRole(captured.request.role)) {
		const validation = validateSqlite(restorePath);
		if (
			captured.sqliteValidation === null ||
			validation.userVersion !== captured.sqliteValidation.userVersion ||
			validation.pageCount !== captured.sqliteValidation.pageCount
		) {
			throw new FixtureBackupRuntimeError("restore_failed");
		}
		sqliteQuickCheck = "ok";
	}
	return {
		sha256: restored.sha256,
		sizeBytes: String(restored.stat.size),
		mode: captured.sourceObservation.mode,
		equalsBackup: true,
		sqliteQuickCheck,
	};
};

const safeRemoveOwnedDirectory = (path: string | undefined, identity: FileIdentity | undefined) => {
	if (path === undefined || identity === undefined) return;
	const stat = pathStatOrNull(path);
	if (stat === null) return;
	if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, identity)) {
		throw new FixtureBackupRuntimeError("unsafe_cleanup");
	}
	rmSync(path, { recursive: true, force: false });
};

const removeOwnedLock = (
	path: string | undefined,
	descriptor: number | undefined,
	identity: FileIdentity | undefined,
) => {
	if (descriptor === undefined) return;
	try {
		if (path !== undefined) {
			const opened = fstatSync(descriptor, { bigint: true });
			const expectedIdentity = identity ?? { dev: opened.dev, ino: opened.ino };
			const stat = pathStatOrNull(path);
			if (stat !== null) {
				if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, expectedIdentity)) {
					throw new FixtureBackupRuntimeError("unsafe_cleanup");
				}
				unlinkSync(path);
			}
		}
	} finally {
		closeSync(descriptor);
	}
};

const expectedBundlePaths = (entries: ReadonlyArray<FixtureBackupEntryEvidence>) => {
	const paths = new Set(["evidence.json", "payload"]);
	for (const entry of entries) {
		let current = "payload";
		const segments = entry.archivePath.split("/");
		for (const segment of segments.slice(0, -1)) {
			current = `${current}/${segment}`;
			paths.add(current);
		}
		paths.add(`payload/${entry.archivePath}`);
	}
	return [...paths].sort();
};

const expectedRestorePaths = (entries: ReadonlyArray<FixtureBackupEntryEvidence>) => {
	const paths = new Set<string>();
	for (const entry of entries) {
		let current = "";
		const segments = entry.archivePath.split("/");
		for (const segment of segments.slice(0, -1)) {
			current = current === "" ? segment : `${current}/${segment}`;
			paths.add(current);
		}
		paths.add(entry.archivePath);
	}
	return [...paths].sort();
};

const bundlePaths = (root: string, uid: number) => {
	const paths: Array<string> = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const relativePath = relative(root, path).replaceAll("\\", "/");
			if (entry.isSymbolicLink()) throw new FixtureBackupRuntimeError("unsafe_path");
			if (entry.isDirectory()) {
				assertOwnedDirectory(path, uid, "0700");
				paths.push(relativePath);
				visit(path);
			} else if (entry.isFile()) paths.push(relativePath);
			else throw new FixtureBackupRuntimeError("unsafe_path");
		}
	};
	visit(root);
	return paths.sort();
};

const syncDirectory = (path: string) => {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
};

const syncOwnedDirectoryTree = (root: string, uid: number) => {
	assertOwnedDirectory(root, uid, "0700");
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) throw new FixtureBackupRuntimeError("unsafe_path");
		if (entry.isDirectory()) syncOwnedDirectoryTree(join(root, entry.name), uid);
		else if (!entry.isFile()) throw new FixtureBackupRuntimeError("unsafe_path");
	}
	syncDirectory(root);
};

const observeRestoredInventory = (
	restoreRoot: string,
	entries: ReadonlyArray<FixtureBackupEntryEvidence>,
	uid: number,
) => {
	const observedEntries = entries.map((entry) => {
		const restorePath = join(restoreRoot, ...entry.archivePath.split("/"));
		const restored = readOwnedFile(restorePath, uid, [entry.restoreArtifact.mode]);
		if (
			restored.sha256 !== entry.backupArtifact.sha256 ||
			String(restored.stat.size) !== entry.backupArtifact.sizeBytes ||
			modeText(restored.stat.mode) !== entry.restoreArtifact.mode
		) {
			throw new FixtureBackupRuntimeError("restore_failed");
		}
		if (entry.sqliteValidation !== null) {
			const validation = validateSqlite(restorePath);
			if (
				validation.userVersion !== entry.sqliteValidation.userVersion ||
				validation.pageCount !== entry.sqliteValidation.pageCount
			) {
				throw new FixtureBackupRuntimeError("restore_failed");
			}
		} else if (bytesHaveSqliteHeader(restored.bytes)) {
			throw new FixtureBackupRuntimeError("restore_failed");
		}
		return {
			id: entry.id,
			role: entry.role,
			archivePath: entry.archivePath,
			backupArtifact: {
				...entry.backupArtifact,
				sha256: restored.sha256,
				sizeBytes: String(restored.stat.size),
			},
		};
	});
	return fixturePayloadInventorySha256(observedEntries);
};

export const verifyPublishedFixtureBackup = (
	finalRoot: string,
	expectedRequestSha256: string,
	expectedUid = process.getuid?.(),
) => {
	if (expectedUid === undefined) throw new FixtureBackupRuntimeError("platform_unsupported");
	assertFixtureAbsolutePath(finalRoot);
	assertOwnedDirectory(finalRoot, expectedUid, "0700");
	const evidencePath = join(finalRoot, "evidence.json");
	const evidenceFile = readOwnedFile(evidencePath, expectedUid, ["0600"]);
	const evidenceText = evidenceFile.bytes.toString("utf8");
	const envelope = verifyFixtureBackupEvidenceEnvelope(evidenceText);
	if (
		envelope.receipt.requestSha256 !== expectedRequestSha256 ||
		envelope.receipt.boundaries.finalBackupRoot !== finalRoot ||
		envelope.receipt.platform.uid !== String(expectedUid) ||
		envelope.receipt.entries.some((entry) => entry.sourceObservation.uid !== envelope.receipt.platform.uid)
	) {
		throw new FixtureBackupRuntimeError("publication_failed");
	}
	if (fixturePayloadInventorySha256(envelope.receipt.entries) !== envelope.receipt.payloadInventorySha256) {
		throw new FixtureBackupRuntimeError("publication_failed");
	}
	if (
		fixtureCanonicalJson(bundlePaths(finalRoot, expectedUid)) !==
		fixtureCanonicalJson(expectedBundlePaths(envelope.receipt.entries))
	) {
		throw new FixtureBackupRuntimeError("publication_failed");
	}
	for (const entry of envelope.receipt.entries) {
		const artifact = readOwnedFile(join(finalRoot, entry.backupArtifact.relativePath), expectedUid, ["0600"]);
		if (
			artifact.sha256 !== entry.backupArtifact.sha256 ||
			String(artifact.stat.size) !== entry.backupArtifact.sizeBytes
		) {
			throw new FixtureBackupRuntimeError("publication_failed");
		}
		if (entry.sqliteValidation !== null) {
			const validation = validateSqlite(join(finalRoot, entry.backupArtifact.relativePath));
			if (
				validation.userVersion !== entry.sqliteValidation.userVersion ||
				validation.pageCount !== entry.sqliteValidation.pageCount
			) {
				throw new FixtureBackupRuntimeError("publication_failed");
			}
		} else if (bytesHaveSqliteHeader(artifact.bytes)) {
			throw new FixtureBackupRuntimeError("source_role_mismatch");
		}
	}
	return { evidencePath, evidenceText, envelope };
};

export const runFixtureBackupRestore = async (
	requestEnvelope: FixtureBackupRequestEnvelope,
	options: FixtureBackupRuntimeOptions,
): Promise<PublishedFixtureBackup> => {
	const envelope = verifyFixtureBackupRequestEnvelope(formatFixtureBackupRequestEnvelope(requestEnvelope));
	const request = decodeFixtureBackupRequest(envelope.request);
	const { platform, uid } = requireSupportedPlatform(options);
	assertFixtureRoot(request.fixtureRoot, uid);
	assertOwnedDirectory(request.sourceBoundary, uid, "0700");
	assertOwnedDirectory(request.outputParent, uid, "0700");
	const sourceIdentities = new Set<string>();
	for (const entry of request.entries) {
		const stat = assertSourceFile(request.fixtureRoot, entry.sourcePath, uid);
		const identity = `${stat.dev}:${stat.ino}`;
		if (sourceIdentities.has(identity)) throw new FixtureBackupRuntimeError("unsafe_link");
		sourceIdentities.add(identity);
	}

	const backupId = `backup_${envelope.requestSha256.slice(0, 32)}`;
	const finalRoot = resolve(request.outputParent, backupId);
	if (pathStatOrNull(finalRoot) !== null) throw new FixtureBackupRuntimeError("output_exists");
	const lockPath = join(request.outputParent, `.${backupId}.lock`);
	let lockDescriptor: number | undefined;
	let lockIdentity: FileIdentity | undefined;
	let lockBaseline: BigIntStats | undefined;
	let stagingRoot: string | undefined;
	let stagingIdentity: FileIdentity | undefined;
	let restoreRoot: string | undefined;
	let restoreIdentity: FileIdentity | undefined;
	let published = false;
	try {
		try {
			lockDescriptor = openExclusiveFile(lockPath);
		} catch (cause) {
			throw new FixtureBackupRuntimeError("lock_unavailable", { cause });
		}
		fchmodSync(lockDescriptor, 0o600);
		fsyncSync(lockDescriptor);
		const lockStat = fstatSync(lockDescriptor, { bigint: true });
		const lockPathStat = lstatSync(lockPath, { bigint: true });
		if (
			!lockStat.isFile() ||
			lockStat.uid !== BigInt(uid) ||
			lockStat.nlink !== 1n ||
			modeText(lockStat.mode) !== "0600" ||
			!sameStableFile(lockStat, lockPathStat)
		) {
			throw new FixtureBackupRuntimeError("lock_unavailable");
		}
		lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
		lockBaseline = lockStat;

		stagingRoot = mkdtempSync(join(request.outputParent, `.${backupId}.partial-`));
		setAndSyncDirectoryMode(stagingRoot);
		const stagingStat = assertOwnedDirectory(stagingRoot, uid, "0700");
		stagingIdentity = { dev: stagingStat.dev, ino: stagingStat.ino };
		const payloadRoot = join(stagingRoot, "payload");
		mkdirSync(payloadRoot, { mode: 0o700 });
		setAndSyncDirectoryMode(payloadRoot);

		const captured: Array<CapturedEntry> = [];
		let totalBytes = 0n;
		for (const entry of request.entries) {
			makeArchiveParents(payloadRoot, entry.archivePath, uid);
			const candidatePath = join(payloadRoot, ...entry.archivePath.split("/"));
			const result = isSqliteBackupRole(entry.role)
				? await captureSqliteFile(request.fixtureRoot, entry, candidatePath, uid, options.hooks)
				: captureOrdinaryFile(request.fixtureRoot, entry, candidatePath, uid, options.hooks);
			totalBytes += BigInt(result.backupArtifact.sizeBytes);
			if (totalBytes > MAX_TOTAL_BYTES) throw new FixtureBackupRuntimeError("backup_too_large");
			captured.push(result);
		}

		restoreRoot = mkdtempSync(join(request.outputParent, `.${backupId}.restore-`));
		setAndSyncDirectoryMode(restoreRoot);
		const restoreStat = assertOwnedDirectory(restoreRoot, uid, "0700");
		restoreIdentity = { dev: restoreStat.dev, ino: restoreStat.ino };
		const restoredEntries: Array<FixtureBackupEntryEvidence> = [];
		for (const item of captured) {
			options.hooks?.beforeRestoreEntry?.(item.request, item.candidatePath);
			makeArchiveParents(restoreRoot, item.request.archivePath, uid);
			const restored = copyForRestore(item, join(restoreRoot, ...item.request.archivePath.split("/")), uid);
			restoredEntries.push({
				id: item.request.id,
				role: item.request.role,
				sourcePath: item.request.sourcePath,
				archivePath: item.request.archivePath,
				captureMethod: isSqliteBackupRole(item.request.role)
					? "node_sqlite_online_backup"
					: "stable_descriptor_copy",
				sourceObservation: item.sourceObservation,
				backupArtifact: item.backupArtifact,
				sqliteValidation: item.sqliteValidation,
				restoreArtifact: restored,
			});
		}
		const payloadInventorySha256 = fixturePayloadInventorySha256(restoredEntries);
		options.hooks?.beforeRestoreValidation?.({ restoreRoot });
		syncOwnedDirectoryTree(restoreRoot, uid);
		if (
			fixtureCanonicalJson(bundlePaths(restoreRoot, uid)) !==
			fixtureCanonicalJson(expectedRestorePaths(restoredEntries))
		) {
			throw new FixtureBackupRuntimeError("restore_failed");
		}
		const restoredInventorySha256 = observeRestoredInventory(restoreRoot, restoredEntries, uid);
		if (restoredInventorySha256 !== payloadInventorySha256) {
			throw new FixtureBackupRuntimeError("restore_failed");
		}
		safeRemoveOwnedDirectory(restoreRoot, restoreIdentity);
		restoreRoot = undefined;
		restoreIdentity = undefined;

		const receipt: FixtureBackupEvidenceReceipt = {
			kind: "harnessy.local-host.fixture-backup.evidence",
			schemaVersion: 1,
			fixtureOnly: true,
			operationalEvidence: false,
			requestSha256: envelope.requestSha256,
			backupId,
			startedAt: request.createdAt,
			completedAt: options.now(),
			platform: {
				os: platform,
				arch: options.arch ?? process.arch,
				nodeVersion: options.nodeVersion ?? process.version,
				uid: String(uid),
				filesystemPolicy: "posix-local-filesystem-only",
				threatModel: "cooperative-owner-observed-replacement",
			},
			boundaries: {
				fixtureRoot: request.fixtureRoot,
				sourceBoundary: request.sourceBoundary,
				outputParent: request.outputParent,
				finalBackupRoot: finalRoot,
			},
			scope: request.scope,
			reviewToken: {
				sourcePath: request.reviewToken.sourcePath,
				disposition: "exclude_and_regenerate_after_authorized_activation",
				accessed: false,
				copied: false,
			},
			entries: restoredEntries,
			payloadInventorySha256,
			restoreRehearsal: {
				target: "ephemeral_new_empty_directory",
				overwrite: false,
				completed: true,
				inventorySha256: restoredInventorySha256,
				temporaryRootRemoved: true,
			},
			publication: {
				strategy: "same_parent_atomic_rename",
				overwrite: false,
				directoryMode: "0700",
				fileMode: "0600",
				stagingPathAbsentAfterRename: true,
				parentFsync: "required_before_success",
			},
		};
		const evidenceEnvelope = makeFixtureBackupEvidenceEnvelope(receipt);
		const evidenceText = formatFixtureBackupEvidenceEnvelope(evidenceEnvelope);
		const evidencePath = join(stagingRoot, "evidence.json");
		writeCanonicalFile(evidencePath, evidenceText);
		syncOwnedDirectoryTree(payloadRoot, uid);
		syncDirectory(stagingRoot);

		options.hooks?.beforePublish?.({ stagingRoot, finalRoot, evidencePath });
		assertOwnedDirectory(request.outputParent, uid, "0700");
		const finalLockStat = lstatSync(lockPath, { bigint: true });
		const finalOpenedLockStat = fstatSync(lockDescriptor, { bigint: true });
		const finalStagingStat = assertOwnedDirectory(stagingRoot, uid, "0700");
		if (
			lockIdentity === undefined ||
			lockBaseline === undefined ||
			stagingIdentity === undefined ||
			!sameStableFile(finalLockStat, lockBaseline) ||
			!sameStableFile(finalOpenedLockStat, lockBaseline) ||
			!sameIdentity(finalStagingStat, stagingIdentity) ||
			pathStatOrNull(finalRoot) !== null ||
			fixtureCanonicalJson(bundlePaths(stagingRoot, uid)) !==
				fixtureCanonicalJson(expectedBundlePaths(restoredEntries))
		) {
			throw new FixtureBackupRuntimeError("publication_failed");
		}
		for (const entry of restoredEntries) {
			const artifact = readOwnedFile(join(stagingRoot, entry.backupArtifact.relativePath), uid, ["0600"]);
			if (
				artifact.sha256 !== entry.backupArtifact.sha256 ||
				String(artifact.stat.size) !== entry.backupArtifact.sizeBytes
			) {
				throw new FixtureBackupRuntimeError("publication_failed");
			}
			if (entry.sqliteValidation === null && bytesHaveSqliteHeader(artifact.bytes)) {
				throw new FixtureBackupRuntimeError("source_role_mismatch");
			}
		}
		verifyFixtureBackupEvidenceEnvelope(readOwnedFile(evidencePath, uid, ["0600"]).bytes.toString("utf8"));
		renameSync(stagingRoot, finalRoot);
		published = true;
		stagingRoot = undefined;
		stagingIdentity = undefined;
		syncDirectory(request.outputParent);
		const verified = verifyPublishedFixtureBackup(finalRoot, envelope.requestSha256, uid);
		const publishedLockDescriptor = lockDescriptor;
		const publishedLockIdentity = lockIdentity;
		lockDescriptor = undefined;
		lockIdentity = undefined;
		lockBaseline = undefined;
		removeOwnedLock(lockPath, publishedLockDescriptor, publishedLockIdentity);
		syncDirectory(request.outputParent);
		return { finalRoot, ...verified };
	} catch (cause) {
		let cleanupError: unknown;
		try {
			safeRemoveOwnedDirectory(restoreRoot, restoreIdentity);
			if (!published) safeRemoveOwnedDirectory(stagingRoot, stagingIdentity);
			const cleanupLockDescriptor = lockDescriptor;
			const cleanupLockIdentity = lockIdentity;
			lockDescriptor = undefined;
			lockIdentity = undefined;
			lockBaseline = undefined;
			removeOwnedLock(lockPath, cleanupLockDescriptor, cleanupLockIdentity);
		} catch (error) {
			cleanupError = error;
		}
		if (cleanupError !== undefined) throw cleanupError;
		if (cause instanceof FixtureBackupRuntimeError) throw cause;
		throw new FixtureBackupRuntimeError(published ? "publication_failed" : "publication_failed", { cause });
	}
};

export const assertNoFixtureBackupDebris = (outputParent: string) => {
	const debris = readdirSync(outputParent).filter(
		(name) => name.startsWith(".backup_") || name.includes(".partial-") || name.includes(".restore-"),
	);
	if (debris.length > 0) throw new FixtureBackupRuntimeError("unsafe_cleanup");
};
