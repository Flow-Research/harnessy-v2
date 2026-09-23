import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { CommunityBriefingQueue } from "../../harnessy-sdk/src/community-briefing/queue.ts";
import {
	type CommunityDraftProcessOptions,
	runCommunityDraftProcess,
} from "../src/jarvis/community-briefing/draft-process.ts";
import { runNativeCommunityReview } from "../src/jarvis/community-briefing/native-draft.ts";
import {
	type CommunityReviewProcessOptions,
	runCommunityReviewProcess,
} from "../src/jarvis/community-briefing/review-process.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = async () => {
	const pythonPath = process.env.HARNESSY_TEST_JARVIS_PYTHON;
	if (!pythonPath) throw new Error("Set HARNESSY_TEST_JARVIS_PYTHON to the isolated installed interpreter.");
	const root = mkdtempSync(join(tmpdir(), "community-review-parent-"));
	roots.push(root);
	mkdirSync(join(root, "sources"));
	const options: CommunityDraftProcessOptions = {
		pythonPath,
		runId: "initial-quiet-week",
		action: "generate",
		week_start: "2026-09-14",
		config: {
			source_path: join(root, "sources"),
			draft_path: join(root, "drafts"),
			state_path: join(root, "state"),
			timezone: "Africa/Lagos",
		},
		timeoutMs: 5000,
		signal: new AbortController().signal,
		generate: async () => {
			throw new Error("Quiet week must not use a provider");
		},
	};
	const draft = await runCommunityDraftProcess(options);
	return { root, options, draft };
};

const row = (options: CommunityDraftProcessOptions, sql: string) => {
	const db = new DatabaseSync(join(options.config.state_path, "weekly-briefings.sqlite3"), { readOnly: true });
	try {
		db.exec("PRAGMA busy_timeout=2000");
		return db.prepare(sql).get()!;
	} finally {
		db.close();
	}
};

it.each(["success", "provider-failure", "deadline", "missing-credential", "cancel"])(
	"keeps review independent from a bounded AI operation: %s",
	async (mode) => {
		const { root, options, draft } = await fixture();
		const controller = new AbortController();
		let ready: (url: string) => void = () => {};
		const urlPromise = new Promise<string>((resolve) => {
			ready = resolve;
		});
		let finished: (status: string) => void = () => {};
		const finishedPromise = new Promise<string>((resolve) => {
			finished = resolve;
		});
		let calls = 0;
		const requests: { prompt: string; sequence: number; remaining: number }[] = [];
		let observed: AbortSignal | undefined;
		const review: CommunityReviewProcessOptions = {
			pythonPath: options.pythonPath,
			config: { ...options.config, review_port: 0 },
			signal: controller.signal,
			operationTimeoutMs: mode === "deadline" ? 100 : 2000,
			onReady: ready,
			onRunFinished: (result) => finished(result.status),
			generate: async (prompt, sequence, signal, deadline) => {
				calls++;
				observed = signal;
				requests.push({ prompt, sequence, remaining: deadline - Date.now() });
				if (mode === "deadline" || mode === "cancel") return new Promise(() => {});
				if (mode === "provider-failure") throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
				return {
					receiptId: "synthetic-review-response",
					model: "synthetic-model",
					text: JSON.stringify({
						title: "We have a short update this week.",
						discord_summary: "We have fewer public updates this week.",
						sections: Object.fromEntries(
							["This week in brief", "What moved", "What we learned", "What comes next", "How to take part"].map(
								(heading) => [
									heading,
									"We have no further verified public updates to share this week. We will keep this summary brief.",
								],
							),
						),
					}),
				};
			},
		};
		// Observe failure immediately; startup/protocol failures must not become
		// unhandled rejections while the HTTP side of the test is running.
		const running = (
			mode === "missing-credential"
				? runNativeCommunityReview({
						...review,
						authPath: join(root, "absent-auth.json"),
						model: "gpt-5.5",
						maximumOutputBytes: 65536,
					})
				: runCommunityReviewProcess(review)
		).then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			const url = await Promise.race([
				urlPromise,
				running.then(() => {
					throw new Error("Review exited before readiness");
				}),
			]);
			const login = await fetch(url);
			expect(login.status).toBe(200);
			const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
			await login.text();
			const base = new URL(url).origin;
			const page = await (await fetch(`${base}/briefing/${draft.briefing_id}`, { headers: { cookie } })).text();
			const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
			const before = row(options, "SELECT * FROM community_briefings");
			if (mode === "deadline") await new Promise((resolve) => setTimeout(resolve, 200));
			const response = await fetch(`${base}/briefing/revise/${draft.briefing_id}`, {
				method: "POST",
				redirect: "manual",
				headers: { cookie },
				body: new URLSearchParams({
					csrf,
					revise_instruction: "Make this clearer.",
					revise_provider: "codex",
					briefing_markdown: readFileSync(String(before.briefing_path), "utf8"),
					discord_summary: readFileSync(String(before.discord_path), "utf8"),
				}),
			});
			expect(response.status).toBe(303);
			await response.text();
			if (mode === "cancel") {
				await expect.poll(() => calls).toBe(1);
				controller.abort();
				expect(await running).toBeInstanceOf(Error);
				expect(observed?.aborted).toBe(true);
				expect(
					row(
						options,
						"SELECT status,calls,receipts_json FROM community_draft_runs WHERE run_id != 'initial-quiet-week'",
					),
				).toEqual({ status: "running", calls: 1, receipts_json: "[]" });
				expect(row(options, "SELECT * FROM community_briefings")).toEqual(before);
				await expect(fetch(base)).rejects.toThrow();
				return;
			}
			expect(await finishedPromise).toBe(mode === "success" ? "completed" : "failed");
			const after = row(options, "SELECT * FROM community_briefings");
			expect(after).toMatchObject({ approved_hash: null, google_doc_id: null, discord_message_id: null });
			expect(after.draft_hash === before.draft_hash).toBe(mode !== "success");
			const ledger = row(
				options,
				"SELECT status,calls,receipts_json FROM community_draft_runs WHERE run_id != 'initial-quiet-week'",
			);
			expect(ledger.calls).toBe(1);
			expect(JSON.parse(String(ledger.receipts_json))).toHaveLength(mode === "success" ? 1 : 0);
			const refreshed = await fetch(`${base}/briefing/${draft.briefing_id}`, { headers: { cookie } });
			expect(refreshed.status).toBe(200);
			expect(await refreshed.text()).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
			expect(calls).toBe(mode === "missing-credential" ? 0 : 1);
			for (const request of requests) {
				expect(request.sequence).toBe(1);
				expect(request.prompt).toContain("Make this clearer");
				expect(request.remaining).toBeGreaterThan(0);
			}
			if (mode === "deadline") expect(observed?.aborted).toBe(true);
		} finally {
			controller.abort();
			await running;
		}
		// Cleanup must not mask an earlier assertion or provider failure.
		expect(await running).toBeUndefined();
	},
	10000,
);

