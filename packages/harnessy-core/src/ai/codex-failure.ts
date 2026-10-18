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
] as const;

export type CodexProviderFailureCode = (typeof CODEX_PROVIDER_FAILURE_CODES)[number];

/** A content-free provider failure carrying only its allow-listed code. */
export class CodexProviderError extends Error {
	readonly code: CodexProviderFailureCode;
	constructor(code: CodexProviderFailureCode) {
		super(`Codex generation failed (${code}); reconcile before retrying.`);
		this.name = "CodexProviderError";
		this.code = code;
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
	return "provider_unavailable";
};

/** The allow-listed code of a provider failure, or undefined for any other error. */
export const codexProviderFailureCode = (error: unknown): CodexProviderFailureCode | undefined =>
	error instanceof CodexProviderError ? error.code : undefined;
