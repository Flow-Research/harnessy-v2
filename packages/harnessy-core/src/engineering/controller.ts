import { resolve } from "node:path";
import * as Result from "effect/Result";
import { type ExecutionGuard, type IncludedExecutionPolicy, requireExecutionPermit } from "../work/execution-policy.ts";
import { runWork, type WorkDeps, type WorkOptions, type WorkOutcome } from "../work/run.ts";
import { ENGINEERING_PILOT, type EngineeringJob, type EngineeringRun } from "./contracts.ts";
import type { HostLaunch, HostRequestUnsigned } from "./host-contract.ts";
import type { EngineeringInterventionStore, InterventionReason } from "./host-intervention.ts";
import { type EngineeringStore, engineeringLaunchId, type HostTerminationEvidence } from "./store.ts";

export interface EngineeringRepositoryProfile {
	readonly id: EngineeringJob["repository"];
	readonly root: string;
	readonly base: string;
	readonly accountId: string;
	readonly workstreamCli: ReadonlyArray<string>;
	readonly agentAllow?: string;
	/** Copy the checkout's ignored dependency folders into the worktree, so that checks can run there. */
	readonly agentDeps?: "clone";
}

/** Facts come from host probes and the provider adapter, never the job payload. */
export interface HostReadiness {
	readonly status: "ready" | "paused";
	readonly reason: string;
	readonly sourceRevision: string;
	readonly evaluatorDigest: string;
	readonly workloadDigest: string;
	/**
	 * For a proof-only job: true when the job's pinned source is an ancestor of the current base.
	 * Merging the reviewed pull request moves the base, so a proof-only successor can never pin
	 * the current base. The runner still requires the pinned source of the retained authority.
	 */
	readonly pinnedSourceIsAncestor?: boolean;
}

export type HostProcessObservation =
	| { readonly state: "unknown"; readonly reason: string }
	| { readonly state: "active"; readonly identity: string }
	| { readonly state: "stopped"; readonly identity: string; readonly evidence: string };
export type RemoteAuthorityReceipt =
	| {
			readonly status: "current";
			readonly launchId: string;
			readonly grantId: string;
			readonly requestDigest: string;
			readonly observedAt: number;
			readonly expiresAt: number;
	  }
	| { readonly status: "unavailable" | "refused"; readonly reason: string };

export interface EngineeringControllerDeps {
	readonly now: () => number;
	readonly profiles: ReadonlyArray<EngineeringRepositoryProfile>;
	readonly work: WorkDeps;
	/** Live server authority is checked separately from stored delivery acknowledgments. */
	readonly remoteAuthority?: (launch: HostLaunch) => Promise<RemoteAuthorityReceipt>;
	/** Remote runs only. An open intervention holds a reserved run until a person resumes or stops it. */
	readonly interventions?: EngineeringInterventionStore;
	readonly readiness: (job: EngineeringJob, profile: EngineeringRepositoryProfile) => Promise<HostReadiness>;
	readonly inspect: (run: EngineeringRun) => Promise<HostProcessObservation>;
	readonly cancel: (run: EngineeringRun, identity: string) => Promise<void>;
	readonly verify: (
		run: EngineeringRun,
		outcome?: WorkOutcome,
	) => Promise<
		| {
				readonly verdict: "pass";
				readonly evidenceDigest: string;
				readonly runId: string;
				readonly grantId: string;
				readonly baselineRevision: string;
				readonly candidateRevision: string;
				readonly evaluatorDigest: string;
				readonly workloadDigest: string;
		  }
		| { readonly verdict: "reject" | "unavailable"; readonly reason: string }
	>;
	/** Tests replace the external boundary, not the ledger or decision state machine. */
	readonly execute?: (options: WorkOptions, deps: WorkDeps) => Promise<WorkOutcome>;
}

export interface EngineeringTick {
	readonly state: "idle" | "paused" | "occupied" | "settled";
	readonly reason: string;
	readonly runId?: string;
}

