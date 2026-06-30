import { describe, expect, it } from "@effect/vitest";

import {
	classifyFailure,
	isClaudeModelAlias,
	looksLikeMarkdownDocument,
	providerOrder,
	resolveProviderModel,
} from "../src/ai/runner.ts";

describe("AiRunner provider order", () => {
	it("defaults to the claude/codex/opencode chain under auto", () => {
		expect(providerOrder({})).toEqual(["claude", "codex", "opencode"]);
	});

	it("pins a single provider when one is requested", () => {
		expect(providerOrder({}, "codex")).toEqual(["codex"]);
		expect(providerOrder({ HARNESSY_AI_PROVIDER: "opencode" })).toEqual(["opencode"]);
	});

	it("reads a configured CSV order, lowercased and trimmed", () => {
		expect(providerOrder({ HARNESSY_AI_PROVIDER_ORDER: "Codex, OpenCode , claude" })).toEqual([
			"codex",
			"opencode",
			"claude",
		]);
	});
});

describe("AiRunner model resolution", () => {
	it("keeps Claude aliases for claude but does not leak them to other providers", () => {
		expect(isClaudeModelAlias("sonnet")).toBe(true);
		expect(isClaudeModelAlias("gpt-5.4-mini")).toBe(false);
		expect(resolveProviderModel({}, "claude", "sonnet")).toBe("sonnet");
		// A Claude alias must not forward to codex/opencode.
		expect(resolveProviderModel({}, "codex", "sonnet")).toBe("gpt-5.4-mini");
		expect(resolveProviderModel({}, "opencode", "sonnet")).toBeNull();
	});

	it("forwards a portable model and honors provider-specific env overrides", () => {
		expect(resolveProviderModel({}, "codex", "gpt-5.4")).toBe("gpt-5.4");
		expect(resolveProviderModel({}, "opencode", "qwen")).toBe("qwen");
		expect(resolveProviderModel({ HARNESSY_AI_CODEX_MODEL: "o4" }, "codex", "sonnet")).toBe("o4");
		expect(resolveProviderModel({ HARNESSY_AI_CLAUDE_MODEL: "opus" }, "claude", "sonnet")).toBe("opus");
	});
});

describe("AiRunner failure classification", () => {
	it("maps provider output to the v1 failure classes", () => {
		expect(classifyFailure("", "Please run /login", 1).errorType).toBe("auth_required");
		expect(classifyFailure("", "invalid API key").errorType).toBe("auth_required");
		expect(classifyFailure("", "Rate limit exceeded (429)").errorType).toBe("rate_limited");
		expect(classifyFailure("", "credit balance too low").errorType).toBe("quota");
		expect(classifyFailure("", "", 124).errorType).toBe("timeout");
		expect(classifyFailure("", "boom").errorType).toBe("cli_error");
	});

	it("flags transient vs permanent failures", () => {
		expect(classifyFailure("", "unauthorized")).toMatchObject({ permanent: true, transient: false });
		expect(classifyFailure("", "rate limit")).toMatchObject({ transient: true, permanent: false });
	});
});

describe("AiRunner markdown heuristic", () => {
	it("recognizes a structured markdown document", () => {
		expect(looksLikeMarkdownDocument("## What Moved\n...\n## What Needs\n...")).toBe(true);
		expect(looksLikeMarkdownDocument("just a short line")).toBe(false);
		expect(looksLikeMarkdownDocument("")).toBe(false);
	});
});
