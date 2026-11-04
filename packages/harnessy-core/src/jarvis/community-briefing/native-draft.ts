import { createCodexDraftProvider } from "../life-orchestrator/codex-provider.ts";
import { refreshLocalLifeCredential as refreshLocalCodexCredential } from "../life-orchestrator/local-credential.ts";
import { type CommunityDraftProcessOptions, runCommunityDraftProcess } from "./draft-process.ts";
import { type CommunityReviewProcessOptions, runCommunityReviewProcess } from "./review-process.ts";

export interface NativeCommunityDraftOptions extends Omit<CommunityDraftProcessOptions, "generate"> {
	readonly authPath: string;
	readonly model: string;
	readonly maximumOutputBytes: number;
}

/** Explicit local draft invocation. The adapter consumes its run and each call
 * in the existing queue before requesting AI. No signing, fallback or publication.
 * The optional provider only redirects transport in isolated tests, never CLI configuration.
 */
const validateOutputLimit = (options: { readonly maximumOutputBytes: number }) => {
	if (
		!Number.isSafeInteger(options.maximumOutputBytes) ||
		options.maximumOutputBytes < 1 ||
		options.maximumOutputBytes > 1048576
	)
		throw new Error("Community draft output limit must be between one byte and 1 MiB.");
};

const generateReply = async (
	options: Pick<NativeCommunityDraftOptions, "authPath" | "model" | "maximumOutputBytes">,
	prompt: string,
	signal: AbortSignal,
	deadline: number,
	provider?: Parameters<typeof createCodexDraftProvider>[1],
) => {
	signal.throwIfAborted();
	await refreshLocalCodexCredential(options.authPath, signal);
	signal.throwIfAborted();
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new Error("Community draft deadline exceeded.");
	const response = await createCodexDraftProvider(
		{ authPath: options.authPath, timeoutMs: remaining, maximumOutputBytes: options.maximumOutputBytes },
		provider,
	).generate({ provider: "codex", model: options.model, prompt }, signal);
	return { text: response.markdown, model: response.model, receiptId: response.receiptId };
};

export const runNativeCommunityDraft = async (
	options: NativeCommunityDraftOptions,
	provider?: Parameters<typeof createCodexDraftProvider>[1],
) => {
	validateOutputLimit(options);
	const deadline = Date.now() + options.timeoutMs;
	return runCommunityDraftProcess({
		...options,
		generate: (prompt, _sequence, signal) => generateReply(options, prompt, signal, deadline, provider),
	});
};

export interface NativeCommunityReviewOptions extends Omit<CommunityReviewProcessOptions, "generate"> {
	readonly authPath: string;
	readonly model: string;
	readonly maximumOutputBytes: number;
}

export const runNativeCommunityReview = async (
	options: NativeCommunityReviewOptions,
	provider?: Parameters<typeof createCodexDraftProvider>[1],
) => {
	validateOutputLimit(options);
	return runCommunityReviewProcess({
		...options,
		generate: (prompt, _sequence, signal, deadline) => generateReply(options, prompt, signal, deadline, provider),
	});
};
