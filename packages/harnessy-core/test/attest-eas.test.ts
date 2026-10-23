import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { CONTRIBUTION_FIELDS, EAS_BASE_SEPOLIA, SCHEMA, SCHEMA_UID, TEST_DOMAIN } from "../src/attest/certificate.ts";
import {
	ATTEST_TYPES,
	type AttestMessage,
	abiDecode,
	abiEncode,
	addressOf,
	attestDigest,
	checksumAddress,
	keccak,
	offchainUid,
	parseHex,
	recoverAddress,
	schemaUid,
	signDigest,
	toHex,
	uintBytes,
} from "../src/attest/eas.ts";

interface VectorCase {
	readonly values: Record<string, string>;
	readonly data: string;
	readonly salt: string;
	readonly digest: string;
	readonly uid: string;
	readonly signature: { v: number; r: string; s: string };
	readonly domain: Record<string, string>;
	readonly types: unknown;
	readonly primaryType: string;
}

/** Produced by test/fixtures/attest/generate-vectors.mjs with the official EAS SDK 2.10.0. */
const vectors = JSON.parse(
	readFileSync(new URL("./fixtures/attest/eas-sdk-vectors.json", import.meta.url), "utf8"),
) as {
	seed: string;
	signer: string;
	schema: string;
	schemaUid: string;
	cases: VectorCase[];
};
const SECRET = keccak(utf8ToBytes(vectors.seed));
const EAS = parseHex(EAS_BASE_SEPOLIA, 20) as Uint8Array;

const valuesOf = (values: Record<string, string>) =>
	CONTRIBUTION_FIELDS.map((field) => {
		const value = values[field.name] as string;
		if (field.type === "bytes32") return parseHex(value, 32) as Uint8Array;
		return field.type === "string" ? value : BigInt(value);
	});

const messageOf = (vector: VectorCase): AttestMessage => ({
	schema: parseHex(SCHEMA_UID, 32) as Uint8Array,
	recipient: new Uint8Array(20),
	time: BigInt(vector.values.acceptedAt as string),
	expirationTime: 0n,
	revocable: true,
	refUID: new Uint8Array(32),
	data: parseHex(vector.data) as Uint8Array,
	salt: parseHex(vector.salt, 32) as Uint8Array,
});

describe("EAS primitives against the official SDK", () => {
	it("computes the schema string and UID exactly as the SchemaRegistry does", () => {
		expect(SCHEMA).toBe(vectors.schema);
		expect(SCHEMA_UID).toBe(vectors.schemaUid);
		expect(toHex(schemaUid(SCHEMA, new Uint8Array(20), true))).toBe(vectors.schemaUid);
		expect(toHex(schemaUid(SCHEMA, new Uint8Array(20), false))).not.toBe(vectors.schemaUid);
	});

	it("uses the SDK's version 2 domain and types", () => {
		for (const vector of vectors.cases) {
			expect(vector.domain).toEqual({ ...TEST_DOMAIN, chainId: TEST_DOMAIN.chainId.toString() });
			expect(vector.types).toEqual(ATTEST_TYPES);
			expect(vector.primaryType).toBe("Attest");
		}
	});

	it("binds the revocable flag into the digest and the UID", () => {
		const vector = vectors.cases[0] as VectorCase;
		const message = messageOf(vector);
		const irrevocable = { ...message, revocable: false };
		expect(toHex(attestDigest(TEST_DOMAIN, EAS, irrevocable))).not.toBe(vector.digest);
		expect(toHex(offchainUid(SCHEMA_UID, irrevocable))).not.toBe(vector.uid);
	});

	it("derives the vector signer address from the fixed test key", () => {
		expect(addressOf(SECRET)).toBe(vectors.signer);
	});

	it.each(
		vectors.cases.map((vector) => [vector.values.awardUnit === "" ? "no award" : "with award", vector] as const),
	)("matches the SDK encoding, digest, UID and RFC 6979 signature (%s)", (_name, vector) => {
		const data = abiEncode(CONTRIBUTION_FIELDS, valuesOf(vector.values));
		expect(toHex(data)).toBe(vector.data);
		const message = messageOf(vector);
		const digest = attestDigest(TEST_DOMAIN, EAS, message);
		expect(toHex(digest)).toBe(vector.digest);
		expect(toHex(offchainUid(SCHEMA_UID, message))).toBe(vector.uid);
		expect(signDigest(digest, SECRET)).toEqual(vector.signature);
		expect(recoverAddress(digest, vector.signature)).toEqual(Result.succeed(vectors.signer));
	});
});

