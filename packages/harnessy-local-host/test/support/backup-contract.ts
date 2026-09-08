import { createHash } from "node:crypto";
import { basename, isAbsolute, parse, relative, resolve, sep } from "node:path";

export const FIXTURE_BACKUP_SCHEMA_VERSION = 1 as const;

export const FIXTURE_BACKUP_ROLES = [
	"meeting_publication_sqlite",
	"community_briefing_sqlite",
	"meeting_review_log",
	"community_briefing_draft",
	"community_briefing_provenance",
	"jarvis_config",
	"jarvis_environment",
	"life_state",
	"cron_state",
	"scheduler_definition",
] as const;

export type FixtureBackupRole = (typeof FIXTURE_BACKUP_ROLES)[number];
export type FixtureBackupScopeDisposition = "included" | "not_configured";

export interface FixtureBackupScopeEntry {
	readonly role: FixtureBackupRole;
	readonly disposition: FixtureBackupScopeDisposition;
	readonly entryIds: ReadonlyArray<string>;
}

export interface FixtureBackupEntry {
	readonly id: string;
	readonly role: FixtureBackupRole;
	readonly sourcePath: string;
	readonly archivePath: string;
}

export interface FixtureBackupRequest {
	readonly kind: "harnessy.local-host.fixture-backup.request";
	readonly schemaVersion: 1;
	readonly fixtureOnly: true;
	readonly operationalEvidence: false;
	readonly createdAt: string;
	readonly platformPolicy: "posix-local-filesystem-only";
	readonly fixtureRoot: string;
	readonly sourceBoundary: string;
	readonly outputParent: string;
	readonly scope: ReadonlyArray<FixtureBackupScopeEntry>;
	readonly entries: ReadonlyArray<FixtureBackupEntry>;
	readonly reviewToken: {
		readonly sourcePath: string | null;
		readonly disposition: "exclude_and_regenerate_after_authorized_activation";
		readonly accessAllowed: false;
	};
	readonly restorePolicy: {
		readonly target: "ephemeral_new_empty_directory";
		readonly overwrite: false;
		readonly removeAfterVerification: true;
	};
	readonly publicationPolicy: {
		readonly strategy: "same_parent_atomic_rename";
		readonly overwrite: false;
	};
}

export interface FixtureBackupRequestEnvelope {
	readonly request: FixtureBackupRequest;
	readonly requestSha256: string;
}

export interface FixtureBackupSourceObservation {
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
	readonly mode: "0400" | "0600";
	readonly nlink: "1";
	readonly sizeBytes: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
	readonly pathnameStableObserved: true;
	readonly sourceBytesSha256: string | null;
}

export interface FixtureBackupArtifactEvidence {
	readonly relativePath: string;
	readonly sha256: string;
	readonly sizeBytes: string;
	readonly mode: "0600";
	readonly nlink: "1";
}

export interface FixtureBackupSqliteValidation {
	readonly quickCheck: "ok";
	readonly userVersion: number;
	readonly pageCount: string;
}

export interface FixtureBackupRestoreArtifactEvidence {
	readonly sha256: string;
	readonly sizeBytes: string;
	readonly mode: "0400" | "0600";
	readonly equalsBackup: true;
	readonly sqliteQuickCheck: "ok" | null;
}

export interface FixtureBackupEntryEvidence {
	readonly id: string;
	readonly role: FixtureBackupRole;
	readonly sourcePath: string;
	readonly archivePath: string;
	readonly captureMethod: "stable_descriptor_copy" | "node_sqlite_online_backup";
	readonly sourceObservation: FixtureBackupSourceObservation;
	readonly backupArtifact: FixtureBackupArtifactEvidence;
	readonly sqliteValidation: FixtureBackupSqliteValidation | null;
	readonly restoreArtifact: FixtureBackupRestoreArtifactEvidence;
}

