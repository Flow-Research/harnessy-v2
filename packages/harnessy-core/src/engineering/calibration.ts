import { createHash } from "node:crypto";
import { z } from "zod";
import { calibrateNullExperiments, type NullCalibration } from "./evaluation.ts";

/**
 * A null calibration binds the signed-rank assumptions to one workload on
 * one host. It is built from benchmark reports in which both sides are the
 * same source, so every measured difference is noise. A benchmark may use the
 * signed-rank method only with a calibration that matches its profile, its
 * evaluator, its workload and its host, and that supports every metric that
 * the decision reads.
 */

export const CALIBRATION_MAXIMUM_AGE_MS = 30 * 24 * 60 * 60_000;
export const CALIBRATION_MINIMUM_EXPERIMENTS = 20;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const calibrationMetricSchema = z.strictObject({
	experiments: z.number().int().nonnegative(),
	intervalsExcludingZero: z.number().int().nonnegative(),
	falseKeeps: z.number().int().nonnegative(),
	lagOneCorrelation: z.number().nullable(),
	positiveShare: z.number().nullable(),
	supported: z.boolean(),
	reasons: z.array(z.string().max(200)).max(20),
});
export const nullCalibrationSchema = z.strictObject({
	schema: z.literal("harnessy.engineering.null-calibration.v1"),
	profile: z.string().min(1).max(100),
	hostDigest: digest,
	evaluatorDigest: digest,
	/** Useful operations in one sample. The workload input itself is new in every run. */
	completedWork: z.number().int().positive(),
	createdAt: z.number().int().positive(),
	experiments: z.number().int().nonnegative(),
	metrics: z.record(z.string().min(1).max(100), calibrationMetricSchema),
});
export type NullCalibrationRecord = z.infer<typeof nullCalibrationSchema>;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * The parts of a benchmark environment that describe the machine and its
 * tools. The source projections are left out, because a real experiment
 * compares two different sources on the same host.
 */
export const hostIdentityDigest = (identity: unknown): string => {
	const value = (typeof identity === "object" && identity !== null ? identity : {}) as Readonly<
		Record<string, unknown>
	>;
	// A tool is named by its content. One tool, the supervisor, is built into each run's own folder.
	const tools = (Array.isArray(value.tools) ? value.tools : [])
		.map((tool: unknown) =>
			typeof tool === "object" && tool !== null && "digest" in tool ? String(tool.digest) : "unknown",
		)
		.sort();
	return sha256(
		JSON.stringify([
			...["platform", "arch", "os", "cpus", "node", "supervisorSource", "compiler"].map((key) => [
				key,
				value[key] ?? null,
			]),
			["tools", tools],
		]),
	);
};

const reportSchema = z.object({
	schema: z.literal("harnessy.engineering.benchmark.v1"),
	measurementStatus: z.literal("observed"),
	profile: z.string().optional(),
	environment: z.object({ identity: z.unknown() }),
	baseline: z.object({
		valid: z.literal(true),
		binding: z.object({ sourceTreeDigest: digest, evaluatorDigest: digest }),
		samples: z
			.array(
				z.object({ measurements: z.record(z.string(), z.number()), completedWork: z.number().int().positive() }),
			)
			.length(10),
	}),
	candidate: z.object({
		valid: z.literal(true),
		binding: z.object({ sourceTreeDigest: digest, evaluatorDigest: digest }),
		samples: z
			.array(
				z.object({ measurements: z.record(z.string(), z.number()), completedWork: z.number().int().positive() }),
			)
			.length(10),
	}),
});

/**
 * Build a calibration from baseline against baseline reports. A report that
 * compares two different sources, or that comes from another host, profile,
 * evaluator or workload, is refused: it is not a null experiment of this set.
 */
