import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import * as Result from "effect/Result";
import { z } from "zod";
import type { ExecutionGuard, ExecutionGuardRequest } from "../work/execution-policy.ts";
import { herdrArgv } from "../work/logic.ts";
import { inspectWorkProcess, type Run, type WorkDeps, type WorkOutcome, worktreePath } from "../work/run.ts";
import type { EngineeringJob, EngineeringRun } from "./contracts.ts";
import type {
	EngineeringControllerDeps,
	EngineeringRepositoryProfile,
	HostProcessObservation,
	HostReadiness,
} from "./controller.ts";

/**
 * Live adapters for one owner machine. Every fact here comes from a host
 * probe or from a file that only the owner writes. Nothing comes from the
 * job, the task text or the worker's output.
 */

/** Settings that select a metered provider path. Their presence refuses a launch. */
export const METERED_ENVIRONMENT: ReadonlyArray<string> = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_AWS_API_KEY",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CONFIG_DIR",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
];

const argvSchema = z.array(z.string().min(1).max(400)).min(1).max(40);
const profileSchema = z.strictObject({
	id: z.enum(["harnessy-v2", "garden", "workstream"]),
	root: z.string().min(1).max(1000),
	base: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/),
	workstreamCli: argvSchema,
	agentAllow: z.string().min(1).max(2000).optional(),
	agentDeps: z.literal("clone").optional(),
	/** Commands that must pass on the exact candidate. Host-owned, never task-owned. */
	verify: z.array(argvSchema).min(1).max(12),
	verifyTimeoutMinutes: z.number().int().min(1).max(90).default(30),
});
export const hostConfigSchema = z.strictObject({
	schema: z.literal("harnessy.engineering.host.v1"),
	/** The subscription account that `claude auth status` must report. */
	accountId: z.string().min(3).max(200),
	profiles: z.array(profileSchema).min(1).max(3),
});
export type EngineeringHostConfig = z.infer<typeof hostConfigSchema>;
export type EngineeringHostProfile = EngineeringHostConfig["profiles"][number];

const extraUsageSchema = z.strictObject({
	schema: z.literal("harnessy.engineering.extra-usage.v1"),
	accountId: z.string().min(3).max(200),
	extraUsage: z.literal("off"),
	confirmedBy: z.literal("julian"),
	confirmedAt: z.number().int().positive(),
});
const pauseSchema = z.strictObject({
	schema: z.literal("harnessy.engineering.provider-pause.v1"),
	until: z.number().int().positive(),
	reason: z.string().min(1).max(300),
	recordedAt: z.number().int().positive(),
});

export const EXTRA_USAGE_CONFIRMATION_MS = 30 * 24 * 60 * 60_000;
export const EXTRA_USAGE_FILE = "extra-usage-confirmation.json";
export const PROVIDER_PAUSE_FILE = "provider-pause.json";
const DEFAULT_LIMIT_PAUSE_MS = 60 * 60_000;
const MAX_LIMIT_PAUSE_MS = 7 * 24 * 60 * 60_000;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** A private owner file: regular, owned by this user, and closed to group and others. */
const readOwnerJson = (path: string): unknown => {
	const stat = statSync(path);
	if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
		throw new Error(`${path} must be a regular file with mode 600 that this user owns`);
	if (stat.size > 65_536) throw new Error(`${path} exceeds the input limit`);
	return JSON.parse(readFileSync(path, "utf8"));
};

const writePrivateJson = (path: string, value: unknown): void => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
};

export const readHostConfig = (path: string): EngineeringHostConfig => hostConfigSchema.parse(readOwnerJson(path));

/** The evaluator identity is the exact host-owned verification rule for a repository. */
export const profileEvaluatorDigest = (profile: EngineeringHostProfile): string =>
	sha256(JSON.stringify(["harnessy.engineering.repository-checks.v1", profile.id, profile.base, profile.verify]));

/** A product task has no benchmark workload. The digest names that fact for the repository. */
export const profileWorkloadDigest = (profile: EngineeringHostProfile): string =>
	sha256(JSON.stringify(["harnessy.engineering.workload.none.v1", profile.id]));

