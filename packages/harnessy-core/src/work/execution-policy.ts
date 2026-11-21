import * as Result from "effect/Result";

/** Host-selected execution policy. Task prose and worker output cannot set it. */
export interface IncludedExecutionPolicy {
	readonly agent: "claude-code";
	readonly billing: "included-only";
	readonly authorityId: string;
	readonly accountId: string;
	readonly expiresAt: number;
	readonly launchId: string;
}

/** A provider adapter must establish this from current host and provider facts. */
export interface ExecutionPermit {
	readonly status: "allowed";
	readonly agent: "claude-code";
	readonly authorityId: string;
	readonly accountId: string;
	readonly taskId: string;
	readonly launchId: string;
	readonly repository: string;
	readonly billing: "included-only";
	readonly paidFallback: "disabled";
	readonly remainingRequests: number;
	readonly checkedAt: number;
	readonly validUntil: number;
}

export interface ExecutionGuardRequest {
	readonly policy: IncludedExecutionPolicy;
	readonly taskId: string;
	readonly repository: string;
	readonly phase: "preflight" | "effect" | "agent-launch" | "agent-wait";
	readonly now: number;
}

/**
 * This callback belongs to the host controller. A CLI login, worker JSON,
 * subscription name, or operator Boolean alone cannot establish a permit.
 * A missing provider adapter refuses execution. There is no paid fallback.
 */
export type ExecutionGuard = (
	request: ExecutionGuardRequest,
) => Promise<ExecutionPermit | { readonly status: "paused"; readonly reason: string }>;

export const EXECUTION_GUARD_INTERVAL_MS = 15_000;

export class ExecutionPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionPolicyError";
	}
}

/** Stable identity stored with the work binding. Renewed grants need a new run. */
export const executionPolicyBinding = (policy: IncludedExecutionPolicy | undefined): string | undefined =>
	policy === undefined
		? undefined
		: JSON.stringify([
				policy.agent,
				policy.billing,
				policy.authorityId,
				policy.accountId,
				policy.expiresAt,
				policy.launchId,
			]);

/** Read retained identity without treating old expiry as current authority. */
export const readExecutionPolicyBinding = (text: string | undefined): IncludedExecutionPolicy | undefined => {
	if (text === undefined) return undefined;
	const parsed = Result.try((): unknown => JSON.parse(text));
	if (Result.isFailure(parsed)) return undefined;
	const value = parsed.success;
	if (
		!Array.isArray(value) ||
		value.length !== 6 ||
		value[0] !== "claude-code" ||
		value[1] !== "included-only" ||
		typeof value[2] !== "string" ||
		value[2].length === 0 ||
		typeof value[3] !== "string" ||
		value[3].length === 0 ||
		typeof value[4] !== "number" ||
		!Number.isFinite(value[4]) ||
		value[4] <= 0 ||
		typeof value[5] !== "string" ||
		!/^[a-zA-Z0-9_-]{1,160}$/.test(value[5])
	)
		return undefined;
	const policy: IncludedExecutionPolicy = {
		agent: value[0],
		billing: value[1],
		authorityId: value[2],
		accountId: value[3],
		expiresAt: value[4],
		launchId: value[5],
	};
	return executionPolicyBinding(policy) === text ? policy : undefined;
};

/** Refuse unknown, expired, stale, mismatched, or exhausted provider evidence. */
export const requireExecutionPermit = async (
	request: ExecutionGuardRequest,
	guard: ExecutionGuard | undefined,
	clock: () => number = Date.now,
): Promise<ExecutionPermit> => {
	const { policy } = request;
	const startedAt = clock();
	if (
		policy.agent !== "claude-code" ||
		policy.billing !== "included-only" ||
		typeof policy.authorityId !== "string" ||
		policy.authorityId.length === 0 ||
		typeof policy.accountId !== "string" ||
		policy.accountId.length === 0 ||
		typeof policy.launchId !== "string" ||
		!/^[a-zA-Z0-9_-]{1,160}$/.test(policy.launchId) ||
		!Number.isFinite(startedAt) ||
		!Number.isFinite(policy.expiresAt) ||
		policy.expiresAt <= startedAt
	)
		throw new ExecutionPolicyError("execution policy is invalid, unsupported, or expired");
	if (guard === undefined)
		throw new ExecutionPolicyError(
			"no trusted provider adapter can establish included allowance and disabled paid fallback",
		);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const permit = await Promise.race([
		Promise.resolve().then(() => guard(request)),
		new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error("Provider guard timed out")), EXECUTION_GUARD_INTERVAL_MS);
		}),
	])
		.catch(() => {
			throw new ExecutionPolicyError("the trusted provider allowance or authority check failed");
		})
		.finally(() => clearTimeout(timeout));
	const now = clock();
	if (
		!Number.isFinite(now) ||
		now < startedAt ||
		policy.expiresAt <= now ||
		permit === null ||
		typeof permit !== "object" ||
		permit.status !== "allowed" ||
		permit.agent !== policy.agent ||
		permit.authorityId !== policy.authorityId ||
		permit.accountId !== policy.accountId ||
		permit.taskId !== request.taskId ||
		permit.launchId !== policy.launchId ||
		permit.repository !== request.repository ||
		permit.billing !== "included-only" ||
		permit.paidFallback !== "disabled" ||
		!Number.isSafeInteger(permit.remainingRequests) ||
		permit.remainingRequests <= 0 ||
		!Number.isFinite(permit.checkedAt) ||
		permit.checkedAt > now ||
		now - permit.checkedAt > EXECUTION_GUARD_INTERVAL_MS ||
		!Number.isFinite(permit.validUntil) ||
		permit.validUntil <= now ||
		permit.validUntil > policy.expiresAt
	)
		throw new ExecutionPolicyError(
			"included allowance or current authority is unavailable, exhausted, stale, or mismatched",
		);
	return permit;
};
