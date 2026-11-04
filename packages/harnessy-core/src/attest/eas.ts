/**
 * Ethereum Attestation Service (EAS) off-chain attestation primitives, version 2.
 *
 * Mirrors `@ethereum-attestation-service/eas-sdk` 2.10.0 (`offchain/offchain.ts`,
 * `offchain/typed-data-handler.ts`, `schema-registry.ts`, `schema-encoder.ts`)
 * without ethers: EIP-712 hashing with keccak-256 and secp256k1 signing with
 * deterministic RFC 6979 nonces. `test/fixtures/attest/eas-sdk-vectors.json`
 * holds the SDK's own output for the same inputs.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import * as Result from "effect/Result";

/** EAS off-chain attestation format version 2: the SDK's latest, which adds a salt. */
export const OFFCHAIN_VERSION = 2;
export const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
export const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

/** EIP-712 domain of an EAS deployment, as the SDK builds it from the contract. */
export interface EasDomain {
	readonly name: string;
	readonly version: string;
	readonly chainId: bigint;
	readonly verifyingContract: string;
}

/** The SDK's `OFFCHAIN_ATTESTATION_TYPES[Version2]` signing type. */
export const ATTEST_TYPES = {
	Attest: [
		{ name: "version", type: "uint16" },
		{ name: "schema", type: "bytes32" },
		{ name: "recipient", type: "address" },
		{ name: "time", type: "uint64" },
		{ name: "expirationTime", type: "uint64" },
		{ name: "revocable", type: "bool" },
		{ name: "refUID", type: "bytes32" },
		{ name: "data", type: "bytes" },
		{ name: "salt", type: "bytes32" },
	],
} as const;
export const ATTEST_PRIMARY_TYPE = "Attest";
const ATTEST_TYPE_STRING = `Attest(${ATTEST_TYPES.Attest.map((field) => `${field.type} ${field.name}`).join(",")})`;
const DOMAIN_TYPE_STRING = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** The fields of one version 2 off-chain attestation message, as bytes and integers. */
export interface AttestMessage {
	readonly schema: Uint8Array;
	readonly recipient: Uint8Array;
	readonly time: bigint;
	readonly expirationTime: bigint;
	readonly revocable: boolean;
	readonly refUID: Uint8Array;
	readonly data: Uint8Array;
	readonly salt: Uint8Array;
}

/** An Ethereum-style recoverable signature: `v` is 27 or 28, `r` and `s` are 32-byte hex. */
export interface EthSignature {
	readonly v: number;
	readonly r: string;
	readonly s: string;
}

const UINT64_MAX = 2n ** 64n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;
const HALF_ORDER = secp256k1.Point.Fn.ORDER >> 1n;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

export const keccak = (bytes: Uint8Array): Uint8Array => keccak_256(bytes);
export const toHex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

/** `0x` hex of an exact byte length (any length when omitted), or undefined. */
export const parseHex = (value: unknown, length?: number): Uint8Array | undefined => {
	if (typeof value !== "string" || !HEX.test(value)) return undefined;
	const bytes = hexToBytes(value.slice(2));
	return length === undefined || bytes.length === length ? bytes : undefined;
};

/** Big-endian unsigned integer of `size` bytes; throws when out of range. */
export const uintBytes = (value: bigint, size: number): Uint8Array => {
	if (value < 0n || value >= 1n << BigInt(size * 8)) throw new Error(`integer out of range for ${size * 8} bits`);
	return hexToBytes(value.toString(16).padStart(size * 2, "0"));
};

const word = (value: bigint): Uint8Array => uintBytes(value, 32);
const leftPad = (bytes: Uint8Array): Uint8Array => concatBytes(new Uint8Array(32 - bytes.length), bytes);

/** ABI types used by Harnessy schemas. */
export type AbiType = "string" | "bytes32" | "uint64" | "uint256";
export interface AbiField {
	readonly name: string;
	readonly type: AbiType;
}
export type AbiValue = string | bigint | Uint8Array;

