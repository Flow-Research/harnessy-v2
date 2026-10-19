import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import {
	CODEX_PROVIDER_FAILURE_CODES,
	CODEX_TRANSIENT_FAILURE_CODES,
	CodexProviderError,
	classifyCodexProviderFailure,
	codexProviderFailureCode,
} from "../src/ai/codex-failure.ts";
import { CODEX_MODEL_BASE_ID, DEFAULT_CODEX_MODEL, resolveCodexModel } from "../src/ai/codex-model.ts";
import { resolveProviderModel } from "../src/ai/runner.ts";
import { communityExecutionOptions } from "../src/cli/community-draft.ts";

const catalog = openaiCodexProvider();

describe("Codex model resolution", () => {
	it("defaults every Codex caller to gpt-6-astra, which pi-ai does not list", () => {
		expect(DEFAULT_CODEX_MODEL).toBe("gpt-6-astra");
		expect(catalog.getModels().some((model) => model.id === DEFAULT_CODEX_MODEL)).toBe(false);
		expect(catalog.getModels().some((model) => model.id === CODEX_MODEL_BASE_ID)).toBe(true);
	});

	it("resolves a listed id to pi-ai's own entry", () => {
		const listed = catalog.getModels().find((model) => model.id === "gpt-5.4");
		expect(resolveCodexModel(catalog, "gpt-5.4")).toBe(listed);
	});

	it("clones the documented base entry for an unlisted id, changing only id and name", () => {
		const base = catalog.getModels().find((model) => model.id === CODEX_MODEL_BASE_ID);
		const resolved = resolveCodexModel(catalog, "gpt-6-astra");
		expect(resolved).toEqual({ ...base, id: "gpt-6-astra", name: "gpt-6-astra" });
		expect(resolved).toMatchObject({ provider: "openai-codex", api: "openai-codex-responses" });
		expect(Object.isFrozen(resolved)).toBe(true);
		// The catalog itself is untouched.
		expect(catalog.getModels().some((model) => model.id === "gpt-6-astra")).toBe(false);
	});

	it("accepts a different base so a future rename needs only configuration", () => {
		expect(resolveCodexModel(catalog, "gpt-7", "gpt-5.4")).toMatchObject({ id: "gpt-7", name: "gpt-7" });
	});

	it("fails without fallback when the base entry is missing or not a Codex responses model", () => {
		expect(() => resolveCodexModel(catalog, "gpt-6-astra", "absent-base")).toThrow(
			"Codex base model entry is unavailable; no fallback.",
		);
		const foreign = {
			getModels: () => catalog.getModels().map((model) => ({ ...model, provider: "openai" as const })),
		};
		expect(() => resolveCodexModel(foreign, "gpt-6-astra")).toThrow("base model entry is unavailable");
		expect(() => resolveCodexModel(foreign, "gpt-5.5")).toThrow("not an openai-codex responses model");
	});

	it.each(["", " gpt", "gpt 6", "../gpt", "x".repeat(101)])("rejects malformed model id %j", (id) => {
		expect(() => resolveCodexModel(catalog, id)).toThrow("Codex model id is invalid.");
	});
});

describe("Codex provider failure codes", () => {
	it("treats only a missing response and 502/503/504 as transient", () => {
		expect([...CODEX_TRANSIENT_FAILURE_CODES].sort()).toEqual(["provider_network", "provider_unavailable"]);
		expect(CODEX_TRANSIENT_FAILURE_CODES.has(classifyCodexProviderFailure(200, "response.failed"))).toBe(false);
		expect(CODEX_TRANSIENT_FAILURE_CODES.has(classifyCodexProviderFailure(500, undefined))).toBe(false);
		expect(CODEX_TRANSIENT_FAILURE_CODES.has(classifyCodexProviderFailure(503, undefined))).toBe(true);
	});
	it.each([
		[
			400,
			"The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.",
			"provider_model_unsupported",
		],
		[400, "Invalid request body", "provider_rejected"],
		[401, "expired", "provider_auth"],
		[403, "forbidden", "provider_auth"],
		[404, "missing", "provider_rejected"],
		[429, "You have hit your ChatGPT usage limit", "provider_rate_limited"],
		[500, "boom", "provider_failed"],
		[501, undefined, "provider_failed"],
		[502, undefined, "provider_unavailable"],
		[503, undefined, "provider_unavailable"],
		[504, undefined, "provider_unavailable"],
		// An in-stream failure after HTTP 200 (response.failed) is not transient.
		[200, "stream failed", "provider_failed"],
		[302, undefined, "provider_failed"],
		[undefined, "fetch failed", "provider_network"],
	] as const)("maps HTTP %s to its allow-listed code", (status, detail, code) => {
		expect(classifyCodexProviderFailure(status, detail)).toBe(code);
		expect(CODEX_PROVIDER_FAILURE_CODES).toContain(code);
	});

	it("carries only the code, never provider text", () => {
		const error = new CodexProviderError("provider_auth");
		expect(error.message).toBe("Codex generation failed (provider_auth); reconcile before retrying.");
		expect(codexProviderFailureCode(error)).toBe("provider_auth");
		expect(codexProviderFailureCode(new Error("provider_auth"))).toBeUndefined();
	});
});

describe("Codex CLI and runner defaults", () => {
	it("defaults the community --model flag to gpt-6-astra and keeps the explicit flag", async () => {
		const seen: string[] = [];
		const probe = Command.make("probe", { model: communityExecutionOptions.model }, ({ model }) =>
			Effect.sync(() => {
				seen.push(model);
			}),
		);
		const run = (args: string[]) =>
			Effect.runPromise(Command.runWith(probe, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)));
		await run([]);
		await run(["--model", "gpt-5.4"]);
		expect(seen).toEqual(["gpt-6-astra", "gpt-5.4"]);
	});

	it("translates Claude aliases for Codex to gpt-6-astra", () => {
		expect(resolveProviderModel({}, "codex", "sonnet")).toBe("gpt-6-astra");
		expect(resolveProviderModel({}, "codex")).toBe("gpt-6-astra");
		expect(resolveProviderModel({}, "codex", "gpt-5.4")).toBe("gpt-5.4");
	});
});
