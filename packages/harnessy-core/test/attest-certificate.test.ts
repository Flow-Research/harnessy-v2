import { readFileSync } from "node:fs";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import {
	CERTIFICATE_FORMAT,
	CONTRIBUTION_FIELDS,
	type ContributionClaim,
	certificateText,
	claimFromRecord,
	claimJson,
	parseContributions,
	SCHEMA_UID,
	verifyCertificate,
} from "../src/attest/certificate.ts";
import { abiEncode, addressOf, keccak, offchainUid, parseHex, toHex } from "../src/attest/eas.ts";

const vectors = JSON.parse(
	readFileSync(new URL("./fixtures/attest/eas-sdk-vectors.json", import.meta.url), "utf8"),
) as {
	seed: string;
	signer: string;
	cases: Array<{ values: Record<string, string>; data: string; salt: string; uid: string; signature: unknown }>;
};
const SECRET = keccak(utf8ToBytes(vectors.seed));
const SIGNER = addressOf(SECRET);
const OTHER_SECRET = keccak(utf8ToBytes("another key"));
const PROJECT = "01a1601c-db5d-7559-9824-953db93ddcf7";

/** A WorkStream `contributions -o json` item, as the CLI prints it. */
const record = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	contribution_id: "01a16023-9d1f-74cf-9e14-fd2c50ea82b6",
	project_id: PROJECT,
	task_id: "01a16020-7f3f-78e2-96ce-2029226d3a1b",
	submission_id: "01a16021-ef00-7595-96e3-173438d254c2",
	contributor_id: "01a1601b-bbe7-760b-91bf-b3b3f355e8c6",
	contributor_display_name: "Claude Code agent (operated by Julian)",
	contribution_type: "accepted_submission",
	source_final_acceptance_id: "01a16023-9c95-71bb-b7ac-4bc93da2c60f",
	artifact_hash: "sha256:e02ac6d75e020e591a7626dc84533d17b5289be9e2ce2c061d8d0675810a6786",
	contribution_policy_version_id: "01a1601d-9bf4-7602-8867-b180b4d02d07",
	policy_version_number: 1,
	recorded_at: "2026-10-21T20:25:09.156547Z",
	accepted_at: "2026-10-21T20:25:09.062294Z",
	acceptance_source: "task_post_submit_route",
	task_title: "Loop smoke test",
	awards: [],
	...overrides,
});

const points = (quantity: string, unit = "FLOW") => ({
	award_id: "01a16023-0000-7000-8000-000000000001",
	award_definition_id: "01a16023-0000-7000-8000-000000000002",
	instrument: "project_points",
	unit,
	quantity,
});

const claimOf = (overrides: Record<string, unknown> = {}): ContributionClaim => {
	const claim = claimFromRecord(record(overrides), PROJECT);
	if (Result.isFailure(claim)) throw new Error(claim.failure);
	return claim.success;
};

const failure = (overrides: Record<string, unknown>) => {
	const claim = claimFromRecord(record(overrides), PROJECT);
	return Result.isFailure(claim) ? claim.failure : "accepted";
};

