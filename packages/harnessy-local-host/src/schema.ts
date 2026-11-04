import { createHash } from "node:crypto";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { Schema } from "effect";

export const LOCAL_HOST_PLAN_SCHEMA_VERSION = 1 as const;
export const V1_REVIEW_SCHEDULER_ID = "tech.flowresearch.jarvis.meeting-review" as const;
export const V1_WORKER_SCHEDULER_ID = "com.flow-harness.project.flow-meeting-publication-worker" as const;
export const V2_REVIEW_SCHEDULER_ID = "tech.flowresearch.harnessy.meeting-publication.review" as const;
export const V2_WORKER_SCHEDULER_ID = "tech.flowresearch.harnessy.meeting-publication.worker" as const;

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const NonNegativeInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

const statusKeys = [
	"pending_review",
	"approved",
	"publishing",
	"published",
	"rejected",
	"blocked",
	"archived",
] as const;
const failureKeys = ["configuration", "source", "store", "notification", "google", "discord"] as const;
const exclusionKeys = [
	"missing_source_root",
	"path_boundary",
	"symlink",
	"race_detected",
	"read_error",
	"invalid_utf8",
	"oversize",
	"file_limit",
	"invalid_date",
	"project_boundary",
	"missing_summary",
	"transcript_section",
	"before_cutoff",
	"empty_note",
	"note_too_long",
	"identity_change",
	"write_error",
] as const;
const preflightPlan = [
	["enabled", "disabled"],
	["source", "missing_source_path"],
	["state", "missing_state_path"],
	["project", "missing_project"],
	["cutover", "missing_cutover_date"],
	["google_owner", "missing_google_owner"],
	["google_folder", "missing_google_folder"],
	["discord_channel", "missing_discord_channel"],
	["write_authority", "v1_owned"],
	["note_quality", "unsafe_notes"],
	["state_database", "migration_required"],
] as const;

export const LocalHostOperationalGateId = Schema.Literals([
	"backup_verified",
	"restore_tested",
	"v1_writer_stopped",
	"one_writer_proven",
	"live_credentials_validated",
	"v2_smoke_passed",
	"rollback_ready",
]);
export type LocalHostOperationalGateId = typeof LocalHostOperationalGateId.Type;

export const LocalHostOperationalGateStatus = Schema.Literals(["missing", "not_checked"]);
export type LocalHostOperationalGateStatus = typeof LocalHostOperationalGateStatus.Type;

export class LocalHostOperationalGate extends Schema.Class<LocalHostOperationalGate>("LocalHostOperationalGate")({
	id: LocalHostOperationalGateId,
	status: LocalHostOperationalGateStatus,
	evidence: Schema.Null,
}) {}

export class LocalHostSchedulerPlan extends Schema.Class<LocalHostSchedulerPlan>("LocalHostSchedulerPlan")({
	role: Schema.Literals(["review", "worker"]),
	legacySchedulerId: Schema.String,
	v2SchedulerId: Schema.String,
	install: Schema.Literal(false),
	enabled: Schema.Literal(false),
	workingDirectory: Schema.String,
	argv: Schema.Array(Schema.String),
}) {}

export class LocalHostBinding extends Schema.Class<LocalHostBinding>("LocalHostBinding")({
	configPath: Schema.String,
	sourcePath: Schema.String,
	statePath: Schema.String,
	configSha256: Sha256,
	hostExecutablePath: Schema.String,
	hostExecutableSha256: Sha256,
}) {}

export class LocalHostOwnershipPlan extends Schema.Class<LocalHostOwnershipPlan>("LocalHostOwnershipPlan")({
	currentWriter: Schema.Literal("v1"),
	plannedWriter: Schema.Literal("v2"),
	writeAllowed: Schema.Literal(false),
}) {}

export class LocalHostReviewTokenPlan extends Schema.Class<LocalHostReviewTokenPlan>("LocalHostReviewTokenPlan")({
	included: Schema.Literal(false),
	disposition: Schema.Literal("regenerate_after_activation_review"),
}) {}

