import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeDraftGrantHost, lifeDraftGrantPayload } from "../src/jarvis/life-orchestrator/draft-grant-host.ts";
import { generateLifeDraft, type LifeDraftAuthority } from "../src/jarvis/life-orchestrator/draft-provider.ts";

const keys = generateKeyPairSync("ed25519");
const trust = new Map([["owner", keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]);
const now = () => Date.parse("2030-01-01T00:00:00Z");
const request = {
	runId: "synthetic",
	kind: "daily",
	provider: "codex",
	model: "synthetic",
	prompt: "Draft only",
} as const;
const authority: LifeDraftAuthority = {
	grantId: "one-use",
	operation: "life.draft",
	runId: request.runId,
	kind: request.kind,
	provider: request.provider,
	model: request.model,
	promptHash: createHash("sha256").update(request.prompt).digest("hex"),
	expiresAt: "2030-01-01T00:01:00Z",
	maximumOutputBytes: 1024,
};
const signed = (value = authority) => ({
	issuer: "owner",
	authority: value,
	signature: sign(null, Buffer.from(lifeDraftGrantPayload("owner", value)), keys.privateKey).toString("base64"),
});
const roots: string[] = [];
const hosts: LifeDraftGrantHost[] = [];
const root = () => {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "life-grant-test-")));
	roots.push(path);
	return path;
};
const open = (path: string) => {
	const host = new LifeDraftGrantHost(path, trust, now);
	hosts.push(host);
	return host;
};
afterEach(() => {
	for (const host of hosts.splice(0)) host.close();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("owner-signed Life draft consumption", () => {
	it("verifies a real Ed25519 grant and persists consumption before generation", async () => {
		const path = root();
		const host = open(path);
		const competing = open(path);
		const provider = {
			generate: vi.fn(async () => {
				await expect(competing.bind(signed()).authorize(authority)).rejects.toThrow("consumed");
				return {
					markdown: "# Review me",
					provider: request.provider,
					model: request.model,
					receiptId: "synthetic",
				};
			}),
		};
		const result = await generateLifeDraft(request, authority, {
			...host.bind(signed()),
			provider,
			signal: new AbortController().signal,
			now,
		});
		expect(result.receipt.status).toBe("needs_review");
		expect(provider.generate).toHaveBeenCalledTimes(1);
		expect(statSync(join(path, "draft-grants.sqlite3")).mode & 0o777).toBe(0o600);
	});
	it("retains uncertain consumption after host reopen", async () => {
		const path = root();
		const host = new LifeDraftGrantHost(path, trust, now);
		await host.bind(signed()).authorize(authority);
		host.close(); // Equivalent persisted checkpoint before provider completion or receipt.
		await expect(open(path).bind(signed()).authorize(authority)).rejects.toThrow("consumed");
	});
	it("does not release a grant when a provider throws", async () => {
		const host = open(root());
		const provider = {
			generate: vi.fn(async () => {
				throw new Error("uncertain provider result");
			}),
		};
		const boundary = { ...host.bind(signed()), provider, signal: new AbortController().signal, now };
		await expect(generateLifeDraft(request, authority, boundary)).rejects.toThrow("uncertain");
		await expect(generateLifeDraft(request, authority, boundary)).rejects.toThrow("consumed");
		expect(provider.generate).toHaveBeenCalledTimes(1);
	});
	it("fences independent host consumers sharing the database", async () => {
		const path = root();
		const results = await Promise.allSettled([
			open(path).bind(signed()).authorize(authority),
			open(path).bind(signed()).authorize(authority),
		]);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
	});
	it("persists revocation before consumption and after consumption", async () => {
		const path = root();
		const host = open(path);
		host.revoke(authority.grantId);
		await expect(open(path).bind(signed()).authorize(authority)).rejects.toThrow("revoked");
		const second = { ...authority, grantId: "second" };
		const bound = host.bind(signed(second));
		await bound.authorize(second);
		open(path).revoke(second.grantId);
		await expect(bound.revalidate(second)).rejects.toThrow("revoked");
	});
	it("rejects forged and unknown issuers without consuming valid authority", async () => {
		const host = open(root());
		await expect(
			host.bind({ ...signed(), signature: Buffer.alloc(64).toString("base64") }).authorize(authority),
		).rejects.toThrow("signature");
		await expect(host.bind({ ...signed(), issuer: "unknown" }).authorize(authority)).rejects.toThrow("signature");
		await host.bind(signed()).authorize(authority);
	});
	it("rejects changed request, expired grant and missing consumed evidence", async () => {
		const host = open(root());
		await expect(host.bind(signed()).authorize({ ...authority, model: "changed" })).rejects.toThrow("changed");
		const expired = { ...authority, expiresAt: "2029-01-01T00:00:00Z" };
		await expect(host.bind(signed(expired)).authorize(expired)).rejects.toThrow("expired");
		await expect(host.bind(signed()).revalidate(authority)).rejects.toThrow("absent");
	});
	it("rechecks revocation after actual generation", async () => {
		const host = open(root());
		await expect(
			generateLifeDraft(request, authority, {
				...host.bind(signed()),
				signal: new AbortController().signal,
				now,
				provider: {
					generate: async () => {
						host.revoke(authority.grantId);
						return {
							markdown: "# Draft",
							provider: request.provider,
							model: request.model,
							receiptId: "synthetic",
						};
					},
				},
			}),
		).rejects.toThrow("revoked");
	});
	it("rejects public directories and symbolic links without changing permissions", () => {
		const path = root();
		chmodSync(path, 0o755);
		expect(() => open(path)).toThrow("owner-only");
		expect(statSync(path).mode & 0o777).toBe(0o755);
		const safe = root();
		const link = join(safe, "alias");
		symlinkSync(path, link);
		expect(() => open(link)).toThrow("canonical");
	});
});
