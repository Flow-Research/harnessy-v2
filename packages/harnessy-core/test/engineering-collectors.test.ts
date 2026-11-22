import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { describe, expect, it, vi } from "vitest";
import { makeEngineeringCommand } from "../src/cli/engineering.ts";
import {
	assembleCollection,
	collectionGate,
	collectPullRequestChecks,
	collectReopenedDefects,
	collectWorkStreamAcceptance,
	githubReadOnlySource,
	INSTALLED_COLLECTORS,
	type ReadOnlyFetch,
	type ReadOnlySource,
} from "../src/engineering/collectors.ts";
import { METRIC_REGISTRY } from "../src/engineering/metrics.ts";
import type { Run, WorkDeps } from "../src/work/run.ts";

const NOW = Date.parse("2026-11-22T12:00:00Z");
const HEAD = "a".repeat(40);
const REPO = "Flow-Research/garden";

/** A fixed response map. Any other request fails, as a missing input would. */
function fixtures(responses: Record<string, unknown>): { source: ReadOnlySource; seen: string[] } {
	const seen: string[] = [];
	return {
		seen,
		source: async (request) => {
			seen.push(request);
			if (!(request in responses)) return { ok: false, reason: "not_found" };
			const value = responses[request];
			return { ok: true, body: typeof value === "string" ? value : JSON.stringify(value) };
		},
	};
}

const run = (name: string, conclusion: string | null, id: number, status = "completed", app = 15368) => ({
	id,
	name,
	status,
	conclusion,
	app: { id: app },
});