export class LocalHostStateEvidence extends Schema.Class<LocalHostStateEvidence>("LocalHostStateEvidence")({
	exists: Schema.Boolean,
	schemaState: Schema.Literals(["missing", "migration_required", "current"]),
	schemaVersion: Schema.NullOr(Schema.Int),
	totalItems: NonNegativeInt,
	statusCounts: Schema.Record(Schema.String, NonNegativeInt),
	failureCounts: Schema.Record(Schema.String, NonNegativeInt),
}) {}

export class LocalHostScanEvidence extends Schema.Class<LocalHostScanEvidence>("LocalHostScanEvidence")({
	filesSeen: NonNegativeInt,
	eligible: NonNegativeInt,
	exclusions: Schema.Record(Schema.String, NonNegativeInt),
	dryRun: Schema.Literal(true),
}) {}

export class LocalHostPreflightCheckEvidence extends Schema.Class<LocalHostPreflightCheckEvidence>(
	"LocalHostPreflightCheckEvidence",
)({
	name: Schema.String,
	passed: Schema.Boolean,
	required: Schema.Boolean,
	code: Schema.String,
}) {}

export class LocalHostPreflightEvidence extends Schema.Class<LocalHostPreflightEvidence>("LocalHostPreflightEvidence")({
	ready: Schema.Literal(false),
	checks: Schema.Array(LocalHostPreflightCheckEvidence),
}) {}

export class LocalHostInspectionEvidence extends Schema.Class<LocalHostInspectionEvidence>(
	"LocalHostInspectionEvidence",
)({
	state: LocalHostStateEvidence,
	scan: LocalHostScanEvidence,
	preflight: LocalHostPreflightEvidence,
}) {}

export class LocalHostPlanReceipt extends Schema.Class<LocalHostPlanReceipt>("LocalHostPlanReceipt")({
	kind: Schema.Literal("harnessy.local-host.meeting-publication.plan"),
	schemaVersion: Schema.Literal(LOCAL_HOST_PLAN_SCHEMA_VERSION),
	createdAt: Schema.String,
	activated: Schema.Literal(false),
	activationReady: Schema.Literal(false),
	binding: LocalHostBinding,
	ownership: LocalHostOwnershipPlan,
	reviewToken: LocalHostReviewTokenPlan,
	inspection: LocalHostInspectionEvidence,
	operationalGates: Schema.Array(LocalHostOperationalGate),
	schedulers: Schema.Array(LocalHostSchedulerPlan),
}) {}

export class LocalHostPlanEnvelope extends Schema.Class<LocalHostPlanEnvelope>("LocalHostPlanEnvelope")({
	receipt: LocalHostPlanReceipt,
	receiptSha256: Sha256,
}) {}

export class LocalHostReceiptError extends Error {
	readonly code: "invalid_json" | "invalid_schema" | "noncanonical_receipt" | "digest_mismatch" | "unsafe_plan";

	constructor(code: LocalHostReceiptError["code"]) {
		super("Local-host planning receipt validation failed");
		this.name = "LocalHostReceiptError";
		this.code = code;
	}
}

const gatePlan = [
	["backup_verified", "missing"],
	["restore_tested", "not_checked"],
	["v1_writer_stopped", "not_checked"],
	["one_writer_proven", "not_checked"],
	["live_credentials_validated", "not_checked"],
	["v2_smoke_passed", "not_checked"],
	["rollback_ready", "missing"],
] as const satisfies ReadonlyArray<readonly [LocalHostOperationalGateId, LocalHostOperationalGateStatus]>;

export const inactiveOperationalGates = () =>
	gatePlan.map(([id, status]) => new LocalHostOperationalGate({ id, status, evidence: null }));

const containsControlCharacter = (value: string) =>
	[...value].some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
	});

