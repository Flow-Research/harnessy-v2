import { spawn } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";

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
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
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
	const stop = () => child.kill("SIGKILL");
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
						const data = await callWhileActive(signal, () => options.generate(prompt, calls, signal));
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
				catch: () => new Error("Community draft did not complete safely; inspect its local state before retrying."),
			}),
		);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", stop);
		controller.abort();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
		lines.close();
	}
};
