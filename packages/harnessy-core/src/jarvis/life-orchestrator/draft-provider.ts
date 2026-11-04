import { createHash } from "node:crypto";

import { Schema } from "effect";

import { resolveProviderModel } from "../../ai/runner.ts";

const Provider = Schema.Literals(["claude", "codex", "opencode"]);

/** Exact input to one draft-generation call, never a publication instruction. */
export const LifeDraftRequest = Schema.Struct({
	runId: Schema.String,
	kind: Schema.Literals(["daily", "weekly"]),
	provider: Provider,
	model: Schema.String,
	prompt: Schema.String,
});
export type LifeDraftRequest = typeof LifeDraftRequest.Type;

/** Host-verified grant, bound to one request. This shape is not a signature verifier. */
export const LifeDraftAuthority = Schema.Struct({
	grantId: Schema.String,
	operation: Schema.Literal("life.draft"),
	runId: Schema.String,
	kind: Schema.Literals(["daily", "weekly"]),
	provider: Provider,
	model: Schema.String,
	promptHash: Schema.String,
	expiresAt: Schema.String,
	/** Acceptance limit, not a provider token/cost budget. */
	maximumOutputBytes: Schema.Int,
});
export type LifeDraftAuthority = typeof LifeDraftAuthority.Type;

/** Content-free generation receipt. It is neither review approval nor delivery evidence. */
export const LifeDraftReceipt = Schema.Struct({
	status: Schema.Literal("needs_review"),
	grantId: Schema.String,
	runId: Schema.String,
	kind: Schema.Literals(["daily", "weekly"]),
	provider: Provider,
	model: Schema.String,
	promptHash: Schema.String,
	draftHash: Schema.String,
	providerReceiptId: Schema.String,
});
export type LifeDraftReceipt = typeof LifeDraftReceipt.Type;

export interface LifeDraftProvider {
	/** The owning host binds credentials/tool identity; no fallback or publication tools.
	 * The adapter must not expose mutation tools to generated instructions.
	 */
	readonly generate: (request: LifeDraftRequest, signal: AbortSignal) => Promise<unknown>;
}

export interface LifeDraftBoundary {
	readonly provider: LifeDraftProvider;
	/** Verify issuer, revocation and policy; durably consume the grant before returning.
	 * Repeated/in-flight grants must be rejected. This contract does not implement a store.
	 */
	readonly authorize: (authority: LifeDraftAuthority) => Promise<void>;
	/** Recheck revocation after generation without consuming the grant a second time. */
	readonly revalidate: (authority: LifeDraftAuthority) => Promise<void>;
	readonly signal: AbortSignal;
	readonly now?: () => number;
}

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Contract-only consumer: no installed AI tool, scheduler, file write or publication.
 * The host must preserve its consumed grant on failure, and persist successful receipts
 * with exact draft bytes before review. A provider exception can mean incurred usage;
 * this function never retries, renews authority or switches provider/model.
 * Expiry rejects a late result; it does not guarantee cancellation of upstream work.
 * A real host must enforce its execution deadline/budget at the provider boundary.
 */
export const generateLifeDraft = async (
	input: LifeDraftRequest,
	grant: LifeDraftAuthority,
	boundary: LifeDraftBoundary,
): Promise<{ readonly markdown: string; readonly receipt: LifeDraftReceipt }> => {
	const request = Object.freeze(Schema.decodeUnknownSync(LifeDraftRequest)(input));
	const authority = Object.freeze(Schema.decodeUnknownSync(LifeDraftAuthority)(grant));
	const now = boundary.now ?? Date.now;
	const validTime = () => {
		const current = now();
		const deadline = Date.parse(authority.expiresAt);
		if (!Number.isFinite(current) || !Number.isFinite(deadline) || deadline <= current || boundary.signal.aborted)
			throw new Error("Life draft authority expired or cancelled; no automatic retry.");
	};
	if (
		!request.runId.trim() ||
		!request.prompt.trim() ||
		!request.model.trim() ||
		!authority.grantId.trim() ||
		authority.maximumOutputBytes < 1 ||
		request.runId !== authority.runId ||
		request.kind !== authority.kind ||
		request.provider !== authority.provider ||
		request.model !== authority.model ||
		hash(request.prompt) !== authority.promptHash ||
		resolveProviderModel({}, request.provider, request.model) !== request.model
	)
		throw new Error("Life draft request does not match its explicit authority.");
	validTime();
	await boundary.authorize(authority);
	validTime();
	const response = await boundary.provider.generate(request, boundary.signal);
	validTime();
	await boundary.revalidate(authority);
	validTime();
	const result = Schema.decodeUnknownSync(
		Schema.Struct({ markdown: Schema.String, provider: Provider, model: Schema.String, receiptId: Schema.String }),
	)(response);
	if (
		result.provider !== request.provider ||
		result.model !== request.model ||
		!result.receiptId.trim() ||
		!result.markdown.trim() ||
		Buffer.byteLength(result.markdown, "utf8") > authority.maximumOutputBytes
	)
		throw new Error("Life draft provider returned an invalid or mismatched result; reconcile before retrying.");
	return {
		markdown: result.markdown,
		receipt: {
			status: "needs_review",
			grantId: authority.grantId,
			runId: request.runId,
			kind: request.kind,
			provider: request.provider,
			model: request.model,
			promptHash: authority.promptHash,
			draftHash: hash(result.markdown),
			providerReceiptId: result.receiptId,
		},
	};
};