/** The EAS schema string: `type name` pairs joined by commas, as registered. */
export const schemaString = (fields: ReadonlyArray<AbiField>): string =>
	fields.map((field) => `${field.type} ${field.name}`).join(",");

/** `SchemaRegistry.getSchemaUID`: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export const schemaUid = (schema: string, resolver: Uint8Array, revocable: boolean): Uint8Array =>
	keccak(concatBytes(utf8ToBytes(schema), resolver, Uint8Array.of(revocable ? 1 : 0)));

const staticWord = (type: Exclude<AbiType, "string">, value: AbiValue): Uint8Array => {
	if (type === "bytes32") {
		if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error("bytes32 needs 32 bytes");
		return value;
	}
	if (typeof value !== "bigint") throw new Error(`${type} needs an integer`);
	if (value > (type === "uint64" ? UINT64_MAX : UINT256_MAX)) throw new Error(`${type} out of range`);
	return word(value);
};

/** Standard ABI encoding of one tuple, as `SchemaEncoder.encodeData` produces. Throws on a type mismatch. */
export const abiEncode = (fields: ReadonlyArray<AbiField>, values: ReadonlyArray<AbiValue>): Uint8Array => {
	if (fields.length !== values.length) throw new Error("value count does not match the schema");
	const heads: Uint8Array[] = [];
	const tails: Uint8Array[] = [];
	let tailOffset = 32 * fields.length;
	fields.forEach((field, index) => {
		const value = values[index] as AbiValue;
		if (field.type !== "string") {
			heads.push(staticWord(field.type, value));
			return;
		}
		if (typeof value !== "string") throw new Error(`${field.name} needs a string`);
		const bytes = utf8ToBytes(value);
		const padded = concatBytes(bytes, new Uint8Array((32 - (bytes.length % 32)) % 32));
		heads.push(word(BigInt(tailOffset)));
		tails.push(word(BigInt(bytes.length)), padded);
		tailOffset += 32 + padded.length;
	});
	return concatBytes(...heads, ...tails);
};

const readWord = (data: Uint8Array, offset: number): bigint => BigInt(toHex(data.subarray(offset, offset + 32)));
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode `data` for `fields`, accepting only the canonical encoding: the
 * decoded values must re-encode to exactly the same bytes. Out-of-range
 * offsets, trailing bytes, dirty padding and invalid UTF-8 all fail.
 */
export const abiDecode = (fields: ReadonlyArray<AbiField>, data: Uint8Array): Result.Result<AbiValue[], string> => {
	const decoded = Result.try(() =>
		fields.map((field, index): AbiValue => {
			const head = data.subarray(index * 32, index * 32 + 32);
			if (field.type === "bytes32") return head;
			if (field.type !== "string") return readWord(data, index * 32);
			const offset = Number(readWord(data, index * 32));
			const length = Number(readWord(data, offset));
			return UTF8.decode(data.subarray(offset + 32, offset + 32 + length));
		}),
	);
	if (Result.isFailure(decoded)) return Result.fail("attestation data is not valid ABI for the schema");
	const again = Result.try(() => abiEncode(fields, decoded.success));
	return Result.isSuccess(again) && bytesToHex(again.success) === bytesToHex(data)
		? Result.succeed(decoded.success)
		: Result.fail("attestation data is not the canonical ABI encoding for the schema");
};

/** EIP-712 domain separator for `EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)`. */
export const domainSeparator = (domain: EasDomain, verifyingContract: Uint8Array): Uint8Array =>
	keccak(
		concatBytes(
			keccak(utf8ToBytes(DOMAIN_TYPE_STRING)),
			keccak(utf8ToBytes(domain.name)),
			keccak(utf8ToBytes(domain.version)),
			word(domain.chainId),
			leftPad(verifyingContract),
		),
	);

