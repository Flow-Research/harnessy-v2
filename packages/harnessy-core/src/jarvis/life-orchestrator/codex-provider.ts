import type { AssistantMessage } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import * as Effect from "effect/Effect";

import { readStableMeetingPublicationSmokeFile } from "../meeting-publication/operational-input.ts";
import type { LifeDraftRequest } from "./draft-provider.ts";

export interface CodexLifeDraftProviderOptions {
	readonly authPath: string;
	readonly timeoutMs: number;
	readonly maximumOutputBytes: number;
}

/** One text-only request. The optional provider is an isolated-test seam, never CLI configuration. */
export const createCodexDraftProvider = (input: CodexLifeDraftProviderOptions, provider = openaiCodexProvider()) => {
	const options = Object.freeze({ ...input });
	return {
		generate: async (request: Pick<LifeDraftRequest, "provider" | "model" | "prompt">, signal: AbortSignal) => {
			if (signal.aborted) throw new Error("Codex draft cancelled before execution.");
			if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600_000)
				throw new Error("Codex timeout must be a positive bounded integer.");
			if (!Number.isSafeInteger(options.maximumOutputBytes) || options.maximumOutputBytes < 1)
				throw new Error("Codex output limit must be positive.");
			const model = provider.getModels().find((candidate) => candidate.id === request.model);
			if (
				request.provider !== "codex" ||
				!model ||
				model.provider !== "openai-codex" ||
				model.api !== "openai-codex-responses"
			)
				throw new Error("Codex requires the exact requested provider and supported model; no fallback.");
			if (!process.getuid || process.platform === "win32") throw new Error("Codex OAuth requires POSIX ownership.");
			const uid = BigInt(process.getuid());
			const { authBytes, access, expires } = Effect.runSync(
				Effect.try({
					try: () => {
						const authBytes = readStableMeetingPublicationSmokeFile(
							options.authPath,
							uid,
							"private",
							65_536,
						).bytes;
						const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(authBytes));
						if (typeof document !== "object" || document === null || !("openai-codex" in document))
							throw new Error();
						const credential = document["openai-codex"];
						if (
							typeof credential !== "object" ||
							credential === null ||
							!("type" in credential) ||
							credential.type !== "oauth" ||
							!("access" in credential) ||
							typeof credential.access !== "string" ||
							!("expires" in credential) ||
							typeof credential.expires !== "number" ||
							!Number.isFinite(credential.expires) ||
							!("accountId" in credential) ||
							typeof credential.accountId !== "string" ||
							!credential.accountId.trim()
						)
							throw new Error();
						const parts = credential.access.split(".");
						if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error();
						const token: unknown = JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[1]!, "base64url")),
						);
						if (
							typeof token !== "object" ||
							token === null ||
							!("exp" in token) ||
							typeof token.exp !== "number" ||
							!Number.isFinite(token.exp) ||
							!("https://api.openai.com/auth" in token)
						)
							throw new Error();
						const account = token["https://api.openai.com/auth"];
						if (
							typeof account !== "object" ||
							account === null ||
							!("chatgpt_account_id" in account) ||
							account.chatgpt_account_id !== credential.accountId
						)
							throw new Error();
						const access = credential.access;
						const expires = Math.min(credential.expires, token.exp * 1_000);
						if (!Number.isFinite(expires) || !Number.isFinite(Date.now()) || expires <= Date.now())
							throw new Error();
						return { authBytes, access, expires };
					},
					catch: () =>
						new Error("Codex requires valid unexpired owner-only V2 OAuth credentials; no refresh or fallback."),
				}),
			);
			const controller = new AbortController();
			const cancelled = () => controller.abort(new Error("Codex draft cancelled; reconcile before retrying."));
			signal.addEventListener("abort", cancelled, { once: true });
			if (signal.aborted) cancelled();
			const timer = setTimeout(
				() => controller.abort(new Error("Codex draft deadline exceeded; reconcile before retrying.")),
				Math.max(1, Math.min(options.timeoutMs, expires - Date.now())),
			);
			const assertActive = () => {
				controller.signal.throwIfAborted();
				if (!Number.isFinite(Date.now()) || Date.now() >= expires)
					throw new Error("Codex OAuth expired; no refresh or fallback.");
			};
			let abortListener: (() => void) | undefined;
			try {
				assertActive();
				const stream = provider.stream(
					model,
					{
						systemPrompt:
							"Produce only the requested review draft. No tools are available. Do not perform actions.",
						messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
					},
					{
						apiKey: access,
						transport: "sse",
						redirect: "error",
						maxRetries: 0,
						reasoningEffort: "high",
						signal: controller.signal,
						timeoutMs: options.timeoutMs,
						onPayload: (payload) => {
							assertActive();
							if (
								!readStableMeetingPublicationSmokeFile(options.authPath, uid, "private", 65_536).bytes.equals(
									authBytes,
								)
							)
								throw new Error("Codex OAuth changed before dispatch.");
							if (typeof payload !== "object" || payload === null) throw new Error("Invalid Codex payload.");
							return { ...payload, tools: [], tool_choice: "none", parallel_tool_calls: false };
						},
					},
				);
				const consume = async () => {
					let result: AssistantMessage | undefined;
					for await (const event of stream) {
						assertActive();
						const message =
							event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
						let size = 0;
						for (const block of message.content) {
							if (block.type === "toolCall")
								throw new Error("Codex returned a forbidden tool call; reconcile before retrying.");
							size += Buffer.byteLength(block.type === "text" ? block.text : block.thinking, "utf8");
						}
						if (size > options.maximumOutputBytes)
							throw new Error("Codex output exceeded its byte limit; reconcile before retrying.");
						if (event.type === "error") throw new Error("Codex generation failed; reconcile before retrying.");
						if (event.type === "done") result = event.message;
					}
					assertActive();
					if (!result || result.stopReason !== "stop")
						throw new Error("Codex returned an incomplete draft; reconcile before retrying.");
					const markdown = result.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("")
						.trim();
					if (!markdown || !result.responseId?.trim())
						throw new Error("Codex returned no draft or response receipt; reconcile before retrying.");
					return { markdown, provider: "codex", model: model.id, receiptId: result.responseId };
				};
				const aborted = new Promise<never>((_resolve, reject) => {
					abortListener = () => reject(controller.signal.reason);
					controller.signal.addEventListener("abort", abortListener, { once: true });
					if (controller.signal.aborted) abortListener();
				});
				return await Promise.race([consume(), aborted]);
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", cancelled);
				if (abortListener) controller.signal.removeEventListener("abort", abortListener);
				controller.abort();
			}
		},
	};
};

// Existing Life callers keep the same text-only transport and validation.
export const createCodexLifeDraftProvider = createCodexDraftProvider;
