import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { type CommunityDraftProcessOptions, callWhileActive } from "./draft-process.ts";
import type { CommunityWeekGenerationResult } from "./weekly-generation.ts";

/** The adapter's answer to one scheduled week; a publishing claim is a protocol error. */
const WeekResult = Schema.Struct({
	type: Schema.Literal("generate_week_result"),
	request_id: Schema.String,
	week_start: Schema.String,
	status: Schema.Literals(["created", "existing", "busy", "failed"]),
	briefing_id: Schema.optional(Schema.String),
	code: Schema.optional(Schema.String),
	ran: Schema.Boolean,
	publication: Schema.Literal(false),
});

/** Ask the review's own adapter for one scheduled week. Never publishes. */
export type CommunityWeekRequest = (weekStart: string) => Promise<CommunityWeekGenerationResult>;

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
	/**
	 * Started once the review is ready and stopped with it. It receives the only
	 * way to ask this review's adapter to generate a scheduled week, so weekly
	 * generation adds no process, argv or launchd label for the one-writer guard.
	 */
	readonly onScheduler?: (generateWeek: CommunityWeekRequest, signal: AbortSignal) => void | Promise<void>;
	/** Deadline for one scheduled request, including source collection. Default: twice the operation deadline plus one minute. */
	readonly scheduledRequestTimeoutMs?: number;
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
	// One scheduled request at a time. Its own deadline covers source collection
	// before the native run starts; the run itself keeps the operation deadline.
	const scheduler = new AbortController();
	const scheduled = new Map<
		string,
		{
			readonly weekStart: string;
			readonly resolve: (result: CommunityWeekGenerationResult) => void;
			readonly timer: ReturnType<typeof setTimeout>;
		}
	>();
	const expired = new Set<string>();
	const settleScheduled = (requestId: string, result: CommunityWeekGenerationResult) => {
		const request = scheduled.get(requestId);
		if (!request) return;
		scheduled.delete(requestId);
		clearTimeout(request.timer);
		request.resolve(result);
	};
	const generateWeek: CommunityWeekRequest = (weekStart) =>
		new Promise<CommunityWeekGenerationResult>((resolve) => {
			if (!/^\d{4}-\d{2}-\d{2}$/u.test(weekStart) || scheduler.signal.aborted || !ready) {
				resolve({ status: "failed", code: "review_unavailable" });
				return;
			}
			if (scheduled.size > 0) {
				resolve({ status: "busy" });
				return;
			}
			const requestId = randomUUID();
			const timer = setTimeout(
				() => {
					expired.add(requestId);
					settleScheduled(requestId, { status: "failed", code: "adapter_timeout" });
				},
				options.scheduledRequestTimeoutMs ?? options.operationTimeoutMs * 2 + 60_000,
			);
			scheduled.set(requestId, { weekStart, resolve, timer });
			child.stdin.write(
				`${JSON.stringify({ type: "generate_week", request_id: requestId, week_start: weekStart })}\n`,
			);
		});
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
							if (options.onScheduler)
								Promise.resolve()
									.then(() => options.onScheduler?.(generateWeek, scheduler.signal))
									// The scheduler records its own failures; it can never stop review.
									.catch(() => undefined);
							continue;
						}
						if (ready && event.type === "generate_week_result") {
							const result = Schema.decodeUnknownSync(WeekResult)(event);
							const request = scheduled.get(result.request_id);
							if (!request) {
								if (expired.delete(result.request_id)) continue;
								throw new Error("Unexpected scheduled generation result.");
							}
							if (request.weekStart !== result.week_start) throw new Error("Scheduled week changed.");
							settleScheduled(result.request_id, {
								status: result.status,
								ran: result.ran,
								...(result.briefing_id === undefined ? {} : { briefingId: result.briefing_id }),
								...(result.code === undefined ? {} : { code: result.code }),
							});
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
		scheduler.abort();
		for (const requestId of Array.from(scheduled.keys()))
			settleScheduled(requestId, { status: "failed", code: "review_stopped" });
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