export interface FixtureBackupEvidenceReceipt {
	readonly kind: "harnessy.local-host.fixture-backup.evidence";
	readonly schemaVersion: 1;
	readonly fixtureOnly: true;
	readonly operationalEvidence: false;
	readonly requestSha256: string;
	readonly backupId: string;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly platform: {
		readonly os: "darwin" | "linux";
		readonly arch: string;
		readonly nodeVersion: string;
		readonly uid: string;
		readonly filesystemPolicy: "posix-local-filesystem-only";
		readonly threatModel: "cooperative-owner-observed-replacement";
	};
	readonly boundaries: {
		readonly fixtureRoot: string;
		readonly sourceBoundary: string;
		readonly outputParent: string;
		readonly finalBackupRoot: string;
	};
	readonly scope: ReadonlyArray<FixtureBackupScopeEntry>;
	readonly reviewToken: {
		readonly sourcePath: string | null;
		readonly disposition: "exclude_and_regenerate_after_authorized_activation";
		readonly accessed: false;
		readonly copied: false;
	};
	readonly entries: ReadonlyArray<FixtureBackupEntryEvidence>;
	readonly payloadInventorySha256: string;
	readonly restoreRehearsal: {
		readonly target: "ephemeral_new_empty_directory";
		readonly overwrite: false;
		readonly completed: true;
		readonly inventorySha256: string;
		readonly temporaryRootRemoved: true;
	};
	readonly publication: {
		readonly strategy: "same_parent_atomic_rename";
		readonly overwrite: false;
		readonly directoryMode: "0700";
		readonly fileMode: "0600";
		readonly stagingPathAbsentAfterRename: true;
		readonly parentFsync: "required_before_success";
	};
}

export interface FixtureBackupEvidenceEnvelope {
	readonly receipt: FixtureBackupEvidenceReceipt;
	readonly receiptSha256: string;
}

type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };

export class FixtureBackupContractError extends Error {
	readonly code:
		| "invalid_json"
		| "invalid_schema"
		| "noncanonical_json"
		| "digest_mismatch"
		| "unsafe_path"
		| "invalid_scope";

	constructor(code: FixtureBackupContractError["code"]) {
		super("Fixture backup contract validation failed");
		this.name = "FixtureBackupContractError";
		this.code = code;
	}
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const entryIdPattern = /^entry_[a-f0-9]{16}$/u;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimalPattern = /^(0|[1-9]\d*)$/u;
const archiveSegmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const sqliteSidecarPattern = /(?:-wal|-shm|-journal)$/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: ReadonlyArray<string>) => {
	const actual = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
		throw new FixtureBackupContractError("invalid_schema");
	}
};

const expectRecord = (value: unknown, keys: ReadonlyArray<string>) => {
	if (!isRecord(value)) throw new FixtureBackupContractError("invalid_schema");
	exactKeys(value, keys);
	return value;
};

const expectString = (value: unknown) => {
	if (typeof value !== "string") throw new FixtureBackupContractError("invalid_schema");
	return value;
};

const expectLiteral = <Value extends string | number | boolean | null>(value: unknown, expected: Value) => {
	if (value !== expected) throw new FixtureBackupContractError("invalid_schema");
	return expected;
};

const expectSha256 = (value: unknown) => {
	const text = expectString(value);
	if (!sha256Pattern.test(text)) throw new FixtureBackupContractError("invalid_schema");
	return text;
};

const expectDecimal = (value: unknown) => {
	const text = expectString(value);
	if (!decimalPattern.test(text)) throw new FixtureBackupContractError("invalid_schema");
	return text;
};

const expectTimestamp = (value: unknown) => {
	const text = expectString(value);
	if (!timestampPattern.test(text) || new Date(text).toISOString() !== text) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	return text;
};

const containsControlCharacter = (value: string) =>
	[...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});

export const assertFixtureAbsolutePath = (value: string) => {
	if (
		value.length === 0 ||
		containsControlCharacter(value) ||
		!isAbsolute(value) ||
		resolve(value) !== value ||
		parse(value).root === value
	) {
		throw new FixtureBackupContractError("unsafe_path");
	}
	return value;
};

const assertNotSqliteSidecarPath = (value: string) => {
	if (sqliteSidecarPattern.test(value)) throw new FixtureBackupContractError("invalid_scope");
	return value;
};

