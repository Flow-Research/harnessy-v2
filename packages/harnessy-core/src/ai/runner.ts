import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Default provider fallback order, mirroring v1 `ai_runner.DEFAULT_PROVIDER_ORDER`. */
const DEFAULT_PROVIDER_ORDER = ["claude", "codex", "opencode"] as const;
/** Default Claude model alias. */
const DEFAULT_CLAUDE_MODEL = "sonnet";
/** Default Codex model when a Claude alias would otherwise leak across providers. */
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
/** Short Claude aliases that must not be forwarded to other providers. */
const CLAUDE_MODEL_ALIASES = new Set(["sonnet", "haiku", "opus"]);
/** Failure classes that may succeed on retry. */
const TRANSIENT_FAILURES = new Set(["timeout", "rate_limited", "quota", "hook_failed", "cli_error"]);
/** Failure classes that will not succeed on retry. */
const PERMANENT_FAILURES = new Set(["auth_required", "unavailable", "invalid_provider"]);

/** Environment lookup (process env or a test double). */
export type AiEnv = Readonly<Record<string, string | undefined>>;

/** Inputs for resolving the provider/model plan. */
export interface AiResolveOptions {
	/** Environment to read `HARNESSY_AI_*` / `FLOW_AI_*` settings from. */
	readonly env: AiEnv;
	/** `auto`, `claude`, `codex`, or `opencode`; defaults to env then `auto`. */
	readonly provider?: string;
	/** Requested model (a Claude alias is translated/omitted for other providers). */
	readonly model?: string;
}

/** Inputs for classifying a provider failure. */
export interface AiClassifyOptions {
	/** Captured stdout. */
	readonly stdout: string;
	/** Captured stderr. */
	readonly stderr: string;
	/** Process exit code, when known. */
	readonly exitCode?: number;
}

/** One provider's resolved model in the fallback order. */
export interface AiProviderResolution {
	/** Provider name. */
	readonly provider: string;
	/** Resolved model, or null when the provider should pick its own default. */
	readonly model: string | null;
}

/** The resolved provider fallback plan. */
export interface AiResolution {
	/** Whether a single provider was pinned (vs the `auto` fallback chain). */
	readonly single: boolean;
	/** Providers in fallback order. */
	readonly providerOrder: ReadonlyArray<string>;
	/** Each provider in order with its resolved model. */
	readonly resolved: ReadonlyArray<AiProviderResolution>;
}

/** A classified provider failure. */
export interface AiFailure {
	/** Failure class (e.g. `auth_required`, `timeout`, `cli_error`). */
	readonly errorType: string;
	/** Human-readable explanation. */
	readonly message: string;
	/** Whether a retry might succeed. */
	readonly transient: boolean;
	/** Whether the failure is terminal. */
	readonly permanent: boolean;
}

/** Read an env var, treating empty as absent, with an optional default (v1 `_env`). */
const envValue = (env: AiEnv, name: string, fallback?: string): string | undefined => {
	const value = env[name];
	return value === undefined || value === "" ? fallback : value;
};

/** Split a CSV env value into lowercased, trimmed, non-empty items (v1 `_split_csv`). */
const splitCsv = (value: string | undefined): Array<string> =>
	value
		? value
				.split(",")
				.map((item) => item.trim().toLowerCase())
				.filter((item) => item !== "")
		: [];

/** Whether a model string is a Claude short alias (v1 `_is_claude_model_alias`). */
export const isClaudeModelAlias = (model: string | undefined): boolean => {
	if (!model) return false;
	const lowered = model.trim().toLowerCase();
	return CLAUDE_MODEL_ALIASES.has(lowered) || lowered.startsWith("claude");
};

/** Resolve the provider fallback order (v1 `provider_order`). */
export const providerOrder = (env: AiEnv, provider?: string): Array<string> => {
	const selected = (
		provider ||
		envValue(env, "HARNESSY_AI_PROVIDER") ||
		envValue(env, "FLOW_AI_PROVIDER") ||
		"auto"
	).toLowerCase();
	if (selected !== "auto") return [selected];
	const configured = splitCsv(envValue(env, "HARNESSY_AI_PROVIDER_ORDER") || envValue(env, "FLOW_AI_PROVIDER_ORDER"));
	return configured.length > 0 ? configured : [...DEFAULT_PROVIDER_ORDER];
};