function pullFixtures(
	checkRuns: ReadonlyArray<unknown>,
	extra: Record<string, unknown> = {},
	protection: unknown = {
		required_status_checks: {
			enforcement_level: "everyone",
			checks: [
				{ context: "Verify", app_id: 15368 },
				{ context: "PR contract", app_id: 15368 },
			],
			contexts: ["Verify", "PR contract"],
		},
	},
) {
	return {
		[`repos/${REPO}/pulls/7`]: { state: "open", head: { sha: HEAD }, base: { ref: "dev" } },
		[`repos/${REPO}/branches/dev`]: { name: "dev", protection },
		[`repos/${REPO}/rules/branches/dev`]: [],
		[`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: {
			total_count: checkRuns.length,
			check_runs: checkRuns,
		},
		[`repos/${REPO}/commits/${HEAD}/status?per_page=100`]: { total_count: 0, statuses: [] },
		...extra,
	};
}

describe("pull request required check collector", () => {
	it("observes required check coverage on the exact head with provenance", async () => {
		const { source } = fixtures(
			pullFixtures([
				run("Verify", "failure", 1),
				run("Verify", "success", 2),
				run("PR contract", "success", 3),
				run("Verify", "failure", 4, "completed", 999),
				run("Optional lint", "failure", 5),
			]),
		);
		const [coverage, skipped] = await collectPullRequestChecks({
			source,
			repository: REPO,
			pullRequest: 7,
			now: () => NOW,
		});
		expect(coverage.observation).toMatchObject({
			metricId: "tests.required_scenario_coverage",
			status: "observed",
			value: 1,
			denominator: 2,
			sampleCount: 2,
		});
		expect(skipped.observation).toMatchObject({ metricId: "tests.skipped", status: "observed", value: 0 });
		expect(coverage.provenance.collector).toBe("github.pull-request-required-checks.v1");
		expect(coverage.provenance.subject).toMatchObject({ headSha: HEAD, baseRef: "dev" });
		expect(coverage.provenance.requests).toHaveLength(6);
		for (const request of coverage.provenance.requests) expect(request.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("counts a missing and a skipped required check as not executed, never as passed", async () => {
		const { source } = fixtures(
			pullFixtures([run("Verify", "skipped", 1)], {
				[`repos/${REPO}/rules/branches/dev`]: [
					{
						type: "required_status_checks",
						parameters: { required_status_checks: [{ context: "Ruleset gate", integration_id: 15368 }] },
					},
				],
			}),
		);
		const [coverage, skipped] = await collectPullRequestChecks({
			source,
			repository: REPO,
			pullRequest: 7,
			now: () => NOW,
		});
		expect(coverage.observation).toMatchObject({ status: "observed", value: 0, denominator: 3 });
		expect(skipped.observation).toMatchObject({ status: "observed", value: 3 });
	});

	it("reports pending required checks as inconclusive without a value", async () => {
		const { source } = fixtures(
			pullFixtures([run("Verify", null, 1, "in_progress"), run("PR contract", "success", 2)]),
		);
		for (const entry of await collectPullRequestChecks({ source, repository: REPO, pullRequest: 7 })) {
			expect(entry.observation.status).toBe("inconclusive");
			expect(entry.observation.reason).toBe("required_checks_pending_on_exact_head");
			expect(entry.observation).not.toHaveProperty("value");
		}
	});

	it("does not invent a denominator when the base branch declares no required checks", async () => {
		const { source } = fixtures(
			pullFixtures(
				[run("Verify", "success", 1)],
				{},
				{ required_status_checks: { enforcement_level: "off", checks: [] } },
			),
		);
		for (const entry of await collectPullRequestChecks({ source, repository: REPO, pullRequest: 7 })) {
			expect(entry.observation.status).toBe("unsupported");
			expect(entry.observation.reason).toBe("base_branch_declares_no_required_checks:dev");
			expect(entry.observation).not.toHaveProperty("value");
		}
	});

	it("fails on missing or malformed input and on incomplete check pages", async () => {
		const missing = fixtures({});
		const malformed = fixtures({ ...pullFixtures([]), [`repos/${REPO}/pulls/7`]: "{not json" });
		const truncated = fixtures(
			pullFixtures([], {
				[`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&page=1`]: {
					total_count: 2,
					check_runs: [run("Verify", "success", 1)],
				},
			}),
		);
		for (const [{ source }, reason] of [
			[missing, /^read_failed:/],
			[malformed, /^malformed_json:/],
			[truncated, /^read_failed:.*page=2/],
		] as const) {
			for (const entry of await collectPullRequestChecks({ source, repository: REPO, pullRequest: 7 })) {
				expect(entry.observation.status).toBe("failed");
				expect(entry.observation.reason).toMatch(reason);
				expect(entry.observation).not.toHaveProperty("value");
			}
		}
	});

	it("is inconclusive when the head moves during collection", async () => {
		let reads = 0;
		const base = pullFixtures([run("Verify", "success", 1), run("PR contract", "success", 2)]);
		const source: ReadOnlySource = async (request) => {
			if (request === `repos/${REPO}/pulls/7` && reads++ > 0)
				return {
					ok: true,
					body: JSON.stringify({ state: "open", head: { sha: "b".repeat(40) }, base: { ref: "dev" } }),
				};
			return { ok: true, body: JSON.stringify(base[request as keyof typeof base]) };
		};
		for (const entry of await collectPullRequestChecks({ source, repository: REPO, pullRequest: 7 }))
			expect(entry.observation).toMatchObject({
				status: "inconclusive",
				reason: "pull_request_head_changed_during_collection",
			});
	});

	it("reads GitHub with GET-only argv and refuses other paths", async () => {
		const calls: ReadonlyArray<string>[] = [];
		const fake: Run = async (argv) => {
			calls.push(argv);
			return { exitCode: 0, stdout: "{}", stderr: "" };
		};
		const source = githubReadOnlySource(fake);
		expect(await source(`repos/${REPO}/pulls/7`)).toEqual({ ok: true, body: "{}" });
		expect(await source("graphql")).toEqual({ ok: false, reason: "refused_github_path" });
		expect(await source(`repos/${REPO}/../x`)).toEqual({ ok: false, reason: "refused_github_path" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain("--method");
		expect(calls[0]).not.toContain("-X");
		expect(calls[0].some((part) => /^-[fF]$|^--(raw-)?field$|^--input$/.test(part))).toBe(false);
	});
});

describe("reopened defect collector", () => {
	const search = (items: ReadonlyArray<unknown>, incomplete = false) => ({
		total_count: items.length,
		incomplete_results: incomplete,
		items,
	});
	const searchPath =
		"search/issues?q=repo%3AFlow-Research%2Fgarden+is%3Aissue+label%3A%22bug%22+updated%3A%3E%3D2026-10-23T12%3A00%3A00Z&per_page=100&page=1";

	it("counts distinct defects reopened inside the window", async () => {
		const { source } = fixtures({
			[`repos/${REPO}/labels/bug`]: { name: "bug" },
			[searchPath]: search([{ number: 3 }, { number: 4 }]),
			[`repos/${REPO}/issues/3/events?per_page=100&page=1`]: [
				{ event: "closed", created_at: "2026-11-01T00:00:00Z" },
				{ event: "reopened", created_at: "2026-11-02T00:00:00Z" },
				{ event: "reopened", created_at: "2026-11-03T00:00:00Z" },
			],
			[`repos/${REPO}/issues/4/events?per_page=100&page=1`]: [
				{ event: "reopened", created_at: "2026-09-01T00:00:00Z" },
			],
		});
		const [entry] = await collectReopenedDefects({ source, repository: REPO, label: "bug", now: () => NOW });
		expect(entry.observation).toMatchObject({ metricId: "defects.reopened", status: "observed", value: 1 });
		expect(entry.provenance.subject).toMatchObject({ candidateIssues: 2, reopenEvents: 2, reopenedIssues: [3] });
	});

	it("never reports zero defects when the declared label is missing", async () => {
		const { source, seen } = fixtures({ [searchPath]: search([]) });
		const [entry] = await collectReopenedDefects({ source, repository: REPO, label: "bug", now: () => NOW });
		expect(entry.observation.status).toBe("failed");
		expect(entry.observation).not.toHaveProperty("value");
		expect(seen).not.toContain(searchPath);
	});

	it("is inconclusive on incomplete search and fails on malformed events", async () => {
		const incomplete = fixtures({ [`repos/${REPO}/labels/bug`]: { name: "bug" }, [searchPath]: search([], true) });
		expect(
			(
				await collectReopenedDefects({ source: incomplete.source, repository: REPO, label: "bug", now: () => NOW })
			)[0].observation,
		).toMatchObject({ status: "inconclusive", reason: "search_results_incomplete" });
		const malformed = fixtures({
			[`repos/${REPO}/labels/bug`]: { name: "bug" },
			[searchPath]: search([{ number: 3 }]),
			[`repos/${REPO}/issues/3/events?per_page=100&page=1`]: [{ event: "reopened", created_at: "yesterday" }],
		});
		expect(
			(await collectReopenedDefects({ source: malformed.source, repository: REPO, label: "bug", now: () => NOW }))[0]
				.observation,
		).toMatchObject({ status: "failed", reason: "malformed_issue_event_time" });
	});
});

describe("WorkStream submission acceptance collector", () => {
	const PROJECT = "11111111-2222-4333-8444-555555555555";
	function api(pages: ReadonlyArray<unknown>, health: unknown = { status: "ok" }) {
		const calls: Array<{ url: string; method: string; authorization?: string }> = [];
		const fetch: ReadOnlyFetch = async (url, init) => {
			calls.push({ url, method: init.method, authorization: init.headers.Authorization });
			const parsed = new URL(url);
			if (parsed.pathname === "/api/v1/health") return { status: 200, text: async () => JSON.stringify(health) };
			const cursor = parsed.searchParams.get("cursor");
			const page = pages[cursor === null ? 0 : Number(cursor)];
			if (page === undefined) return { status: 404, text: async () => "" };
			return { status: 200, text: async () => (typeof page === "string" ? page : JSON.stringify(page)) };
		};
		return { fetch, calls };
	}
	const submission = (status: string, decided: string | null) => ({
		submission_id: randomUUID(),
		project_id: PROJECT,
		status,
		decided_at: decided,
	});

	it("observes accepted divided by decided submissions over every page", async () => {
		const { fetch, calls } = api([
			{
				items: [
					submission("accepted", "2026-11-20T00:00:00Z"),
					submission("needs_revision", "2026-11-19T00:00:00Z"),
					submission("review_pending", null),
				],
				next_cursor: "1",
			},
			{
				items: [submission("rejected", "2026-11-18T00:00:00Z"), submission("accepted", "2026-09-01T00:00:00Z")],
				next_cursor: null,
			},
		]);
		const [entry] = await collectWorkStreamAcceptance({
			fetch,
			baseUrl: "http://127.0.0.1:18100",
			token: "secret-token",
			projectId: PROJECT,
			now: () => NOW,
		});
		expect(entry.observation).toMatchObject({
			metricId: "behavior.task_acceptance",
			status: "observed",
			value: 1 / 3,
			denominator: 3,
			sampleCount: 3,
		});
		expect(calls.every((call) => call.method === "GET")).toBe(true);
		expect(calls[0].authorization).toBeUndefined();
		expect(JSON.stringify(entry)).not.toContain("secret-token");
		expect(entry.provenance.requests).toHaveLength(3);
	});

	it("reports a missing credential as unavailable after a real health read", async () => {
		const { fetch, calls } = api([]);
		const [entry] = await collectWorkStreamAcceptance({
			fetch,
			baseUrl: "http://127.0.0.1:18100",
			projectId: PROJECT,
		});
		expect(entry.observation).toMatchObject({ status: "unavailable", reason: "no_workstream_read_credential" });
		expect(entry.observation).not.toHaveProperty("value");
		expect(calls).toHaveLength(1);
	});

	it("does not invent a ratio without decided submissions", async () => {
		const { fetch } = api([{ items: [submission("review_pending", null)], next_cursor: null }]);
		const [entry] = await collectWorkStreamAcceptance({
			fetch,
			baseUrl: "http://127.0.0.1:18100",
			token: "t",
			projectId: PROJECT,
		});
		expect(entry.observation).toMatchObject({ status: "unavailable", reason: "no_decided_submissions_in_window" });
		expect(entry.observation).not.toHaveProperty("value");
	});

	it("fails on malformed submissions, unknown states and unreachable APIs", async () => {
		for (const [pages, reason] of [
			[["{bad"], /^malformed_json:/],
			[
				[{ items: [submission("approved", "2026-11-20T00:00:00Z")], next_cursor: null }],
				/^unknown_submission_status$/,
			],
			[[{ items: [submission("accepted", null)], next_cursor: null }], /^decided_submission_without_decision_time$/],
			[
				[
					{
						items: [{ ...submission("accepted", "2026-11-20T00:00:00Z"), project_id: "other" }],
						next_cursor: null,
					},
				],
				/^submission_outside_declared_project$/,
			],
			[[{ items: [] }], /^malformed_submission_cursor$/],
		] as const) {
			const { fetch } = api(pages);
			const [entry] = await collectWorkStreamAcceptance({
				fetch,
				baseUrl: "http://127.0.0.1:18100",
				token: "t",
				projectId: PROJECT,
				now: () => NOW,
			});
			expect(entry.observation.status).toBe("failed");
			expect(entry.observation.reason).toMatch(reason);
			expect(entry.observation).not.toHaveProperty("value");
		}
		const down: ReadOnlyFetch = async () => {
			throw new Error("connect ECONNREFUSED");
		};
		const [entry] = await collectWorkStreamAcceptance({
			fetch: down,
			baseUrl: "http://127.0.0.1:18100",
			token: "t",
			projectId: PROJECT,
		});
		expect(entry.observation).toMatchObject({ status: "failed" });
		expect(entry.observation.reason).toMatch(/ECONNREFUSED/);
	});

	it("refuses a non-loopback API before any request", async () => {
		const { fetch, calls } = api([]);
		for (const baseUrl of [
			"https://workstream.example",
			"http://10.0.0.1:18100",
			"http://127.0.0.1:18100/api",
			"http://u:p@127.0.0.1:1",
		])
			await expect(collectWorkStreamAcceptance({ fetch, baseUrl, token: "t", projectId: PROJECT })).rejects.toThrow(
				"loopback",
			);
		expect(calls).toHaveLength(0);
	});
});

describe("collection record and gate", () => {
	it("lists every registered metric and marks each one without a collector unsupported", async () => {
		const { source } = fixtures(pullFixtures([run("Verify", "success", 1), run("PR contract", "success", 2)]));
		const collected = await collectPullRequestChecks({ source, repository: REPO, pullRequest: 7, now: () => NOW });
		const collection = assembleCollection({ product: "garden", repository: REPO, collected, now: () => NOW });
		expect(collection.metrics.map((entry) => entry.observation.metricId)).toEqual(
			METRIC_REGISTRY.map((metric) => metric.id),
		);
		const unsupported = collection.metrics.filter((entry) => entry.observation.status === "unsupported");
		expect(unsupported).toHaveLength(METRIC_REGISTRY.length - 2);
		for (const entry of unsupported) expect(entry.observation).not.toHaveProperty("value");
		expect(
			collection.metrics.find((entry) => entry.observation.metricId === "behavior.task_acceptance")?.observation
				.reason,
		).toBe("collector_not_configured_for_this_run");
		expect(collection.metrics.find((entry) => entry.observation.metricId === "web.lcp")?.observation.reason).toBe(
			"no_installed_collector",
		);
		expect(Object.values(INSTALLED_COLLECTORS).flat()).toHaveLength(4);
		expect(() =>
			assembleCollection({ product: "garden", repository: REPO, collected: [...collected, collected[0]] }),
		).toThrow("Repeated");
	});

	it("passes only observed metrics inside their limits and fails every other status", async () => {
		const passing = fixtures(pullFixtures([run("Verify", "success", 1), run("PR contract", "success", 2)]));
		const pending = fixtures(pullFixtures([run("Verify", null, 1, "queued"), run("PR contract", "success", 2)]));
		const failing = fixtures(pullFixtures([run("Verify", "failure", 1), run("PR contract", "success", 2)]));
		const gate = async (source: ReadOnlySource) =>
			collectionGate(
				assembleCollection({
					product: "garden",
					repository: REPO,
					collected: await collectPullRequestChecks({ source, repository: REPO, pullRequest: 7 }),
				}),
				[
					{ metricId: "tests.required_scenario_coverage", threshold: 1 },
					{ metricId: "tests.skipped", threshold: 0 },
				],
			);
		expect(await gate(passing.source)).toEqual({ passed: true, reasons: [] });
		expect(await gate(pending.source)).toEqual({
			passed: false,
			reasons: [
				"metric_not_observed:tests.required_scenario_coverage:inconclusive",
				"metric_not_observed:tests.skipped:inconclusive",
			],
		});
		expect(await gate(failing.source)).toEqual({
			passed: false,
			reasons: ["metric_outside_limit:tests.required_scenario_coverage"],
		});
		const empty = assembleCollection({ product: "workstream", repository: REPO, collected: [] });
		expect(collectionGate(empty, [{ metricId: "behavior.task_acceptance", threshold: 0 }])).toEqual({
			passed: false,
			reasons: ["metric_not_observed:behavior.task_acceptance:unsupported"],
		});
		expect(() => collectionGate(empty, [])).toThrow();
		expect(() => collectionGate(empty, [{ metricId: "invented.metric", threshold: 0 }])).toThrow("Unknown metric");
	});
});

describe("engineering collect command", () => {
	it("writes a new owner-only record through GET-only gh reads", async () => {
		const root = mkdtempSync(join(tmpdir(), "collect-"));
		const output = join(root, "collection.json");
		const responses = pullFixtures([run("Verify", "success", 1), run("PR contract", "success", 2)]);
		const calls: string[][] = [];
		const work: WorkDeps = {
			platform: "darwin",
			stateRoot: "/state",
			managedSettingsPaths: [],
			now: () => NOW,
			sleep: async () => {},
			uuid: () => "00000000-0000-4000-8000-000000000000",
			log: () => {},
			notify: async () => {},
			run: async (argv) => {
				calls.push([...argv]);
				const body = responses[argv.at(-1) as keyof typeof responses];
				return body === undefined
					? { exitCode: 1, stdout: "", stderr: "not found" }
					: { exitCode: 0, stdout: JSON.stringify(body), stderr: "" };
			},
		};
		const printed = vi.spyOn(console, "log").mockImplementation(() => {});
		const command = (args: string[]) =>
			Effect.runPromise(
				Command.runWith(
					makeEngineeringCommand(
						() => "/unused.sqlite",
						() => NOW,
						() => work,
					),
					{ version: "test" },
				)(args).pipe(Effect.provide(NodeServices.layer)),
			);
		await command(["collect", "--product", "garden", "--pull-request", "7", "--output", output]);
		const summary = JSON.parse(String(printed.mock.calls.at(-1)?.[0]));
		expect(summary).toMatchObject({ repository: REPO, unsupported: METRIC_REGISTRY.length - 2 });
		expect(summary.collected).toEqual([
			{ metricId: "tests.required_scenario_coverage", status: "observed", value: 1 },
			{ metricId: "tests.skipped", status: "observed", value: 0 },
		]);
		expect(JSON.parse(readFileSync(output, "utf8")).metrics).toHaveLength(METRIC_REGISTRY.length);
		expect(statSync(output).mode & 0o777).toBe(0o600);
		expect(calls.every((argv) => argv[0] === "gh" && argv[1] === "api")).toBe(true);
		await expect(command(["collect", "--product", "garden", "--output", output])).rejects.toThrow();
		printed.mockRestore();
		rmSync(root, { recursive: true, force: true });
	});
});