/** The single continuous controller delegates actual task work to the existing runner. */
export class EngineeringController {
	readonly #store: EngineeringStore;
	readonly #deps: EngineeringControllerDeps;

	constructor(store: EngineeringStore, deps: EngineeringControllerDeps) {
		this.#store = store;
		this.#deps = deps;
		if (new Set(deps.profiles.map((profile) => profile.id)).size !== deps.profiles.length)
			throw new Error("Duplicate repository profile");
	}

	async tick(): Promise<EngineeringTick> {
		const active = this.#store.active();
		if (active !== undefined) {
			const offer = this.#store.hostOffer(active.id);
			// Recover a stop already committed by an older host before its controller write.
			if (active.state !== "cancel_requested" && this.#deps.interventions?.hasStopAnswer(active.id))
				return this.#observe(this.#store.requestCancellation(active.id, this.#deps.now()));
			if (active.state === "reserved" && offer !== undefined) {
				if (!offer.acknowledged)
					return {
						state: "paused",
						reason: "Remote acknowledgment pending; worker has not started",
						runId: active.id,
					};
				if ((this.#deps.interventions?.open(active.id).length ?? 0) > 0) {
					const now = this.#deps.now();
					if (
						now >= active.workerDeadline ||
						Result.isFailure(Result.try(() => this.#store.assertAuthority(active.id, now)))
					)
						return this.#observe(this.#store.requestCancellation(active.id, now));
					return {
						state: "paused",
						reason: "Intervention open; a person must resume or stop the run",
						runId: active.id,
					};
				}
				const admitted = await this.#admit(active.job, active.grantId, active.id);
				if (admitted.status === "ready") return this.#execute(active, admitted.profile);
				const raised = admitted.code === "allowance_unavailable" ? this.#raise(active.id, admitted.code) : "";
				return { state: "paused", reason: `${admitted.reason}${raised}`, runId: active.id };
			}
			const observed = await this.#observe(active);
			return offer !== undefined &&
				observed.state === "occupied" &&
				this.#store.get(active.id).state === "reconciling"
				? { ...observed, reason: `${observed.reason}${this.#raise(active.id, "reconciliation_required")}` }
				: observed;
		}
		const fence = this.#store.hostFence();
		if (fence?.disposition === "declining")
			return {
				state: "paused",
				reason: "Remote decline receipt pending; delivery capacity remains occupied",
				runId: fence.launch.launchId,
			};
		const candidates = this.#store.approvedJobs(this.#deps.now());
		const approved = candidates.filter(
			(entry) =>
				(entry.launchId !== undefined || !this.#store.requiresRemoteAdmission()) &&
				(fence === undefined || entry.launchId === fence.launch.launchId),
		);
		approved.sort(
			(left, right) =>
				Number(!["security", "correctness"].includes(left.job.lane)) -
				Number(!["security", "correctness"].includes(right.job.lane)),
		);
		const reasons: string[] = [];
		for (const { job, grantId, launchId: remoteLaunchId } of approved) {
			const launchId = remoteLaunchId ?? engineeringLaunchId();
			const admitted = await this.#admit(job, grantId, launchId);
			if (admitted.status === "paused") {
				if (
					remoteLaunchId !== undefined &&
					Result.isFailure(
						Result.try(() => this.#store.declineHostLaunch(launchId, admitted.code, this.#deps.now())),
					)
				)
					return {
						state: "occupied",
						reason: "Remote offer changed during admission; reconciliation remains fenced",
						runId: launchId,
					};
				reasons.push(`${job.id}: ${admitted.reason}`);
				continue;
			}
			const reserved = Result.try(() => this.#store.reserve(job.id, grantId, launchId, this.#deps.now()));
			if (Result.isFailure(reserved)) {
				if (
					remoteLaunchId !== undefined &&
					this.#store.active()?.id !== launchId &&
					Result.isFailure(
						Result.try(() => this.#store.declineHostLaunch(launchId, "admission_paused", this.#deps.now())),
					)
				)
					return {
						state: "occupied",
						reason: "Remote reservation changed; reconciliation remains fenced",
						runId: launchId,
					};
				reasons.push(
					`${job.id}: ${reserved.failure instanceof Error ? reserved.failure.message : "Reservation refused"}`,
				);
				continue;
			}
			if (remoteLaunchId !== undefined)
				return {
					state: "paused",
					reason: "Remote acknowledgment pending; worker has not started",
					runId: launchId,
				};
			return this.#execute(reserved.success, admitted.profile);
		}
		if (fence !== undefined && reasons.length === 0)
			return {
				state: "paused",
				reason: "Remote delivery remains fenced pending explicit reconciliation",
				runId: fence.launch.launchId,
			};
		if (candidates.length > 0 && approved.length === 0 && this.#store.requiresRemoteAdmission())
			return { state: "paused", reason: "Central Garden launch admission is required for locally approved jobs" };
		return reasons.length === 0
			? { state: "idle", reason: "No approved work" }
			: { state: "paused", reason: reasons.join("; ") };
	}

	/** Raising is idempotent. A failure leaves the tick result unchanged and is named in its reason. */
	#raise(runId: string, reason: InterventionReason): string {
		const interventions = this.#deps.interventions;
		if (interventions === undefined) return "";
		return Result.isFailure(Result.try(() => interventions.raise(runId, reason, this.#deps.now())))
			? "; intervention could not be recorded"
			: "; intervention raised for a person";
	}

	async #admit(
		job: EngineeringJob,
		grantId: string,
		launchId: string,
	): Promise<
		| { status: "ready"; profile: EngineeringRepositoryProfile }
		| {
				status: "paused";
				reason: string;
				code: Extract<HostRequestUnsigned["body"], { operation: "decline" }>["reason"];
		  }
	> {
		const profile = this.#deps.profiles.find((entry) => entry.id === job.repository);
		if (profile === undefined)
			return { status: "paused", reason: "Repository has no host profile", code: "admission_paused" };
		const readiness = await this.#deps.readiness(job, profile);
		const sourceAdmitted =
			readiness.sourceRevision === job.sourceRevision ||
			(job.proofOnlyResume !== undefined && readiness.pinnedSourceIsAncestor === true);
		if (
			readiness.status !== "ready" ||
			!sourceAdmitted ||
			readiness.evaluatorDigest !== job.evaluatorDigest ||
			readiness.workloadDigest !== job.workloadDigest
		)
			return {
				status: "paused",
				reason: `Host, isolation or pinned source/evaluator/workload unavailable: ${
					readiness.status === "ready" && !sourceAdmitted
						? job.proofOnlyResume === undefined
							? "the job does not pin the current base"
							: "the pinned source is not an ancestor of the current base"
						: readiness.reason
				}`,
				code: sourceAdmitted ? "isolation_unavailable" : "source_unavailable",
			};
		if (!(await this.#remoteCurrent(launchId)))
			return { status: "paused", reason: "Remote authority is unavailable or refused", code: "admission_paused" };
		const providerProblem = await requireExecutionPermit(
			{
				policy: {
					agent: "claude-code",
					billing: "included-only",
					authorityId: grantId,
					launchId,
					accountId: profile.accountId,
					expiresAt: this.#deps.now() + ENGINEERING_PILOT.workerMs,
				},
				taskId: job.taskId,
				repository: resolve(profile.root),
				phase: "preflight",
				now: this.#deps.now(),
			},
			this.#deps.work.executionGuard,
			this.#deps.now,
		).then(
			() => undefined,
			(cause: unknown) => (cause instanceof Error ? cause.message : "Provider admission unavailable"),
		);
		if (providerProblem !== undefined)
			return { status: "paused", reason: providerProblem, code: "allowance_unavailable" };
		if (!(await this.#remoteCurrent(launchId)))
			return {
				status: "paused",
				reason: "Remote authority changed during provider admission",
				code: "admission_paused",
			};
		return { status: "ready", profile };
	}

	async #remoteCurrent(runId: string): Promise<boolean> {
		const offer = this.#store.hostOffer(runId);
		if (offer === undefined) return true;
		if (offer.disposition !== "offered" || this.#deps.remoteAuthority === undefined) return false;
		const startedAt = this.#deps.now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const receipt = await Promise.race([
			Promise.resolve()
				.then(() => this.#deps.remoteAuthority!(offer.launch))
				.catch((): RemoteAuthorityReceipt => ({ status: "unavailable", reason: "Remote authority probe failed" })),
			new Promise<RemoteAuthorityReceipt>((resolve) => {
				timer = setTimeout(
					() => resolve({ status: "unavailable", reason: "Remote authority probe timed out" }),
					15_000,
				);
			}),
		]);
		clearTimeout(timer);
		const checkedAt = this.#deps.now();
		return (
			receipt.status === "current" &&
			receipt.launchId === offer.launch.launchId &&
			receipt.grantId === offer.launch.grant.id &&
			receipt.requestDigest === offer.launch.requestDigest &&
			Number.isSafeInteger(receipt.observedAt) &&
			Number.isSafeInteger(receipt.expiresAt) &&
			checkedAt >= startedAt &&
			receipt.observedAt >= startedAt &&
			receipt.observedAt <= checkedAt &&
			checkedAt - receipt.observedAt <= 15_000 &&
			receipt.expiresAt > checkedAt &&
			receipt.expiresAt <= offer.launch.grant.expiresAt &&
			this.#store.hostOffer(runId)?.disposition === "offered"
		);
	}

	async #execute(run: EngineeringRun, profile: EngineeringRepositoryProfile): Promise<EngineeringTick> {
		const policy: IncludedExecutionPolicy = {
			agent: "claude-code",
			billing: "included-only",
			authorityId: run.grantId,
			launchId: run.id,
			accountId: profile.accountId,
			expiresAt: this.#store.authorityExpiresAt(run.id),
		};
		const originalGuard = this.#deps.work.executionGuard;
		const guarded: ExecutionGuard = async (request) => {
			if (!(await this.#remoteCurrent(run.id)))
				return { status: "paused", reason: "Remote authority is unavailable or refused" };
			if (Result.isFailure(Result.try(() => this.#store.assertAuthority(run.id, this.#deps.now())))) {
				return { status: "paused", reason: "Run authority or cancellation forbids new effects" };
			}
			if (
				this.#deps.now() >= run.verificationDeadline ||
				(["agent-wait", "agent-launch"].includes(request.phase) && this.#deps.now() >= run.workerDeadline)
			)
				return { status: "paused", reason: "Worker or verification deadline reached" };
			if (originalGuard === undefined) return { status: "paused", reason: "Provider verifier unavailable" };
			const permit = await originalGuard(request);
			if (!(await this.#remoteCurrent(run.id)))
				return { status: "paused", reason: "Remote authority changed during provider verification" };
			if (Result.isFailure(Result.try(() => this.#store.assertAuthority(run.id, this.#deps.now())))) {
				return { status: "paused", reason: "Authority changed during provider verification" };
			}
			if (
				this.#deps.now() >= run.verificationDeadline ||
				(["agent-wait", "agent-launch"].includes(request.phase) && this.#deps.now() >= run.workerDeadline)
			)
				return { status: "paused", reason: "Deadline elapsed during provider verification" };
			return permit;
		};
		const ownerToken = engineeringLaunchId();
		const started = Result.try(() => this.#store.start(run.id, this.#deps.now(), ownerToken));
		if (Result.isFailure(started))
			return {
				state: "occupied",
				reason: "Run changed before start; existing generation remains authoritative",
				runId: run.id,
			};
		this.#store.bindProcess(run.id, `harnessy-work:${run.id}`, this.#deps.now());
		const outcome = await (this.#deps.execute ?? runWork)(
			{
				task: run.job.taskId,
				sourceRevision: run.job.sourceRevision,
				taskContentDigest: run.job.taskRevision,
				repo: profile.root,
				base: profile.base,
				budgetUsd: 0,
				maxMinutes: Math.max(0.001, (run.workerDeadline - this.#deps.now()) / 60_000),
				mergeWaitHours: ENGINEERING_PILOT.verificationMs / 3_600_000,
				outcomeWaitHours: 0,
				workstreamCli: profile.workstreamCli,
				approvePush: run.job.proofOnlyResume === undefined,
				dryRun: false,
				executionPolicy: policy,
				...(run.job.proofOnlyResume === undefined ? {} : { proofOnlyResume: run.job.proofOnlyResume }),
				...(profile.agentAllow === undefined ? {} : { agentAllow: profile.agentAllow }),
				...(profile.agentDeps === undefined ? {} : { agentDeps: profile.agentDeps }),
			},
			{
				...this.#deps.work,
				executionGuard: guarded,
				protectedPaths: [...(this.#deps.work.protectedPaths ?? []), this.#store.root],
			},
		)
			.catch((cause: unknown) => {
				// A thrown call is not proof of failure before launch. Retain capacity and inspect.
				// The message is kept, so that an operator can see why the runner stopped.
				const message = (cause instanceof Error ? cause.message : "unknown error")
					.replace(/\s+/g, " ")
					.slice(0, 300);
				this.#store.markUncertain(
					run.id,
					`Runner interrupted, host reconciliation required: ${message}`,
					this.#deps.now(),
				);
				return undefined;
			})
			.finally(() => {
				this.#store.runnerReturned(run.id, ownerToken, this.#deps.now());
			});
		return this.#observe(this.#store.get(run.id), outcome);
	}

	async #observe(run: EngineeringRun, outcome?: WorkOutcome): Promise<EngineeringTick> {
		const observation: HostProcessObservation = await this.#deps
			.inspect(run)
			.catch(() => ({ state: "unknown" as const, reason: "Host observation failed" }));
		if (observation.state === "unknown") {
			// A transient poll failure does not prove the owner stopped or authorize restart.
			return { state: "occupied", reason: observation.reason, runId: run.id };
		}
		if (run.processIdentity !== null && run.processIdentity !== observation.identity) {
			this.#store.markUncertain(run.id, "Host process identity changed", this.#deps.now());
			return { state: "occupied", reason: "Host process identity changed", runId: run.id };
		}
		if (
			run.state === "cancel_requested" &&
			run.processIdentity === null &&
			run.ownerPid === null &&
			run.ownerToken === null &&
			observation.state === "stopped" &&
			observation.evidence.length > 0 &&
			this.#store.hostOffer(run.id)?.acknowledged === true
		) {
			this.#store.settle(run.id, "cancelled", "Reservation cancelled before worker start", this.#deps.now(), {
				identity: null,
				terminationEvidence: observation.evidence,
			});
			this.#deps.interventions?.closeTerminalRun(run.id);
			return { state: "settled", reason: "Cancellation confirmed before worker start", runId: run.id };
		}
		if (run.processIdentity === null)
			return { state: "occupied", reason: "Launch generation has not been acknowledged", runId: run.id };
		if (observation.state === "active") {
			let stop = run.state === "cancel_requested" || this.#deps.now() >= run.workerDeadline;
			if (!(await this.#remoteCurrent(run.id))) stop = true;
			if (Result.isFailure(Result.try(() => this.#store.assertAuthority(run.id, this.#deps.now())))) stop = true;
			if (stop) {
				this.#store.requestCancellation(run.id, this.#deps.now());
				await this.#deps.cancel(run, observation.identity).catch(() => undefined);
			}
			return {
				state: "occupied",
				reason: stop ? "Termination requested, confirmation pending" : "Owned worker remains active",
				runId: run.id,
			};
		}
		if (observation.evidence.length === 0) {
			this.#store.markUncertain(run.id, "Termination evidence missing", this.#deps.now());
			return { state: "occupied", reason: "Termination evidence missing", runId: run.id };
		}
		if (!run.runnerReturned) {
			const owner = Result.try(() => {
				if (run.ownerPid !== null) process.kill(run.ownerPid, 0);
			});
			const ownerMayBeAlive = !(
				Result.isFailure(owner) &&
				owner.failure instanceof Error &&
				"code" in owner.failure &&
				owner.failure.code === "ESRCH"
			);
			if (ownerMayBeAlive)
				return { state: "occupied", reason: "Launch owner is active or unconfirmed", runId: run.id };
		}
		if (run.state === "cancel_requested") {
			this.#store.settle(run.id, "cancelled", "Host confirmed owned worker termination", this.#deps.now(), {
				identity: observation.identity,
				terminationEvidence: observation.evidence,
			});
			return { state: "settled", reason: "Cancellation confirmed", runId: run.id };
		}
		const termination = { identity: observation.identity, terminationEvidence: observation.evidence };
		return this.#verify(run, outcome, termination).catch(() => {
			const current = this.#store.get(run.id);
			if (["succeeded", "failed", "cancelled"].includes(current.state))
				return {
					state: "settled" as const,
					reason: "Another controller recorded the terminal result",
					runId: run.id,
				};
			this.#store.settle(
				run.id,
				"failed",
				"Verification failed or authority expired after confirmed process termination",
				this.#deps.now(),
				termination,
			);
			return { state: "settled" as const, reason: "Verification failed or authority expired", runId: run.id };
		});
	}

	async #verify(
		run: EngineeringRun,
		outcome: WorkOutcome | undefined,
		termination: HostTerminationEvidence,
	): Promise<EngineeringTick> {
		if (!(await this.#remoteCurrent(run.id))) throw new Error("Remote verification authority unavailable");
		if (run.state !== "verifying") this.#store.beginVerification(run.id, this.#deps.now());
		const verified = await this.#deps.verify(this.#store.get(run.id), outcome);
		if (!(await this.#remoteCurrent(run.id))) throw new Error("Remote authority changed during verification");
		if (verified.verdict === "unavailable") return { state: "paused", reason: verified.reason, runId: run.id };
		if (
			verified.verdict === "pass" &&
			(!/^[a-f0-9]{64}$/.test(verified.evidenceDigest) ||
				verified.runId !== run.id ||
				verified.grantId !== run.grantId ||
				verified.baselineRevision !== run.job.sourceRevision ||
				verified.evaluatorDigest !== run.job.evaluatorDigest ||
				verified.workloadDigest !== run.job.workloadDigest ||
				!/^[a-f0-9]{40}$/.test(verified.candidateRevision) ||
				(typeof outcome?.report.head_sha === "string" && outcome.report.head_sha !== verified.candidateRevision))
		)
			throw new Error("Invalid or mismatched verifier receipt");
		this.#store.settle(
			run.id,
			verified.verdict === "pass" ? "succeeded" : "failed",
			verified.verdict === "pass" ? `Independent evidence: ${verified.evidenceDigest}` : verified.reason,
			this.#deps.now(),
			{ ...termination, ...(verified.verdict === "pass" ? { verificationDigest: verified.evidenceDigest } : {}) },
		);
		return {
			state: "settled",
			reason:
				verified.verdict === "pass"
					? "Verified engineering outcome, no acceptance or deployment implied"
					: verified.reason,
			runId: run.id,
		};
	}
}
