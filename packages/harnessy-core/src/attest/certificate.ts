/**
 * "Flow verified this work" certificates: one EAS off-chain attestation per
 * accepted WorkStream contribution, under the `workstream.contribution.v1`
 * schema, wrapped in a small Harnessy file that marks it as a test certificate.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as Result from "effect/Result";
import { field, isTaskId, parseJson } from "../work/logic.ts";
import {
	type AbiField,
	type AbiValue,
	ATTEST_PRIMARY_TYPE,
	ATTEST_TYPES,
	type AttestMessage,
	abiDecode,
	abiEncode,
	attestDigest,
	type EasDomain,
	type EthSignature,
	keccak,
	OFFCHAIN_VERSION,
	offchainUid,
	parseHex,
	recoverAddress,
	schemaString,
	schemaUid,
	signDigest,
	toHex,
	ZERO_ADDRESS,
	ZERO_BYTES32,
} from "./eas.ts";

export const SCHEMA_NAME = "workstream.contribution.v1";
export const CONTRIBUTION_FIELDS: ReadonlyArray<AbiField> = [
	{ name: "contributionId", type: "string" },
	{ name: "projectId", type: "string" },
	{ name: "taskId", type: "string" },
	{ name: "contributorId", type: "string" },
	{ name: "contributionType", type: "string" },
	{ name: "artifactHash", type: "bytes32" },
	{ name: "acceptedAt", type: "uint64" },
	{ name: "policyVersionId", type: "string" },
	{ name: "awardUnit", type: "string" },
	{ name: "awardQuantity", type: "uint256" },
];
export const SCHEMA = schemaString(CONTRIBUTION_FIELDS);
/** Revocable with no resolver, so a mistaken certificate can be revoked later. */
export const SCHEMA_REVOCABLE = true;
export const SCHEMA_UID = toHex(schemaUid(SCHEMA, new Uint8Array(20), SCHEMA_REVOCABLE));

/** EAS on Base Sepolia (OP Stack predeploy); `version()` returned "1.4.1-beta.3" on 22 October 2026. */
export const EAS_BASE_SEPOLIA = "0x4200000000000000000000000000000000000021";
export const TEST_DOMAIN: EasDomain = {
	name: "EAS Attestation",
	version: "1.4.1-beta.3",
	chainId: 84532n,
	verifyingContract: EAS_BASE_SEPOLIA,
};
const EAS_ADDRESS_BYTES = parseHex(EAS_BASE_SEPOLIA, 20) as Uint8Array;

export const CERTIFICATE_FORMAT = "harnessy.attest.certificate.v1";
export const TEST_NOTICE =
	"TEST certificate signed with a Harnessy test key for Base Sepolia (chain 84532). It is not a Flow production attestation.";

const CONTRIBUTION_TYPES = ["accepted_submission", "completed_review"] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];

