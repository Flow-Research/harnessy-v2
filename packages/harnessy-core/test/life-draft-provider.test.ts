import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { generateLifeDraft, type LifeDraftAuthority, type LifeDraftRequest } from "../src/life-orchestrator.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const request: LifeDraftRequest = {
	runId: "synthetic-run",
	kind: "daily",
	provider: "codex",
	model: "synthetic-model",
	prompt: "Draft only.\n",
};
const authority: LifeDraftAuthority = {
	grantId: "synthetic-grant",
	operation: "life.draft",
	runId: request.runId,
	kind: request.kind,
	provider: request.provider,
	model: request.model,
	promptHash: hash(request.prompt),
	expiresAt: "2030-01-01T00:01:00Z",
	maximumOutputBytes: 1024,
};
const result = {
	markdown: "# Draft\nReview this first.\n",
	provider: request.provider,
	model: request.model,
	receiptId: "synthetic-receipt",
};
function fixture() {
	return {
		provider: { generate: vi.fn(async () => result) },
		authorize: vi.fn(async () => {}),
		revalidate: vi.fn(async () => {}),
		signal: new AbortController().signal,
		now: () => Date.parse("2030-01-01T00:00:00Z"),
	};
}

describe("Life draft-only provider contract", () => {
	it("returns exact draft hashes and review-only receipt through an actual loopback transport", async () => {
		const received: unknown[] = [];
		const server = createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			received.push(JSON.parse(body));
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify(result));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing loopback address");
			const boundary = fixture();
			const value = await generateLifeDraft(request, authority, {
				...boundary,
				provider: {
					generate: async (input, signal) => {
						const response = await fetch(`http://127.0.0.1:${address.port}/draft`, {
							method: "POST",
							body: JSON.stringify(input),
							signal,
						});
						return response.json();
					},
				},
			});
			expect(received).toEqual([request]);
			expect(value).toEqual({
				markdown: result.markdown,
				receipt: {
					status: "needs_review",
					grantId: authority.grantId,
					runId: request.runId,
					kind: request.kind,
					provider: request.provider,
					model: request.model,
					promptHash: hash(request.prompt),
					draftHash: hash(result.markdown),
					providerReceiptId: result.receiptId,
				},
			});
			expect(boundary.authorize).toHaveBeenCalledExactlyOnceWith(authority);
			expect(boundary.revalidate).toHaveBeenCalledExactlyOnceWith(authority);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
	it.each([
		{ runId: "other" },
		{ kind: "weekly" },
		{ provider: "claude" },
		{ model: "other" },
		{ promptHash: hash("different bytes") },
		{ maximumOutputBytes: 0 },
		{ grantId: " " },
		{ operation: "life.publish" },
		{ expiresAt: "2029-01-01T00:00:00Z" },
		{ expiresAt: "invalid" },
	])("refuses mismatched or invalid authority before invoking provider: %j", async (change) => {
		const boundary = fixture();
		await expect(
			generateLifeDraft(request, { ...authority, ...change } as LifeDraftAuthority, boundary),
		).rejects.toThrow();
		expect(boundary.provider.generate).not.toHaveBeenCalled();
		expect(boundary.authorize).not.toHaveBeenCalled();
	});
	it("does not silently translate an AiRunner model alias", async () => {
		const boundary = fixture();
		await expect(
			generateLifeDraft({ ...request, model: "sonnet" }, { ...authority, model: "sonnet" }, boundary),
		).rejects.toThrow("explicit authority");
		expect(boundary.provider.generate).not.toHaveBeenCalled();
	});
	it("requires host authorization and does not retry uncertain provider failure", async () => {
		const denied = fixture();
		denied.authorize.mockRejectedValueOnce(new Error("revoked"));
		await expect(generateLifeDraft(request, authority, denied)).rejects.toThrow("revoked");
		expect(denied.provider.generate).not.toHaveBeenCalled();
		const uncertain = fixture();
		uncertain.provider.generate.mockRejectedValueOnce(new Error("timeout after usage"));
		await expect(generateLifeDraft(request, authority, uncertain)).rejects.toThrow("timeout after usage");
		expect(uncertain.provider.generate).toHaveBeenCalledTimes(1);
		expect(uncertain.authorize).toHaveBeenCalledTimes(1);
	});
	it.each(["authorization", "generation", "revalidation"])("rejects expiry during %s", async (stage) => {
		const boundary = fixture();
		let expired = false;
		boundary.now = () => Date.parse(expired ? "2030-01-01T00:02:00Z" : "2030-01-01T00:00:00Z");
		if (stage === "authorization")
			boundary.authorize.mockImplementationOnce(async () => {
				expired = true;
			});
		if (stage === "generation")
			boundary.provider.generate.mockImplementationOnce(async () => {
				expired = true;
				return result;
			});
		if (stage === "revalidation")
			boundary.revalidate.mockImplementationOnce(async () => {
				expired = true;
			});
		await expect(generateLifeDraft(request, authority, boundary)).rejects.toThrow("expired");
		expect(boundary.provider.generate).toHaveBeenCalledTimes(stage === "authorization" ? 0 : 1);
	});
	it("does not return a draft after revocation or cancellation", async () => {
		const revoked = fixture();
		revoked.revalidate.mockRejectedValueOnce(new Error("revoked"));
		await expect(generateLifeDraft(request, authority, revoked)).rejects.toThrow("revoked");
		const cancelled = fixture();
		const controller = new AbortController();
		cancelled.signal = controller.signal;
		cancelled.provider.generate.mockImplementationOnce(async () => {
			controller.abort();
			return result;
		});
		await expect(generateLifeDraft(request, authority, cancelled)).rejects.toThrow("cancelled");
	});
	it.each([
		{ provider: "claude" },
		{ model: "other" },
		{ receiptId: " " },
		{ markdown: " " },
		{ markdown: "é".repeat(513) },
	])("rejects provider result without a success receipt: %j", async (change) => {
		const boundary = fixture();
		boundary.provider.generate.mockResolvedValueOnce({ ...result, ...change } as typeof result);
		await expect(generateLifeDraft(request, authority, boundary)).rejects.toThrow("invalid or mismatched");
		expect(boundary.provider.generate).toHaveBeenCalledTimes(1);
	});
});
