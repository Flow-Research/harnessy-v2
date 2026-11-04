import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, expect, it } from "vitest";
import { refreshLocalLifeCredential } from "../src/jarvis/life-orchestrator/local-credential.ts";

const roots: string[] = [];
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const credential = (accountId = "fixture", expires = Date.now() + 60000) => ({
	type: "oauth" as const,
	accountId,
	expires,
	refresh: "synthetic-refresh",
	access: `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.synthetic`,
});
const fixture = (expires = 0) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "life-refresh-")));
	roots.push(root);
	const path = join(root, "auth.json");
	writeFileSync(
		path,
		JSON.stringify({
			"openai-codex": credential("fixture", expires),
			other: { type: "api_key", key: "synthetic-other" },
		}),
		{ mode: 0o600 },
	);
	return { path, before: readFileSync(path), signal: new AbortController().signal };
};

it("refreshes under the existing lock and preserves unrelated credentials", async () => {
	const f = fixture();
	let calls = 0;
	await refreshLocalLifeCredential(f.path, f.signal, async (refresh) => {
		calls++;
		expect(refresh).toBe("synthetic-refresh");
		return credential();
	});
	const saved = JSON.parse(readFileSync(f.path, "utf8"));
	expect(saved["openai-codex"].expires).toBeGreaterThan(Date.now());
	expect(saved.other).toEqual({ type: "api_key", key: "synthetic-other" });
	expect(calls).toBe(1);
});
it("avoids refresh and writes when the access credential remains valid", async () => {
	const f = fixture(Date.now() + 60000);
	await refreshLocalLifeCredential(f.path, f.signal, async () => {
		throw new Error("must not refresh");
	});
	expect(readFileSync(f.path)).toEqual(f.before);
});
it("serializes concurrent refresh callers without rotating twice", async () => {
	const f = fixture();
	let calls = 0;
	const refresh = async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 20));
		return credential();
	};
	await Promise.all([
		refreshLocalLifeCredential(f.path, f.signal, refresh),
		refreshLocalLifeCredential(f.path, f.signal, refresh),
	]);
	expect(calls).toBe(1);
});
it.each(["other-account", "expired"])("rejects %s before replacing credentials", async (mode) => {
	const f = fixture();
	await expect(
		refreshLocalLifeCredential(f.path, f.signal, async () =>
			credential(mode === "expired" ? "fixture" : "other", mode === "expired" ? 0 : Date.now() + 60000),
		),
	).rejects.toThrow("renewed safely");
	expect(readFileSync(f.path)).toEqual(f.before);
});
it("sanitizes provider failure and preserves credentials", async () => {
	const f = fixture();
	await expect(
		refreshLocalLifeCredential(f.path, f.signal, async () => {
			throw new Error("PRIVATE_TOKEN_SENTINEL");
		}),
	).rejects.toThrow(/^V2 Codex login could not be renewed safely/);
	expect(readFileSync(f.path)).toEqual(f.before);
});
it("does not overwrite concurrent logout/account edits", async () => {
	const f = fixture();
	await expect(
		refreshLocalLifeCredential(f.path, f.signal, async () => {
			writeFileSync(f.path, "{}");
			return credential();
		}),
	).rejects.toThrow("renewed safely");
	expect(readFileSync(f.path, "utf8")).toBe("{}");
});
it("rejects public credentials without changing their permissions", async () => {
	const f = fixture();
	chmodSync(f.path, 0o644);
	await expect(refreshLocalLifeCredential(f.path, f.signal, async () => credential())).rejects.toThrow(
		"renewed safely",
	);
	expect(readFileSync(f.path)).toEqual(f.before);
});
it("rejects cancellation without calling refresh", async () => {
	const f = fixture();
	let calls = 0;
	await expect(
		refreshLocalLifeCredential(f.path, AbortSignal.abort(), async () => {
			calls++;
			return credential();
		}),
	).rejects.toThrow("renewed safely");
	expect(calls).toBe(0);
	expect(readFileSync(f.path)).toEqual(f.before);
});
it("persists successful rotation on late cancellation but rejects generation continuation", async () => {
	const f = fixture();
	const controller = new AbortController();
	await expect(
		refreshLocalLifeCredential(f.path, controller.signal, async () => {
			controller.abort();
			return credential();
		}),
	).rejects.toThrow("renewed safely");
	expect(JSON.parse(readFileSync(f.path, "utf8"))["openai-codex"].expires).toBeGreaterThan(Date.now());
});

it("cancels while another owner holds the lock without later refreshing or leaving a lock", async () => {
	const f = fixture();
	const release = await lockfile.lock(f.path);
	let calls = 0;
	try {
		await expect(
			refreshLocalLifeCredential(f.path, AbortSignal.timeout(50), async () => {
				calls++;
				return credential();
			}),
		).rejects.toThrow("renewed safely");
		expect(calls).toBe(0);
		expect(readFileSync(f.path)).toEqual(f.before);
	} finally {
		await release();
	}
	// No detached acquisition may consume the lock after cancellation.
	const reacquired = await lockfile.lock(f.path);
	await reacquired();
	expect(calls).toBe(0);
}, 2000);