const assertNotReviewTokenPath = (value: string) => {
	if (basename(value).toLowerCase() === "review.token") {
		throw new FixtureBackupContractError("invalid_scope");
	}
	return value;
};

const isPathWithin = (parent: string, child: string) => {
	const path = relative(parent, child);
	return path !== "" && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
};

const pathsOverlap = (left: string, right: string) =>
	left === right || isPathWithin(left, right) || isPathWithin(right, left);

export const isSqliteBackupRole = (role: FixtureBackupRole) =>
	role === "meeting_publication_sqlite" || role === "community_briefing_sqlite";

const decodeRole = (value: unknown) => {
	const role = expectString(value);
	if (!(FIXTURE_BACKUP_ROLES as ReadonlyArray<string>).includes(role)) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	return role as FixtureBackupRole;
};

const decodeScope = (value: unknown): ReadonlyArray<FixtureBackupScopeEntry> => {
	if (!Array.isArray(value) || value.length !== FIXTURE_BACKUP_ROLES.length) {
		throw new FixtureBackupContractError("invalid_scope");
	}
	return value.map((candidate, index) => {
		const record = expectRecord(candidate, ["role", "disposition", "entryIds"]);
		const role = decodeRole(record.role);
		if (role !== FIXTURE_BACKUP_ROLES[index]) throw new FixtureBackupContractError("invalid_scope");
		const disposition = expectString(record.disposition);
		if (disposition !== "included" && disposition !== "not_configured") {
			throw new FixtureBackupContractError("invalid_scope");
		}
		if (!Array.isArray(record.entryIds)) throw new FixtureBackupContractError("invalid_scope");
		const entryIds = record.entryIds.map((id) => {
			const text = expectString(id);
			if (!entryIdPattern.test(text)) throw new FixtureBackupContractError("invalid_scope");
			return text;
		});
		if (new Set(entryIds).size !== entryIds.length || (disposition === "included") !== entryIds.length > 0) {
			throw new FixtureBackupContractError("invalid_scope");
		}
		if (isSqliteBackupRole(role) && entryIds.length > 1) throw new FixtureBackupContractError("invalid_scope");
		return { role, disposition, entryIds };
	});
};

const decodeArchivePath = (value: unknown) => {
	const path = expectString(value);
	const segments = path.split("/");
	if (
		path.length === 0 ||
		path.length > 512 ||
		path.includes("\\") ||
		segments.some((segment) => !archiveSegmentPattern.test(segment) || segment === "." || segment === "..")
	) {
		throw new FixtureBackupContractError("unsafe_path");
	}
	return path;
};

const decodeEntries = (value: unknown): ReadonlyArray<FixtureBackupEntry> => {
	if (!Array.isArray(value) || value.length > 128) throw new FixtureBackupContractError("invalid_schema");
	const entries = value.map((candidate) => {
		const record = expectRecord(candidate, ["id", "role", "sourcePath", "archivePath"]);
		const id = expectString(record.id);
		if (!entryIdPattern.test(id)) throw new FixtureBackupContractError("invalid_schema");
		return {
			id,
			role: decodeRole(record.role),
			sourcePath: assertFixtureAbsolutePath(expectString(record.sourcePath)),
			archivePath: decodeArchivePath(record.archivePath),
		};
	});
	if (
		entries.some(
			(entry, index) => index > 0 && entries[index - 1]?.archivePath.localeCompare(entry.archivePath) >= 0,
		) ||
		new Set(entries.map((entry) => entry.id)).size !== entries.length ||
		new Set(entries.map((entry) => entry.sourcePath)).size !== entries.length ||
		new Set(entries.map((entry) => entry.archivePath)).size !== entries.length
	) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	return entries;
};