export const buildNullCalibration = (
	reports: ReadonlyArray<unknown>,
	profile: string,
	now: number,
): NullCalibrationRecord => {
	const parsed = reports.map((report) => reportSchema.parse(report));
	const first = parsed[0];
	if (first === undefined) throw new Error("No benchmark report was given");
	const hostDigest = hostIdentityDigest(first.environment.identity);
	const { evaluatorDigest } = first.baseline.binding;
	const completedWork = first.baseline.samples[0]?.completedWork ?? 0;
	const differences = new Map<string, number[][]>();
	for (const report of parsed) {
		if ((report.profile ?? "pure-task-operations") !== profile)
			throw new Error("A report belongs to another profile");
		if (report.baseline.binding.sourceTreeDigest !== report.candidate.binding.sourceTreeDigest)
			throw new Error("A report compares two different sources, so it is not a null experiment");
		if (
			hostIdentityDigest(report.environment.identity) !== hostDigest ||
			[report.baseline.binding, report.candidate.binding].some(
				(binding) => binding.evaluatorDigest !== evaluatorDigest,
			) ||
			[...report.baseline.samples, ...report.candidate.samples].some(
				(sample) => sample.completedWork !== completedWork,
			)
		)
			throw new Error("The reports do not share one host, evaluator and workload");
		for (const id of Object.keys(report.baseline.samples[0]?.measurements ?? {})) {
			const values = report.baseline.samples.map((sample, index) => {
				const base = sample.measurements[id];
				const other = report.candidate.samples[index]?.measurements[id];
				return base === undefined || other === undefined || base === 0 ? Number.NaN : (other - base) / base;
			});
			differences.set(id, [...(differences.get(id) ?? []), values]);
		}
	}
	const metrics: Record<string, NullCalibration> = {};
	for (const [id, experiments] of differences) metrics[id] = calibrateNullExperiments(experiments);
	return nullCalibrationSchema.parse({
		schema: "harnessy.engineering.null-calibration.v1",
		profile,
		hostDigest,
		evaluatorDigest,
		completedWork,
		createdAt: now,
		experiments: parsed.length,
		metrics: Object.fromEntries(
			Object.entries(metrics).map(([id, value]) => [
				id,
				{
					...value,
					lagOneCorrelation: Number.isFinite(value.lagOneCorrelation) ? value.lagOneCorrelation : null,
					positiveShare: Number.isFinite(value.positiveShare) ? value.positiveShare : null,
				},
			]),
		),
	});
};

/** Reasons why a calibration cannot support one benchmark. Empty when it can. */
export const calibrationProblems = (
	value: unknown,
	expected: {
		readonly profile: string;
		readonly hostDigest: string;
		readonly evaluatorDigest: string;
		readonly completedWork: number;
		readonly metrics: ReadonlyArray<string>;
		readonly now: number;
	},
): ReadonlyArray<string> => {
	const parsed = nullCalibrationSchema.safeParse(value);
	if (!parsed.success) return ["calibration_malformed"];
	const calibration = parsed.data;
	const problems: string[] = [];
	if (calibration.profile !== expected.profile) problems.push("calibration_of_another_profile");
	if (calibration.hostDigest !== expected.hostDigest) problems.push("calibration_of_another_host_or_toolchain");
	if (calibration.evaluatorDigest !== expected.evaluatorDigest) problems.push("calibration_of_another_evaluator");
	if (calibration.completedWork !== expected.completedWork) problems.push("calibration_of_another_workload");
	if (calibration.createdAt > expected.now || expected.now - calibration.createdAt > CALIBRATION_MAXIMUM_AGE_MS)
		problems.push("calibration_stale");
	if (calibration.experiments < CALIBRATION_MINIMUM_EXPERIMENTS) problems.push("calibration_too_small");
	for (const id of expected.metrics) {
		const metric = calibration.metrics[id];
		if (metric === undefined) problems.push(`calibration_lacks_metric:${id}`);
		else if (!metric.supported || metric.experiments < CALIBRATION_MINIMUM_EXPERIMENTS)
			problems.push(`calibration_does_not_support:${id}`);
	}
	return problems;
};
