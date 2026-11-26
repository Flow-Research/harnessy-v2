import { createHash } from "node:crypto";
import * as Result from "effect/Result";
import type { Run } from "../work/run.ts";
import { METRIC_REGISTRY, type MeasurementStatus, type MetricObservation, observation } from "./metrics.ts";

/**
 * Collectors turn read-only observations of Garden and WorkStream work into
 * registered metric values. A collector never invents a value: missing,
 * malformed, pending or incomplete input gives a non-observed status with a
 * reason, and `collectionGate` treats every non-observed metric as failing.
 */
export const COLLECTION_SCHEMA = "harnessy.engineering.collection.v1";
export type CollectedProduct = "garden" | "workstream";

export const PRODUCT_REPOSITORIES: Readonly<Record<CollectedProduct, string>> = Object.freeze({
	garden: "Flow-Research/garden",
	workstream: "Flow-Research/workstream",
});

/** Each installed collector and the registered metrics it can observe. */
export const INSTALLED_COLLECTORS = Object.freeze({
	"github.pull-request-required-checks.v1": Object.freeze(["tests.required_scenario_coverage", "tests.skipped"]),
	"github.reopened-defects.v1": Object.freeze(["defects.reopened"]),
	"workstream.submission-outcomes.v1": Object.freeze(["behavior.task_acceptance"]),
} as const);
export type CollectorId = keyof typeof INSTALLED_COLLECTORS;

export interface CollectionRequest {
	/** The exact read path or URL. Credentials are never recorded. */
	readonly request: string;
	/** SHA-256 of the exact response bytes. */
	readonly digest: string;
}

export interface CollectionProvenance {
	readonly collector: CollectorId | "none";
	readonly source: string;
	readonly subject: Readonly<Record<string, string | number | boolean | ReadonlyArray<unknown>>>;
	readonly requests: ReadonlyArray<CollectionRequest>;
	readonly observedAt: string;
	readonly limits: ReadonlyArray<string>;
}

export interface CollectedObservation {
	readonly observation: MetricObservation;
	readonly provenance: CollectionProvenance;
}

/** A read-only source of response bytes. A failure carries a reason and no data. */
export type ReadOnlySource = (
	request: string,
) => Promise<{ readonly ok: true; readonly body: string } | { readonly ok: false; readonly reason: string }>;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_PATH = /^(repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/|search\/issues\?)[A-Za-z0-9_.~%/?&=+:-]*$/;
const MAXIMUM_PAGES = 10;
const MAXIMUM_DEFECT_CANDIDATES = 300;

class CollectionFailure extends Error {
	readonly status: Exclude<MeasurementStatus, "observed">;
	constructor(status: Exclude<MeasurementStatus, "observed">, reason: string) {
		super(reason);
		this.status = status;
	}
}

const fail = (reason: string): never => {
	throw new CollectionFailure("failed", reason);
};

type Json = Readonly<Record<string, unknown>>;
const record = (value: unknown, reason: string): Json =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : fail(reason);
const list = (value: unknown, reason: string): ReadonlyArray<unknown> => (Array.isArray(value) ? value : fail(reason));
const text = (value: unknown, reason: string): string =>
	typeof value === "string" && value !== "" ? value : fail(reason);
const integer = (value: unknown, reason: string): number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(reason);
const time = (value: unknown, reason: string): number => {
	const parsed = Date.parse(text(value, reason));
	return Number.isFinite(parsed) ? parsed : fail(reason);
};

/** Read one response and record its digest. A transport failure fails the collection. */
async function readJson(source: ReadOnlySource, request: string, requests: CollectionRequest[]): Promise<unknown> {
	const response = await source(request).catch((cause: unknown) => ({
		ok: false as const,
		reason: cause instanceof Error ? cause.message : "read failed",
	}));
	if (!response.ok) return fail(`read_failed:${request}:${response.reason.slice(0, 200)}`);
	requests.push({ request, digest: sha(response.body) });
	return Result.match(
		Result.try(() => JSON.parse(response.body) as unknown),
		{ onFailure: () => fail(`malformed_json:${request}`), onSuccess: (value) => value },
	);
}

function settle(
	metricIds: ReadonlyArray<string>,
	provenance: (requests: ReadonlyArray<CollectionRequest>) => CollectionProvenance,
	requests: CollectionRequest[],
	cause: unknown,
): ReadonlyArray<CollectedObservation> {
	const status = cause instanceof CollectionFailure ? cause.status : "failed";
	const reason = cause instanceof Error ? cause.message : "collector_failed";
	return metricIds.map((id) => ({
		observation: observation(id, status, { reason }),
		provenance: provenance([...requests]),
	}));
}