const assertScopeMatchesEntries = (
	scope: ReadonlyArray<FixtureBackupScopeEntry>,
	entries: ReadonlyArray<FixtureBackupEntry>,
) => {
	const knownIds = new Set(entries.map((entry) => entry.id));
	for (const scopeEntry of scope) {
		const expected = entries.filter((entry) => entry.role === scopeEntry.role).map((entry) => entry.id);
		if (
			expected.length !== scopeEntry.entryIds.length ||
			expected.some((id, index) => id !== scopeEntry.entryIds[index]) ||
			scopeEntry.entryIds.some((id) => !knownIds.has(id))
		) {
			throw new FixtureBackupContractError("invalid_scope");
		}
	}
};

export const decodeFixtureBackupRequest = (value: unknown): FixtureBackupRequest => {
	const record = expectRecord(value, [
		"kind",
		"schemaVersion",
		"fixtureOnly",
		"operationalEvidence",
		"createdAt",
		"platformPolicy",
		"fixtureRoot",
		"sourceBoundary",
		"outputParent",
		"scope",
		"entries",
		"reviewToken",
		"restorePolicy",
		"publicationPolicy",
	]);
	expectLiteral(record.kind, "harnessy.local-host.fixture-backup.request");
	expectLiteral(record.schemaVersion, FIXTURE_BACKUP_SCHEMA_VERSION);
	expectLiteral(record.fixtureOnly, true);
	expectLiteral(record.operationalEvidence, false);
	const createdAt = expectTimestamp(record.createdAt);
	expectLiteral(record.platformPolicy, "posix-local-filesystem-only");
	const fixtureRoot = assertFixtureAbsolutePath(expectString(record.fixtureRoot));
	const sourceBoundary = assertFixtureAbsolutePath(expectString(record.sourceBoundary));
	const outputParent = assertFixtureAbsolutePath(expectString(record.outputParent));
	if (
		!isPathWithin(fixtureRoot, sourceBoundary) ||
		!isPathWithin(fixtureRoot, outputParent) ||
		pathsOverlap(sourceBoundary, outputParent)
	) {
		throw new FixtureBackupContractError("unsafe_path");
	}
	const scope = decodeScope(record.scope);
	const entries = decodeEntries(record.entries);
	assertScopeMatchesEntries(scope, entries);
	for (const entry of entries) {
		if (!isPathWithin(sourceBoundary, entry.sourcePath)) throw new FixtureBackupContractError("unsafe_path");
		assertNotReviewTokenPath(assertNotSqliteSidecarPath(entry.sourcePath));
	}
	const reviewToken = expectRecord(record.reviewToken, ["sourcePath", "disposition", "accessAllowed"]);
	const reviewTokenPath =
		reviewToken.sourcePath === null ? null : assertFixtureAbsolutePath(expectString(reviewToken.sourcePath));
	if (reviewTokenPath !== null && !isPathWithin(sourceBoundary, reviewTokenPath)) {
		throw new FixtureBackupContractError("unsafe_path");
	}
	expectLiteral(reviewToken.disposition, "exclude_and_regenerate_after_authorized_activation");
	expectLiteral(reviewToken.accessAllowed, false);
	if (
		entries.some(
			(entry) =>
				entry.sourcePath === reviewTokenPath ||
				entry.archivePath.split("/").some((segment) => segment.toLowerCase() === "review.token"),
		)
	) {
		throw new FixtureBackupContractError("invalid_scope");
	}
	const restorePolicy = expectRecord(record.restorePolicy, ["target", "overwrite", "removeAfterVerification"]);
	expectLiteral(restorePolicy.target, "ephemeral_new_empty_directory");
	expectLiteral(restorePolicy.overwrite, false);
	expectLiteral(restorePolicy.removeAfterVerification, true);
	const publicationPolicy = expectRecord(record.publicationPolicy, ["strategy", "overwrite"]);
	expectLiteral(publicationPolicy.strategy, "same_parent_atomic_rename");
	expectLiteral(publicationPolicy.overwrite, false);
	return {
		kind: "harnessy.local-host.fixture-backup.request",
		schemaVersion: 1,
		fixtureOnly: true,
		operationalEvidence: false,
		createdAt,
		platformPolicy: "posix-local-filesystem-only",
		fixtureRoot,
		sourceBoundary,
		outputParent,
		scope,
		entries,
		reviewToken: {
			sourcePath: reviewTokenPath,
			disposition: "exclude_and_regenerate_after_authorized_activation",
			accessAllowed: false,
		},
		restorePolicy: { target: "ephemeral_new_empty_directory", overwrite: false, removeAfterVerification: true },
		publicationPolicy: { strategy: "same_parent_atomic_rename", overwrite: false },
	};
};

