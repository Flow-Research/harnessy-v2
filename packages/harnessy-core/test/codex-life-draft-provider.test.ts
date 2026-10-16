import "../../harnessy-local-host/test/support/fixture-network-guard.mjs";

import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexLifeDraftProvider } from "../src/jarvis/life-orchestrator/codex-provider.ts";
import type { LifeDraftRequest } from "../src/jarvis/life-orchestrator/draft-provider.ts";

const request: LifeDraftRequest = {
	runId: "run-1",
	kind: "daily",
	provider: "codex",
	model: "gpt-5.4-mini",
	prompt: "Prepare a review-only draft.",
};
const credential = (changes: Record<string, unknown> = {}) => {
	const payload = {
		exp: Math.floor(Date.now() / 1_000) + 3600,
		"https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
	};
	return {
		type: "oauth",
		access: `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic`,
		refresh: "synthetic-unused-refresh",
		expires: Date.now() + 3_600_000,
		accountId: "fixture-account",
		...changes,
	};
};
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const answer = (text = "# Draft\n\nReview me.", status = "completed", id: string | null = "resp_fixture") => {
	const item = {
		type: "message",
		id: "msg_fixture",
		role: "assistant",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return (
		event({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }) +
		event({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }) +
		event({ type: "response.output_item.done", output_index: 0, item }) +
		event({
			type: status === "incomplete" ? "response.incomplete" : "response.completed",
			response: { ...(id === null ? {} : { id }), status },
		})
	);
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fixture = async (respond: (response: ServerResponse) => void = (response) => response.end(answer())) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "life-codex-text-")));
	chmodSync(root, 0o700);
	const authPath = join(root, "auth.json");
	writeFileSync(authPath, JSON.stringify({ "openai-codex": credential() }), { mode: 0o600 });
	const initialBytes = readFileSync(authPath);
	const initialStat = statSync(authPath);
	const calls: {
		path: string | undefined;
		method: string | undefined;
		body: unknown;
		authorization: string | undefined;
		account: string | string[] | undefined;
	}[] = [];
	let notifyRequest: (() => void) | undefined;
	const received = new Promise<void>((resolve) => {
		notifyRequest = resolve;
	});
	const server = createServer(async (incoming, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks);
		const body = incoming.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes;
		calls.push({
			path: incoming.url,
			method: incoming.method,
			body: JSON.parse(body.toString("utf8")) as unknown,
			authorization: incoming.headers.authorization,
			account: incoming.headers["chatgpt-account-id"],
		});
		notifyRequest?.();
		response.setHeader("Content-Type", "text/event-stream");
		respond(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture needs loopback port");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const actual = openaiCodexProvider();
	// Preserve the actual pi provider and stream implementation; only its
	// catalog endpoint points at this synthetic transport. No API mocks.
	const provider = {
		...actual,
		getModels: () => actual.getModels().map((model) => ({ ...model, baseUrl })),
		stream: (...args: Parameters<typeof actual.stream>) => {
			// Assert consumer policy before the network guard can affect fetch.
			expect(args[2]).toMatchObject({ transport: "sse", maxRetries: 0, redirect: "error" });
			return actual.stream(...args);
		},
	};
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		authPath,
		calls,
		received,
		provider,
		create: (options: { timeoutMs?: number; maximumOutputBytes?: number } = {}) =>
			createCodexLifeDraftProvider({ authPath, timeoutMs: 2_000, maximumOutputBytes: 4096, ...options }, provider),
		assertUnchanged: () => {
			expect(readFileSync(authPath)).toEqual(initialBytes);
			const after = statSync(authPath);
			expect([after.ino, after.mode, after.mtimeMs, after.size]).toEqual([
				initialStat.ino,
				initialStat.mode,
				initialStat.mtimeMs,
				initialStat.size,
			]);
			expect(readdirSync(root)).toEqual(["auth.json"]);
		},
	};
};