it("rejects invalid execution bounds and pre-cancelled work before starting review", async () => {
	const { options } = await fixture();
	let callbacks = 0;
	const review: CommunityReviewProcessOptions = {
		pythonPath: options.pythonPath,
		config: { ...options.config, review_port: 0 },
		signal: new AbortController().signal,
		operationTimeoutMs: 100,
		onReady: () => {
			callbacks++;
		},
		generate: async () => {
			callbacks++;
			throw new Error("Must not generate");
		},
	};
	for (const operationTimeoutMs of [0, -1, 600001, 1.5, Number.NaN]) {
		await expect(runCommunityReviewProcess({ ...review, operationTimeoutMs })).rejects.toThrow("deadline");
	}
	await expect(runCommunityReviewProcess({ ...review, pythonPath: "python" })).rejects.toThrow("absolute paths");
	await expect(
		runCommunityReviewProcess({ ...review, config: { ...review.config, state_path: "relative" } }),
	).rejects.toThrow("absolute paths");
	await expect(
		runCommunityReviewProcess({ ...review, config: { ...review.config, timezone: "x".repeat(1048576) } }),
	).rejects.toThrow("input exceeds");
	await expect(runCommunityReviewProcess({ ...review, signal: AbortSignal.abort() })).rejects.toThrow();
	expect(callbacks).toBe(0);
	expect(row(options, "SELECT COUNT(*) AS count FROM community_draft_runs")).toEqual({ count: 1 });
});

it("reports an unavailable review interpreter without a dangling process", async () => {
	const { root, options } = await fixture();
	await expect(
		runCommunityReviewProcess({
			pythonPath: join(root, "missing-python"),
			config: { ...options.config, review_port: 0 },
			signal: new AbortController().signal,
			operationTimeoutMs: 100,
			onReady: () => {
				throw new Error("Must not become ready");
			},
			generate: options.generate,
		}),
	).rejects.toThrow("Community review stopped");
});