const asJsonValue = (value: unknown): JsonValue => {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (Array.isArray(value)) return value.map(asJsonValue);
	if (isRecord(value)) {
		const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return Object.fromEntries(entries.map(([key, entry]) => [key, asJsonValue(entry)]));
	}
	throw new FixtureBackupContractError("invalid_schema");
};

export const fixtureCanonicalJson = (value: unknown) => JSON.stringify(asJsonValue(value));
export const fixtureSha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export const makeFixtureBackupRequestEnvelope = (request: FixtureBackupRequest): FixtureBackupRequestEnvelope => {
	const decoded = decodeFixtureBackupRequest(request);
	return { request: decoded, requestSha256: fixtureSha256(fixtureCanonicalJson(decoded)) };
};

export const formatFixtureBackupRequestEnvelope = (envelope: FixtureBackupRequestEnvelope) =>
	`${fixtureCanonicalJson(envelope)}\n`;

export const verifyFixtureBackupRequestEnvelope = (text: string): FixtureBackupRequestEnvelope => {
	let input: unknown;
	try {
		input = JSON.parse(text) as unknown;
	} catch {
		throw new FixtureBackupContractError("invalid_json");
	}
	const record = expectRecord(input, ["request", "requestSha256"]);
	const request = decodeFixtureBackupRequest(record.request);
	const requestSha256 = expectSha256(record.requestSha256);
	if (fixtureSha256(fixtureCanonicalJson(request)) !== requestSha256) {
		throw new FixtureBackupContractError("digest_mismatch");
	}
	const envelope = { request, requestSha256 };
	if (formatFixtureBackupRequestEnvelope(envelope) !== text) {
		throw new FixtureBackupContractError("noncanonical_json");
	}
	return envelope;
};