describe("contribution records", () => {
	it("keeps only the signed fields and no personal data", () => {
		const claim = claimOf();
		expect(claimJson(claim)).toEqual({
			contributionId: "01a16023-9d1f-74cf-9e14-fd2c50ea82b6",
			projectId: PROJECT,
			taskId: "01a16020-7f3f-78e2-96ce-2029226d3a1b",
			contributorId: "01a1601b-bbe7-760b-91bf-b3b3f355e8c6",
			contributionType: "accepted_submission",
			artifactHash: "0xe02ac6d75e020e591a7626dc84533d17b5289be9e2ce2c061d8d0675810a6786",
			acceptedAt: "1792614309",
			policyVersionId: "01a1601d-9bf4-7602-8867-b180b4d02d07",
			awardUnit: "",
			awardQuantity: "0",
		});
		const text = certificateText(claim, SECRET, SIGNER);
		expect(text).not.toContain("Claude Code agent");
		expect(text).not.toContain("Loop smoke test");
		expect(text).not.toContain("01a16021-ef00-7595-96e3-173438d254c2");
	});

	it("sums whole project points of one unit and ignores money awards", () => {
		const claim = claimOf({
			awards: [points("10"), points("5.000"), { instrument: "money", unit: "NGN", quantity: "2500.50" }],
		});
		expect([claim.awardUnit, claim.awardQuantity]).toEqual(["FLOW", 15n]);
	});

	it("accepts the largest uint256 points total", () => {
		const max = (2n ** 256n - 1n).toString();
		expect(claimOf({ awards: [points(max)] }).awardQuantity).toBe(2n ** 256n - 1n);
	});

	it("uses the record time for a completed review without its own acceptance", () => {
		const claim = claimOf({
			contribution_type: "completed_review",
			accepted_at: null,
			recorded_at: "2026-10-22T06:16:11.302562+00:00",
		});
		expect(claim.acceptedAt).toBe(1792649771n);
		expect(failure({ accepted_at: null })).toContain("has no valid acceptance time");
	});

	it("accepts real calendar edges and offsets", () => {
		expect(claimOf({ accepted_at: "2028-02-29T23:59:59.999-05:30" }).acceptedAt).toBe(1835501399n);
		expect(claimOf({ accepted_at: "2026-12-31T00:00:00Z" }).acceptedAt).toBe(1798675200n);
	});

	it("lower-cases IDs and the project comparison", () => {
		expect(claimFromRecord(record({ project_id: PROJECT.toUpperCase() }), PROJECT.toUpperCase())).toEqual(
			Result.succeed(claimOf()),
		);
	});

	it.each([
		[{ contribution_id: "not-a-uuid" }, "a contribution has a missing or malformed ID"],
		[{ project_id: undefined }, "a contribution has a missing or malformed ID"],
		[{ task_id: 7 }, "a contribution has a missing or malformed ID"],
		[{ contributor_id: null }, "a contribution has a missing or malformed ID"],
		[{ contribution_policy_version_id: "" }, "a contribution has a missing or malformed ID"],
		[{ project_id: "01a1601c-db5d-7559-9824-000000000000" }, "belongs to project"],
		[{ contribution_type: "bounty" }, "unknown contribution type"],
		[{ artifact_hash: "sha1:abc" }, "artifact_hash is not sha256"],
		[{ accepted_at: "yesterday" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-13-45T99:99:99Z" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-02-30T00:00:00Z" }, "has no valid acceptance time"],
		[{ accepted_at: "0050-01-01T00:00:00Z" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-04-31T10:00:00+01:00" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-00-10T10:00:00Z" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-01-01T24:00:00Z" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-01-01T10:60:00Z" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-01-01T10:00:60Z" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-01-01T10:00:00+24:00" }, "has no valid acceptance time"],
		[{ accepted_at: "2026-01-01T10:00:00-05:60" }, "has no valid acceptance time"],
		[{ accepted_at: 1792614309 }, "has no valid acceptance time"],
		[{ accepted_at: "1969-12-31T23:59:59Z" }, "has no valid acceptance time"],
		[{ awards: null }, "awards is not a list"],
		[{ awards: [points("1.5")] }, "not a whole number"],
		[{ awards: [points("-1")] }, "malformed quantity"],
		[{ awards: [points("1", "")] }, "no unit"],
		[{ awards: [{ instrument: "project_points", quantity: "1" }] }, "no unit"],
		[{ awards: [points("1"), points("1", "XP")] }, "more than one unit"],
		[{ awards: [points((2n ** 256n).toString())] }, "points total does not fit in uint256"],
		[{ awards: [points((2n ** 255n).toString()), points((2n ** 255n).toString())] }, "does not fit in uint256"],
	])("rejects %o", (overrides, message) => {
		expect(failure(overrides)).toContain(message);
	});

	it("parses a contribution list and fails the whole batch on any bad record", () => {
		const second = record({ contribution_id: "01a16240-b924-7823-b2ff-7462a1dd0983", awards: [points("10")] });
		const ok = parseContributions(JSON.stringify({ exported_at: "x", items: [record(), second] }), PROJECT);
		expect(Result.isSuccess(ok) && ok.success.map((claim) => claim.awardQuantity)).toEqual([0n, 10n]);
		expect(parseContributions(JSON.stringify({ items: [] }), PROJECT)).toEqual(Result.succeed([]));
		expect(parseContributions("not json", PROJECT)).toEqual(Result.fail("WorkStream returned no contribution list"));
		expect(parseContributions(JSON.stringify({ items: {} }), PROJECT)).toEqual(
			Result.fail("WorkStream returned no contribution list"),
		);
		expect(parseContributions(JSON.stringify({ items: [record(), record()] }), PROJECT)).toEqual(
			Result.fail("contribution 01a16023-9d1f-74cf-9e14-fd2c50ea82b6 appears twice"),
		);
		expect(
			parseContributions(JSON.stringify({ items: [record(), record({ artifact_hash: "x" })] }), PROJECT),
		).toEqual(Result.fail("contribution 01a16023-9d1f-74cf-9e14-fd2c50ea82b6: artifact_hash is not sha256:<64 hex>"));
	});
});