describe("ABI encoding", () => {
	const vector = vectors.cases[1] as VectorCase;
	const data = parseHex(vector.data) as Uint8Array;

	it("round-trips the canonical encoding", () => {
		expect(abiDecode(CONTRIBUTION_FIELDS, data)).toEqual(Result.succeed(valuesOf(vector.values)));
	});

	it("rejects non-canonical, truncated and non-UTF-8 data", () => {
		const trailing = new Uint8Array([...data, ...new Uint8Array(32)]);
		expect(abiDecode(CONTRIBUTION_FIELDS, trailing)).toEqual(
			Result.fail("attestation data is not the canonical ABI encoding for the schema"),
		);
		expect(abiDecode(CONTRIBUTION_FIELDS, data.subarray(0, 100))).toEqual(
			Result.fail("attestation data is not valid ABI for the schema"),
		);
		const badUtf8 = abiEncode([{ name: "s", type: "string" }], ["ab"]);
		badUtf8[64] = 0xff;
		expect(Result.isFailure(abiDecode([{ name: "s", type: "string" }], badUtf8))).toBe(true);
		const bigInt = abiEncode([{ name: "n", type: "uint256" }], [2n ** 64n]);
		expect(abiDecode([{ name: "n", type: "uint64" }], bigInt)).toEqual(
			Result.fail("attestation data is not the canonical ABI encoding for the schema"),
		);
	});

	it("rejects values that do not fit the schema", () => {
		expect(() => abiEncode([{ name: "s", type: "string" }], [])).toThrow("value count");
		expect(() => abiEncode([{ name: "s", type: "string" }], [1n])).toThrow("s needs a string");
		expect(() => abiEncode([{ name: "h", type: "bytes32" }], ["0x00"])).toThrow("bytes32 needs 32 bytes");
		expect(() => abiEncode([{ name: "h", type: "bytes32" }], [new Uint8Array(31)])).toThrow("bytes32 needs 32 bytes");
		expect(() => abiEncode([{ name: "n", type: "uint64" }], ["1"])).toThrow("uint64 needs an integer");
		expect(() => abiEncode([{ name: "n", type: "uint64" }], [2n ** 64n])).toThrow("uint64 out of range");
		expect(() => abiEncode([{ name: "n", type: "uint256" }], [2n ** 256n])).toThrow("uint256 out of range");
		expect(toHex(abiEncode([{ name: "n", type: "uint256" }], [2n ** 256n - 1n]))).toBe(`0x${"ff".repeat(32)}`);
	});

	it("bounds fixed-width integers", () => {
		expect(toHex(uintBytes(258n, 2))).toBe("0x0102");
		expect(() => uintBytes(-1n, 2)).toThrow("out of range");
		expect(() => uintBytes(65536n, 2)).toThrow("out of range");
	});
});

describe("hex and addresses", () => {
	it("parses only even-length 0x hex of the requested size", () => {
		expect(parseHex("0x0aFF")).toEqual(Uint8Array.of(10, 255));
		expect(parseHex("0x", 0)).toEqual(new Uint8Array(0));
		expect(parseHex("0x0aff", 3)).toBeUndefined();
		expect(parseHex("0xabc")).toBeUndefined();
		expect(parseHex("abcd")).toBeUndefined();
		expect(parseHex(1234)).toBeUndefined();
	});

	it("applies the EIP-55 checksum", () => {
		expect(checksumAddress(parseHex("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed") as Uint8Array)).toBe(
			"0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
		);
	});
});

describe("signature recovery", () => {
	const vector = vectors.cases[0] as VectorCase;
	const digest = parseHex(vector.digest, 32) as Uint8Array;
	const n = secp256k1.Point.Fn.ORDER;

	it("rejects malformed signatures", () => {
		const bad = Result.fail("signature must have v 27 or 28 and 32-byte r and s");
		expect(recoverAddress(digest, { ...vector.signature, v: 1 })).toEqual(bad);
		expect(recoverAddress(digest, { ...vector.signature, r: "0x1234" })).toEqual(bad);
		expect(recoverAddress(digest, { ...vector.signature, s: "nope" })).toEqual(bad);
	});

	it("rejects the high-S twin of a valid signature and zero r", () => {
		const highS = toHex(uintBytes(n - BigInt(vector.signature.s), 32));
		const flipped = vector.signature.v === 27 ? 28 : 27;
		const unusable = Result.fail("signature does not recover to a valid signer");
		expect(recoverAddress(digest, { v: flipped, r: vector.signature.r, s: highS })).toEqual(unusable);
		expect(recoverAddress(digest, { ...vector.signature, r: `0x${"00".repeat(32)}` })).toEqual(unusable);
	});

	it("recovers a different signer for a different digest", () => {
		const other = recoverAddress(keccak(utf8ToBytes("other")), vector.signature);
		expect(Result.isSuccess(other) && other.success).not.toBe(vectors.signer);
	});
});