const decodeEvidenceEntry = (value: unknown): FixtureBackupEntryEvidence => {
	const record = expectRecord(value, [
		"id",
		"role",
		"sourcePath",
		"archivePath",
		"captureMethod",
		"sourceObservation",
		"backupArtifact",
		"sqliteValidation",
		"restoreArtifact",
	]);
	const id = expectString(record.id);
	if (!entryIdPattern.test(id)) throw new FixtureBackupContractError("invalid_schema");
	const role = decodeRole(record.role);
	const captureMethod = expectString(record.captureMethod);
	const expectedCaptureMethod = isSqliteBackupRole(role) ? "node_sqlite_online_backup" : "stable_descriptor_copy";
	if (captureMethod !== expectedCaptureMethod) throw new FixtureBackupContractError("invalid_schema");
	const sourceObservation = expectRecord(record.sourceObservation, [
		"dev",
		"ino",
		"uid",
		"mode",
		"nlink",
		"sizeBytes",
		"mtimeNs",
		"ctimeNs",
		"pathnameStableObserved",
		"sourceBytesSha256",
	]);
	const sourceMode = expectString(sourceObservation.mode);
	if (sourceMode !== "0400" && sourceMode !== "0600") throw new FixtureBackupContractError("invalid_schema");
	const sourceBytesSha256 =
		sourceObservation.sourceBytesSha256 === null ? null : expectSha256(sourceObservation.sourceBytesSha256);
	const sourceSizeBytes = expectDecimal(sourceObservation.sizeBytes);
	if ((sourceBytesSha256 === null) !== isSqliteBackupRole(role)) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	const backupArtifact = expectRecord(record.backupArtifact, ["relativePath", "sha256", "sizeBytes", "mode", "nlink"]);
	const archivePath = decodeArchivePath(record.archivePath);
	if (expectString(backupArtifact.relativePath) !== `payload/${archivePath}`) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	expectLiteral(backupArtifact.mode, "0600");
	expectLiteral(backupArtifact.nlink, "1");
	let sqliteValidation: FixtureBackupSqliteValidation | null = null;
	if (record.sqliteValidation !== null) {
		const sqlite = expectRecord(record.sqliteValidation, ["quickCheck", "userVersion", "pageCount"]);
		expectLiteral(sqlite.quickCheck, "ok");
		if (!Number.isSafeInteger(sqlite.userVersion) || (sqlite.userVersion as number) < 0) {
			throw new FixtureBackupContractError("invalid_schema");
		}
		sqliteValidation = {
			quickCheck: "ok",
			userVersion: sqlite.userVersion as number,
			pageCount: expectDecimal(sqlite.pageCount),
		};
	}
	if ((sqliteValidation !== null) !== isSqliteBackupRole(role)) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	const restored = expectRecord(record.restoreArtifact, [
		"sha256",
		"sizeBytes",
		"mode",
		"equalsBackup",
		"sqliteQuickCheck",
	]);
	const backupSha256 = expectSha256(backupArtifact.sha256);
	const backupSizeBytes = expectDecimal(backupArtifact.sizeBytes);
	const restoredSha256 = expectSha256(restored.sha256);
	const restoredSizeBytes = expectDecimal(restored.sizeBytes);
	if (restoredSha256 !== backupSha256 || restoredSizeBytes !== backupSizeBytes) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	if (!isSqliteBackupRole(role) && (sourceBytesSha256 !== backupSha256 || sourceSizeBytes !== backupSizeBytes)) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	const restoredMode = expectString(restored.mode);
	if ((restoredMode !== "0400" && restoredMode !== "0600") || restoredMode !== sourceMode) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	expectLiteral(restored.equalsBackup, true);
	if (isSqliteBackupRole(role)) expectLiteral(restored.sqliteQuickCheck, "ok");
	else expectLiteral(restored.sqliteQuickCheck, null);
	return {
		id,
		role,
		sourcePath: assertNotReviewTokenPath(
			assertNotSqliteSidecarPath(assertFixtureAbsolutePath(expectString(record.sourcePath))),
		),
		archivePath,
		captureMethod: expectedCaptureMethod,
		sourceObservation: {
			dev: expectDecimal(sourceObservation.dev),
			ino: expectDecimal(sourceObservation.ino),
			uid: expectDecimal(sourceObservation.uid),
			mode: sourceMode,
			nlink: expectLiteral(sourceObservation.nlink, "1"),
			sizeBytes: sourceSizeBytes,
			mtimeNs: expectDecimal(sourceObservation.mtimeNs),
			ctimeNs: expectDecimal(sourceObservation.ctimeNs),
			pathnameStableObserved: expectLiteral(sourceObservation.pathnameStableObserved, true),
			sourceBytesSha256,
		},
		backupArtifact: {
			relativePath: `payload/${archivePath}`,
			sha256: backupSha256,
			sizeBytes: backupSizeBytes,
			mode: "0600",
			nlink: "1",
		},
		sqliteValidation,
		restoreArtifact: {
			sha256: restoredSha256,
			sizeBytes: restoredSizeBytes,
			mode: restoredMode,
			equalsBackup: true,
			sqliteQuickCheck: isSqliteBackupRole(role) ? "ok" : null,
		},
	};
};