export const assertAbsolutePlanPath = (value: string) => {
	if (
		value.length === 0 ||
		containsControlCharacter(value) ||
		!isAbsolute(value) ||
		resolve(value) !== value ||
		parse(value).root === value
	) {
		throw new LocalHostReceiptError("unsafe_plan");
	}
	return value;
};

export const planPathsOverlap = (left: string, right: string) => {
	const fromLeft = relative(left, right);
	const fromRight = relative(right, left);
	const isWithin = (value: string) =>
		value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
	return isWithin(fromLeft) || isWithin(fromRight);
};

const exactValues = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>) =>
	actual.length === expected.length && actual.every((value, index) => value === expected[index]);

export interface LocalHostSchedulerPlanInput {
	readonly hostExecutable: string;
	readonly configPath: string;
	readonly futureActivationReceiptPath: string;
	readonly workingDirectory: string;
}

export const makeInactiveSchedulerPlans = (input: LocalHostSchedulerPlanInput) => {
	const hostExecutable = assertAbsolutePlanPath(input.hostExecutable);
	const configPath = assertAbsolutePlanPath(input.configPath);
	const futureActivationReceiptPath = assertAbsolutePlanPath(input.futureActivationReceiptPath);
	const workingDirectory = assertAbsolutePlanPath(input.workingDirectory);
	return [
		new LocalHostSchedulerPlan({
			role: "review",
			legacySchedulerId: V1_REVIEW_SCHEDULER_ID,
			v2SchedulerId: V2_REVIEW_SCHEDULER_ID,
			install: false,
			enabled: false,
			workingDirectory,
			argv: [
				hostExecutable,
				"review-serve",
				"--config",
				configPath,
				"--activation-receipt",
				futureActivationReceiptPath,
			],
		}),
		new LocalHostSchedulerPlan({
			role: "worker",
			legacySchedulerId: V1_WORKER_SCHEDULER_ID,
			v2SchedulerId: V2_WORKER_SCHEDULER_ID,
			install: false,
			enabled: false,
			workingDirectory,
			argv: [hostExecutable, "worker", "--config", configPath, "--activation-receipt", futureActivationReceiptPath],
		}),
	];
};

const assertSchedulerPlan = (receipt: LocalHostPlanReceipt) => {
	if (receipt.schedulers.length !== 2) throw new LocalHostReceiptError("unsafe_plan");
	const [review, worker] = receipt.schedulers;
	if (review === undefined || worker === undefined) throw new LocalHostReceiptError("unsafe_plan");
	const expected = makeInactiveSchedulerPlans({
		hostExecutable: receipt.binding.hostExecutablePath,
		configPath: receipt.binding.configPath,
		futureActivationReceiptPath: review.argv[5] ?? "",
		workingDirectory: review.workingDirectory,
	});
	const actualPlans = [review, worker];
	for (let index = 0; index < expected.length; index += 1) {
		const actual = actualPlans[index];
		const planned = expected[index];
		if (
			actual === undefined ||
			planned === undefined ||
			actual.role !== planned.role ||
			actual.legacySchedulerId !== planned.legacySchedulerId ||
			actual.v2SchedulerId !== planned.v2SchedulerId ||
			actual.install !== false ||
			actual.enabled !== false ||
			actual.workingDirectory !== planned.workingDirectory ||
			!exactValues(actual.argv, planned.argv) ||
			actual.legacySchedulerId === actual.v2SchedulerId
		) {
			throw new LocalHostReceiptError("unsafe_plan");
		}
	}
};

