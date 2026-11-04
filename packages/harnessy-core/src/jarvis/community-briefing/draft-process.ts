import { spawn } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";

import {
	type CodexProviderFailureCode,
	codexProviderFailureCode,
	codexProviderFailureSubCode,
} from "../../ai/codex-failure.ts";

const Result = Schema.Struct({
	type: Schema.Literal("result"),
	briefing_id: Schema.String,
	status: Schema.String,
	draft_hash: Schema.String,
	existing: Schema.Boolean,
	provider_calls: Schema.Int,
	notification_pending: Schema.Boolean,
	notification_error: Schema.Boolean,
	publication: Schema.Literal(false),
});

/** Allow-listed adapter refusals, raised before any run or provider call. */
const REFUSALS = new Set(["native_draft_busy", "orphan_artifacts"]);

/** The fixed, content-free failure. `code` names a known cause when there is one. */
export class CommunityDraftProcessError extends Error {
	readonly code: "native_draft_busy" | "orphan_artifacts" | "deadline_exceeded" | CodexProviderFailureCode | undefined;
	/** The allow-listed network sub-code of a provider failure (for example `ENOTFOUND`). */
	readonly subCode: string | undefined;
	constructor(code: CommunityDraftProcessError["code"], subCode?: string) {
		super("Community draft did not complete safely; inspect its local state before retrying.");
		this.code = code;
		this.subCode = subCode;
	}
}

/** How long a stopped adapter may take to record its failed run after stdin closes. */
export const ADAPTER_STOP_GRACE_MS = 5_000;

export interface CommunityDraftProcessOptions {
	readonly runId: string;
	readonly pythonPath: string;
	readonly config: {
		readonly source_path: string;
		readonly draft_path: string;
		readonly state_path: string;
		readonly timezone: string;
		readonly max_sources?: number;
	};
	readonly action: "generate" | "regenerate" | "revise";
	readonly week_start: string;
	readonly briefing_id?: string;
	readonly instruction?: string;
	readonly markdown?: string;
	readonly discord_summary?: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	/** Grace between closing the adapter's stdin and SIGKILL; defaults to ADAPTER_STOP_GRACE_MS. */
	readonly stopGraceMs?: number;
	/** Return true only after the local notifier confirms successful submission. */
	readonly notify?: (kind: "pending" | "error", count: number, signal: AbortSignal) => Promise<boolean>;
	/** Called only after the adapter durably consumes the explicit run/call.
	 * The owning caller binds provider credentials and policy. Return the generated
	 * text and provider receipt; the adapter records hashes before validating JSON.
	 */
	readonly generate: (
		prompt: string,
		sequence: number,
		signal: AbortSignal,
	) => Promise<{
		readonly text: string;
		readonly receiptId: string;
		readonly model: string;
	}>;
}

export const callWhileActive = <A>(signal: AbortSignal, action: () => Promise<A>): Promise<A> =>
	new Promise<A>((resolve, reject) => {
		const aborted = () => {
			signal.removeEventListener("abort", aborted);
			reject(new Error("Draft operation cancelled."));
		};
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) {
			aborted();
			return;
		}
		Promise.resolve()
			.then(action)
			.then(
				(value) => {
					signal.removeEventListener("abort", aborted);
					resolve(value);
				},
				(error) => {
					signal.removeEventListener("abort", aborted);
					reject(error);
				},
			);
	});

