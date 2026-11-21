import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Run } from "../work/run.ts";

export const METRIC_REGISTRY_VERSION = "harnessy.engineering.metrics.v1";
export type MetricDirection = "lower" | "higher";
export type MeasurementStatus = "observed" | "unavailable" | "unsupported" | "failed" | "inconclusive";
export type MetricDomain =
	| "behavior"
	| "defects"
	| "security"
	| "structure"
	| "size"
	| "tests"
	| "server"
	| "cpu"
	| "memory"
	| "data"
	| "web"
	| "native"
	| "recovery"
	| "agent"
	| "delivery"
	| "cost";

export interface MetricDefinition {
	readonly id: string;
	readonly domain: MetricDomain;
	readonly definition: string;
	readonly unit: string;
	readonly direction: MetricDirection;
	readonly workload: string;
	readonly source: string;
	readonly owner: "Harnessy" | "Garden" | "WorkStream" | "GitHub";
	readonly environment: string;
	readonly collectionWindow: string;
	readonly acceptanceRule: string;
}

export interface MetricObservation {
	readonly registryVersion: typeof METRIC_REGISTRY_VERSION;
	readonly metricId: string;
	readonly status: MeasurementStatus;
	readonly value?: number;
	readonly sampleCount: number;
	readonly denominator?: number;
	readonly reason?: string;
}

type DefinitionRow = readonly [string, string, MetricDirection, string];

interface DomainDefinition {
	readonly domain: MetricDomain;
	readonly owner: MetricDefinition["owner"];
	readonly source: string;
	readonly workload: string;
	readonly environment: string;
	readonly window: string;
	readonly rule: string;
	readonly metrics: ReadonlyArray<DefinitionRow>;
}