describe("certificates", () => {
	it("embeds exactly what the official EAS SDK signs for the same contribution", () => {
		for (const vector of vectors.cases) {
			const v = vector.values;
			const claim = claimOf({
				contribution_id: v.contributionId,
				task_id: v.taskId,
				contributor_id: v.contributorId,
				contribution_type: v.contributionType,
				artifact_hash: `sha256:${(v.artifactHash as string).slice(2)}`,
				accepted_at: new Date(Number(v.acceptedAt) * 1000).toISOString(),
				contribution_policy_version_id: v.policyVersionId,
				awards: v.awardUnit === "" ? [] : [points(v.awardQuantity as string, v.awardUnit)],
			});
			const sig = JSON.parse(certificateText(claim, SECRET, SIGNER)).eas.sig;
			expect(sig.message.data).toBe(vector.data);
			expect(sig.message.salt).toBe(vector.salt);
			expect(sig.uid).toBe(vector.uid);
			expect(sig.signature).toEqual(vector.signature);
		}
	});

	it("is deterministic and marked as a test certificate", () => {
		const text = certificateText(claimOf(), SECRET, SIGNER);
		expect(certificateText(claimOf(), SECRET, SIGNER)).toBe(text);
		const file = JSON.parse(text);
		expect(file).toMatchObject({ format: CERTIFICATE_FORMAT, test: true, eas: { signer: vectors.signer } });
		expect(file.notice).toMatch(/^TEST certificate/);
		expect(file.eas.sig.domain.chainId).toBe("84532");
		expect(text.endsWith("}\n")).toBe(true);
	});
});

const SIGNATURE_SHAPE = "signature must be exactly v, r and s, with r and s as lowercase 32-byte hex";