export const decodeFixtureBackupEvidenceReceipt = (value: unknown): FixtureBackupEvidenceReceipt => {
	const record = expectRecord(value, [
		"kind",
		"schemaVersion",
		"fixtureOnly",
		"operationalEvidence",
		"requestSha256",
		"backupId",
		"startedAt",
		"completedAt",
		"platform",
		"boundaries",
		"scope",
		"reviewToken",
		"entries",
		"payloadInventorySha256",
		"restoreRehearsal",
		"publication",
	]);
	expectLiteral(record.kind, "harnessy.local-host.fixture-backup.evidence");
	expectLiteral(record.schemaVersion, FIXTURE_BACKUP_SCHEMA_VERSION);
	expectLiteral(record.fixtureOnly, true);
	expectLiteral(record.operationalEvidence, false);
	const requestSha256 = expectSha256(record.requestSha256);
	const backupId = expectString(record.backupId);
	if (backupId !== `backup_${requestSha256.slice(0, 32)}`) throw new FixtureBackupContractError("invalid_schema");
	const startedAt = expectTimestamp(record.startedAt);
	const completedAt = expectTimestamp(record.completedAt);
	if (completedAt < startedAt) throw new FixtureBackupContractError("invalid_schema");
	const platform = expectRecord(record.platform, [
		"os",
		"arch",
		"nodeVersion",
		"uid",
		"filesystemPolicy",
		"threatModel",
	]);
	const os = expectString(platform.os);
	if (os !== "darwin" && os !== "linux") throw new FixtureBackupContractError("invalid_schema");
	const platformUid = expectDecimal(platform.uid);
	expectLiteral(platform.filesystemPolicy, "posix-local-filesystem-only");
	expectLiteral(platform.threatModel, "cooperative-owner-observed-replacement");
	const boundaries = expectRecord(record.boundaries, [
		"fixtureRoot",
		"sourceBoundary",
		"outputParent",
		"finalBackupRoot",
	]);
	const fixtureRoot = assertFixtureAbsolutePath(expectString(boundaries.fixtureRoot));
	const sourceBoundary = assertFixtureAbsolutePath(expectString(boundaries.sourceBoundary));
	const outputParent = assertFixtureAbsolutePath(expectString(boundaries.outputParent));
	const finalBackupRoot = assertFixtureAbsolutePath(expectString(boundaries.finalBackupRoot));
	if (
		!isPathWithin(fixtureRoot, sourceBoundary) ||
		!isPathWithin(fixtureRoot, outputParent) ||
		pathsOverlap(sourceBoundary, outputParent) ||
		finalBackupRoot !== resolve(outputParent, backupId)
	) {
		throw new FixtureBackupContractError("unsafe_path");
	}
	const scope = decodeScope(record.scope);
	if (!Array.isArray(record.entries) || record.entries.length > 128)
		throw new FixtureBackupContractError("invalid_schema");
	const entries = record.entries.map(decodeEvidenceEntry);
	const requestEntries = entries.map((entry) => ({
		id: entry.id,
		role: entry.role,
		sourcePath: entry.sourcePath,
		archivePath: entry.archivePath,
	}));
	assertScopeMatchesEntries(scope, requestEntries);
	if (
		entries.some(
			(entry, index) => index > 0 && entries[index - 1]?.archivePath.localeCompare(entry.archivePath) >= 0,
		) ||
		entries.some((entry) => !isPathWithin(sourceBoundary, entry.sourcePath)) ||
		entries.some((entry) => entry.sourceObservation.uid !== platformUid) ||
		new Set(entries.map((entry) => entry.sourcePath)).size !== entries.length ||
		new Set(entries.map((entry) => `${entry.sourceObservation.dev}:${entry.sourceObservation.ino}`)).size !==
			entries.length
	) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	const reviewToken = expectRecord(record.reviewToken, ["sourcePath", "disposition", "accessed", "copied"]);
	const reviewTokenPath =
		reviewToken.sourcePath === null ? null : assertFixtureAbsolutePath(expectString(reviewToken.sourcePath));
	if (
		(reviewTokenPath !== null && !isPathWithin(sourceBoundary, reviewTokenPath)) ||
		entries.some(
			(entry) =>
				entry.sourcePath === reviewTokenPath ||
				entry.archivePath.split("/").some((segment) => segment.toLowerCase() === "review.token"),
		)
	) {
		throw new FixtureBackupContractError("invalid_scope");
	}
	expectLiteral(reviewToken.disposition, "exclude_and_regenerate_after_authorized_activation");
	expectLiteral(reviewToken.accessed, false);
	expectLiteral(reviewToken.copied, false);
	const restore = expectRecord(record.restoreRehearsal, [
		"target",
		"overwrite",
		"completed",
		"inventorySha256",
		"temporaryRootRemoved",
	]);
	expectLiteral(restore.target, "ephemeral_new_empty_directory");
	expectLiteral(restore.overwrite, false);
	expectLiteral(restore.completed, true);
	expectLiteral(restore.temporaryRootRemoved, true);
	const payloadInventorySha256 = expectSha256(record.payloadInventorySha256);
	const restoredInventorySha256 = expectSha256(restore.inventorySha256);
	if (
		restoredInventorySha256 !== payloadInventorySha256 ||
		fixturePayloadInventorySha256(entries) !== payloadInventorySha256
	) {
		throw new FixtureBackupContractError("invalid_schema");
	}
	const publication = expectRecord(record.publication, [
		"strategy",
		"overwrite",
		"directoryMode",
		"fileMode",
		"stagingPathAbsentAfterRename",
		"parentFsync",
	]);
	expectLiteral(publication.strategy, "same_parent_atomic_rename");
	expectLiteral(publication.overwrite, false);
	expectLiteral(publication.directoryMode, "0700");
	expectLiteral(publication.fileMode, "0600");
	expectLiteral(publication.stagingPathAbsentAfterRename, true);
	expectLiteral(publication.parentFsync, "required_before_success");
	return {
		kind: "harnessy.local-host.fixture-backup.evidence",
		schemaVersion: 1,
		fixtureOnly: true,
		operationalEvidence: false,
		requestSha256,
		backupId,
		startedAt,
		completedAt,
		platform: {
			os,
			arch: expectString(platform.arch),
			nodeVersion: expectString(platform.nodeVersion),
			uid: platformUid,
			filesystemPolicy: "posix-local-filesystem-only",
			threatModel: "cooperative-owner-observed-replacement",
		},
		boundaries: { fixtureRoot, sourceBoundary, outputParent, finalBackupRoot },
		scope,
		reviewToken: {
			sourcePath: reviewTokenPath,
			disposition: "exclude_and_regenerate_after_authorized_activation",
			accessed: false,
			copied: false,
		},
		entries,
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
};

export const makeFixtureBackupEvidenceEnvelope = (
	receipt: FixtureBackupEvidenceReceipt,
): FixtureBackupEvidenceEnvelope => {
	const decoded = decodeFixtureBackupEvidenceReceipt(receipt);
	return { receipt: decoded, receiptSha256: fixtureSha256(fixtureCanonicalJson(decoded)) };
};

export const formatFixtureBackupEvidenceEnvelope = (envelope: FixtureBackupEvidenceEnvelope) =>
	`${fixtureCanonicalJson(envelope)}\n`;

export const verifyFixtureBackupEvidenceEnvelope = (text: string): FixtureBackupEvidenceEnvelope => {
	let input: unknown;
	try {
		input = JSON.parse(text) as unknown;
	} catch {
		throw new FixtureBackupContractError("invalid_json");
	}
	const record = expectRecord(input, ["receipt", "receiptSha256"]);
	const receipt = decodeFixtureBackupEvidenceReceipt(record.receipt);
	const receiptSha256 = expectSha256(record.receiptSha256);
	if (fixtureSha256(fixtureCanonicalJson(receipt)) !== receiptSha256) {
		throw new FixtureBackupContractError("digest_mismatch");
	}
	const envelope = { receipt, receiptSha256 };
	if (formatFixtureBackupEvidenceEnvelope(envelope) !== text) {
		throw new FixtureBackupContractError("noncanonical_json");
	}
	return envelope;
};

export const fixturePayloadInventorySha256 = (
	entries: ReadonlyArray<Pick<FixtureBackupEntryEvidence, "id" | "role" | "archivePath" | "backupArtifact">>,
) =>
	fixtureSha256(
		fixtureCanonicalJson(
			entries.map((entry) => ({
				id: entry.id,
				role: entry.role,
				archivePath: entry.archivePath,
				sha256: entry.backupArtifact.sha256,
				sizeBytes: entry.backupArtifact.sizeBytes,
			})),
		),
	);