describe("text-only Codex Life draft provider", () => {
	it("uses the exact model and saved OAuth in one real tool-free request, leaving auth untouched", async () => {
		const test = await fixture();
		expect(await test.create().generate(request, new AbortController().signal)).toEqual({
			markdown: "# Draft\n\nReview me.",
			provider: "codex",
			model: request.model,
			receiptId: "resp_fixture",
		});
		expect(test.calls).toHaveLength(1);
		expect(test.calls[0]).toMatchObject({
			method: "POST",
			path: "/codex/responses",
			account: "fixture-account",
			body: {
				model: request.model,
				store: false,
				stream: true,
				tools: [],
				tool_choice: "none",
				parallel_tool_calls: false,
				reasoning: { effort: "high" },
				input: [{ role: "user", content: [{ type: "input_text", text: request.prompt }] }],
			},
		});
		expect(test.calls[0]?.authorization).toBe(
			`Bearer ${JSON.parse(readFileSync(test.authPath, "utf8"))["openai-codex"].access}`,
		);
		test.assertUnchanged();
	});
	it("blocks external traffic in the test process", async () => {
		await expect(fetch("https://fixture-egress.invalid/")).rejects.toThrow("Fixture external network access denied");
	});
	it("snapshots host options before any asynchronous callbacks", async () => {
		const test = await fixture();
		const options = { authPath: test.authPath, timeoutMs: 2_000, maximumOutputBytes: 4096 };
		const provider = createCodexLifeDraftProvider(options, test.provider);
		options.authPath = join(test.root, "absent.json");
		options.timeoutMs = Number.NaN;
		options.maximumOutputBytes = 0;
		await expect(provider.generate(request, new AbortController().signal)).resolves.toMatchObject({
			receiptId: "resp_fixture",
		});
		expect(test.calls).toHaveLength(1);
		test.assertUnchanged();
	});
	it.each([401, 429, 503])("does not retry HTTP %s or leak response details", async (status) => {
		const test = await fixture((response) => {
			response.statusCode = status;
			response.end(JSON.stringify({ error: { message: "synthetic-sensitive-response" } }));
		});
		await expect(test.create().generate(request, new AbortController().signal)).rejects.toThrow(
			"Codex generation failed; reconcile before retrying.",
		);
		expect(test.calls).toHaveLength(1);
		test.assertUnchanged();
	});
	it.each([
		["expired stored OAuth", { expires: 0 }],
		["nonfinite expiry", { expires: null }],
		["API key command", { type: "api_key", key: "!this-must-never-execute" }],
		["mismatched account", { accountId: "other-account" }],
		["malformed token", { access: "not-a-token" }],
		[
			"expired token",
			{
				access: `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: 0, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.synthetic`,
			},
		],
	] as const)("rejects %s before any request, with no refresh", async (_name, changes) => {
		const test = await fixture();
		writeFileSync(test.authPath, JSON.stringify({ "openai-codex": credential(changes) }));
		const before = readFileSync(test.authPath);
		await expect(test.create().generate(request, new AbortController().signal)).rejects.toThrow(
			"no refresh or fallback",
		);
		expect(test.calls).toHaveLength(0);
		expect(readFileSync(test.authPath)).toEqual(before);
		expect(readdirSync(test.root)).toEqual(["auth.json"]);
	});
	it.each(["missing", "json", "utf8", "oversize", "permissions", "symlink", "hardlink", "parent-symlink"])(
		"rejects unsafe auth: %s",
		async (kind) => {
			const test = await fixture();
			let authPath = test.authPath;
			if (kind === "missing") authPath = join(test.root, "missing.json");
			if (kind === "json") writeFileSync(authPath, "{");
			if (kind === "utf8") writeFileSync(authPath, Buffer.from([0xff]));
			if (kind === "oversize") writeFileSync(authPath, " ".repeat(65_537));
			if (kind === "permissions") chmodSync(authPath, 0o644);
			if (kind === "symlink") {
				authPath = join(test.root, "linked.json");
				symlinkSync(test.authPath, authPath);
			}
			if (kind === "hardlink") linkSync(authPath, join(test.root, "linked.json"));
			if (kind === "parent-symlink") {
				mkdirSync(join(test.root, "actual"), { mode: 0o700 });
				symlinkSync(join(test.root, "actual"), join(test.root, "alias"));
				authPath = join(test.root, "alias", "auth.json");
				writeFileSync(join(test.root, "actual", "auth.json"), JSON.stringify({ "openai-codex": credential() }), {
					mode: 0o600,
				});
			}
			const before = readFileSync(test.authPath);
			await expect(
				createCodexLifeDraftProvider(
					{ authPath, timeoutMs: 2_000, maximumOutputBytes: 4096 },
					test.provider,
				).generate(request, new AbortController().signal),
			).rejects.toThrow("owner-only V2 OAuth");
			expect(test.calls).toHaveLength(0);
			expect(readFileSync(test.authPath)).toEqual(before);
		},
	);
	it.each([
		{ ...request, model: "not-an-exact-supported-model" },
		{ ...request, provider: "claude" as const },
	])("rejects provider/model mismatch", async (input) => {
		const test = await fixture();
		await expect(test.create().generate(input, new AbortController().signal)).rejects.toThrow("no fallback");
		expect(test.calls).toHaveLength(0);
		test.assertUnchanged();
	});
	it.each([
		["incomplete", answer("partial", "incomplete"), "incomplete"],
		["empty", answer(""), "no draft or response receipt"],
		["missing receipt", answer("draft", "completed", null), "no draft or response receipt"],
		["truncated", event({ type: "response.created", response: { id: "resp_partial" } }), "generation failed"],
		[
			"tool call",
			event({
				type: "response.output_item.added",
				output_index: 0,
				item: {
					type: "function_call",
					id: "fc_fixture",
					call_id: "call_fixture",
					name: "apply_patch",
					arguments: "{}",
				},
			}) + event({ type: "response.completed", response: { id: "resp_tools", status: "completed" } }),
			"forbidden tool call",
		],
	] as const)("rejects %s without another provider call", async (_name, body, error) => {
		const test = await fixture((response) => response.end(body));
		await expect(test.create().generate(request, new AbortController().signal)).rejects.toThrow(error);
		expect(test.calls).toHaveLength(1);
		test.assertUnchanged();
	});
	it("enforces UTF-8 output bytes, not character count", async () => {
		const test = await fixture((response) => response.end(answer("ééé")));
		await expect(
			test.create({ maximumOutputBytes: 5 }).generate(request, new AbortController().signal),
		).rejects.toThrow("byte limit");
		expect(test.calls).toHaveLength(1);
		test.assertUnchanged();
	});
	it("enforces the deadline after response headers while the body stalls", async () => {
		const test = await fixture((response) => response.flushHeaders());
		await expect(test.create({ timeoutMs: 100 }).generate(request, new AbortController().signal)).rejects.toThrow(
			"deadline",
		);
		expect(test.calls).toHaveLength(1);
		test.assertUnchanged();
	});
	it("cancels an in-flight stream and never retries", async () => {
		const test = await fixture((response) => response.flushHeaders());
		const controller = new AbortController();
		const pending = test.create().generate(request, controller.signal);
		const rejected = expect(pending).rejects.toThrow("cancelled");
		await test.received;
		controller.abort();
		await rejected;
		expect(test.calls).toHaveLength(1);
		test.assertUnchanged();
	});
	it("aborts a silent stream at saved OAuth expiry, before its longer execution timeout", async () => {
		const test = await fixture((response) => response.flushHeaders());
		writeFileSync(test.authPath, JSON.stringify({ "openai-codex": credential({ expires: Date.now() + 150 }) }));
		const before = readFileSync(test.authPath);
		const started = performance.now();
		await expect(test.create({ timeoutMs: 2_000 }).generate(request, new AbortController().signal)).rejects.toThrow(
			"deadline",
		);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(test.calls).toHaveLength(1);
		expect(readFileSync(test.authPath)).toEqual(before);
		expect(readdirSync(test.root)).toEqual(["auth.json"]);
	});
	it("rejects cancellation before credentials or network access", async () => {
		const test = await fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(test.create().generate(request, controller.signal)).rejects.toThrow("cancelled before execution");
		expect(test.calls).toHaveLength(0);
		test.assertUnchanged();
	});
});
