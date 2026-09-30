import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AuthDecryptionError,
	AuthFileCipher,
	type AuthKeychain,
	AuthStorage,
	FileAuthStorageBackend,
} from "../src/core/auth-storage.ts";

class FakeKeychain implements AuthKeychain {
	keys = new Map<string, Buffer>();
	available = true;

	load(id: string): Buffer | undefined {
		return this.keys.get(id);
	}

	store(id: string, key: Buffer): boolean {
		if (!this.available) return false;
		this.keys.set(id, Buffer.from(key));
		return true;
	}
}

const SECRET = "sk-synthetic-secret-value";
const roots: string[] = [];

const fixture = (content?: string) => {
	const root = mkdtempSync(join(tmpdir(), "auth-encryption-"));
	roots.push(root);
	const path = join(root, "auth.json");
	if (content !== undefined) writeFileSync(path, content, { mode: 0o600 });
	return { root, path };
};

const storage = (path: string, cipher: AuthFileCipher) =>
	AuthStorage.fromStorage(new FileAuthStorageBackend(path, cipher));

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("auth.json encryption at rest", () => {
	it("encrypts with a keychain key and reads back after relocation", () => {
		const { root, path } = fixture();
		const keychain = new FakeKeychain();
		storage(path, new AuthFileCipher({ keychain })).set("anthropic", { type: "api_key", key: SECRET });

		const raw = readFileSync(path, "utf-8");
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain("anthropic");
		expect(AuthFileCipher.isEncrypted(raw)).toBe(true);
		expect(keychain.keys.size).toBe(1);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

		const moved = join(root, "moved.json");
		renameSync(path, moved);
		expect(storage(moved, new AuthFileCipher({ keychain })).get("anthropic")).toEqual({
			type: "api_key",
			key: SECRET,
		});
	});

	it("reads a legacy plaintext file and encrypts it on the next write", () => {
		const { path } = fixture(JSON.stringify({ openai: { type: "api_key", key: SECRET } }));
		const keychain = new FakeKeychain();
		const auth = storage(path, new AuthFileCipher({ keychain }));
		expect(auth.get("openai")).toEqual({ type: "api_key", key: SECRET });
		expect(readFileSync(path, "utf-8")).toContain(SECRET);

		auth.set("anthropic", { type: "api_key", key: "sk-second" });
		expect(readFileSync(path, "utf-8")).not.toContain(SECRET);
		expect(storage(path, new AuthFileCipher({ keychain })).list().sort()).toEqual(["anthropic", "openai"]);
	});

	it("keeps the same keychain key across writes", () => {
		const { path } = fixture();
		const keychain = new FakeKeychain();
		const auth = storage(path, new AuthFileCipher({ keychain }));
		auth.set("a", { type: "api_key", key: "one" });
		auth.set("b", { type: "api_key", key: "two" });
		expect(keychain.keys.size).toBe(1);
	});

	it("prefers a passphrase over the keychain and rejects the wrong one without overwriting", () => {
		const { path } = fixture();
		const keychain = new FakeKeychain();
		storage(path, new AuthFileCipher({ passphrase: "correct horse", keychain })).set("anthropic", {
			type: "api_key",
			key: SECRET,
		});
		expect(keychain.keys.size).toBe(0);
		const encrypted = readFileSync(path, "utf-8");
		expect(encrypted).not.toContain(SECRET);

		const wrong = storage(path, new AuthFileCipher({ passphrase: "wrong" }));
		expect(wrong.list()).toEqual([]);
		expect(() => wrong.set("other", { type: "api_key", key: "x" })).toThrow(/could not be loaded/);
		expect(readFileSync(path, "utf-8")).toBe(encrypted);

		expect(() => storage(path, new AuthFileCipher()).set("other", { type: "api_key", key: "x" })).toThrow(
			/AUTH_PASSPHRASE/,
		);
		expect(storage(path, new AuthFileCipher({ passphrase: "correct horse" })).get("anthropic")).toEqual({
			type: "api_key",
			key: SECRET,
		});
	});

	it("rejects a modified ciphertext, swapped key descriptor, or unknown algorithm", () => {
		const keychain = new FakeKeychain();
		const cipher = new AuthFileCipher({ keychain });
		const envelope = JSON.parse(cipher.encode(JSON.stringify({ a: { type: "api_key", key: SECRET } }), undefined));

		const data = Buffer.from(envelope.data, "base64");
		data[0] ^= 1;
		expect(() => cipher.decode(JSON.stringify({ ...envelope, data: data.toString("base64") }))).toThrow(
			AuthDecryptionError,
		);

		const otherId = "00000000-0000-4000-8000-000000000000";
		keychain.keys.set(otherId, keychain.keys.get(envelope.key.id)!);
		const swapped = JSON.stringify({ ...envelope, key: { source: "keychain", id: otherId } });
		expect(() => new AuthFileCipher({ keychain }).decode(swapped)).toThrow(AuthDecryptionError);

		expect(() => cipher.decode(JSON.stringify({ ...envelope, alg: "aes-128-cbc" }))).toThrow(AuthDecryptionError);
	});

	it("fails closed when the keychain key is missing", () => {
		const { path } = fixture();
		storage(path, new AuthFileCipher({ keychain: new FakeKeychain() })).set("a", { type: "api_key", key: SECRET });
		const encrypted = readFileSync(path, "utf-8");

		const auth = storage(path, new AuthFileCipher({ keychain: new FakeKeychain() }));
		expect(auth.list()).toEqual([]);
		expect(auth.drainErrors()[0]?.message).toMatch(/not found in the OS keychain/);
		expect(() => auth.set("b", { type: "api_key", key: "x" })).toThrow();
		expect(readFileSync(path, "utf-8")).toBe(encrypted);
	});

	it("falls back to plaintext in auto mode when no key source is available", () => {
		const { path } = fixture();
		const keychain = new FakeKeychain();
		keychain.available = false;
		storage(path, new AuthFileCipher({ keychain })).set("a", { type: "api_key", key: SECRET });
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ a: { type: "api_key", key: SECRET } });
	});

	it("refuses to store or load plaintext in required mode", () => {
		const { path } = fixture(JSON.stringify({ a: { type: "api_key", key: SECRET } }));
		const auth = storage(path, new AuthFileCipher({ mode: "required" }));
		expect(auth.list()).toEqual([]);
		expect(auth.drainErrors()[0]).toBeInstanceOf(AuthDecryptionError);

		const { path: empty } = fixture();
		const fresh = storage(empty, new AuthFileCipher({ mode: "required" }));
		expect(() => fresh.set("a", { type: "api_key", key: "x" })).toThrow(/required/);
		expect(readFileSync(empty, "utf-8")).toBe("{}");
	});

	it("decrypts and stores plaintext when turned off", () => {
		const { path } = fixture();
		const keychain = new FakeKeychain();
		storage(path, new AuthFileCipher({ keychain })).set("a", { type: "api_key", key: SECRET });

		storage(path, new AuthFileCipher({ mode: "off", keychain })).set("b", { type: "api_key", key: "two" });
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
			a: { type: "api_key", key: SECRET },
			b: { type: "api_key", key: "two" },
		});
	});

	it("gives lock callers the same document as decoding a raw read", async () => {
		const { path } = fixture();
		const backend = new FileAuthStorageBackend(path, new AuthFileCipher({ keychain: new FakeKeychain() }));
		await backend.withLockAsync(async () => ({ result: undefined, next: '{"a":{"type":"api_key","key":"k"}}' }));
		await backend.withLockAsync(async (current) => {
			expect(current).toBe(backend.decode(readFileSync(path, "utf-8")));
			return { result: undefined };
		});
	});
});
