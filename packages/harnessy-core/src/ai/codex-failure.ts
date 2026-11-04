/**
 * Allow-listed Codex provider failure codes. These codes are the only
 * provider detail Harnessy records or logs: provider text never leaves here.
 */
export const CODEX_PROVIDER_FAILURE_CODES = [
	"provider_model_unsupported",
	"provider_auth",
	"provider_rate_limited",
	"provider_rejected",
	"provider_unavailable",
	"provider_network",
	// Any other failure after the provider answered, including an in-stream error after HTTP 200.
	"provider_failed",
] as const;

export type CodexProviderFailureCode = (typeof CODEX_PROVIDER_FAILURE_CODES)[number];

/**
 * Transient failures: retrying the same request later may succeed. Only a request that got
 * no response (`provider_network`) or a gateway or availability answer (502, 503, 504:
 * `provider_unavailable`). A failure inside a 200 stream may already have been billed and
 * repeats for the same input, so it is `provider_failed` and not transient.
 */
export const CODEX_TRANSIENT_FAILURE_CODES: ReadonlySet<CodexProviderFailureCode> = new Set([
	"provider_network",
	"provider_unavailable",
]);

/** System error codes a failed fetch may carry; anything else is not reported. */
const NETWORK_SUB_CODES: ReadonlySet<string> = new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"ENETUNREACH",
	"ENETDOWN",
	"EHOSTUNREACH",
	"EHOSTDOWN",
	"EPIPE",
]);
/** undici (`UND_ERR_*`) and Node TLS (`ERR_TLS_*`) error codes. */
const NETWORK_SUB_CODE_PATTERN = /^(?:UND_ERR|ERR_TLS)_[A-Z0-9_]{1,48}$/u;

/**
 * The allow-listed sub-code of a fetch that threw before any HTTP response: the first
 * known `code` in the error's `cause` chain (Node wraps it as `TypeError: fetch failed`),
 * including the members of an `AggregateError`. `unexpected_redirect` is undici's refusal
 * under `redirect: "error"`, and `timeout` an `AbortSignal.timeout`. Messages are compared
 * with fixed strings only: no provider or error text is ever returned.
 */
export const codexNetworkSubCode = (error: unknown): string | undefined => {
	const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: error, depth: 0 }];
	while (pending.length > 0) {
		const { value, depth } = pending.shift()!;
		if (typeof value !== "object" || value === null || depth > 4) continue;
		const { code, cause, errors, name, message } = value as {
			readonly code?: unknown;
			readonly cause?: unknown;
			readonly errors?: unknown;
			readonly name?: unknown;
			readonly message?: unknown;
		};
		if (typeof code === "string" && (NETWORK_SUB_CODES.has(code) || NETWORK_SUB_CODE_PATTERN.test(code))) return code;
		if (message === "unexpected redirect") return "unexpected_redirect";
		if (name === "TimeoutError") return "timeout";
		if (Array.isArray(errors))
			for (const member of errors.slice(0, 8)) pending.push({ value: member, depth: depth + 1 });
		pending.push({ value: cause, depth: depth + 1 });
	}
	return undefined;
};

/** A content-free provider failure carrying only its allow-listed code and network sub-code. */
export class CodexProviderError extends Error {
	readonly code: CodexProviderFailureCode;
	/** For `provider_network`: the allow-listed fetch error code (codexNetworkSubCode), if known. */
	readonly subCode: string | undefined;
	constructor(code: CodexProviderFailureCode, subCode?: string) {
		super(`Codex generation failed (${code}); reconcile before retrying.`);
		this.name = "CodexProviderError";
		this.code = code;
		this.subCode = subCode;
	}
}

/**
 * Map a failed Codex exchange to its code. `status` is the HTTP status the
 * provider answered with, or undefined when no response arrived. `detail` is
 * read only to recognise an unsupported model and is never returned.
 */
export const classifyCodexProviderFailure = (
	status: number | undefined,
	detail: string | undefined,
): CodexProviderFailureCode => {
	if (status === undefined) return "provider_network";
	if (status === 400 && /not supported/iu.test(detail ?? "")) return "provider_model_unsupported";
	if (status === 401 || status === 403) return "provider_auth";
	if (status === 429) return "provider_rate_limited";
	if (status >= 400 && status < 500) return "provider_rejected";
	if (status === 502 || status === 503 || status === 504) return "provider_unavailable";
	return "provider_failed";
};

/** The allow-listed code of a provider failure, or undefined for any other error. */
export const codexProviderFailureCode = (error: unknown): CodexProviderFailureCode | undefined =>
	error instanceof CodexProviderError ? error.code : undefined;

/** The allow-listed network sub-code of a provider failure, or undefined. */
export const codexProviderFailureSubCode = (error: unknown): string | undefined =>
	error instanceof CodexProviderError ? error.subCode : undefined;