/** Resolve a provider's model without leaking another provider's defaults (v1 `provider_model`). */
export const resolveProviderModel = (env: AiEnv, provider: string, model?: string): string | null => {
	const normalized = provider.toLowerCase();
	if (normalized === "claude") {
		return envValue(env, "HARNESSY_AI_CLAUDE_MODEL", model || DEFAULT_CLAUDE_MODEL) ?? null;
	}
	if (normalized === "codex") {
		const configured = envValue(env, "HARNESSY_AI_CODEX_MODEL");
		if (configured) return configured;
		if (!model || isClaudeModelAlias(model)) {
			return envValue(env, "HARNESSY_AI_CODEX_DEFAULT_MODEL", DEFAULT_CODEX_MODEL) ?? null;
		}
		return model;
	}
	if (normalized === "opencode") {
		const configured = envValue(env, "HARNESSY_AI_OPENCODE_MODEL");
		if (configured) return configured;
		if (!model || isClaudeModelAlias(model)) return null;
		return model;
	}
	return model ?? null;
};

/** Classify a provider failure from its output and exit code (v1 `classify_failure`). */
export const classifyFailure = (stdout: string, stderr: string, exitCode?: number): AiFailure => {
	const lower = `${stdout || ""}\n${stderr || ""}`.trim().toLowerCase();
	const make = (errorType: string, message: string): AiFailure => ({
		errorType,
		message,
		transient: TRANSIENT_FAILURES.has(errorType),
		permanent: PERMANENT_FAILURES.has(errorType),
	});
	if (lower.includes("not logged in") || lower.includes("please run /login") || lower.includes("login required")) {
		return make("auth_required", "Provider is not logged in.");
	}
	if (lower.includes("authentication") || lower.includes("unauthorized") || lower.includes("invalid api key")) {
		return make("auth_required", "Provider authentication failed.");
	}
	if (lower.includes("rate limit") || lower.includes("429")) {
		return make("rate_limited", "Provider rate limit was hit.");
	}
	if (lower.includes("quota") || lower.includes("credit balance") || lower.includes("billing")) {
		return make("quota", "Provider quota or billing limit was hit.");
	}
	if (lower.includes("sessionend hook") && lower.includes("hook cancelled")) {
		return make("hook_failed", "Provider generated a hook failure after execution.");
	}
	if (exitCode === 124 || lower.includes("timed out") || lower.includes("timeout")) {
		return make("timeout", "Provider call timed out.");
	}
	return make("cli_error", "Provider CLI exited unsuccessfully.");
};

/** Heuristic for whether provider output is a usable markdown document (v1 `looks_like_markdown_document`). */
export const looksLikeMarkdownDocument = (text: string): boolean => {
	const stripped = text.trim();
	if (stripped === "") return false;
	const signals = ["## What Moved", "## What Needs", "## Strategic Picture", "## Background Work", "# ", "## "];
	const hits = signals.filter((signal) => stripped.includes(signal)).length;
	return hits >= 2 || stripped.length > 500;
};

/**
 * Ports the deterministic core of v1 `_shared/ai_runner.py`: the provider-agnostic
 * resolution logic (fallback order, per-provider model resolution without leaking
 * Claude aliases) and failure classification. This is the host-neutral contract a
 * runtime uses to decide which provider/model to invoke and how to interpret a
 * failure. The actual provider execution (stdin-piped CLI calls with per-provider
 * argv) is intentionally left to a gated executor / Pi-native runtime — only the
 * pure decision logic is ported here.
 */
export class AiRunner extends Context.Service<
	AiRunner,
	{
		/** Resolve the provider fallback order and each provider's model. */
		readonly resolve: (options: AiResolveOptions) => Effect.Effect<AiResolution>;
		/** Classify a provider failure from its captured output. */
		readonly classify: (options: AiClassifyOptions) => Effect.Effect<AiFailure>;
	}
>()("@harnessy/core/AiRunner") {
	/** Pure runner; resolution and classification have no platform dependencies. */
	static readonly layer = Layer.succeed(AiRunner, {
		resolve: (options: AiResolveOptions) =>
			Effect.sync(() => {
				const selected = (
					options.provider ||
					envValue(options.env, "HARNESSY_AI_PROVIDER") ||
					envValue(options.env, "FLOW_AI_PROVIDER") ||
					"auto"
				).toLowerCase();
				const order = providerOrder(options.env, options.provider);
				return {
					single: selected !== "auto",
					providerOrder: order,
					resolved: order.map((provider) => ({
						provider,
						model: resolveProviderModel(options.env, provider, options.model),
					})),
				} satisfies AiResolution;
			}),
		classify: (options: AiClassifyOptions) =>
			Effect.sync(() => classifyFailure(options.stdout, options.stderr, options.exitCode)),
	});
}