/**
 * Read GitHub through `gh api` with GET only. The argv never carries a method,
 * a field, or a request body, so this source cannot write.
 */
export function githubReadOnlySource(run: Run, timeoutMs = 30000): ReadOnlySource {
	return async (path) => {
		if (!GITHUB_PATH.test(path) || path.includes("..")) return { ok: false, reason: "refused_github_path" };
		const result = await run(
			["gh", "api", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", path],
			{ timeoutMs },
		);
		if (result.exitCode !== 0 || result.timedOut === true)
			return { ok: false, reason: result.timedOut === true ? "timed_out" : `gh_exit_${result.exitCode ?? "none"}` };
		return { ok: true, body: result.stdout };
	};
}

type CheckState = "passed" | "failed" | "skipped" | "pending" | "missing";

/**
 * Required checks are the union of the base branch protection and the branch
 * rulesets. A check passes only with conclusion `success` on the exact head.
 * GitHub admits `skipped` and `neutral` for merge, but they are not executed
 * passing evidence here.
 */
export async function collectPullRequestChecks(input: {
	readonly source: ReadOnlySource;
	readonly repository: string;
	readonly pullRequest: number;
	/**
	 * The declared base branch. When it is given, a pull request with another
	 * base fails, so the required checks are always those of this branch.
	 */
	readonly expectedBase?: string;
	readonly now?: () => number;
}): Promise<ReadonlyArray<CollectedObservation>> {
	if (!REPOSITORY.test(input.repository)) throw new Error("Repository must be OWNER/NAME");
	if (!Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1)
		throw new Error("Invalid pull request number");
	if (input.expectedBase !== undefined && !/^[A-Za-z0-9._/-]{1,100}$/.test(input.expectedBase))
		throw new Error("Invalid expected base branch");
	const now = input.now ?? Date.now;
	const metrics = INSTALLED_COLLECTORS["github.pull-request-required-checks.v1"];
	const requests: CollectionRequest[] = [];
	const subject: Record<string, string | number | boolean | ReadonlyArray<unknown>> = {
		repository: input.repository,
		pullRequest: input.pullRequest,
	};
	const provenance = (seen: ReadonlyArray<CollectionRequest>): CollectionProvenance => ({
		collector: "github.pull-request-required-checks.v1",
		source: "GitHub REST API through gh, GET only",
		subject: { ...subject },
		requests: seen,
		observedAt: new Date(now()).toISOString(),
		limits: [
			"Required checks are the current base branch protection and rulesets, not the rules at the time of each run.",
			"A required check passes only with conclusion success on the exact pull request head.",
		],
	});
	return Promise.resolve()
		.then(async (): Promise<ReadonlyArray<CollectedObservation>> => {
			const repo = `repos/${input.repository}`;
			const pull = record(
				await readJson(input.source, `${repo}/pulls/${input.pullRequest}`, requests),
				"malformed_pull",
			);
			const head = text(record(pull.head, "malformed_pull_head").sha, "malformed_pull_head");
			const base = text(record(pull.base, "malformed_pull_base").ref, "malformed_pull_base");
			if (!/^[a-f0-9]{40}$/.test(head)) fail("malformed_pull_head");
			if (input.expectedBase !== undefined && base !== input.expectedBase)
				fail("pull_request_base_is_not_the_declared_base");
			Object.assign(subject, { headSha: head, baseRef: base, state: text(pull.state, "malformed_pull_state") });
			const branch = record(
				await readJson(input.source, `${repo}/branches/${encodeURIComponent(base)}`, requests),
				"malformed_branch",
			);
			const required = new Map<string, { readonly context: string; readonly appId?: number }>();
			const add = (context: unknown, appId: unknown) => {
				const name = text(context, "malformed_required_check");
				const app = typeof appId === "number" && Number.isSafeInteger(appId) && appId > 0 ? appId : undefined;
				required.set(`${name}\0${app ?? "any"}`, { context: name, ...(app === undefined ? {} : { appId: app }) });
			};
			const protection =
				branch.protection === undefined ? undefined : record(branch.protection, "malformed_protection");
			const status =
				protection?.required_status_checks === undefined
					? undefined
					: record(protection.required_status_checks, "malformed_required_checks");
			if (status !== undefined && status.enforcement_level !== "off") {
				const checks = list(status.checks ?? [], "malformed_required_checks");
				for (const check of checks) {
					const entry = record(check, "malformed_required_check");
					add(entry.context, entry.app_id);
				}
				if (checks.length === 0)
					for (const context of list(status.contexts ?? [], "malformed_required_checks")) add(context, undefined);
			}
			const rules = list(
				await readJson(input.source, `${repo}/rules/branches/${encodeURIComponent(base)}`, requests),
				"malformed_rules",
			);
			for (const rule of rules) {
				const value = record(rule, "malformed_rule");
				if (value.type !== "required_status_checks") continue;
				const parameters = record(value.parameters, "malformed_rule_parameters");
				for (const check of list(parameters.required_status_checks, "malformed_rule_parameters")) {
					const entry = record(check, "malformed_rule_check");
					add(entry.context, entry.integration_id);
				}
			}
			if (required.size === 0)
				throw new CollectionFailure("unsupported", `base_branch_declares_no_required_checks:${base}`);
			const runs: Json[] = [];
			let total: number | undefined;
			for (let page = 1; total === undefined || runs.length < total; page++) {
				if (page > MAXIMUM_PAGES) throw new CollectionFailure("inconclusive", "check_run_page_limit_reached");
				const body = record(
					await readJson(input.source, `${repo}/commits/${head}/check-runs?per_page=100&page=${page}`, requests),
					"malformed_check_runs",
				);
				const count = integer(body.total_count, "malformed_check_runs");
				if (total !== undefined && count !== total) fail("check_run_total_changed_during_collection");
				total = count;
				const pageRuns = list(body.check_runs, "malformed_check_runs");
				if (pageRuns.length === 0 && runs.length < total) fail("check_run_pages_incomplete");
				for (const item of pageRuns) runs.push(record(item, "malformed_check_run"));
			}
			if (runs.length !== total) fail("check_run_pages_incomplete");
			const combined = record(
				await readJson(input.source, `${repo}/commits/${head}/status?per_page=100`, requests),
				"malformed_status",
			);
			const statuses = list(combined.statuses, "malformed_status").map((item) => record(item, "malformed_status"));
			if (integer(combined.total_count, "malformed_status") !== statuses.length) fail("status_pages_incomplete");
			const states = [...required.values()].map((check) => {
				const matching = runs.filter(
					(item) =>
						item.name === check.context &&
						(check.appId === undefined || record(item.app, "malformed_check_run_app").id === check.appId),
				);
				const latest = matching.reduce<Json | undefined>(
					(best, item) =>
						best === undefined ||
						integer(item.id, "malformed_check_run_id") > integer(best.id, "malformed_check_run_id")
							? item
							: best,
					undefined,
				);
				let state: CheckState = "missing";
				if (latest !== undefined) {
					const conclusion = latest.conclusion;
					if (latest.status !== "completed") state = "pending";
					else if (conclusion === "success") state = "passed";
					else if (conclusion === "skipped") state = "skipped";
					else if (typeof conclusion === "string") state = "failed";
					else fail("malformed_check_run_conclusion");
				} else if (check.appId === undefined) {
					const legacy = statuses.find((item) => item.context === check.context);
					if (legacy !== undefined)
						state =
							legacy.state === "success"
								? "passed"
								: legacy.state === "pending"
									? "pending"
									: typeof legacy.state === "string"
										? "failed"
										: fail("malformed_status_state");
				}
				return { context: check.context, appId: check.appId ?? "any", state };
			});
			subject.requiredChecks = states;
			const after = record(
				await readJson(input.source, `${repo}/pulls/${input.pullRequest}`, requests),
				"malformed_pull",
			);
			if (record(after.head, "malformed_pull_head").sha !== head)
				throw new CollectionFailure("inconclusive", "pull_request_head_changed_during_collection");
			if (record(after.base, "malformed_pull_base").ref !== base)
				fail("pull_request_base_changed_during_collection");
			if (states.some((check) => check.state === "pending"))
				throw new CollectionFailure("inconclusive", "required_checks_pending_on_exact_head");
			const passed = states.filter((check) => check.state === "passed").length;
			const notExecuted = states.filter((check) => check.state === "skipped" || check.state === "missing").length;
			return [
				{
					observation: observation(metrics[0], "observed", {
						value: passed / states.length,
						sampleCount: states.length,
						denominator: states.length,
					}),
					provenance: provenance([...requests]),
				},
				{
					observation: observation(metrics[1], "observed", { value: notExecuted, sampleCount: states.length }),
					provenance: provenance([...requests]),
				},
			];
		})
		.catch((cause: unknown) => settle(metrics, provenance, requests, cause));
}

/**
 * Count distinct issues with the declared defect label that GitHub records as
 * reopened inside the window. The label must exist, so a missing label cannot
 * produce a silent zero. Incomplete search results are inconclusive.
 */
function observationWindow(days: number, clock: () => number, name: string) {
	if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw new Error(`${name} window must be 1 to 90 days`);
	const now = clock();
	return { now, since: now - days * 86_400_000 };
}

export async function collectReopenedDefects(input: {
	readonly source: ReadOnlySource;
	readonly repository: string;
	readonly label: string;
	readonly windowDays?: number;
	readonly now?: () => number;
}): Promise<ReadonlyArray<CollectedObservation>> {
	if (!REPOSITORY.test(input.repository)) throw new Error("Repository must be OWNER/NAME");
	if (!/^[A-Za-z0-9 _.:/-]{1,50}$/.test(input.label)) throw new Error("Invalid defect label");
	const { now, since } = observationWindow(input.windowDays ?? 30, input.now ?? Date.now, "Defect");
	const metrics = INSTALLED_COLLECTORS["github.reopened-defects.v1"];
	const requests: CollectionRequest[] = [];
	const subject: Record<string, string | number | boolean | ReadonlyArray<unknown>> = {
		repository: input.repository,
		defectLabel: input.label,
		windowStart: new Date(since).toISOString(),
		windowEnd: new Date(now).toISOString(),
	};
	const provenance = (seen: ReadonlyArray<CollectionRequest>): CollectionProvenance => ({
		collector: "github.reopened-defects.v1",
		source: "GitHub REST issue search and issue events through gh, GET only",
		subject: { ...subject },
		requests: seen,
		observedAt: new Date(now).toISOString(),
		limits: [
			"Defects are issues that carry the declared label now. Severity is not mapped.",
			"Pull requests are excluded. Defects tracked outside GitHub issues are not counted.",
		],
	});
	return Promise.resolve()
		.then(async (): Promise<ReadonlyArray<CollectedObservation>> => {
			const repo = `repos/${input.repository}`;
			const label = record(
				await readJson(input.source, `${repo}/labels/${encodeURIComponent(input.label)}`, requests),
				"malformed_label",
			);
			if (label.name !== input.label) fail("declared_defect_label_differs");
			const query = new URLSearchParams({
				q: `repo:${input.repository} is:issue label:"${input.label}" updated:>=${new Date(since).toISOString().slice(0, 19)}Z`,
				per_page: "100",
			});
			const issues: number[] = [];
			let total: number | undefined;
			for (let page = 1; total === undefined || issues.length < total; page++) {
				if (page > MAXIMUM_PAGES) throw new CollectionFailure("inconclusive", "defect_search_page_limit_reached");
				const body = record(
					await readJson(input.source, `search/issues?${query.toString()}&page=${page}`, requests),
					"malformed_search",
				);
				if (body.incomplete_results !== false)
					throw new CollectionFailure("inconclusive", "search_results_incomplete");
				const count = integer(body.total_count, "malformed_search");
				if (count > MAXIMUM_DEFECT_CANDIDATES)
					throw new CollectionFailure("inconclusive", `defect_candidates_exceed_${MAXIMUM_DEFECT_CANDIDATES}`);
				if (total !== undefined && count !== total) fail("search_total_changed_during_collection");
				total = count;
				const items = list(body.items, "malformed_search");
				if (items.length === 0 && issues.length < total) fail("search_pages_incomplete");
				for (const item of items) {
					const issue = record(item, "malformed_search_item");
					if (issue.pull_request !== undefined) fail("search_returned_pull_request");
					issues.push(integer(issue.number, "malformed_search_item"));
				}
			}
			let events = 0;
			const reopened: number[] = [];
			for (const issue of issues) {
				let found = false;
				for (let page = 1; ; page++) {
					if (page > MAXIMUM_PAGES) throw new CollectionFailure("inconclusive", `issue_event_page_limit:${issue}`);
					const items = list(
						await readJson(input.source, `${repo}/issues/${issue}/events?per_page=100&page=${page}`, requests),
						"malformed_issue_events",
					);
					for (const item of items) {
						const event = record(item, "malformed_issue_event");
						if (event.event !== "reopened") continue;
						const at = time(event.created_at, "malformed_issue_event_time");
						if (at >= since && at <= now) {
							events++;
							found = true;
						}
					}
					if (items.length < 100) break;
				}
				if (found) reopened.push(issue);
			}
			Object.assign(subject, { candidateIssues: issues.length, reopenEvents: events, reopenedIssues: reopened });
			return [
				{
					// One complete window. The candidate count is in the subject.
					observation: observation(metrics[0], "observed", { value: reopened.length, sampleCount: 1 }),
					provenance: provenance([...requests]),
				},
			];
		})
		.catch((cause: unknown) => settle(metrics, provenance, requests, cause));
}

export type ReadOnlyFetch = (
	url: string,
	init: { readonly method: "GET"; readonly headers: Readonly<Record<string, string>>; readonly redirect: "error" },
) => Promise<{ readonly status: number; readonly text: () => Promise<string> }>;

const SUBMISSION_STATUSES = new Set(["evaluation_pending", "review_pending", "accepted", "needs_revision", "rejected"]);
const DECIDED = new Set(["accepted", "needs_revision", "rejected"]);

/**
 * Read the caller's own WorkStream submissions in one project from a loopback
 * API with GET only. The value is accepted submissions divided by decided
 * submissions whose decision falls inside the window.
 */
export async function collectWorkStreamAcceptance(input: {
	readonly fetch: ReadOnlyFetch;
	readonly baseUrl: string;
	readonly token?: string;
	readonly projectId?: string;
	readonly windowDays?: number;
	readonly now?: () => number;
}): Promise<ReadonlyArray<CollectedObservation>> {
	const base = new URL(input.baseUrl);
	if (
		base.protocol !== "http:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
		base.username !== "" ||
		base.password !== "" ||
		(base.pathname !== "/" && base.pathname !== "") ||
		base.search !== ""
	)
		throw new Error("The WorkStream collector reads only a loopback http API root");
	const { now, since } = observationWindow(input.windowDays ?? 30, input.now ?? Date.now, "Acceptance");
	const metrics = INSTALLED_COLLECTORS["workstream.submission-outcomes.v1"];
	const requests: CollectionRequest[] = [];
	const subject: Record<string, string | number | boolean | ReadonlyArray<unknown>> = {
		api: base.origin,
		windowStart: new Date(since).toISOString(),
		windowEnd: new Date(now).toISOString(),
	};
	const provenance = (seen: ReadonlyArray<CollectionRequest>): CollectionProvenance => ({
		collector: "workstream.submission-outcomes.v1",
		source: "WorkStream API, GET only",
		subject: { ...subject },
		requests: seen,
		observedAt: new Date(now).toISOString(),
		limits: [
			"Only the caller's own submissions are read.",
			"Submission records carry no policy revision, so one project is the policy scope.",
			"needs_revision counts as a decision that is not acceptance.",
		],
	});
	const source: ReadOnlySource = async (request) => {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (request !== "/api/v1/health" && input.token !== undefined) headers.Authorization = `Bearer ${input.token}`;
		const response = await input.fetch(new URL(request, base).toString(), {
			method: "GET",
			headers,
			redirect: "error",
		});
		if (response.status !== 200) return { ok: false, reason: `http_${response.status}` };
		return { ok: true, body: await response.text() };
	};
	return Promise.resolve()
		.then(async (): Promise<ReadonlyArray<CollectedObservation>> => {
			const health = record(await readJson(source, "/api/v1/health", requests), "malformed_health");
			if (health.status !== "ok") fail("workstream_not_healthy");
			if (input.token === undefined || input.token.trim() === "")
				throw new CollectionFailure("unavailable", "no_workstream_read_credential");
			if (
				input.projectId === undefined ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.projectId)
			)
				throw new CollectionFailure("unavailable", "no_declared_workstream_project");
			subject.projectId = input.projectId;
			let accepted = 0;
			let decided = 0;
			let read = 0;
			let cursor: string | undefined;
			for (let page = 1; ; page++) {
				if (page > MAXIMUM_PAGES * 5) throw new CollectionFailure("inconclusive", "submission_page_limit_reached");
				const query = new URLSearchParams({
					project_id: input.projectId,
					updated_since: new Date(since).toISOString(),
					limit: "100",
					...(cursor === undefined ? {} : { cursor }),
				});
				const body = record(
					await readJson(source, `/api/v1/actors/me/submissions?${query.toString()}`, requests),
					"malformed_submission_page",
				);
				for (const item of list(body.items, "malformed_submission_page")) {
					const submission = record(item, "malformed_submission");
					text(submission.submission_id, "malformed_submission");
					if (submission.project_id !== input.projectId) fail("submission_outside_declared_project");
					const state = text(submission.status, "malformed_submission_status");
					if (!SUBMISSION_STATUSES.has(state)) fail("unknown_submission_status");
					read++;
					if (!DECIDED.has(state)) continue;
					const at = time(submission.decided_at, "decided_submission_without_decision_time");
					if (at < since || at > now) continue;
					decided++;
					if (state === "accepted") accepted++;
				}
				if (body.next_cursor === null) break;
				cursor = text(body.next_cursor, "malformed_submission_cursor");
			}
			Object.assign(subject, { submissionsRead: read, decided, accepted });
			if (decided === 0) throw new CollectionFailure("unavailable", "no_decided_submissions_in_window");
			return [
				{
					observation: observation(metrics[0], "observed", {
						value: accepted / decided,
						sampleCount: decided,
						denominator: decided,
					}),
					provenance: provenance([...requests]),
				},
			];
		})
		.catch((cause: unknown) => settle(metrics, provenance, requests, cause));
}

