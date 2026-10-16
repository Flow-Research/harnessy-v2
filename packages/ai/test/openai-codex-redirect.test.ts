import "../../harnessy-local-host/test/support/fixture-network-guard.mjs";

import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import { openaiCodexProvider } from "../src/providers/openai-codex.ts";

const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64url")}.synthetic`;
const prompt = "private-prompt-canary-not-for-redirect";
afterEach(() => vi.restoreAllMocks());

describe("Codex SSE redirect policy", () => {
	it.each([307, 308])("passes explicit error policy to fetch and never replays HTTP %s", async (status) => {
		const calls: { path: string | undefined; method: string | undefined; body: string }[] = [];
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const bytes = Buffer.concat(chunks);
			const body = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes;
			calls.push({ path: request.url, method: request.method, body: body.toString("utf8") });
			if (request.url === "/codex/responses") {
				response.writeHead(status, { Location: "/must-not-receive-private-prompt" });
			} else response.writeHead(500);
			response.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected loopback port");
			const model = openaiCodexProvider().getModels()[0]!;
			// Keep real fetch and loopback transport. The shared guard forces manual
			// redirects; inspecting the incoming option ensures it cannot mask a
			// missing production redirect policy (removing that line fails this test).
			const fetchCalls = vi.spyOn(globalThis, "fetch");
			const result = await stream(
				{ ...model, baseUrl: `http://127.0.0.1:${address.port}` },
				{ messages: [{ role: "user", content: prompt, timestamp: 0 }] },
				{ apiKey: token, transport: "sse", maxRetries: 0, timeoutMs: 1000, redirect: "error" },
			).result();
			expect(fetchCalls).toHaveBeenCalledTimes(1);
			expect(fetchCalls.mock.calls[0]?.[1]?.redirect).toBe("error");
			expect(result.stopReason).toBe("error");
			expect(result.responseId).toBeUndefined();
			expect(calls).toHaveLength(1);
			expect(calls[0]).toMatchObject({ path: "/codex/responses", method: "POST" });
			expect(calls[0]?.body).toContain(prompt);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
