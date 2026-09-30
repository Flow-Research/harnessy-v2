/**
 * Encryption at rest for auth.json.
 *
 * The file holds either the legacy plaintext credential document or an
 * envelope encrypting that document with AES-256-GCM. The key comes from a
 * passphrase in the environment (scrypt) or from a random key stored in the OS
 * keychain and referenced by id, so a relocated file still finds its key.
 * Without either, auth.json stays plaintext (mode 0600) unless encryption is
 * required.
 *
 * This keeps credentials out of backups, synced folders, disk images and
 * accidental commits. It does not isolate credentials from code running as the
 * same user: extensions run in-process, and the keychain releases the key to
 * any process that can invoke the platform keychain tool.
 */

import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { APP_NAME } from "../config.ts";

export type AuthEncryptionMode = "auto" | "required" | "off";

/** Stores 32-byte data keys by id. `store` returns false when no keychain is usable. */
export interface AuthKeychain {
	load(id: string): Buffer | undefined;
	store(id: string, key: Buffer): boolean;
}

export interface AuthFileCipherOptions {
	mode?: AuthEncryptionMode;
	passphrase?: string;
	keychain?: AuthKeychain;
}

type KeyDescriptor =
	| { source: "keychain"; id: string }
	| { source: "passphrase"; salt: string; n: number; r: number; p: number };

interface AuthEnvelope {
	authEncryption: 1;
	alg: "aes-256-gcm";
	key: KeyDescriptor;
	iv: string;
	tag: string;
	data: string;
}

const KEYCHAIN_SERVICE = "pi-coding-agent-auth";
const KEYCHAIN_TIMEOUT_MS = 15000;
const SCRYPT = { n: 2 ** 15, r: 8, p: 1 } as const;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export class AuthDecryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthDecryptionError";
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isBase64 = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);

const isHexKey = (value: string) => /^[0-9a-f]{64}$/.test(value);

const newPassphraseDescriptor = (): KeyDescriptor => ({
	source: "passphrase",
	salt: randomBytes(16).toString("base64"),
	...SCRYPT,
});

/** Returns the envelope, undefined for a plaintext document, or throws for a malformed envelope. */
function parseEnvelope(raw: string): AuthEnvelope | undefined {
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(document) || !("authEncryption" in document)) return undefined;
	const { authEncryption, alg, key, iv, tag, data } = document;
	if (authEncryption !== 1 || alg !== "aes-256-gcm" || !isBase64(iv) || !isBase64(tag) || !isBase64(data)) {
		throw new AuthDecryptionError("Unsupported or malformed auth.json encryption envelope");
	}
	if (isRecord(key) && key.source === "keychain" && typeof key.id === "string" && /^[0-9a-f-]{36}$/.test(key.id)) {
		return { authEncryption, alg, key: { source: "keychain", id: key.id }, iv, tag, data };
	}
	if (
		isRecord(key) &&
		key.source === "passphrase" &&
		isBase64(key.salt) &&
		key.n === SCRYPT.n &&
		key.r === SCRYPT.r &&
		key.p === SCRYPT.p
	) {
		return { authEncryption, alg, key: { source: "passphrase", salt: key.salt, ...SCRYPT }, iv, tag, data };
	}
	throw new AuthDecryptionError("Unsupported auth.json encryption key descriptor");
}

/** Binds the key descriptor to the ciphertext so it cannot be swapped. */
function additionalData(key: KeyDescriptor): Buffer {
	const fields = key.source === "keychain" ? [key.source, key.id] : [key.source, key.salt, key.n, key.r, key.p];
	return Buffer.from(JSON.stringify([1, "aes-256-gcm", ...fields]), "utf-8");
}

export class AuthFileCipher {
	private mode: AuthEncryptionMode;
	private passphrase: string | undefined;
	private keychain: AuthKeychain | undefined;
	private keys = new Map<string, Buffer>();

	constructor(options: AuthFileCipherOptions = {}) {
		this.mode = options.mode ?? "auto";
		this.passphrase = options.passphrase || undefined;
		this.keychain = options.keychain;
	}

	/** Whether stored content is (or claims to be) an encryption envelope. */
	static isEncrypted(raw: string): boolean {
		try {
			return parseEnvelope(raw) !== undefined;
		} catch {
			return true;
		}
	}

