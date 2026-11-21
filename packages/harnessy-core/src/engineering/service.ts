import { setTimeout as delay } from "node:timers/promises";
import { ENGINEERING_PILOT } from "./contracts.ts";
import type { EngineeringController, EngineeringTick } from "./controller.ts";

export interface EngineeringServiceReport {
	readonly schema: "harnessy.engineering.service.v1";
	readonly at: number;
	readonly result: EngineeringTick;
}

/** One serial owner. Sleep does not imply uptime when the computer is suspended. */
export const runEngineeringService = async (
	controller: Pick<EngineeringController, "tick">,
	signal: AbortSignal,
	report: (value: EngineeringServiceReport) => Promise<void>,
	clock: () => number = Date.now,
	wait: (ms: number, signal: AbortSignal) => Promise<void> = async (ms, activeSignal) => {
		await delay(ms, undefined, { signal: activeSignal });
	},
): Promise<void> => {
	while (!signal.aborted) {
		const at = clock();
		const result = await controller.tick();
		// A failed receipt write stops this service. It never continues without monitoring evidence.
		await report({ schema: "harnessy.engineering.service.v1", at, result });
		if (signal.aborted) break;
		await wait(ENGINEERING_PILOT.intervalMs, signal).catch((cause: unknown) => {
			if (!signal.aborted) throw cause;
		});
	}
};