/** EIP-712 `hashStruct` of the version 2 `Attest` message. */
export const attestStructHash = (message: AttestMessage): Uint8Array =>
	keccak(
		concatBytes(
			keccak(utf8ToBytes(ATTEST_TYPE_STRING)),
			word(BigInt(OFFCHAIN_VERSION)),
			message.schema,
			leftPad(message.recipient),
			word(message.time),
			word(message.expirationTime),
			word(message.revocable ? 1n : 0n),
			message.refUID,
			keccak(message.data),
			message.salt,
		),
	);

/** The EIP-712 digest the attester signs: keccak256(0x1901 || domainSeparator || hashStruct). */
export const attestDigest = (domain: EasDomain, verifyingContract: Uint8Array, message: AttestMessage): Uint8Array =>
	keccak(
		concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator(domain, verifyingContract), attestStructHash(message)),
	);

/**
 * `Offchain.getOffchainUID` for version 2. The SDK packs the schema UID as the
 * UTF-8 bytes of its hex string, not as 32 raw bytes, so `schemaHex` must be
 * the exact string stored in the message. The trailing zero is a `uint32`.
 */
export const offchainUid = (schemaHex: string, message: AttestMessage): Uint8Array =>
	keccak(
		concatBytes(
			uintBytes(BigInt(OFFCHAIN_VERSION), 2),
			utf8ToBytes(schemaHex),
			message.recipient,
			new Uint8Array(20),
			uintBytes(message.time, 8),
			uintBytes(message.expirationTime, 8),
			Uint8Array.of(message.revocable ? 1 : 0),
			message.refUID,
			message.data,
			message.salt,
			new Uint8Array(4),
		),
	);

/** EIP-55 mixed-case checksum form of a 20-byte address. */
export const checksumAddress = (address: Uint8Array): string => {
	const lower = bytesToHex(address);
	const hash = bytesToHex(keccak(utf8ToBytes(lower)));
	let out = "0x";
	for (let index = 0; index < lower.length; index++)
		out += Number.parseInt(hash[index] as string, 16) >= 8 ? lower[index]?.toUpperCase() : lower[index];
	return out;
};

const publicKeyAddress = (uncompressed: Uint8Array): string =>
	checksumAddress(keccak(uncompressed.subarray(1)).subarray(12));

/** Checksummed Ethereum address of a secp256k1 secret key. */
export const addressOf = (secretKey: Uint8Array): string => publicKeyAddress(secp256k1.getPublicKey(secretKey, false));

export const isValidSecretKey = (secretKey: Uint8Array): boolean => secp256k1.utils.isValidSecretKey(secretKey);

/** Deterministic (RFC 6979) low-S signature of a 32-byte digest. */
export const signDigest = (digest: Uint8Array, secretKey: Uint8Array): EthSignature => {
	const recovered = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });
	return {
		v: 27 + (recovered[0] as number),
		r: toHex(recovered.subarray(1, 33)),
		s: toHex(recovered.subarray(33, 65)),
	};
};

/** Recover the checksummed signer address, rejecting malformed and high-S (malleable) signatures. */
export const recoverAddress = (digest: Uint8Array, signature: EthSignature): Result.Result<string, string> => {
	const r = parseHex(signature.r, 32);
	const s = parseHex(signature.s, 32);
	if ((signature.v !== 27 && signature.v !== 28) || r === undefined || s === undefined)
		return Result.fail("signature must have v 27 or 28 and 32-byte r and s");
	const recovered = Result.try(() => {
		const parsed = secp256k1.Signature.fromBytes(concatBytes(Uint8Array.of(signature.v - 27), r, s), "recovered");
		if (parsed.s > HALF_ORDER) throw new Error("high-S");
		return publicKeyAddress(parsed.recoverPublicKey(digest).toBytes(false));
	});
	return Result.isSuccess(recovered)
		? Result.succeed(recovered.success)
		: Result.fail("signature does not recover to a valid signer");
};