const assertReceiptInvariants = (receipt: LocalHostPlanReceipt) => {
	assertAbsolutePlanPath(receipt.binding.configPath);
	assertAbsolutePlanPath(receipt.binding.sourcePath);
	assertAbsolutePlanPath(receipt.binding.statePath);
	assertAbsolutePlanPath(receipt.binding.hostExecutablePath);
	if (planPathsOverlap(receipt.binding.sourcePath, receipt.binding.statePath)) {
		throw new LocalHostReceiptError("unsafe_plan");
	}
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(receipt.createdAt)) {
		throw new LocalHostReceiptError("unsafe_plan");
	}
	const onlyKnownKeys = (actual: Readonly<Record<string, number>>, known: ReadonlyArray<string>) =>
		Object.keys(actual).every((key) => known.includes(key));
	if (
		!onlyKnownKeys(receipt.inspection.state.statusCounts, statusKeys) ||
		!onlyKnownKeys(receipt.inspection.state.failureCounts, failureKeys) ||
		!onlyKnownKeys(receipt.inspection.scan.exclusions, exclusionKeys)
	) {
		throw new LocalHostReceiptError("unsafe_plan");
	}
	const checks = receipt.inspection.preflight.checks;
	if (checks.length !== preflightPlan.length) throw new LocalHostReceiptError("unsafe_plan");
	for (let index = 0; index < preflightPlan.length; index += 1) {
		const check = checks[index];
		const planned = preflightPlan[index];
		if (check === undefined || planned === undefined || check.name !== planned[0] || check.required !== true) {
			throw new LocalHostReceiptError("unsafe_plan");
		}
		if (check.name === "write_authority") {
			if (check.passed !== false || check.code !== "v1_owned") throw new LocalHostReceiptError("unsafe_plan");
		} else if (check.name === "state_database") {
			const allowed = [
				"missing",
				"current",
				"migration_required",
				"unsafe_state",
				"schema_newer",
				"schema_invalid",
				"read_failed",
			];
			if (!allowed.includes(check.code) || check.passed !== (check.code === "missing" || check.code === "current")) {
				throw new LocalHostReceiptError("unsafe_plan");
			}
		} else if (check.code !== (check.passed ? "ok" : planned[1])) {
			throw new LocalHostReceiptError("unsafe_plan");
		}
	}
	if (checks.filter((check) => check.name === "write_authority").length !== 1) {
		throw new LocalHostReceiptError("unsafe_plan");
	}
	if (receipt.operationalGates.length !== gatePlan.length) throw new LocalHostReceiptError("unsafe_plan");
	for (let index = 0; index < gatePlan.length; index += 1) {
		const gate = receipt.operationalGates[index];
		const planned = gatePlan[index];
		if (gate === undefined || planned === undefined || gate.id !== planned[0] || gate.status !== planned[1]) {
			throw new LocalHostReceiptError("unsafe_plan");
		}
	}
	assertSchedulerPlan(receipt);
};

type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | { readonly [key: string]: JsonValue };

const asJsonValue = (value: unknown): JsonValue => {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(asJsonValue);
	if (typeof value === "object") {
		const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
		return Object.fromEntries(entries.map(([key, entry]) => [key, asJsonValue(entry)]));
	}
	throw new LocalHostReceiptError("invalid_schema");
};

export const canonicalJson = (value: unknown) => JSON.stringify(asJsonValue(value));
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export const makePlanEnvelope = (receipt: LocalHostPlanReceipt) => {
	assertReceiptInvariants(receipt);
	return new LocalHostPlanEnvelope({
		receipt,
		receiptSha256: sha256(canonicalJson(receipt)),
	});
};

export const formatPlanEnvelope = (envelope: LocalHostPlanEnvelope) => `${canonicalJson(envelope)}\n`;

export const verifyPlanEnvelope = (text: string) => {
	let input: unknown;
	try {
		input = JSON.parse(text) as unknown;
	} catch {
		throw new LocalHostReceiptError("invalid_json");
	}
	let envelope: LocalHostPlanEnvelope;
	try {
		envelope = Schema.decodeUnknownSync(LocalHostPlanEnvelope)(input);
	} catch {
		throw new LocalHostReceiptError("invalid_schema");
	}
	assertReceiptInvariants(envelope.receipt);
	if (sha256(canonicalJson(envelope.receipt)) !== envelope.receiptSha256) {
		throw new LocalHostReceiptError("digest_mismatch");
	}
	if (formatPlanEnvelope(envelope) !== text) throw new LocalHostReceiptError("noncanonical_receipt");
	return envelope;
};