/** Private process composition: no credential discovery, publication or retries. */
export const runCommunityDraftProcess = async (options: CommunityDraftProcessOptions) => {
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600000)
		throw new Error("Community draft timeout must be between one millisecond and ten minutes.");
	for (const path of [
		options.pythonPath,
		options.config.source_path,
		options.config.draft_path,
		options.config.state_path,
	])
		if (!isAbsolute(path)) throw new Error("Community draft requires explicit absolute paths.");
	options.signal.throwIfAborted();
	const request = JSON.stringify({
		run_id: options.runId,
		action: options.action,
		config: options.config,
		week_start: options.week_start,
		briefing_id: options.briefing_id,
		instruction: options.instruction,
		markdown: options.markdown,
		discord_summary: options.discord_summary,
		notifications: options.notify !== undefined,
	});
	if (Buffer.byteLength(request) >= 1048576) throw new Error("Community draft input exceeds its bound.");
	const controller = new AbortController();
	let timedOut = false;
	let refusal: "native_draft_busy" | "orphan_artifacts" | undefined;
	let providerFailure: CodexProviderFailureCode | undefined;
	let providerSubCode: string | undefined;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs);
	const signal = AbortSignal.any([options.signal, controller.signal]);
	const child = spawn(
		options.pythonPath,
		["-I", fileURLToPath(new URL("../../../resources/community-draft-adapter.py", import.meta.url))],
		{
			cwd: options.config.source_path,
			env: { PATH: dirname(options.pythonPath), LANG: "en_US.UTF-8" },
			stdio: ["pipe", "pipe", "ignore"],
		},
	);
	const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
	child.once("error", () => controller.abort());
	child.stdin.on("error", () => controller.abort());
	// Close stdin first: an adapter waiting for a reply then fails its read, marks
	// its run failed and exits. SIGKILL only an adapter that outlives the grace.
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		if (!child.stdin.destroyed) child.stdin.end();
		killTimer ??= setTimeout(() => child.kill("SIGKILL"), options.stopGraceMs ?? ADAPTER_STOP_GRACE_MS);
	};
	signal.addEventListener("abort", stop, { once: true });
	if (signal.aborted) stop();
	let bytes = 0;
	child.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes > 4 * 1048576) controller.abort();
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
	let result: typeof Result.Type | undefined;
	let calls = 0;
	let notifications = 0;
	try {
		return await Effect.runPromise(
			Effect.tryPromise({
				try: async () => {
					child.stdin.write(`${request}\n`);
					for await (const line of lines) {
						signal.throwIfAborted();
						const event: unknown = JSON.parse(line);
						if (typeof event !== "object" || event === null || !("type" in event) || result)
							throw new Error("Unexpected adapter message.");
						if (event.type === "error") {
							if ("code" in event && typeof event.code === "string" && REFUSALS.has(event.code))
								refusal = event.code as typeof refusal;
							continue;
						}
						if (event.type === "result") {
							result = Schema.decodeUnknownSync(Result)(event);
							if (result.provider_calls !== calls) throw new Error("Adapter call count mismatch.");
							continue;
						}
						if (event.type === "notification") {
							if (
								!options.notify ||
								++notifications > 2 ||
								!("kind" in event) ||
								(event.kind !== "pending" && event.kind !== "error") ||
								!("count" in event) ||
								typeof event.count !== "number" ||
								!Number.isSafeInteger(event.count) ||
								event.count < 0 ||
								event.count > 10000
							)
								throw new Error("Invalid notification request.");
							const kind = event.kind;
							const count = event.count;
							const notify = options.notify;
							const delivered = await callWhileActive(signal, () =>
								Promise.resolve()
									.then(() => notify(kind, count, signal))
									.then(
										(value) => value === true,
										() => false,
									),
							);
							child.stdin.write(`${JSON.stringify({ type: "notification-result", kind, delivered })}\n`);
							continue;
						}
						if (
							event.type !== "generate" ||
							!("sequence" in event) ||
							event.sequence !== calls + 1 ||
							calls >= 3 ||
							!("prompt" in event) ||
							typeof event.prompt !== "string" ||
							Buffer.byteLength(event.prompt) > 262144
						)
							throw new Error("Invalid adapter request.");
						const prompt = event.prompt;
						calls++;
						const data = await callWhileActive(signal, () => options.generate(prompt, calls, signal)).catch(
							(error: unknown) => {
								providerFailure = codexProviderFailureCode(error);
								providerSubCode = codexProviderFailureSubCode(error);
								throw error;
							},
						);
						signal.throwIfAborted();
						if (typeof data !== "object" || data === null || Array.isArray(data))
							throw new Error("Strict JSON object required.");
						const reply = JSON.stringify({ ...data, sequence: calls, provider: "codex" });
						if (Buffer.byteLength(reply) >= 1048576) throw new Error("Adapter reply exceeds its bound.");
						child.stdin.write(`${reply}\n`);
					}
					const code = await closed;
					signal.throwIfAborted();
					if (code !== 0 || !result) throw new Error("Adapter did not complete.");
					return result;
				},
				catch: () =>
					timedOut || refusal !== undefined
						? new CommunityDraftProcessError(timedOut ? "deadline_exceeded" : refusal)
						: new CommunityDraftProcessError(providerFailure, providerSubCode),
			}),
		);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		controller.abort();
		stop();
		await closed;
		clearTimeout(killTimer);
		lines.close();
	}
};
