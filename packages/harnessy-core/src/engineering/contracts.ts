import { createHash } from "node:crypto";
import type { z } from "zod";
import { type engineeringGrantSchema, engineeringJobSchema } from "./host-contract.ts";

export { engineeringGrantSchema, engineeringJobSchema } from "./host-contract.ts";

export type EngineeringJob = z.infer<typeof engineeringJobSchema>;
export type EngineeringLane = EngineeringJob["lane"];

export type EngineeringGrant = z.infer<typeof engineeringGrantSchema>;
export type EngineeringRunState =
	| "reserved"
	| "running"
	| "verifying"
	| "cancel_requested"
	| "reconciling"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface EngineeringRun {
	readonly id: string;
	readonly job: EngineeringJob;
	readonly digest: string;
	readonly grantId: string;
	readonly state: EngineeringRunState;
	readonly reservedAt: number;
	readonly workerDeadline: number;
	readonly verificationDeadline: number;
	readonly processIdentity: string | null;
	readonly ownerPid: number | null;
	readonly ownerToken: string | null;
	readonly runnerReturned: boolean;
	readonly detail: string;
}

export interface EngineeringEvent {
	readonly sequence: number;
	readonly runId: string;
	readonly at: number;
	readonly state: EngineeringRunState;
	readonly detail: string;
}

/** Parse before hashing so unknown properties and alternate key order cannot change identity. */
export const engineeringJobDigest = (value: unknown): string => {
	const job = engineeringJobSchema.parse(value);
	return createHash("sha256").update(JSON.stringify(job)).digest("hex");
};

export const ENGINEERING_PILOT = Object.freeze({
	intervalMs: 15 * 60_000,
	windowMs: 24 * 60 * 60_000,
	maximumAttempts: 6,
	maximumObjectiveFailures: 3,
	workerMs: 45 * 60_000,
	verificationMs: 90 * 60_000,
});