it.each(["publishing", "blocked", "published", "orphan-lease"])(
	"preserves native publication claims and receipts against review mutations: %s",
	async (status) => {
		const { options, draft } = await fixture();
		const controller = new AbortController();
		let ready: (url: string) => void = () => {};
		const readyPromise = new Promise<string>((resolve) => {
			ready = resolve;
		});
		let calls = 0;
		const running = runCommunityReviewProcess({
			pythonPath: options.pythonPath,
			config: { ...options.config, review_port: 0 },
			signal: controller.signal,
			operationTimeoutMs: 1000,
			onReady: ready,
			generate: async () => {
				calls++;
				throw new Error("No AI call is eligible");
			},
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		const queue = new CommunityBriefingQueue(join(options.config.state_path, "weekly-briefings.sqlite3"));
		try {
			const url = await Promise.race([
				readyPromise,
				running.then(() => {
					throw new Error("Review stopped before readiness");
				}),
			]);
			const login = await fetch(url);
			expect(login.status).toBe(200);
			const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
			await login.text();
			const base = new URL(url).origin;
			const page = await (await fetch(`${base}/briefing/${draft.briefing_id}`, { headers: { cookie } })).text();
			const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
			const initial = row(options, "SELECT * FROM community_briefings");
			const markdown = readFileSync(String(initial.briefing_path), "utf8");
			const summary = readFileSync(String(initial.discord_path), "utf8");
			const fields = new URLSearchParams({
				csrf,
				briefing_markdown: markdown,
				discord_summary: summary,
				revise_instruction: "Change this draft",
				revise_provider: "codex",
			});
			const approve = await fetch(`${base}/briefing/approve/${draft.briefing_id}`, {
				method: "POST",
				redirect: "manual",
				headers: { cookie },
				body: fields,
			});
			expect(approve.status).toBe(303);
			await approve.text();
			const now = new Date().toISOString();
			const claimed = queue.claim(now)!;
			expect(claimed.briefingId).toBe(draft.briefing_id);
			queue.recordGoogle(claimed, "synthetic-doc", "https://docs.example/synthetic-doc", now);
			if (status === "orphan-lease") {
				// A conflicting status must not hide retained ownership evidence.
				queue.database.exec(
					"UPDATE community_briefings SET status='approved', google_doc_id=NULL, google_doc_url=NULL",
				);
			}
			if (status === "blocked") queue.markFailure(claimed, "discord", "uncertain_delivery", now);
			if (status === "published") queue.markPublished(claimed, "synthetic-channel", "synthetic-message", now);
			const before = row(options, "SELECT * FROM community_briefings");
			expect(before.status).toBe(status === "orphan-lease" ? "approved" : status);
			const files = [String(before.briefing_path), String(before.discord_path), String(before.provenance_path)];
			const bytes = files.map((path) => readFileSync(path));
			for (const action of ["save", "approve", "reject", "revise"]) {
				const response = await fetch(`${base}/briefing/${action}/${draft.briefing_id}`, {
					method: "POST",
					redirect: "manual",
					headers: { cookie },
					body: fields,
				});
				expect(response.status, action).toBe(409);
				await response.text();
				expect(row(options, "SELECT * FROM community_briefings")).toEqual(before);
				expect(files.map((path) => readFileSync(path))).toEqual(bytes);
			}
			expect(calls).toBe(0);
			expect(row(options, "SELECT COUNT(*) AS count FROM community_draft_runs")).toEqual({ count: 1 });
			if (status === "orphan-lease") {
				await expect(
					runCommunityDraftProcess({ ...options, action: "regenerate", runId: "blocked-regeneration" }),
				).rejects.toThrow();
				expect(row(options, "SELECT * FROM community_briefings")).toEqual(before);
				expect(files.map((path) => readFileSync(path))).toEqual(bytes);
				expect(
					row(options, "SELECT status,calls FROM community_draft_runs WHERE run_id='blocked-regeneration'"),
				).toEqual({ status: "failed", calls: 0 });
			}
			if (status === "publishing") {
				expect(() => queue.assertClaim(claimed)).not.toThrow();
				queue.markPublished(claimed, "synthetic-channel", "synthetic-message", now);
				expect(row(options, "SELECT status,google_doc_id,discord_message_id FROM community_briefings")).toEqual({
					status: "published",
					google_doc_id: "synthetic-doc",
					discord_message_id: "synthetic-message",
				});
			}
		} finally {
			controller.abort();
			await running;
			queue.close();
		}
		expect(await running).toBeUndefined();
	},
	10000,
);