const DOMAINS: ReadonlyArray<DomainDefinition> = [
	{
		domain: "behavior",
		owner: "WorkStream",
		source: "Protected scenario evaluator and WorkStream decision receipts",
		workload: "Fixed critical journeys and task policy revision",
		environment: "Disposable service fixture with declared actor/workspace",
		window: "Every candidate revision",
		rule: "Every required scenario passes with exact useful output. Owner receipts establish acceptance.",
		metrics: [
			["critical_journeys_passed", "ratio", "higher", "Passed required journeys divided by all required journeys"],
			["contract_failures", "count", "lower", "Failed declared cross-product contract scenarios"],
			[
				"task_acceptance",
				"ratio",
				"higher",
				"Accepted submissions divided by decided submissions under the same policy",
			],
			[
				"output_correctness",
				"ratio",
				"higher",
				"Outputs matching protected semantic expectations divided by expected outputs",
			],
			[
				"authorization_failures",
				"count",
				"lower",
				"Unexpected grants or denials in protected authorization scenarios",
			],
		],
	},
	{
		domain: "defects",
		owner: "WorkStream",
		source: "Linked reproduced defects, release revisions, and issue history",
		workload: "Declared release cohort and severity mapping",
		environment: "Owner issue records with source and release identity",
		window: "Per release and rolling 30 real days",
		rule: "Do not infer unknown defects from detector silence. Compare equal release exposure.",
		metrics: [
			[
				"reproduced_fixes",
				"count",
				"higher",
				"Defects with a failing reproduction before and passing reproduction after the fix",
			],
			["reopened", "count", "lower", "Previously closed defects reopened during the collection window"],
			["escaped", "count", "lower", "Confirmed defects first found after release, grouped by severity"],
			["reproduction_time", "seconds", "lower", "Time from defect report to a saved repeatable reproduction"],
			["repair_time", "seconds", "lower", "Time from defect report to independently verified repair"],
		],
	},
	{
		domain: "security",
		owner: "Harnessy",
		source: "Pinned existing security checks, secret/dependency scanners, and authority fixtures",
		workload: "Same tracked source, dependency graph, exclusions, and advisory snapshot",
		environment: "Networkless evaluator plus pinned advisory input",
		window: "Every revision and advisory snapshot",
		rule: "Required security and privacy failures veto improvement. Missing reports cannot pass.",
		metrics: [
			["findings", "count", "lower", "Confirmed scanner findings grouped by severity and detector version"],
			["exposed_secrets", "count", "lower", "Confirmed credential exposures in the declared scanned source"],
			[
				"vulnerable_dependencies",
				"count",
				"lower",
				"Reachable vulnerable dependency versions under the pinned advisory snapshot",
			],
			[
				"tenant_separation_failures",
				"count",
				"lower",
				"Cross-account or cross-workspace data and effect escapes in required scenarios",
			],
			["unsafe_grants", "count", "lower", "Operations admitted outside their current approved authority"],
			[
				"finding_age",
				"seconds",
				"lower",
				"Time since each unresolved confirmed security finding was first recorded",
			],
		],
	},
	{
		domain: "structure",
		owner: "Harnessy",
		source: "Pinned language-aware static analyzer",
		workload: "Whole maintained modules including moved decisions and fixed exclusions",
		environment: "Pinned parser and tracked source snapshot",
		window: "Each source revision",
		rule: "Compare whole modules and preserved behavior. Moved branches cannot establish a reduction.",
		metrics: [
			[
				"cyclomatic_complexity",
				"decision_points",
				"lower",
				"Independent control-flow paths per function with declared aggregation",
			],
			["module_decisions", "decision_points", "lower", "Decision points summed across the full maintained module"],
			["nesting_depth", "levels", "lower", "Maximum nested control-flow depth per function"],
			["function_size", "source_lines", "lower", "Maintained source lines per function with declared percentile"],
			["dependency_cycles", "count", "lower", "Strongly connected dependency components containing a cycle"],
			["public_interface_growth", "symbols", "lower", "Added public symbols relative to the approved baseline"],
		],
	},
	{
		domain: "size",
		owner: "Harnessy",
		source: "Pinned source/dependency/bundle analyzers",
		workload: "Same product behavior and fixed source/generated boundaries",
		environment: "Exact source and built artifact digests",
		window: "Each revision and reproducible build",
		rule: "Required behavior is a veto. Reclassification, generated code, or hidden work cannot establish improvement.",
		metrics: [
			[
				"maintained_lines",
				"source_lines",
				"lower",
				"Maintained non-generated source lines under fixed inclusion rules",
			],
			["duplication", "ratio", "lower", "Duplicated maintained source lines divided by maintained source lines"],
			[
				"unused_code",
				"symbols",
				"lower",
				"Unreachable symbols reported by a pinned analyzer with fixed entrypoints",
			],
			[
				"unused_dependencies",
				"packages",
				"lower",
				"Declared dependencies unused by fixed application and tool entrypoints",
			],
			[
				"generated_share",
				"ratio",
				"lower",
				"Generated source lines divided by all source lines under fixed classifications",
			],
			["bundle_size", "bytes", "lower", "Bytes of the same declared compressed or uncompressed artifact"],
		],
	},
	{
		domain: "tests",
		owner: "Harnessy",
		source: "Existing repository tests, scenario catalog, coverage and targeted mutation reports",
		workload: "Frozen required scenarios and changed branches",
		environment: "Pinned toolchain, fixture, and coverage mapping",
		window: "Each candidate and declared repeated-run window",
		rule: "Required skips and missing scenarios fail. Coverage percentages cannot replace critical behavior.",
		metrics: [
			[
				"required_scenario_coverage",
				"ratio",
				"higher",
				"Required scenarios with executed passing evidence divided by required scenarios",
			],
			[
				"changed_branch_coverage",
				"ratio",
				"higher",
				"Executed changed branches divided by instrumented changed branches",
			],
			["skipped", "count", "lower", "Declared scenarios that did not execute, with required status retained"],
			[
				"flaky_outcomes",
				"ratio",
				"lower",
				"Cases with differing outcomes on unchanged input divided by repeated cases",
			],
			[
				"mutation_kill_rate",
				"ratio",
				"higher",
				"Killed non-equivalent mutants divided by executed non-equivalent mutants",
			],
			["runtime", "milliseconds", "lower", "Wall time of the fixed required test workload"],
		],
	},
	{
		domain: "server",
		owner: "Harnessy",
		source: "Pinned local workload driver and existing OpenTelemetry request signals",
		workload: "Fixed authorized requests, output checks, concurrency, warmup, and synthetic dataset",
		environment: "Disposable service with pinned runtime and host capacity",
		window: "Ten alternating baseline/candidate pairs",
		rule: "At least 5 percent primary improvement with supported interval. Required errors veto improvement.",
		metrics: [
			[
				"request_latency",
				"milliseconds",
				"lower",
				"Per-request wall latency with declared p50, p95, and p99 aggregation",
			],
			[
				"useful_throughput",
				"operations_per_second",
				"higher",
				"Correct completed operations divided by elapsed seconds",
			],
			["errors", "count", "lower", "Failed required requests under the fixed workload"],
			["timeouts", "count", "lower", "Requests exceeding the declared fixed deadline"],
			[
				"concurrency",
				"operations",
				"higher",
				"Concurrent correct operations at the declared latency and error limits",
			],
			["queue_delay", "milliseconds", "lower", "Elapsed time between admission and actual execution start"],
		],
	},
	{
		domain: "cpu",
		owner: "Harnessy",
		source: "Declared platform process profiler and event-loop instrumentation",
		workload: "Fixed useful operation count and repeated idle window",
		environment: "Pinned host, power state, and uncontended runtime",
		window: "Ten alternating pairs plus declared idle duration",
		rule: "Missing profiler data is unavailable. Faster incomplete work fails correctness.",
		metrics: [
			[
				"time_per_operation",
				"cpu_microseconds_per_operation",
				"lower",
				"User plus system CPU time divided by correct completed operations",
			],
			["idle_use", "cpu_ratio", "lower", "CPU time divided by wall time in a declared idle window"],
			["sustained_use", "cpu_ratio", "lower", "CPU time divided by wall time under fixed sustained useful load"],
			[
				"event_loop_stalls",
				"milliseconds",
				"lower",
				"Event-loop scheduling delay with declared percentile and sampling overhead",
			],
		],
	},
	{
		domain: "memory",
		owner: "Harnessy",
		source: "Declared platform process and heap profiler",
		workload: "Fixed startup, useful load, repeated operations, and retained-idle windows",
		environment: "Pinned runtime, GC configuration, and process tree scope",
		window: "Ten alternating pairs and declared soak duration",
		rule: "Compare the same memory definition and process scope. Unsupported platforms remain unsupported.",
		metrics: [
			["peak_resident", "bytes", "lower", "Maximum resident process-tree memory over the declared workload"],
			["retained", "bytes", "lower", "Resident or heap bytes after the same declared idle and GC procedure"],
			[
				"allocation_rate",
				"bytes_per_second",
				"lower",
				"Allocated bytes divided by measured useful workload seconds",
			],
			[
				"repeated_work_growth",
				"bytes_per_operation",
				"lower",
				"Retained-memory slope over repeated correct operations",
			],
			["terminations", "count", "lower", "Memory-limit or out-of-memory terminations in the collection window"],
		],
	},
	{
		domain: "data",
		owner: "WorkStream",
		source: "Existing OpenTelemetry database signals and disposable datastore instrumentation",
		workload: "Same authorized read/submission workload and fixed synthetic records",
		environment: "Disposable database/cache with declared cold or warm state",
		window: "Per useful operation and ten alternating pairs",
		rule: "Count useful correct outputs and preserve transaction/tenant semantics.",
		metrics: [
			["query_count", "queries_per_operation", "lower", "Database queries divided by correct useful operations"],
			["query_duration", "milliseconds", "lower", "Query latency distribution under the fixed workload"],
			["connections", "count", "lower", "Peak active connections at fixed useful throughput"],
			["disk_writes", "bytes_per_operation", "lower", "Disk bytes written divided by correct useful operations"],
			["cache_miss_rate", "ratio", "lower", "Cache misses divided by cache lookups under declared cache state"],
			["duplicate_writes", "count", "lower", "Duplicate effects for the same stable operation identity"],
			[
				"network_bytes",
				"bytes_per_operation",
				"lower",
				"Sent plus received bytes divided by correct useful operations",
			],
			[
				"storage_growth",
				"bytes_per_operation",
				"lower",
				"Retained storage increase divided by correct useful operations",
			],
		],
	},
	{
		domain: "web",
		owner: "Garden",
		source: "Pinned browser workload and browser performance/accessibility APIs",
		workload: "Authenticated task/status journey, fixed viewport, dataset, and network profile",
		environment: "Declared real browser/version and device profile",
		window: "Per navigation and ten alternating pairs",
		rule: "Preserve accessible authorized behavior. Synthetic results do not establish physical-device support.",
		metrics: [
			["lcp", "milliseconds", "lower", "Largest Contentful Paint for the declared navigation"],
			["inp", "milliseconds", "lower", "Interaction to Next Paint for the declared interaction window"],
			["cls", "score", "lower", "Cumulative Layout Shift during the declared lifecycle window"],
			["long_tasks", "milliseconds", "lower", "Main-thread time in tasks above the declared long-task threshold"],
			["navigation", "milliseconds", "lower", "Time from navigation request to the declared usable authorized view"],
			[
				"accessibility_failures",
				"count",
				"lower",
				"Confirmed automated and manual accessibility failures in required journeys",
			],
			[
				"javascript_transfer",
				"bytes",
				"lower",
				"Transferred JavaScript bytes for the same navigation and cache state",
			],
		],
	},
	{
		domain: "native",
		owner: "Garden",
		source: "Platform profilers and physical iOS/Android/macOS/Windows/Linux journey records",
		workload: "Signed application startup, control journey, suspend/death/reconnect, and fixed soak",
		environment: "Named physical device, OS, app artifact, and power state",
		window: "Per device build and declared real observation window",
		rule: "Each claimed target needs actual device evidence. Simulator results cannot qualify device behavior.",
		metrics: [
			[
				"launch_time",
				"milliseconds",
				"lower",
				"Cold or warm launch time to the declared usable authenticated screen",
			],
			["frame_delays", "ratio", "lower", "Frames above the declared frame budget divided by measured frames"],
			["hangs", "count", "lower", "Unresponsive intervals above the platform-specific declared threshold"],
			["crashes", "crashes_per_session", "lower", "Confirmed crashes divided by observed native sessions"],
			[
				"battery",
				"energy_per_operation",
				"lower",
				"Platform-measured energy for the fixed useful operation workload",
			],
			["memory", "bytes", "lower", "Peak native application resident memory under fixed workload"],
			["network", "bytes_per_operation", "lower", "Network bytes divided by correct native journey operations"],
			["install_size", "bytes", "lower", "Installed bytes for the same signed target artifact and architecture"],
			[
				"lifecycle_recovery",
				"ratio",
				"higher",
				"Correct lifecycle recoveries divided by executed lifecycle fault scenarios",
			],
		],
	},
	{
		domain: "recovery",
		owner: "Harnessy",
		source: "Durable controller events and real process/service fault scenarios",
		workload: "Fixed restart, cancellation, disconnect, retry, sleep, and lost-reply scenarios",
		environment: "Declared host adapter, persisted state, and process identity",
		window: "Every control change and seven real pilot days",
		rule: "Duplicate effects, orphan workers, and wrong-process termination veto release.",
		metrics: [
			["restart_success", "ratio", "higher", "Correct resumed runs divided by executed restart scenarios"],
			[
				"cancellation_latency",
				"milliseconds",
				"lower",
				"Time from authorized cancellation receipt to confirmed owned-process termination",
			],
			["orphans", "count", "lower", "Owned execution processes remaining after their declared termination boundary"],
			["duplicate_runs", "count", "lower", "More than one execution for the same stable launch identity"],
			["missing_acknowledgments", "count", "lower", "Effects without a reconciled durable acknowledgment"],
			["stale_status", "milliseconds", "lower", "Age of the last authoritative run event at display time"],
			[
				"reconnect_time",
				"milliseconds",
				"lower",
				"Time from connection recovery to an authorized current snapshot and event cursor",
			],
		],
	},
	{
		domain: "agent",
		owner: "Harnessy",
		source: "Existing skill metrics and independent controller/review receipts",
		workload: "Declared task cohort, locked policies, agent versions, and outcomes",
		environment: "Approved installed agent with verified included allowance",
		window: "Per objective and rolling real pilot window",
		rule: "Worker completion claims never establish independently verified completion.",
		metrics: [
			[
				"first_pass_success",
				"ratio",
				"higher",
				"Independently verified first attempts divided by objectives attempted",
			],
			[
				"verified_completion",
				"ratio",
				"higher",
				"Independently verified outcomes divided by settled execution attempts",
			],
			[
				"invalid_evidence",
				"count",
				"lower",
				"Rejected forged, stale, incomplete, or mismatched evidence submissions",
			],
			[
				"repeated_attempts",
				"attempts_per_objective",
				"lower",
				"Execution attempts divided by distinct objective identities",
			],
			["interventions", "count", "lower", "Required human interventions with reason and affected task revision"],
			[
				"review_corrections",
				"count",
				"lower",
				"Confirmed independent review findings requiring source or evidence changes",
			],
		],
	},
	{
		domain: "delivery",
		owner: "GitHub",
		source: "Exact-head GitHub check/review/merge facts and deployment owner receipts",
		workload: "Declared change cohort with linked task, PR, and release identities",
		environment: "Actual forge and deployed-target records",
		window: "Per change and rolling 30 real days",
		rule: "Keep verified PR, merge, deployment, WorkStream acceptance, and payment as distinct events.",
		metrics: [
			[
				"verified_pr_time",
				"seconds",
				"lower",
				"Time from approved objective admission to independently verified draft PR",
			],
			["review_delay", "seconds", "lower", "Time from review request to the declared eligible review decision"],
			[
				"production_lead_time",
				"seconds",
				"lower",
				"Time from commit to verified deployment on the declared production target",
			],
			[
				"deployment_failure",
				"ratio",
				"lower",
				"Failed deployments divided by observed deployments under the same failure definition",
			],
			["recovery_time", "seconds", "lower", "Time from confirmed deployment failure to verified service recovery"],
			["rework", "ratio", "lower", "Corrective changes divided by delivered changes in the declared cohort"],
		],
	},
	{
		domain: "cost",
		owner: "Harnessy",
		source: "Host resource receipts and provider-owned allowance/billing observations",
		workload: "Same verified or WorkStream-accepted outcomes with declared denominator",
		environment: "Existing enrolled machines and approved included subscription usage",
		window: "Per attempt, rolling 24 hours, and real pilot window",
		rule: "Unknown or exhausted allowance pauses execution. New metered charges are forbidden for this pilot.",
		metrics: [
			["compute_time", "cpu_seconds", "lower", "Measured process-tree CPU time for declared verified outcomes"],
			[
				"model_usage",
				"tokens",
				"lower",
				"Provider-reported model tokens with input/output/cache categories retained",
			],
			[
				"included_allowance",
				"provider_units",
				"higher",
				"Provider-confirmed remaining included usage in its declared reset window",
			],
			[
				"metered_charges",
				"currency_minor_units",
				"lower",
				"Provider-confirmed metered charges in a named currency and collection window",
			],
			[
				"resources_per_outcome",
				"resource_units_per_outcome",
				"lower",
				"Declared resource units divided by verified or accepted outcomes, with owner distinguished",
			],
		],
	},
];