/** Text that Claude Code prints when the subscription limit stops a request. */
const LIMIT_TEXT = /usage limit|rate limit|limit reached|out of extra usage|too many requests/i;

/**
 * Read the agent result and decide if a subscription limit stopped it. The
 * reset time is taken from an epoch in the text when one exists.
 */
export const limitPauseFromResult = (
	resultText: string,
	now: number,
): { readonly until: number; readonly reason: string } | undefined => {
	if (!LIMIT_TEXT.test(resultText)) return undefined;
	const parsed = Result.try((): unknown => JSON.parse(resultText));
	// A successful result that only mentions a limit in its prose is not a limit reply.
	if (
		Result.isSuccess(parsed) &&
		typeof parsed.success === "object" &&
		parsed.success !== null &&
		"is_error" in parsed.success &&
		parsed.success.is_error === false
	)
		return undefined;
	const epoch = /\b(1[7-9]\d{8})\b/.exec(resultText)?.[1];
	const reset = epoch === undefined ? Number.NaN : Number(epoch) * 1000;
	const until =
		Number.isFinite(reset) && reset > now && reset - now <= MAX_LIMIT_PAUSE_MS ? reset : now + DEFAULT_LIMIT_PAUSE_MS;
	return { until, reason: "The subscription limit stopped the agent" };
};

export const recordProviderPause = (stateRoot: string, until: number, reason: string, now: number): void =>
	writePrivateJson(join(stateRoot, PROVIDER_PAUSE_FILE), {
		schema: "harnessy.engineering.provider-pause.v1",
		until,
		reason,
		recordedAt: now,
	});

export interface ClaudeGuardOptions {
	readonly run: Run;
	readonly environment: Readonly<Record<string, string | undefined>>;
	/** Private controller state folder. It holds the owner confirmation and any pause. */
	readonly stateRoot: string;
	readonly now: () => number;
}

const paused = (reason: string) => ({ status: "paused" as const, reason });

/**
 * The pilot allowance rule. A permit needs all of these facts at the moment
 * of the check: no metered setting in the launcher environment, a Claude Code
 * sign-in through the subscription for the expected account, an owner
 * confirmation that extra usage is off, and no active limit pause.
 *
 * `remainingRequests` is 1 in a permit. The provider gives no remaining
 * count, so 1 means only "no limit reply is on record".
 */
export const claudeSubscriptionGuard =
	(options: ClaudeGuardOptions): ExecutionGuard =>
	async (request: ExecutionGuardRequest) => {
		const metered = METERED_ENVIRONMENT.filter((name) => (options.environment[name] ?? "") !== "");
		if (metered.length > 0) return paused(`Metered provider settings are present: ${metered.join(", ")}`);
		const pausePath = join(options.stateRoot, PROVIDER_PAUSE_FILE);
		if (existsSync(pausePath)) {
			const pause = Result.try(() => pauseSchema.parse(readOwnerJson(pausePath)));
			if (Result.isFailure(pause)) return paused("The provider pause record cannot be read");
			if (options.now() < pause.success.until)
				return paused(`${pause.success.reason}; paused until ${new Date(pause.success.until).toISOString()}`);
		}
		const confirmation = Result.try(() =>
			extraUsageSchema.parse(readOwnerJson(join(options.stateRoot, EXTRA_USAGE_FILE))),
		);
		if (Result.isFailure(confirmation)) return paused("The owner has not confirmed that extra usage billing is off");
		if (
			confirmation.success.accountId !== request.policy.accountId ||
			confirmation.success.confirmedAt > options.now() ||
			options.now() - confirmation.success.confirmedAt > EXTRA_USAGE_CONFIRMATION_MS
		)
			return paused("The extra usage confirmation is stale or names another account");
		const status = await options.run(["claude", "auth", "status"], { timeoutMs: 10_000 });
		const parsed = Result.try((): unknown => JSON.parse(status.stdout));
		if (status.exitCode !== 0 || Result.isFailure(parsed) || typeof parsed.success !== "object")
			return paused("Claude Code sign-in status is unavailable");
		const facts = (parsed.success ?? {}) as Readonly<Record<string, unknown>>;
		if (facts.loggedIn !== true || facts.authMethod !== "claude.ai" || facts.apiProvider !== "firstParty")
			return paused("Claude Code is not signed in through the subscription");
		if (typeof facts.subscriptionType !== "string" || facts.subscriptionType === "")
			return paused("Claude Code reports no subscription");
		if (facts.email !== request.policy.accountId) return paused("Claude Code is signed in with another account");
		const now = options.now();
		const loginExpiry = typeof facts.loginExpiresAt === "string" ? Date.parse(facts.loginExpiresAt) : Number.NaN;
		if (!Number.isFinite(loginExpiry) || loginExpiry <= now) return paused("The Claude Code sign-in has expired");
		return {
			status: "allowed",
			agent: request.policy.agent,
			authorityId: request.policy.authorityId,
			accountId: request.policy.accountId,
			taskId: request.taskId,
			launchId: request.policy.launchId,
			repository: request.repository,
			billing: "included-only",
			paidFallback: "disabled",
			remainingRequests: 1,
			checkedAt: now,
			validUntil: Math.min(request.policy.expiresAt, loginExpiry, now + 60_000),
		};
	};

