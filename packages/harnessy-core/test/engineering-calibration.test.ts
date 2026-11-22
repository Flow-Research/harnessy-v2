/**
 * The null calibration record: which reports it accepts, and which
 * benchmarks it can support. The reports here are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
	buildNullCalibration,
	CALIBRATION_MAXIMUM_AGE_MS,
	calibrationProblems,
	hostIdentityDigest,
} from "../src/engineering/calibration.ts";

const NOW = 1_800_000_000_000;
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

/** Small deterministic generator, so that every report is reproducible. */
const generator = (seed: number) => {
	let state = seed >>> 0;
	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
};
const identity = {
	platform: "darwin",
	arch: "arm64",
	os: "25.2.0",
	cpus: ["M4"],
	node: "v22.22.2",
	tools: [{ path: "/usr/bin/git", digest: A }],
};
const report = (next: () => number, overrides: Record<string, unknown> = {}, candidateTree = A) => {
	const samples = (bias: number) =>
		Array.from({ length: 10 }, () => ({
			measurements: { "tests.runtime": 100 * (1 + bias + 0.02 * (next() - 0.5)), "memory.peak_resident": 1000 },
			completedWork: 1024,
		}));
	// The workload input is new in every run, so its digest differs between reports.
	const binding = (tree: string) => ({ sourceTreeDigest: tree, evaluatorDigest: B, workloadDigest: C });
	return {
		schema: "harnessy.engineering.benchmark.v1",
		measurementStatus: "observed",
		profile: "pure-task-operations",
		environment: { identity: { ...identity, projectionDigests: { baseline: A, candidate: candidateTree } } },
		baseline: { valid: true, binding: binding(A), samples: samples(0) },
		candidate: { valid: true, binding: binding(candidateTree), samples: samples(0) },
		...overrides,
	};
};
const reports = (count: number, seed = 1) => {
	const next = generator(seed);
	return Array.from({ length: count }, () => report(next));
};
const expected = {
	profile: "pure-task-operations",
	hostDigest: hostIdentityDigest(identity),
	evaluatorDigest: B,
	completedWork: 1024,
	metrics: ["tests.runtime", "memory.peak_resident"],
	now: NOW + 1000,
};

describe("null calibration record", () => {
	it("supports a benchmark of the same profile, host, evaluator and workload", () => {
		const calibration = buildNullCalibration(reports(24), "pure-task-operations", NOW);
		expect(calibration).toMatchObject({ experiments: 24, hostDigest: expected.hostDigest });
		expect(calibration.metrics["tests.runtime"]).toMatchObject({ experiments: 24, falseKeeps: 0, supported: true });
		// A metric that never varies has no noise to judge, and it is still supported.
		expect(calibration.metrics["memory.peak_resident"]?.supported).toBe(true);
		expect(calibrationProblems(calibration, expected)).toEqual([]);
		// The record survives a round trip through its file form.
		expect(calibrationProblems(JSON.parse(JSON.stringify(calibration)), expected)).toEqual([]);
	});

	it("ignores the source projections when it identifies the host", () => {
		expect(hostIdentityDigest({ ...identity, projectionDigests: { baseline: A } })).toBe(
			hostIdentityDigest(identity),
		);
		expect(hostIdentityDigest({ ...identity, node: "v24.0.0" })).not.toBe(hostIdentityDigest(identity));
		// A tool counts by its content, not by the folder of one run.
		expect(hostIdentityDigest({ ...identity, tools: [{ path: "/run-2/git", digest: A }] })).toBe(
			hostIdentityDigest(identity),
		);
		expect(hostIdentityDigest({ ...identity, tools: [{ path: "/usr/bin/git", digest: B }] })).not.toBe(
			hostIdentityDigest(identity),
		);
	});

	it("refuses reports that are not null experiments of one set", () => {
		const next = generator(2);
		const good = reports(20);
		expect(() => buildNullCalibration([], "pure-task-operations", NOW)).toThrow("No benchmark report");
		expect(() => buildNullCalibration([...good, report(next, {}, B)], "pure-task-operations", NOW)).toThrow(
			"not a null experiment",
		);
		expect(() => buildNullCalibration(good, "local-status", NOW)).toThrow("another profile");
		expect(() =>
			buildNullCalibration(
				[...good, report(next, { environment: { identity: { ...identity, node: "v24.0.0" } } })],
				"pure-task-operations",
				NOW,
			),
		).toThrow("one host");
		expect(() =>
			buildNullCalibration([...good, report(next, { measurementStatus: "failed" })], "pure-task-operations", NOW),
		).toThrow();
	});

	it("names each reason why a record cannot support a benchmark", () => {
		const calibration = buildNullCalibration(reports(24), "pure-task-operations", NOW);
		const problems = (change: Partial<typeof expected>, record: unknown = calibration) =>
			calibrationProblems(record, { ...expected, ...change });
		expect(problems({ profile: "local-status" })).toEqual(["calibration_of_another_profile"]);
		expect(problems({ hostDigest: A })).toEqual(["calibration_of_another_host_or_toolchain"]);
		expect(problems({ evaluatorDigest: A })).toEqual(["calibration_of_another_evaluator"]);
		expect(problems({ completedWork: 512 })).toEqual(["calibration_of_another_workload"]);
		expect(problems({ now: NOW + CALIBRATION_MAXIMUM_AGE_MS + 1 })).toEqual(["calibration_stale"]);
		expect(problems({ now: NOW - 1 })).toEqual(["calibration_stale"]);
		expect(problems({ metrics: ["cpu.time_per_operation"] })).toEqual([
			"calibration_lacks_metric:cpu.time_per_operation",
		]);
		expect(problems({}, { ...calibration, extra: true })).toEqual(["calibration_malformed"]);
		expect(problems({}, "supported")).toEqual(["calibration_malformed"]);
		const small = buildNullCalibration(reports(19), "pure-task-operations", NOW);
		expect(problems({}, small)).toEqual([
			"calibration_too_small",
			"calibration_does_not_support:tests.runtime",
			"calibration_does_not_support:memory.peak_resident",
		]);
	});

	it("does not support a metric whose null experiments would be kept", () => {
		const next = generator(3);
		// The candidate side is always 8% faster although the source is the same: a side bias.
		const biased = Array.from({ length: 24 }, () => {
			const value = report(next);
			for (const sample of value.candidate.samples)
				sample.measurements["tests.runtime"] = (sample.measurements["tests.runtime"] ?? 0) * 0.92;
			return value;
		});
		const calibration = buildNullCalibration(biased, "pure-task-operations", NOW);
		expect(calibration.metrics["tests.runtime"]?.supported).toBe(false);
		expect(calibrationProblems(calibration, expected)).toEqual(["calibration_does_not_support:tests.runtime"]);
	});
});
