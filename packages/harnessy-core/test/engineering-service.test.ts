import { describe, expect, it } from "vitest";
import { ENGINEERING_PILOT } from "../src/engineering/contracts.ts";
import { type EngineeringServiceReport, runEngineeringService } from "../src/engineering/service.ts";

describe("continuous engineering service", () => {
	it("runs serially at the declared interval and persists each observation", async () => {
		const stop = new AbortController();
		const reports: EngineeringServiceReport[] = [];
		const waits: number[] = [];
		let ticks = 0;
		let time = 0;
		await runEngineeringService(
			{
				tick: async () => {
					ticks++;
					return { state: "idle", reason: "No approved task" };
				},
			},
			stop.signal,
			async (report) => {
				reports.push(report);
			},
			() => time,
			async (ms) => {
				waits.push(ms);
				time += ms;
				if (ticks === 2) stop.abort();
			},
		);
		expect(ticks).toBe(2);
		expect(reports.map((report) => report.at)).toEqual([0, ENGINEERING_PILOT.intervalMs]);
		expect(waits).toEqual([ENGINEERING_PILOT.intervalMs, ENGINEERING_PILOT.intervalMs]);
	});
	it("stops when evidence cannot persist instead of silently running without monitoring", async () => {
		let ticks = 0;
		await expect(
			runEngineeringService(
				{
					tick: async () => {
						ticks++;
						return { state: "paused", reason: "No allowance evidence" };
					},
				},
				new AbortController().signal,
				async () => {
					throw new Error("Disk full");
				},
			),
		).rejects.toThrow("Disk full");
		expect(ticks).toBe(1);
	});
	it("does not interpret an aborted observation wait as permission to restart work", async () => {
		const stop = new AbortController();
		let ticks = 0;
		await runEngineeringService(
			{
				tick: async () => {
					ticks++;
					return { state: "occupied", reason: "Known host handle" };
				},
			},
			stop.signal,
			async () => {},
			Date.now,
			async () => {
				stop.abort();
				throw new Error("aborted");
			},
		);
		expect(ticks).toBe(1);
	});
	it("propagates unexpected wait failure and runs no tick after explicit stop", async () => {
		const controller = { tick: async () => ({ state: "idle" as const, reason: "No work" }) };
		await expect(
			runEngineeringService(
				controller,
				new AbortController().signal,
				async () => {},
				Date.now,
				async () => {
					throw new Error("Unexpected scheduler failure");
				},
			),
		).rejects.toThrow("scheduler");
		const stop = new AbortController();
		stop.abort();
		await runEngineeringService(
			{
				tick: async () => {
					throw new Error("Must not start");
				},
			},
			stop.signal,
			async () => {},
		);
	});
});