/** Process ids whose working directory is inside `root`. Unrelated processes never match. */
export const processesUnder = async (run: Run, root: string): Promise<ReadonlyArray<number> | undefined> => {
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	const listed = await run(["lsof", "-a", "-d", "cwd", "-Fpn", "-u", String(uid)], { timeoutMs: 15_000 });
	// lsof exits 1 when some processes cannot be read; its output is still usable.
	if (listed.stdout === "" && listed.exitCode !== 0) return undefined;
	const prefix = resolve(root) + sep;
	const found: number[] = [];
	let pid: number | undefined;
	for (const line of listed.stdout.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid !== undefined) {
			const path = line.slice(1);
			if ((path === resolve(root) || path.startsWith(prefix)) && Number.isSafeInteger(pid) && pid !== process.pid)
				found.push(pid);
		}
	}
	return found;
};

export interface LiveHostOptions {
	readonly config: EngineeringHostConfig;
	readonly work: WorkDeps;
	/** Private controller state folder, outside every worktree. */
	readonly stateRoot: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
}

const profileOf = (config: EngineeringHostConfig, repository: EngineeringJob["repository"]) =>
	config.profiles.find((entry) => entry.id === repository);

const identityOf = (run: EngineeringRun): string => `harnessy-work:${run.id}`;

/** Run the host-owned commands on the exact candidate and keep their output as evidence. */
export const verifyCandidate = async (
	run: Run,
	profile: EngineeringHostProfile,
	worktree: string,
	headSha: string,
	evidenceRoot: string,
	now: () => number,
): Promise<
	| { readonly verdict: "pass"; readonly evidenceDigest: string; readonly evidencePath: string }
	| { readonly verdict: "reject"; readonly reason: string }
