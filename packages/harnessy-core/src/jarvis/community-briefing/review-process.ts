import { spawn } from "node:child_process";
import { dirname, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { type CommunityDraftProcessOptions, callWhileActive } from "./draft-process.ts";

export interface CommunityReviewProcessOptions {
	readonly pythonPath: string;
	readonly config: CommunityDraftProcessOptions["config"] & { readonly review_port: number };
	readonly signal: AbortSignal;
	/** Per explicit AI operation, not the lifetime of the review window. */
	readonly operationTimeoutMs: number;
	readonly generate: (
		prompt: string,
		sequence: number,
		signal: AbortSignal,
		deadline: number,
	) => ReturnType<CommunityDraftProcessOptions["generate"]>;
	/** Contains a local bearer link: display to the owner, never diagnostic logs. */
	readonly onReady: (url: string) => void | Promise<void>;
	readonly onRunFinished?: (result: {
		runId: string;
		status: "completed" | "failed";
		calls: number;
	}) => void | Promise<void>;
}

/** Foreground briefing review only. This process cannot acquire publication providers. */
export const runCommunityReviewProcess = async (options: CommunityReviewProcessOptions): Promise<void> => {
	if (
		!Number.isSafeInteger(options.operationTimeoutMs) ||
		options.operationTimeoutMs < 1 ||
		options.operationTimeoutMs > 600000
	)
		throw new Error("Review AI operations require a deadline of at most ten minutes.");
	for (const path of [
		options.pythonPath,
		options.config.source_path,
		options.config.draft_path,
		options.config.state_path,
	])
		if (!isAbsolute(path)) throw new Error("Community review requires explicit absolute paths.");
	const request = JSON.stringify({ action: "review", config: options.config });
	if (Buffer.byteLength(request) >= 1048576) throw new Error("Community review input exceeds its bound.");
	options.signal.throwIfAborted();
	const controller = new AbortController();
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
	let ready = false;
	let active:
		| {
				id: string;
				calls: number;
				deadline: number;
				controller: AbortController;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined;
	let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	const startupTimer = setTimeout(() => controller.abort(), 10000);
	try {
		await Effect.runPromise(
			Effect.tryPromise({
				try: async () => {
					child.stdin.write(`${request}\n`);
					for await (const line of lines) {
						signal.throwIfAborted();
						const event: unknown = JSON.parse(line);
						if (typeof event !== "object" || event === null || !("type" in event))
							throw new Error("Invalid review event.");
						if (event.type === "ready") {
							if (ready || !("url" in event) || typeof event.url !== "string")
								throw new Error("Invalid review readiness.");
							const url = new URL(event.url);
							if (
								url.protocol !== "http:" ||
								url.hostname !== "127.0.0.1" ||
								url.username ||
								url.password ||
								url.pathname !== "/" ||
								!url.searchParams.get("token")
							)
								throw new Error("Invalid local review link.");
							ready = true;
							clearTimeout(startupTimer);
							bytes = 0;
							await callWhileActive(signal, async () => options.onReady(url.href));
							continue;
						}
						if (
							!ready ||
							!("run_id" in event) ||
							typeof event.run_id !== "string" ||
							!/^[a-f0-9-]{36}$/.test(event.run_id)
						)
							throw new Error("Invalid review run identity.");
						if (event.type === "run_started") {
							if (active) throw new Error("Overlapping review run.");
							const operation = new AbortController();
							active = {
								id: event.run_id,
								calls: 0,
								deadline: Date.now() + options.operationTimeoutMs,
								controller: operation,
								timer: setTimeout(() => {
									operation.abort();
									// Give the adapter time to record an ordinary failed operation.
									// A stuck adapter is stopped, never silently retried/restarted.
									recoveryTimer = setTimeout(() => controller.abort(), 2000);
								}, options.operationTimeoutMs),
							};
							continue;
						}
						if (!active || active.id !== event.run_id) throw new Error("Review run changed.");
						if (event.type === "run_finished") {
							if (
								!("status" in event) ||
								(event.status !== "completed" && event.status !== "failed") ||
								!("provider_calls" in event) ||
								event.provider_calls !== active.calls
							)
								throw new Error("Invalid review completion.");
							clearTimeout(active.timer);
							clearTimeout(recoveryTimer);
							active.controller.abort();
							const result: { runId: string; status: "completed" | "failed"; calls: number } = {
								runId: active.id,
								status: event.status,
								calls: active.calls,
							};
							active = undefined;
							bytes = 0;
							await callWhileActive(signal, async () => options.onRunFinished?.(result)).catch(
								(error: unknown) => {
									// The adapter already committed completion. Owner shutdown
									// during its notification is not an interrupted AI operation.
									if (!options.signal.aborted) throw error;
								},
							);
							continue;
						}
						if (
							event.type !== "generate" ||
							!("sequence" in event) ||
							event.sequence !== active.calls + 1 ||
							active.calls >= 3 ||
							!("prompt" in event) ||
							typeof event.prompt !== "string" ||
							Buffer.byteLength(event.prompt) > 262144
						)
							throw new Error("Invalid review generation request.");
						const prompt = event.prompt;
						const sequence = ++active.calls;
						const deadline = active.deadline;
						const operationSignal = AbortSignal.any([signal, active.controller.signal]);
						const reply = await callWhileActive(operationSignal, () =>
							options.generate(prompt, sequence, operationSignal, deadline),
						).then(
							(value) => ({ ...value }),
							() => ({ error: "native_provider_failed" }),
						);
						signal.throwIfAborted();
						const encoded = JSON.stringify({ ...reply, run_id: active.id, sequence, provider: "codex" });
						if (Buffer.byteLength(encoded) >= 1048576) throw new Error("Review response exceeds its bound.");
						child.stdin.write(`${encoded}\n`);
					}
					await closed;
					if (!options.signal.aborted) throw new Error("Review process stopped unexpectedly.");
				},
				catch: () => new Error("Community review stopped; inspect unfinished local revisions before restarting."),
			}),
		);
	} finally {
		clearTimeout(startupTimer);
		clearTimeout(active?.timer);
		clearTimeout(recoveryTimer);
		active?.controller.abort();
		signal.removeEventListener("abort", stop);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
		lines.close();
	}
};
