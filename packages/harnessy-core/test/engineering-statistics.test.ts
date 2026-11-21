/**
 * The exact signed-rank interval and the null calibration. The simulations
 * use a fixed seed, so every count here is reproducible.
 */
import { describe, expect, it } from "vitest";
import { calibrateNullExperiments, signedRankInterval } from "../src/engineering/evaluation.ts";

/** Small deterministic generator (mulberry32). */
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
const normal = (next: () => number): number => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
/** Heavy tails: a normal value divided by a uniform value. Symmetric, not normal. */
const heavy = (next: () => number): number => normal(next) / (0.05 + next());
const experiments = (count: number, draw: () => number): number[][] =>
	Array.from({ length: count }, () => Array.from({ length: 10 }, draw));

describe("exact signed-rank interval for ten pairs", () => {
	it("has the stated exact null coverage", () => {
		// The interval excludes zero exactly when the smaller rank sum is 8 or less.
		let extreme = 0;
		for (let pattern = 0; pattern < 1024; pattern++) {
			let positive = 0;
			for (let rank = 1; rank <= 10; rank++) if ((pattern >> (rank - 1)) & 1) positive += rank;
			if (positive <= 8 || positive >= 47) extreme++;
		}
		expect(extreme).toBe(50);
		// The same count through the function: magnitudes 1..10 with every sign pattern.
		let excluded = 0;
		for (let pattern = 0; pattern < 1024; pattern++) {
			const values = Array.from({ length: 10 }, (_, index) => ((pattern >> index) & 1 ? 1 : -1) * (index + 1));
			const { bounds } = signedRankInterval(values);
			if (bounds[0] > 0 || bounds[1] < 0) excluded++;
		}
		expect(excluded).toBe(50);
	});

	it("estimates the centre and orders its bounds", () => {
		const result = signedRankInterval([0.08, 0.09, 0.1, 0.11, 0.12, 0.1, 0.09, 0.11, 0.1, 0.1]);
		expect(result.mean).toBeCloseTo(0.1, 10);
		expect(result.bounds[0]).toBeGreaterThan(0.08);
		expect(result.bounds[1]).toBeLessThan(0.12);
		expect(result.bounds[0]).toBeLessThanOrEqual(result.mean);
		expect(() => signedRankInterval([1, 2, 3])).toThrow("ten pairs");
	});

	it("keeps its error rate for heavy-tailed symmetric noise, where the t interval assumption fails", () => {
		const next = generator(20261121);
		let excluded = 0;
		const trials = 4000;
		for (let trial = 0; trial < trials; trial++) {
			const { bounds } = signedRankInterval(Array.from({ length: 10 }, () => heavy(next)));
			if (bounds[0] > 0 || bounds[1] < 0) excluded++;
		}
		// Exact rate is 50/1024 = 4.88%. Three standard errors of 4,000 trials is about 1%.
		expect(excluded / trials).toBeGreaterThan(0.038);
		expect(excluded / trials).toBeLessThan(0.06);
	});

	it("detects a real 10% improvement under 2% noise", () => {
		const next = generator(7);
		let detected = 0;
		for (let trial = 0; trial < 500; trial++) {
			const result = signedRankInterval(Array.from({ length: 10 }, () => 0.1 + 0.02 * normal(next)));
			if (result.bounds[0] > 0 && result.mean >= 0.05) detected++;
		}
		expect(detected).toBe(500);
	});
});

describe("null calibration", () => {
	it("supports the assumptions for independent symmetric null differences", () => {
		const next = generator(99);
		const result = calibrateNullExperiments(experiments(40, () => 0.01 * heavy(next)));
		expect(result).toMatchObject({ experiments: 40, falseKeeps: 0, supported: true, reasons: [] });
		expect(result.intervalsExcludingZero).toBeLessThanOrEqual(6);
	});

	it("refuses too few experiments and malformed experiments", () => {
		const next = generator(3);
		expect(calibrateNullExperiments(experiments(19, () => 0.01 * normal(next))).reasons).toContain(
			"at_least_20_null_experiments_required",
		);
		expect(calibrateNullExperiments([[1, 2, 3]]).supported).toBe(false);
		expect(calibrateNullExperiments([Array.from({ length: 10 }, () => Number.NaN)]).reasons).toEqual([
			"each_experiment_needs_ten_finite_differences",
		]);
	});

	it("refuses a side bias, which would make a null experiment look like a win", () => {
		const next = generator(5);
		const biased = calibrateNullExperiments(experiments(40, () => 0.08 + 0.01 * normal(next)));
		expect(biased.supported).toBe(false);
		expect(biased.reasons).toContain("a_null_experiment_would_be_kept");
		expect(biased.reasons).toContain("differences_are_not_centred_on_zero");
	});

	it("refuses serially correlated differences, such as thermal drift", () => {
		const next = generator(11);
		const drifting = Array.from({ length: 40 }, () => {
			let level = 0;
			return Array.from({ length: 10 }, () => {
				level = 0.9 * level + 0.01 * normal(next);
				return level;
			});
		});
		const result = calibrateNullExperiments(drifting);
		expect(result.supported).toBe(false);
		expect(result.reasons).toContain("differences_are_serially_correlated");
	});
});