export interface EngineeringCollection {
	readonly schema: typeof COLLECTION_SCHEMA;
	readonly product: CollectedProduct;
	readonly repository: string;
	readonly collectedAt: string;
	/** One entry for every registered metric, in registry order. */
	readonly metrics: ReadonlyArray<CollectedObservation>;
	readonly notice: string;
}

/**
 * Build one record with an entry for every registered metric. A metric without
 * an installed collector, or one whose collector was not configured, is
 * `unsupported` with a reason and no value.
 */
export function assembleCollection(input: {
	readonly product: CollectedProduct;
	readonly repository: string;
	readonly collected: ReadonlyArray<CollectedObservation>;
	readonly now?: () => number;
}): EngineeringCollection {
	const observedAt = new Date((input.now ?? Date.now)()).toISOString();
	const byId = new Map<string, CollectedObservation>();
	for (const entry of input.collected) {
		if (byId.has(entry.observation.metricId)) throw new Error(`Repeated metric: ${entry.observation.metricId}`);
		byId.set(entry.observation.metricId, entry);
	}
	const installed = new Set<string>(Object.values(INSTALLED_COLLECTORS).flat());
	return Object.freeze({
		schema: COLLECTION_SCHEMA,
		product: input.product,
		repository: input.repository,
		collectedAt: observedAt,
		metrics: Object.freeze(
			METRIC_REGISTRY.map(
				(metric) =>
					byId.get(metric.id) ?? {
						observation: observation(metric.id, "unsupported", {
							reason: installed.has(metric.id)
								? "collector_not_configured_for_this_run"
								: "no_installed_collector",
						}),
						provenance: {
							collector: "none" as const,
							source: "none",
							subject: { product: input.product, repository: input.repository },
							requests: [],
							observedAt,
							limits: [],
						},
					},
			),
		),
		notice:
			"Read-only observation record. It authorizes no task, approval, merge, deployment or WorkStream decision.",
	});
}