/** Definitions are the catalog. They do not claim that every collector is installed. */
export const METRIC_REGISTRY: ReadonlyArray<MetricDefinition> = Object.freeze(
	DOMAINS.flatMap((domain) =>
		domain.metrics.map(([name, unit, direction, definition]) =>
			Object.freeze({
				id: `${domain.domain}.${name}`,
				domain: domain.domain,
				definition,
				unit,
				direction,
				workload: domain.workload,
				source: domain.source,
				owner: domain.owner,
				environment: domain.environment,
				collectionWindow: domain.window,
				acceptanceRule: domain.rule,
			}),
		),
	),
);

export function observation(
	metricId: string,
	status: MeasurementStatus,
	input: {
		readonly value?: number;
		readonly sampleCount?: number;
		readonly denominator?: number;
		readonly reason?: string;
	} = {},
): MetricObservation {
	const definition = METRIC_REGISTRY.find((metric) => metric.id === metricId);
	if (definition === undefined) throw new Error(`Unknown metric: ${metricId}`);
	if (!["observed", "unavailable", "unsupported", "failed", "inconclusive"].includes(status))
		throw new Error("Invalid measurement status");
	const sampleCount = input.sampleCount ?? 0;
	if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) throw new Error("Invalid sample count");
	if (input.denominator !== undefined && (!Number.isFinite(input.denominator) || input.denominator <= 0))
		throw new Error("Invalid denominator");
	if (status === "observed") {
		if (input.value === undefined || !Number.isFinite(input.value) || sampleCount === 0)
			throw new Error("Observed values need finite data and executed samples");
		if (definition.unit === "ratio" && (input.denominator === undefined || input.value < 0 || input.value > 1))
			throw new Error("Ratio values need a denominator and a value between zero and one");
	} else if (input.value !== undefined || input.reason === undefined || input.reason.trim() === "") {
		throw new Error("Non-observed values need a reason and cannot supply a value");
	}
	return Object.freeze({ registryVersion: METRIC_REGISTRY_VERSION, metricId, status, ...input, sampleCount });
}

export interface CommandObservation {
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	readonly outputDigest: string;
	readonly errorDigest: string;
	readonly durationMs: number;
	readonly status: "observed" | "failed";
}

/** Wrap the existing runner. This records wall time, not CPU or native memory. */
export async function observeCommand(
	run: Run,
	argv: ReadonlyArray<string>,
	cwd: string,
	timeoutMs: number,
): Promise<CommandObservation> {
	if (argv.length === 0 || argv.some((part) => part.includes("\0")) || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error("A bounded argv command is required");
	const started = performance.now();
	const result = await run(argv, { cwd, timeoutMs });
	return Object.freeze({
		exitCode: result.exitCode,
		timedOut: result.timedOut === true,
		outputDigest: createHash("sha256").update(result.stdout).digest("hex"),
		errorDigest: createHash("sha256").update(result.stderr).digest("hex"),
		durationMs: performance.now() - started,
		status: result.exitCode === 0 && result.timedOut !== true ? "observed" : "failed",
	});
}