	/** Returns the plaintext credential document for stored file content. */
	decode(raw: string): string {
		const envelope = parseEnvelope(raw);
		if (!envelope) {
			if (this.mode === "required" && raw.trim() !== "" && raw.trim() !== "{}") {
				throw new AuthDecryptionError("auth.json is not encrypted but encryption is required");
			}
			return raw;
		}
		const key = this.resolveKey(envelope.key);
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
			decipher.setAAD(additionalData(envelope.key));
			decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
			const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
			return plaintext.toString("utf-8");
		} catch {
			throw new AuthDecryptionError("auth.json could not be decrypted: wrong key or modified file");
		}
	}

	/**
	 * Returns file content for a plaintext credential document. An existing
	 * envelope keeps its key source; otherwise a passphrase wins over the keychain.
	 */
	encode(plaintext: string, previousRaw: string | undefined): string {
		if (this.mode === "off") return plaintext;
		const previous = previousRaw === undefined ? undefined : parseEnvelope(previousRaw);
		// A fresh salt per write keeps passphrase files independent across rotations.
		const descriptor = previous
			? previous.key.source === "passphrase"
				? newPassphraseDescriptor()
				: previous.key
			: this.newDescriptor();
		if (!descriptor) {
			if (this.mode === "required") {
				throw new Error(
					`Auth encryption is required but no OS keychain is available and ${authEnvName("AUTH_PASSPHRASE")} is not set`,
				);
			}
			return plaintext;
		}
		const key = this.resolveKey(descriptor);
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(additionalData(descriptor));
		const data = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
		const envelope: AuthEnvelope = {
			authEncryption: 1,
			alg: "aes-256-gcm",
			key: descriptor,
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			data: data.toString("base64"),
		};
		return JSON.stringify(envelope, null, 2);
	}

	private newDescriptor(): KeyDescriptor | undefined {
		if (this.passphrase) return newPassphraseDescriptor();
		if (!this.keychain) return undefined;
		const id = randomUUID();
		const key = randomBytes(32);
		if (!this.keychain.store(id, key)) return undefined;
		this.keys.set(`keychain:${id}`, key);
		return { source: "keychain", id };
	}

	private resolveKey(descriptor: KeyDescriptor): Buffer {
		const cacheKey = descriptor.source === "keychain" ? `keychain:${descriptor.id}` : `passphrase:${descriptor.salt}`;
		const cached = this.keys.get(cacheKey);
		if (cached) return cached;
		let key: Buffer | undefined;
		if (descriptor.source === "keychain") {
			key = this.keychain?.load(descriptor.id);
			if (!key) throw new AuthDecryptionError("auth.json encryption key was not found in the OS keychain");
		} else {
			if (!this.passphrase) {
				throw new AuthDecryptionError(`auth.json is passphrase-encrypted; set ${authEnvName("AUTH_PASSPHRASE")}`);
			}
			key = scryptSync(this.passphrase, Buffer.from(descriptor.salt, "base64"), 32, {
				N: descriptor.n,
				r: descriptor.r,
				p: descriptor.p,
				maxmem: SCRYPT_MAX_MEMORY,
			});
		}
		this.keys.set(cacheKey, key);
		return key;
	}
}

/** macOS Keychain through /usr/bin/security; the key travels over stdin, never argv. */
export class MacOSKeychain implements AuthKeychain {
	load(id: string): Buffer | undefined {
		try {
			const hex = execFileSync(
				"/usr/bin/security",
				["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"],
				{
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: KEYCHAIN_TIMEOUT_MS,
				},
			).trim();
			return isHexKey(hex) ? Buffer.from(hex, "hex") : undefined;
		} catch {
			return undefined;
		}
	}

	store(id: string, key: Buffer): boolean {
		try {
			execFileSync("/usr/bin/security", ["-i"], {
				input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${id} -l ${KEYCHAIN_SERVICE} -w ${key.toString("hex")}\n`,
				stdio: ["pipe", "ignore", "ignore"],
				timeout: KEYCHAIN_TIMEOUT_MS,
			});
		} catch {
			return false;
		}
		// Interactive mode does not report per-command failures through its exit code.
		return this.load(id)?.equals(key) ?? false;
	}
}

/** Freedesktop Secret Service through libsecret's secret-tool. */
export class SecretToolKeychain implements AuthKeychain {
	load(id: string): Buffer | undefined {
		try {
			const hex = execFileSync("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", id], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: KEYCHAIN_TIMEOUT_MS,
			}).trim();
			return isHexKey(hex) ? Buffer.from(hex, "hex") : undefined;
		} catch {
			return undefined;
		}
	}

	store(id: string, key: Buffer): boolean {
		try {
			execFileSync(
				"secret-tool",
				["store", `--label=${KEYCHAIN_SERVICE}`, "service", KEYCHAIN_SERVICE, "account", id],
				{
					input: key.toString("hex"),
					stdio: ["pipe", "ignore", "ignore"],
					timeout: KEYCHAIN_TIMEOUT_MS,
				},
			);
		} catch {
			return false;
		}
		return this.load(id)?.equals(key) ?? false;
	}
}

/** e.g. PI_AUTH_PASSPHRASE or HSY_AUTH_PASSPHRASE. */
export function authEnvName(suffix: "AUTH_ENCRYPTION" | "AUTH_PASSPHRASE"): string {
	return `${APP_NAME.toUpperCase()}_${suffix}`;
}

function readAuthEnv(suffix: "AUTH_ENCRYPTION" | "AUTH_PASSPHRASE"): string | undefined {
	return process.env[authEnvName(suffix)] || process.env[`PI_${suffix}`] || undefined;
}

/** Cipher configured from `<APP>_AUTH_ENCRYPTION`, `<APP>_AUTH_PASSPHRASE`, and the platform keychain. */
export function createDefaultAuthFileCipher(): AuthFileCipher {
	const mode = readAuthEnv("AUTH_ENCRYPTION") ?? "auto";
	if (mode !== "auto" && mode !== "required" && mode !== "off") {
		throw new Error(`${authEnvName("AUTH_ENCRYPTION")} must be auto, required, or off`);
	}
	const keychain =
		process.platform === "darwin"
			? new MacOSKeychain()
			: process.platform === "linux"
				? new SecretToolKeychain()
				: undefined;
	return new AuthFileCipher({ mode, passphrase: readAuthEnv("AUTH_PASSPHRASE"), keychain });
}