> => {
	const head = await run(["git", "-C", worktree, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
	if (head.exitCode !== 0 || head.stdout.trim() !== headSha)
		return { verdict: "reject", reason: "The worktree is not at the candidate revision" };
	const status = await run(["git", "-C", worktree, "status", "--porcelain"], { timeoutMs: 30_000 });
	if (status.exitCode !== 0 || status.stdout.trim() !== "")
		return { verdict: "reject", reason: "The candidate worktree has uncommitted changes" };
	const results: Array<Readonly<Record<string, unknown>>> = [];
	for (const argv of profile.verify) {
		const startedAt = now();
		const result = await run(argv, { cwd: worktree, timeoutMs: profile.verifyTimeoutMinutes * 60_000 });
		results.push({
			argv,
			exitCode: result.exitCode ?? null,
			timedOut: result.timedOut === true,
			startedAt,
			finishedAt: now(),
			stdoutDigest: sha256(result.stdout),
			stderrDigest: sha256(result.stderr),
			stdoutTail: result.stdout.slice(-4000),
			stderrTail: result.stderr.slice(-4000),
		});
		if (result.exitCode !== 0) break;
	}
	const after = await run(["git", "-C", worktree, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
	const passed =
		results.length === profile.verify.length &&
		results.every((entry) => entry.exitCode === 0) &&
		after.stdout.trim() === headSha;
	const evidence = `${JSON.stringify(
		{
			schema: "harnessy.engineering.verification.v1",
			repository: profile.id,
			candidateRevision: headSha,
			evaluatorDigest: profileEvaluatorDigest(profile),
			verdict: passed ? "pass" : "reject",
			results,
		},
		null,
		2,
	)}\n`;
	const evidencePath = join(evidenceRoot, `${headSha}-${now()}.json`);
	mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
	writeFileSync(evidencePath, evidence, { mode: 0o600 });
	return passed
		? { verdict: "pass", evidenceDigest: sha256(evidence), evidencePath }
		: { verdict: "reject", reason: `A required check failed; evidence: ${evidencePath}` };
};

/** Outcomes of the existing runner that mean "a checked pull request exists". */
const DELIVERED_HANDOFFS = new Set(["merge_timeout"]);

/** Build the controller ports for this machine. */
export const liveControllerDeps = (options: LiveHostOptions): EngineeringControllerDeps => {
	const { config, work, stateRoot } = options;
	const guard = claudeSubscriptionGuard({
		run: work.run,
		environment: options.environment,
		stateRoot,
		now: work.now,
	});
	const evidenceRoot = join(stateRoot, "verification");
	const worktreeOf = (run: EngineeringRun): string | undefined => {
		const profile = profileOf(config, run.job.repository);
		return profile === undefined ? undefined : worktreePath(resolve(profile.root), run.job.taskId);
	};
	const profiles: ReadonlyArray<EngineeringRepositoryProfile> = config.profiles.map((profile) => ({
		id: profile.id,
		root: profile.root,
		base: profile.base,
		accountId: config.accountId,
		workstreamCli: profile.workstreamCli,
		...(profile.agentAllow === undefined ? {} : { agentAllow: profile.agentAllow }),
		...(profile.agentDeps === undefined ? {} : { agentDeps: profile.agentDeps }),
	}));
	const readiness = async (
		job: EngineeringJob,
		controllerProfile: EngineeringRepositoryProfile,
	): Promise<HostReadiness> => {
		const profile = profileOf(config, job.repository);
		const blank = { sourceRevision: "", evaluatorDigest: "", workloadDigest: "" };
		if (profile === undefined) return { status: "paused", reason: "No host profile", ...blank };
		const digests = {
			evaluatorDigest: profileEvaluatorDigest(profile),
			workloadDigest: profileWorkloadDigest(profile),
		};
		const root = resolve(controllerProfile.root);
		const fetched = await work.run(["git", "-C", root, "fetch", "--quiet", "origin", profile.base], {
			timeoutMs: 120_000,
		});
		if (fetched.exitCode !== 0)
			return { status: "paused", reason: "The base branch cannot be fetched", sourceRevision: "", ...digests };
		const head = await work.run(["git", "-C", root, "rev-parse", `origin/${profile.base}`], { timeoutMs: 30_000 });
		const sourceRevision = head.exitCode === 0 ? head.stdout.trim() : "";
		if (!/^[a-f0-9]{40}$/.test(sourceRevision))
			return { status: "paused", reason: "The base revision cannot be read", sourceRevision: "", ...digests };
		for (const tool of ["herdr", "claude", "gh"]) {
			const found = await work.run(["which", tool], { timeoutMs: 10_000 });
			if (found.exitCode !== 0)
				return { status: "paused", reason: `Required tool is missing: ${tool}`, sourceRevision, ...digests };
		}
		return { status: "ready", reason: "Host probes passed", sourceRevision, ...digests };
	};
	const inspect = async (run: EngineeringRun): Promise<HostProcessObservation> => {
		const worktree = worktreeOf(run);
		if (worktree === undefined) return { state: "unknown", reason: "No host profile for the run" };
		const pane = await inspectWorkProcess(run.job.taskId, work);
		if (pane.launchId !== undefined && pane.launchId !== run.id)
			return { state: "unknown", reason: "The saved work state belongs to another launch" };
		const live = await processesUnder(work.run, worktree);
		if (live === undefined) return { state: "unknown", reason: "Host processes cannot be listed" };
		if (live.length > 0) return { state: "active", identity: identityOf(run) };
		// A pane without a completion line can still hold the agent, which keeps its own directory.
		if (pane.pane !== undefined && pane.status !== "completion-observed")
			return { state: "active", identity: identityOf(run) };
		return {
			state: "stopped",
			identity: identityOf(run),
			evidence: JSON.stringify({
				observedAt: work.now(),
				pane: pane.status,
				...(pane.exitCode === undefined ? {} : { agentExitCode: pane.exitCode }),
				processesUnderWorktree: 0,
				limit: "Processes that left the worktree directory are not observed",
			}),
		};
	};
	const cancel = async (run: EngineeringRun): Promise<void> => {
		const worktree = worktreeOf(run);
		if (worktree === undefined) return;
		const pane = await inspectWorkProcess(run.job.taskId, work);
		if (pane.pane !== undefined && (pane.launchId === undefined || pane.launchId === run.id))
			await work.run(herdrArgv.interrupt(pane.pane), { timeoutMs: 10_000 });
		// Only processes inside this run's own worktree receive a signal.
		for (const pid of (await processesUnder(work.run, worktree)) ?? [])
			Result.try(() => process.kill(pid, "SIGTERM"));
	};
	const verify: EngineeringControllerDeps["verify"] = async (run, outcome?: WorkOutcome) => {
		const profile = profileOf(config, run.job.repository);
		const worktree = worktreeOf(run);
		if (profile === undefined || worktree === undefined)
			return { verdict: "reject", reason: "No host profile for the run" };
		const resultPath = join(work.stateRoot, run.job.taskId, "result.json");
		if (existsSync(resultPath)) {
			const limit = limitPauseFromResult(readFileSync(resultPath, "utf8"), work.now());
			if (limit !== undefined) {
				recordProviderPause(stateRoot, limit.until, limit.reason, work.now());
				return { verdict: "reject", reason: limit.reason };
			}
		}
		if (outcome === undefined) return { verdict: "reject", reason: "The runner returned no outcome" };
		const report = outcome.report;
		const delivered =
			outcome.exitCode === 0 || (typeof report.reason === "string" && DELIVERED_HANDOFFS.has(report.reason));
		if (!delivered)
			return {
				verdict: "reject",
				reason: `The runner stopped: ${typeof report.reason === "string" ? report.reason : "unknown"}`,
			};
		const head = await work.run(["git", "-C", worktree, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
		const headSha = head.stdout.trim();
		if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(headSha))
			return { verdict: "reject", reason: "The candidate revision cannot be read" };
		if (typeof report.pr_url !== "string")
			return { verdict: "reject", reason: "The runner reported no pull request" };
		const checked = await verifyCandidate(work.run, profile, worktree, headSha, evidenceRoot, work.now);
		if (checked.verdict === "reject") return checked;
		return {
			verdict: "pass",
			evidenceDigest: checked.evidenceDigest,
			runId: run.id,
			grantId: run.grantId,
			baselineRevision: run.job.sourceRevision,
			candidateRevision: headSha,
			evaluatorDigest: profileEvaluatorDigest(profile),
			workloadDigest: profileWorkloadDigest(profile),
		};
	};
	const reviewCandidate: NonNullable<WorkDeps["reviewCandidate"]> = async (candidate) => {
		const profile = config.profiles.find((entry) => resolve(entry.root) === resolve(candidate.repository));
		if (profile === undefined) return { verdict: "reject", headSha: candidate.headSha, evidenceDigest: "" };
		const checked = await verifyCandidate(
			work.run,
			profile,
			candidate.worktree,
			candidate.headSha,
			evidenceRoot,
			work.now,
		);
		return {
			verdict: checked.verdict,
			headSha: candidate.headSha,
			evidenceDigest: checked.verdict === "pass" ? checked.evidenceDigest : "",
		};
	};
	return {
		now: work.now,
		profiles,
		work: { ...work, executionGuard: guard, reviewCandidate, protectedPaths: [stateRoot] },
		readiness,
		inspect,
		cancel,
		verify,
	};
};

/** One line for each service tick. A failed write stops the service. */
export const appendServiceReport = (stateRoot: string, value: unknown): void => {
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const path = join(stateRoot, "service.jsonl");
	appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
};
