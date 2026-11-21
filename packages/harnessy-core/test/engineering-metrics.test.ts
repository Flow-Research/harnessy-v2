import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	METRIC_REGISTRY,
	METRIC_REGISTRY_VERSION,
	type MeasurementStatus,
	observation,
	observeCommand,
} from "../src/engineering/metrics.ts";
import { execRun } from "../src/work/run.ts";

describe("engineering metric registry", () => {
	it("keeps the portable JSON catalog aligned with the controller registry", () => {
		const catalog = JSON.parse(
			readFileSync(new URL("../../../docs/engineering-loop/metrics-registry.json", import.meta.url), "utf8"),
		);
		expect(catalog).toEqual({ schema: METRIC_REGISTRY_VERSION, metrics: METRIC_REGISTRY });
	});
	it("defines every agreed domain with interpretation and evidence boundaries", () => {
		expect(new Set(METRIC_REGISTRY.map((metric) => metric.domain)).size).toBe(16);
		expect(new Set(METRIC_REGISTRY.map((metric) => metric.id)).size).toBe(METRIC_REGISTRY.length);
		for (const metric of METRIC_REGISTRY) {
			for (const key of [
				"id",
				"definition",
				"unit",
				"workload",
				"source",
				"owner",
				"environment",
				"collectionWindow",
				"acceptanceRule",
			] as const)
				expect(metric[key].length).toBeGreaterThan(0);
			expect(["lower", "higher"]).toContain(metric.direction);
			expect(Object.isFrozen(metric)).toBe(true);
		}
	});

	it("retains observed sample counts and denominators", () => {
		expect(
			observation("agent.first_pass_success", "observed", { value: 0.8, sampleCount: 10, denominator: 10 }),
		).toEqual({
			registryVersion: METRIC_REGISTRY_VERSION,
			metricId: "agent.first_pass_success",
			status: "observed",
			value: 0.8,
			sampleCount: 10,
			denominator: 10,
		});
	});

	it.each(["unavailable", "unsupported", "failed", "inconclusive"] as const)(
		"preserves %s without a fake zero",
		(status) => {
			const result = observation("native.memory", status, { reason: "No qualified physical-device collector" });
			expect(result.status).toBe(status);
			expect(result).not.toHaveProperty("value");
			expect(() => observation("native.memory", status, { value: 0, reason: "Unavailable" })).toThrow();
			expect(() => observation("native.memory", status)).toThrow();
		},
	);

	it("refuses invented metrics and invalid observations", () => {
		expect(() => observation("unknown", "observed", { value: 1, sampleCount: 1 })).toThrow("Unknown metric");
		for (const input of [
			{ value: Number.NaN, sampleCount: 1 },
			{ value: 1 },
			{ value: 1, sampleCount: -1 },
			{ value: 1, sampleCount: 1, denominator: 0 },
			{ value: 1, sampleCount: 0.1 },
		])
			expect(() => observation("native.memory", "observed", input)).toThrow();
		expect(() => observation("native.memory", "invented" as MeasurementStatus)).toThrow("status");
		for (const input of [
			{ value: -0.1, sampleCount: 1, denominator: 1 },
			{ value: 1.1, sampleCount: 1, denominator: 1 },
			{ value: 0.5, sampleCount: 1 },
		])
			expect(() => observation("agent.first_pass_success", "observed", input)).toThrow("Ratio");
	});
});

describe("command observations through the existing runner", () => {
	it("measures an actual bounded argv process without shell interpolation", async () => {
		const literal = "$(never-execute-this);`literal`";
		const result = await observeCommand(
			execRun,
			[process.execPath, "-e", "process.stdout.write(process.argv[1])", literal],
			process.cwd(),
			2000,
		);
		expect(result.status).toBe("observed");
		expect(result.outputDigest).toBe(createHash("sha256").update(literal).digest("hex"));
		expect(result.durationMs).toBeGreaterThan(0);
		expect(result).not.toHaveProperty("cpuTime");
	});

	it("retains failed and timed-out processes", async () => {
		expect(
			(await observeCommand(execRun, [process.execPath, "-e", "process.exit(3)"], process.cwd(), 2000)).status,
		).toBe("failed");
		const result = await observeCommand(
			execRun,
			[process.execPath, "-e", "setInterval(()=>{},1000)"],
			process.cwd(),
			20,
		);
		expect(result.status).toBe("failed");
		expect(result.timedOut).toBe(true);
	});

	it("refuses missing argv or deadlines", async () => {
		await expect(observeCommand(execRun, [], process.cwd(), 10)).rejects.toThrow();
		await expect(observeCommand(execRun, ["node\0injection"], process.cwd(), 10)).rejects.toThrow();
		await expect(observeCommand(execRun, [process.execPath], process.cwd(), 0)).rejects.toThrow();
	});
});