describe("verification", () => {
	const valid = certificateText(claimOf({ awards: [points("10")] }), SECRET, SIGNER);
	type Mutable = Record<string, any>;
	const edit = (change: (file: Mutable) => void, text = valid): string => {
		const file = JSON.parse(text) as Mutable;
		change(file);
		return JSON.stringify(file);
	};
	const reason = (text: string, attester = SIGNER) => {
		const verdict = verifyCertificate(text, attester);
		return verdict.valid ? "valid" : verdict.reason;
	};

	it("accepts an untouched certificate and reports the signed contribution", () => {
		const verdict = verifyCertificate(valid, SIGNER.toLowerCase());
		expect(verdict).toMatchObject({ valid: true, signer: SIGNER, uid: JSON.parse(valid).eas.sig.uid });
		expect(verdict.valid && verdict.contribution).toMatchObject({ awardUnit: "FLOW", awardQuantity: "10" });
	});

	it("rejects files that are not Harnessy test certificates", () => {
		expect(reason("{")).toBe("not a Harnessy test certificate");
		expect(
			reason(
				edit((file) => {
					file.test = false;
				}),
			),
		).toBe("not a Harnessy test certificate");
		expect(
			reason(
				edit((file) => {
					file.format = "other";
				}),
			),
		).toBe("not a Harnessy test certificate");
	});

	it("rejects added, missing or reworded unsigned fields", () => {
		const message = "the certificate has missing, extra or changed unsigned fields";
		expect(
			reason(
				edit((file) => {
					file.taskTitle = "Shipped the payments system";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.notice = "Production certificate";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.note = "x";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.extra = "x";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					delete file.eas;
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas = null;
				}),
			),
		).toBe(message);
		expect(reason("[]")).toBe("not a Harnessy test certificate");
	});

	it("rejects a different schema", () => {
		expect(
			reason(
				edit((file) => {
					file.schema.uid = `0x${"11".repeat(32)}`;
				}),
			),
		).toMatch(/^schema is not/);
		expect(
			reason(
				edit((file) => {
					file.schema.revocable = false;
				}),
			),
		).toMatch(/^schema is not/);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.schema = `0x${"11".repeat(32)}`;
				}),
			),
		).toBe("attestation fields differ from the certificate schema");
	});

	it("rejects another chain, primary type or type list", () => {
		const message = "EIP-712 domain or types are not EAS version 2 on Base Sepolia";
		expect(
			reason(
				edit((file) => {
					file.eas.sig.domain.chainId = "8453";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.primaryType = "Attestation";
				}),
			),
		).toBe(message);
		expect(reason(edit((file) => file.eas.sig.types.Attest.pop()))).toBe(message);
	});

	it("rejects changed or extra fixed attestation fields", () => {
		const message = "attestation fields differ from the certificate schema";
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.expirationTime = "1";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.extra = 1;
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message = null;
				}),
			),
		).toBe(message);
	});

	it("rejects malformed time, data or salt", () => {
		const message = "attestation time, data or salt is malformed";
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.time = "01";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.time = 1792614309;
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.data = "0xz";
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.salt = "0x00";
				}),
			),
		).toBe(message);
	});

	it("rejects non-canonical signed data", () => {
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.data += "00".repeat(32);
				}),
			),
		).toBe("attestation data is not the canonical ABI encoding for the schema");
	});

	it("rejects a tampered readable field or time", () => {
		expect(
			reason(
				edit((file) => {
					file.contribution.awardQuantity = "1000";
				}),
			),
		).toBe("the readable contribution differs from the signed data");
		expect(
			reason(
				edit((file) => {
					file.eas.sig.message.time = "1792614310";
				}),
			),
		).toBe("attestation time differs from the acceptance time");
	});

	const forged = (claim: ContributionClaim) => (file: Mutable) => {
		const data = abiEncode(
			CONTRIBUTION_FIELDS,
			CONTRIBUTION_FIELDS.map((item) =>
				item.name === "artifactHash"
					? (parseHex(claim.artifactHash, 32) as Uint8Array)
					: (claim[item.name as keyof ContributionClaim] as string | bigint),
			),
		);
		file.eas.sig.message.data = toHex(data);
		file.contribution = claimJson(claim);
		return data;
	};

	it("rejects re-signed data whose UID was not updated", () => {
		const other = claimOf({ awards: [points("1000")] });
		expect(reason(edit((file) => forged(other)(file)))).toBe("attestation UID does not match its content");
	});

	it("rejects re-encoded data with a recomputed UID: the signature no longer matches", () => {
		const other = claimOf({ awards: [points("1000")] });
		const text = edit((file) => {
			const data = forged(other)(file);
			file.eas.sig.uid = toHex(
				offchainUid(SCHEMA_UID, {
					schema: parseHex(SCHEMA_UID, 32) as Uint8Array,
					recipient: new Uint8Array(20),
					time: other.acceptedAt,
					expirationTime: 0n,
					revocable: true,
					refUID: new Uint8Array(32),
					data,
					salt: parseHex(file.eas.sig.message.salt, 32) as Uint8Array,
				}),
			);
		});
		expect(reason(text)).toMatch(/^signature was made by 0x[0-9a-fA-F]{40}, not the stated signer$/);
	});

	it("rejects a missing or malformed signature", () => {
		expect(
			reason(
				edit((file) => {
					file.eas.sig.signature = null;
				}),
			),
		).toBe(SIGNATURE_SHAPE);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.signature.note = "Flow production attestation";
				}),
			),
		).toBe(SIGNATURE_SHAPE);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.signature.r = file.eas.sig.signature.r.toUpperCase().replace("0X", "0x");
				}),
			),
		).toBe(SIGNATURE_SHAPE);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.signature.s = "0x00";
				}),
			),
		).toBe(SIGNATURE_SHAPE);
		expect(
			reason(
				edit((file) => {
					file.eas.sig.signature.v = 29;
				}),
			),
		).toBe("signature must have v 27 or 28 and 32-byte r and s");
		expect(
			reason(
				edit((file) => {
					file.eas.sig.signature.r = `0x${"00".repeat(32)}`;
				}),
			),
		).toBe("signature does not recover to a valid signer");
	});

	it("requires the stated signer to be the exact checksummed signer string", () => {
		const message = `signature was made by ${SIGNER}, not the stated signer`;
		expect(
			reason(
				edit((file) => {
					file.eas.signer = SIGNER.toLowerCase();
				}),
			),
		).toBe(message);
		expect(
			reason(
				edit((file) => {
					file.eas.signer = [SIGNER];
				}),
			),
		).toBe(message);
	});

	it("rejects a certificate signed by another key", () => {
		const other = certificateText(claimOf(), OTHER_SECRET, addressOf(OTHER_SECRET));
		expect(reason(other)).toBe(`signed by ${addressOf(OTHER_SECRET)}, not the expected attester ${SIGNER}`);
		expect(reason(other, addressOf(OTHER_SECRET))).toBe("valid");
		expect(
			reason(
				edit((file) => {
					file.eas.signer = SIGNER;
				}, other),
			),
		).toBe(`signature was made by ${addressOf(OTHER_SECRET)}, not the stated signer`);
	});
});