export interface CollectionRequirement {
	readonly metricId: string;
	/** Inclusive limit in the metric direction: at least this for `higher`, at most this for `lower`. */
	readonly threshold: number;
}

/** A required metric passes only when it is observed and meets its limit. Every other status fails. */
export function collectionGate(
	collection: EngineeringCollection,
	requirements: ReadonlyArray<CollectionRequirement>,
): { readonly passed: boolean; readonly reasons: ReadonlyArray<string> } {
	if (requirements.length === 0) throw new Error("A collection gate needs at least one required metric");
	const reasons: string[] = [];
	for (const requirement of requirements) {
		const definition = METRIC_REGISTRY.find((metric) => metric.id === requirement.metricId);
		if (definition === undefined) throw new Error(`Unknown metric: ${requirement.metricId}`);
		if (!Number.isFinite(requirement.threshold)) throw new Error("Collection thresholds must be finite");
		const entry = collection.metrics.find((metric) => metric.observation.metricId === requirement.metricId);
		const value = entry?.observation.value;
		if (entry === undefined || entry.observation.status !== "observed" || value === undefined) {
			reasons.push(`metric_not_observed:${requirement.metricId}:${entry?.observation.status ?? "absent"}`);
			continue;
		}
		if (definition.direction === "higher" ? value < requirement.threshold : value > requirement.threshold)
			reasons.push(`metric_outside_limit:${requirement.metricId}`);
	}
	return { passed: reasons.length === 0, reasons };
}