/** The signed content of one certificate. The contributor is a WorkStream ID only. */
export interface ContributionClaim {
	readonly contributionId: string;
	readonly projectId: string;
	readonly taskId: string;
	readonly contributorId: string;
	readonly contributionType: ContributionType;
	/** `0x` + the 32-byte sha256 of the submitted proof. */
	readonly artifactHash: string;
	/** Unix seconds. */
	readonly acceptedAt: bigint;
	readonly policyVersionId: string;
	/** Points unit such as `FLOW`, or "" when the contribution earned no points. */
	readonly awardUnit: string;
	readonly awardQuantity: bigint;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ARTIFACT_HASH = /^sha256:([0-9a-f]{64})$/;
const QUANTITY = /^([0-9]+)(?:\.([0-9]+))?$/;
const POINTS_INSTRUMENT = "project_points";
const UINT256_MAX = 2n ** 256n - 1n;

const seconds = (value: unknown): bigint | undefined => {
	if (typeof value !== "string" || !RFC3339.test(value)) return undefined;
	const ms = Date.parse(value);
	return Number.isNaN(ms) || ms < 0 ? undefined : BigInt(Math.floor(ms / 1000));
};

const uuidField = (record: unknown, key: string): string | undefined => {
	const value = field(record, key);
	return typeof value === "string" && isTaskId(value) ? value.toLowerCase() : undefined;
};

/**
 * Points awarded: the sum of `project_points` awards, which must share one
 * unit and be whole numbers. Money awards are not part of this schema.
 */
const pointsAward = (awards: unknown): Result.Result<{ unit: string; quantity: bigint }, string> => {
	if (!Array.isArray(awards)) return Result.fail("awards is not a list");
	const units = new Set<string>();
	let quantity = 0n;
	for (const award of awards) {
		if (field(award, "instrument") !== POINTS_INSTRUMENT) continue;
		const unit = field(award, "unit");
		const match = QUANTITY.exec(String(field(award, "quantity")));
		if (typeof unit !== "string" || unit === "" || match === null)
			return Result.fail("a points award has no unit or a malformed quantity");
		if (!/^0*$/.test(match[2] ?? "")) return Result.fail("a points award is not a whole number");
		units.add(unit);
		quantity += BigInt(match[1] as string);
	}
	if (units.size > 1) return Result.fail("points awards use more than one unit");
	if (quantity > UINT256_MAX) return Result.fail("points total does not fit in uint256");
	return Result.succeed({ unit: [...units][0] ?? "", quantity });
};

/** Validate one WorkStream contribution record and reduce it to the signed claim. */
export const claimFromRecord = (record: unknown, project: string): Result.Result<ContributionClaim, string> => {
	const contributionId = uuidField(record, "contribution_id");
	const projectId = uuidField(record, "project_id");
	const taskId = uuidField(record, "task_id");
	const contributorId = uuidField(record, "contributor_id");
	const policyVersionId = uuidField(record, "contribution_policy_version_id");
	if (
		contributionId === undefined ||
		projectId === undefined ||
		taskId === undefined ||
		contributorId === undefined ||
		policyVersionId === undefined
	)
		return Result.fail("a contribution has a missing or malformed ID");
	const fail = (problem: string) => Result.fail(`contribution ${contributionId}: ${problem}`);
	if (projectId !== project.toLowerCase()) return fail(`belongs to project ${projectId}, not ${project}`);
	const contributionType = CONTRIBUTION_TYPES.find((type) => type === field(record, "contribution_type"));
	if (contributionType === undefined) return fail("unknown contribution type");
	const hash = ARTIFACT_HASH.exec(String(field(record, "artifact_hash")));
	if (hash === null) return fail("artifact_hash is not sha256:<64 hex>");
	// A completed review has no final acceptance of its own; its record time is when it was accepted as work.
	const acceptedAt = seconds(
		field(record, "accepted_at") ?? (contributionType === "completed_review" ? field(record, "recorded_at") : null),
	);
	if (acceptedAt === undefined) return fail("has no valid acceptance time");
	const award = pointsAward(field(record, "awards"));
	if (Result.isFailure(award)) return fail(award.failure);
	return Result.succeed({
		contributionId,
		projectId,
		taskId,
		contributorId,
		contributionType,
		artifactHash: `0x${hash[1]}`,
		acceptedAt,
		policyVersionId,
		awardUnit: award.success.unit,
		awardQuantity: award.success.quantity,
	});
};

/** Parse `workstream contributions -o json` output (`{items: [...]}`) into claims. Any bad record fails the batch. */
export const parseContributions = (stdout: string, project: string): Result.Result<ContributionClaim[], string> => {
	const items = field(parseJson(stdout), "items");
	if (!Array.isArray(items)) return Result.fail("WorkStream returned no contribution list");
	const claims: ContributionClaim[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const claim = claimFromRecord(item, project);
		if (Result.isFailure(claim)) return Result.fail(claim.failure);
		if (seen.has(claim.success.contributionId))
			return Result.fail(`contribution ${claim.success.contributionId} appears twice`);
		seen.add(claim.success.contributionId);
		claims.push(claim.success);
	}
	return Result.succeed(claims);
};

const claimValues = (claim: ContributionClaim): AbiValue[] =>
	CONTRIBUTION_FIELDS.map((item) =>
		item.name === "artifactHash"
			? (parseHex(claim.artifactHash, 32) as Uint8Array)
			: (claim[item.name as keyof ContributionClaim] as AbiValue),
	);

/** JSON form of a claim: integers as decimal strings, the hash as `0x` hex. */
export const claimJson = (claim: ContributionClaim): Record<string, string> => ({
	contributionId: claim.contributionId,
	projectId: claim.projectId,
	taskId: claim.taskId,
	contributorId: claim.contributorId,
	contributionType: claim.contributionType,
	artifactHash: claim.artifactHash,
	acceptedAt: claim.acceptedAt.toString(),
	policyVersionId: claim.policyVersionId,
	awardUnit: claim.awardUnit,
	awardQuantity: claim.awardQuantity.toString(),
});

/** Deterministic salt, so the same contribution and key always produce the same certificate. */
export const claimSalt = (contributionId: string): Uint8Array =>
	keccak(utf8ToBytes(`${SCHEMA_NAME}:${contributionId}`));

const ZERO_ADDRESS_BYTES = new Uint8Array(20);
const ZERO_BYTES32_BYTES = new Uint8Array(32);

const claimMessage = (claim: ContributionClaim): AttestMessage => ({
	schema: parseHex(SCHEMA_UID, 32) as Uint8Array,
	recipient: ZERO_ADDRESS_BYTES,
	// The acceptance time, not the signing time, so re-running reproduces the same file.
	time: claim.acceptedAt,
	expirationTime: 0n,
	revocable: SCHEMA_REVOCABLE,
	refUID: ZERO_BYTES32_BYTES,
	data: abiEncode(CONTRIBUTION_FIELDS, claimValues(claim)),
	salt: claimSalt(claim.contributionId),
});

const domainJson = () => ({ ...TEST_DOMAIN, chainId: TEST_DOMAIN.chainId.toString() });
const schemaJson = () => ({
	name: SCHEMA_NAME,
	uid: SCHEMA_UID,
	definition: SCHEMA,
	resolver: ZERO_ADDRESS,
	revocable: SCHEMA_REVOCABLE,
});

/** Sign one claim and return the certificate file text (pretty JSON with a trailing newline). */
export const certificateText = (claim: ContributionClaim, secretKey: Uint8Array, signer: string): string => {
	const message = claimMessage(claim);
	const signature = signDigest(attestDigest(TEST_DOMAIN, EAS_ADDRESS_BYTES, message), secretKey);
	const certificate = {
		format: CERTIFICATE_FORMAT,
		test: true,
		notice: TEST_NOTICE,
		schema: schemaJson(),
		contribution: claimJson(claim),
		eas: {
			sig: {
				domain: domainJson(),
				primaryType: ATTEST_PRIMARY_TYPE,
				types: ATTEST_TYPES,
				message: {
					version: OFFCHAIN_VERSION,
					schema: SCHEMA_UID,
					recipient: ZERO_ADDRESS,
					time: message.time.toString(),
					expirationTime: "0",
					revocable: SCHEMA_REVOCABLE,
					refUID: ZERO_BYTES32,
					data: toHex(message.data),
					salt: toHex(message.salt),
				},
				uid: toHex(offchainUid(SCHEMA_UID, message)),
				signature,
			},
			signer,
		},
	};
	return `${JSON.stringify(certificate, null, 2)}\n`;
};

export type Verdict =
	| {
			readonly valid: true;
			readonly signer: string;
			readonly uid: string;
			readonly contribution: Record<string, string>;
	  }
	| { readonly valid: false; readonly reason: string };

/** JSON equality that ignores object key order. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, item: unknown) =>
		typeof item === "object" && item !== null && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)))
			: item,
	);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

const keysOf = (value: unknown): string[] =>
	typeof value === "object" && value !== null ? Object.keys(value).sort() : [];
const WRAPPER_KEYS = ["contribution", "eas", "format", "notice", "schema", "test"];
const EAS_KEYS = ["sig", "signer"];
const SIG_KEYS = ["domain", "message", "primaryType", "signature", "types", "uid"];
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const LOWER_WORD = /^0x[0-9a-f]{64}$/;
const FIXED_MESSAGE = {
	version: OFFCHAIN_VERSION,
	schema: SCHEMA_UID,
	recipient: ZERO_ADDRESS,
	expirationTime: "0",
	revocable: SCHEMA_REVOCABLE,
	refUID: ZERO_BYTES32,
};

/**
 * Check a certificate file: its fixed test domain, schema and types, the
 * attestation UID, the readable copy against the signed data, and that the
 * signature recovers to `attester`.
 */
export const verifyCertificate = (text: string, attester: string): Verdict => {
	const invalid = (reason: string): Verdict => ({ valid: false, reason });
	const file = parseJson(text);
	if (field(file, "format") !== CERTIFICATE_FORMAT || field(file, "test") !== true)
		return invalid("not a Harnessy test certificate");
	const eas = field(file, "eas");
	const sig = field(eas, "sig");
	// Unsigned text must not add claims: only the known fields, and the fixed notice.
	if (
		!same(keysOf(file), WRAPPER_KEYS) ||
		!same(keysOf(eas), EAS_KEYS) ||
		!same(keysOf(sig), SIG_KEYS) ||
		field(file, "notice") !== TEST_NOTICE
	)
		return invalid("the certificate has missing, extra or changed unsigned fields");
	if (!same(field(file, "schema"), schemaJson())) return invalid(`schema is not ${SCHEMA_NAME} (${SCHEMA_UID})`);
	if (
		!same(field(sig, "domain"), domainJson()) ||
		field(sig, "primaryType") !== ATTEST_PRIMARY_TYPE ||
		!same(field(sig, "types"), ATTEST_TYPES)
	)
		return invalid("EIP-712 domain or types are not EAS version 2 on Base Sepolia");
	const message = field(sig, "message");
	const { time, data, salt, ...fixed } = (typeof message === "object" && message !== null ? message : {}) as Record<
		string,
		unknown
	>;
	if (!same(fixed, FIXED_MESSAGE)) return invalid("attestation fields differ from the certificate schema");
	const dataBytes = parseHex(data);
	const saltBytes = parseHex(salt, 32);
	if (typeof time !== "string" || !DECIMAL.test(time) || dataBytes === undefined || saltBytes === undefined)
		return invalid("attestation time, data or salt is malformed");
	const decoded = abiDecode(CONTRIBUTION_FIELDS, dataBytes);
	if (Result.isFailure(decoded)) return invalid(decoded.failure);
	const signed = Object.fromEntries(
		CONTRIBUTION_FIELDS.map((item, index) => {
			const value = decoded.success[index] as AbiValue;
			return [item.name, value instanceof Uint8Array ? toHex(value) : value.toString()];
		}),
	);
	if (!same(field(file, "contribution"), signed))
		return invalid("the readable contribution differs from the signed data");
	if (time !== signed.acceptedAt) return invalid("attestation time differs from the acceptance time");
	const attestation: AttestMessage = {
		schema: parseHex(SCHEMA_UID, 32) as Uint8Array,
		recipient: ZERO_ADDRESS_BYTES,
		time: BigInt(time),
		expirationTime: 0n,
		revocable: SCHEMA_REVOCABLE,
		refUID: ZERO_BYTES32_BYTES,
		data: dataBytes,
		salt: saltBytes,
	};
	const uid = toHex(offchainUid(SCHEMA_UID, attestation));
	if (field(sig, "uid") !== uid) return invalid("attestation UID does not match its content");
	// One text form per signature: exactly v, r and s, with lowercase hex as the issuer writes it.
	const signature = field(sig, "signature");
	if (
		!same(keysOf(signature), ["r", "s", "v"]) ||
		!LOWER_WORD.test(String(field(signature, "r"))) ||
		!LOWER_WORD.test(String(field(signature, "s")))
	)
		return invalid("signature must be exactly v, r and s, with r and s as lowercase 32-byte hex");
	const recovered = recoverAddress(
		attestDigest(TEST_DOMAIN, EAS_ADDRESS_BYTES, attestation),
		signature as EthSignature,
	);
	if (Result.isFailure(recovered)) return invalid(recovered.failure);
	const signer = recovered.success;
	if (field(eas, "signer") !== signer) return invalid(`signature was made by ${signer}, not the stated signer`);
	if (signer.toLowerCase() !== attester.toLowerCase())
		return invalid(`signed by ${signer}, not the expected attester ${attester}`);
	return { valid: true, signer, uid, contribution: signed };
};
