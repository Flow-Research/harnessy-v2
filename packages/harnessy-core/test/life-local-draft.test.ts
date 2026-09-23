import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { LifeDraftGrantHost } from "../src/jarvis/life-orchestrator/draft-grant-host.ts";
import { generateNativeLifePreview } from "../src/jarvis/life-orchestrator/native-draft.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "life-local-")));
	roots.push(root);
	const settings = resolveLifeOrchestratorSettings({ projectRoot: root, homeRoot: root });
	const request = {
		runId: "daily:2030-01-01:local",
		kind: "daily",
		provider: "codex",
		model: "synthetic",
		prompt: "Draft only",
	} as const;
	const options = { requestPath: join(root, "request.json"), local: { timeoutMs: 60000, maximumOutputBytes: 1024 } };
	let calls = 0;
	const provider = {
		generate: async () => {
			calls++;
			return { markdown: "# Draft", provider: "codex", model: request.model, receiptId: "synthetic" };
		},
	};
	return { root, settings, request, options, provider, calls: () => calls, signal: new AbortController().signal };
};

it("generates one local draft without keys and rejects replay after reopening the real database", async () => {
	const f = fixture();
	const result = await generateNativeLifePreview(f.settings, f.options, f.request, f.signal, f.provider);
	expect(result.receipt.status).toBe("needs_review");
	expect(result.markdown).toBe("# Draft");
	await expect(generateNativeLifePreview(f.settings, f.options, f.request, f.signal, f.provider)).rejects.toThrow(
		"consumed",
	);
	expect(f.calls()).toBe(1);
	const db = new DatabaseSync(join(f.settings.paths.stateDirectory, "draft-grants.sqlite3"), { readOnly: true });
	try {
		expect(db.prepare("SELECT count(*) AS n FROM life_draft_grants").get()?.n).toBe(1);
	} finally {
		db.close();
	}
});

it("does not evade run consumption by changing the prompt or timeout", async () => {
	const f = fixture();
	await generateNativeLifePreview(f.settings, f.options, f.request, f.signal, f.provider);
	await expect(
		generateNativeLifePreview(
			f.settings,
			{ ...f.options, local: { ...f.options.local, timeoutMs: 120000 } },
			{ ...f.request, prompt: "changed" },
			f.signal,
			f.provider,
		),
	).rejects.toThrow("consumed");
	expect(f.calls()).toBe(1);
});

it("retains uncertain consumption and makes no retry after provider failure", async () => {
	const f = fixture();
	await expect(
		generateNativeLifePreview(f.settings, f.options, f.request, f.signal, {
			generate: async () => {
				throw new Error("uncertain");
			},
		}),
	).rejects.toThrow("uncertain");
	await expect(generateNativeLifePreview(f.settings, f.options, f.request, f.signal, f.provider)).rejects.toThrow(
		"consumed",
	);
	expect(f.calls()).toBe(0);
});

it("fences concurrent local callers before a second provider call", async () => {
	const f = fixture();
	const results = await Promise.allSettled(
		[1, 2].map(() => generateNativeLifePreview(f.settings, f.options, f.request, f.signal, f.provider)),
	);
	expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
	expect(f.calls()).toBe(1);
});

it("rechecks durable revocation after generation", async () => {
	const f = fixture();
	await expect(
		generateNativeLifePreview(f.settings, f.options, f.request, f.signal, {
			generate: async () => {
				const host = new LifeDraftGrantHost(f.settings.paths.stateDirectory, "local-owner");
				try {
					host.revoke(`local:${createHash("sha256").update(f.request.runId).digest("hex")}`);
				} finally {
					host.close();
				}
				return f.provider.generate();
			},
		}),
	).rejects.toThrow("revoked");
});

it.each([0, 600001, NaN])("rejects invalid timeout %s before a call", async (timeoutMs) => {
	const f = fixture();
	await expect(
		generateNativeLifePreview(
			f.settings,
			{ ...f.options, local: { ...f.options.local, timeoutMs } },
			f.request,
			f.signal,
			f.provider,
		),
	).rejects.toThrow("timeout");
	expect(f.calls()).toBe(0);
});

it("rejects cancellation before consuming the run", async () => {
	const f = fixture();
	await expect(
		generateNativeLifePreview(f.settings, f.options, f.request, AbortSignal.abort(), f.provider),
	).rejects.toThrow("cancelled");
	await generateNativeLifePreview(f.settings, f.options, f.request, f.signal, f.provider);
	expect(f.calls()).toBe(1);
});

it.each([
	["--kind", "monthly"],
	["--timeout-seconds", "601"],
	["--max-output-bytes", "0"],
])("actual draft command rejects invalid %s before creating state", (flag, value) => {
	const f = fixture();
	const result = spawnSync(
		process.execPath,
		[
			"--experimental-strip-types",
			fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
			"jarvis",
			"life",
			"draft",
			"--target",
			f.root,
			"--home-root",
			f.root,
			flag,
			value,
		],
		{
			cwd: f.root,
			encoding: "utf8",
			timeout: 10000,
			env: { PATH: process.env.PATH, USER: "fixture", HSY_CODING_AGENT_DIR: join(f.root, "absent-auth") },
		},
	);
	expect(result.status).toBe(1);
	expect(result.stdout + result.stderr).toContain("Draft requires daily/weekly");
	expect(existsSync(f.settings.paths.stateDirectory)).toBe(false);
});
