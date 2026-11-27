import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import * as Result from "effect/Result";
import { z } from "zod";
import type { ExecutionGuard, ExecutionGuardRequest } from "../work/execution-policy.ts";
import { cloneArgv, gitArgv, herdrArgv, parseDepDirs } from "../work/logic.ts";
import { inspectWorkProcess, type Run, type WorkDeps, type WorkOutcome, worktreePath } from "../work/run.ts";
import {
	assembleCollection,
	collectionGate,
	collectPullRequestChecks,
	githubReadOnlySource,
	PRODUCT_REPOSITORIES,
	type ReadOnlySource,
} from "./collectors.ts";
import type { EngineeringJob, EngineeringRun } from "./contracts.ts";
import type {
	EngineeringControllerDeps,
	EngineeringRepositoryProfile,
	HostProcessObservation,
	HostReadiness,
} from "./controller.ts";
import { runAgentReview } from "./reviewer.ts";

/**
 * Live adapters for one owner machine. Every fact here comes from a host
 * probe or from a file that only the owner writes. Nothing comes from the
 * job, the task text or the worker's output.
 */

/**
 * Environment names that can select a provider, an account or a metered
 * path. The rule is a pattern, so a new switch of the same family is refused
 * without a change here. The model-choice names are the only exceptions.
 */
const PROVIDER_NAME =
	/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR$|AWS_BEARER_TOKEN_BEDROCK$|CLAUDE_CODE_API_KEY)/;
const PROVIDER_NAME_ALLOWED: ReadonlySet<string> = new Set([
	"ANTHROPIC_MODEL",
	"ANTHROPIC_SMALL_FAST_MODEL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
]);

/** Names in `environment` that the allowance rule refuses. Empty values do not count. */
export const meteredSettings = (environment: Readonly<Record<string, string | undefined>>): ReadonlyArray<string> =>
	Object.keys(environment)
		.filter(
			(name) => PROVIDER_NAME.test(name) && !PROVIDER_NAME_ALLOWED.has(name) && (environment[name] ?? "") !== "",
		)
		.sort();

/** Parse `env` output. A value that spans lines keeps only its first line, which is enough for names. */
export const parseEnvironment = (stdout: string): Readonly<Record<string, string>> =>
	Object.fromEntries(
		stdout
			.split("\n")
			.map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
			.filter((match) => match !== null)
			.map((match) => [match[1] ?? "", match[2] ?? ""]),
	);

/**
 * A collected metric that the candidate pull request head must meet. Only the
 * metrics of the required-checks collector are admitted, because only they
 * describe the exact candidate. The other collected metrics describe the
 * repository over a time window, not one candidate.
 */
const requiredMetricSchema = z.discriminatedUnion("metric", [
	/** At least this share of the required checks passed on the exact head. */
	z.strictObject({ metric: z.literal("tests.required_scenario_coverage"), threshold: z.number().min(0).max(1) }),
	/** At most this many required checks were skipped or missing on the exact head. */
	z.strictObject({ metric: z.literal("tests.skipped"), threshold: z.number().int().min(0).max(1000) }),
]);
const argvSchema = z.array(z.string().min(1).max(400)).min(1).max(40);
const relativePath = z.string().regex(/^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._@/-]{1,300}$/);
const profileSchema = z
	.strictObject({
		id: z.enum(["harnessy-v2", "garden", "workstream"]),
		/** A host checkout with installed dependencies. The agent cannot write to it. */
		root: z.string().min(1).max(1000),
		base: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/),
		workstreamCli: argvSchema,
		agentAllow: z.string().min(1).max(2000).optional(),
		agentDeps: z.literal("clone").optional(),
		/** Commands that must pass on the exact candidate. Host-owned, never task-owned. */
		verify: z.array(argvSchema).min(1).max(12),
		verifyTimeoutMinutes: z.number().int().min(1).max(90).default(30),
		/** Path prefixes that define the checks. A candidate that changes one goes to a person. */
		protected: z.array(relativePath).max(100).default([]),
		/**
		 * A second reader of each candidate, after the host commands pass. It can
		 * only block a candidate. It uses the same included subscription.
		 */
		reviewer: z.literal("claude").optional(),
		/**
		 * Collected metrics that the pull request head must meet before a run can
		 * succeed. A metric that is not observed fails the candidate. Without this
		 * field, verification is unchanged.
		 */
		requiredMetrics: z
			.array(requiredMetricSchema)
			.min(1)
			.max(2)
			.refine((entries) => new Set(entries.map((entry) => entry.metric)).size === entries.length, {
				message: "A required metric is repeated",
			})
			.optional(),
	})
	.refine((profile) => profile.requiredMetrics === undefined || profile.id !== "harnessy-v2", {
		message: "Collected metrics are qualified only for Garden and WorkStream profiles",
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
/** A limit reply without a readable reset time pauses this long, or until the owner clears it. */
export const MAX_LIMIT_PAUSE_MS = 7 * 24 * 60 * 60_000;
const SHELL_PROBE_MS = 10 * 60_000;

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

/** Check-definition files that no candidate may change, in every repository. */
const PROTECTED_BASENAME =
	/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lock|bun\.lockb|biome\.jsonc?|tsconfig[^/]*\.json|\.npmrc|pyproject\.toml|uv\.lock|Makefile)$/;

/** Changed paths that would let a candidate redefine the checks that judge it. */
export const protectedChanges = (
	profile: Pick<EngineeringHostProfile, "protected">,
	changed: ReadonlyArray<string>,
): ReadonlyArray<string> =>
	changed.filter(
		(path) =>
			path.startsWith(".github/") ||
			PROTECTED_BASENAME.test(path.slice(path.lastIndexOf("/") + 1)) ||
			profile.protected.some(
				(prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
			),
	);

/** The evaluator identity is the exact host-owned verification rule for a repository. */
export const profileEvaluatorDigest = (profile: EngineeringHostProfile): string =>
	sha256(
		JSON.stringify([
			"harnessy.engineering.repository-checks.v2",
			profile.id,
			profile.base,
			profile.verify,
			[...profile.protected].sort(),
			profile.reviewer ?? "none",
			// Appended only when present, so that a profile without the field keeps its digest.
			...(profile.requiredMetrics === undefined
				? []
				: [
						[
							"harnessy.engineering.required-metrics.v1",
							...[...profile.requiredMetrics]
								.sort((left, right) => left.metric.localeCompare(right.metric))
								.map((entry) => [entry.metric, entry.threshold]),
						],
					]),
		]),
	);

/** A product task has no benchmark workload. The digest names that fact for the repository. */
export const profileWorkloadDigest = (profile: EngineeringHostProfile): string =>
	sha256(JSON.stringify(["harnessy.engineering.workload.none.v1", profile.id]));

/** Text that Claude Code prints when the subscription limit stops a request. */
const LIMIT_TEXT = /usage limit|rate limit|limit reached|out of extra usage|too many requests/i;

/**
 * Read the agent result and decide if a subscription limit stopped it. Only
 * the `limit reached|<epoch seconds>` form gives a reset time. Any other
 * limit reply pauses for the maximum, until the owner clears it.
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
	const epoch = /limit reached\|(\d{10})(?!\d)/.exec(resultText)?.[1];
	const reset = epoch === undefined ? Number.NaN : Number(epoch) * 1000;
	const until =
		Number.isFinite(reset) && reset > now ? Math.min(reset, now + MAX_LIMIT_PAUSE_MS) : now + MAX_LIMIT_PAUSE_MS;
	return { until, reason: "The subscription limit stopped the agent" };
};

const readPause = (stateRoot: string) => {
	const path = join(stateRoot, PROVIDER_PAUSE_FILE);
	return existsSync(path) ? pauseSchema.parse(readOwnerJson(path)) : undefined;
};

/** Record a pause. An existing later pause is kept. An unreadable record is replaced. */
export const recordProviderPause = (stateRoot: string, until: number, reason: string, now: number): void => {
	const existing = Result.try(() => readPause(stateRoot));
	if (Result.isSuccess(existing) && existing.success !== undefined && existing.success.until >= until) return;
	writePrivateJson(join(stateRoot, PROVIDER_PAUSE_FILE), {
		schema: "harnessy.engineering.provider-pause.v1",
		until,
		reason,
		recordedAt: now,
	});
};

export interface ClaudeGuardOptions {
	readonly run: Run;
	readonly environment: Readonly<Record<string, string | undefined>>;
	/** Private controller state folder. It holds the owner confirmation and any pause. */
	readonly stateRoot: string;
	readonly now: () => number;
	/** The login shell that the agent pane starts. Its environment is probed too. */
	readonly shell?: string;
}

const paused = (reason: string) => ({ status: "paused" as const, reason });

/**
 * The pilot allowance rule. A permit needs all of these facts at the moment
 * of the check: no provider or account setting in the launcher environment
 * or in the login shell environment that the agent pane gets, a Claude Code
 * sign-in through the subscription for the expected account, an owner
 * confirmation that extra usage is off, and no active limit pause.
 *
 * `remainingRequests` is 1 in a permit. The provider gives no remaining
 * count, so 1 means only "no limit reply is on record".
 */
export const claudeSubscriptionGuard = (options: ClaudeGuardOptions): ExecutionGuard => {
	let shellProbe: { readonly at: number; readonly metered: ReadonlyArray<string> } | undefined;
	const shellMetered = async (): Promise<ReadonlyArray<string> | undefined> => {
		const now = options.now();
		if (shellProbe !== undefined && now >= shellProbe.at && now - shellProbe.at < SHELL_PROBE_MS)
			return shellProbe.metered;
		const shell = options.shell ?? options.environment.SHELL ?? "/bin/zsh";
		const probed = await options.run([shell, "-lic", "env"], { timeoutMs: 10_000 });
		if (probed.exitCode !== 0 || probed.timedOut === true) return undefined;
		shellProbe = { at: now, metered: meteredSettings(parseEnvironment(probed.stdout)) };
		return shellProbe.metered;
	};
	return async (request: ExecutionGuardRequest) => {
		const metered = meteredSettings(options.environment);
		if (metered.length > 0) return paused(`Provider or account settings are present: ${metered.join(", ")}`);
		const pause = Result.try(() => readPause(options.stateRoot));
		if (Result.isFailure(pause)) return paused("The provider pause record cannot be read");
		if (pause.success !== undefined && options.now() < pause.success.until)
			return paused(`${pause.success.reason}; paused until ${new Date(pause.success.until).toISOString()}`);
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
		const inShell = await shellMetered();
		if (inShell === undefined) return paused("The login shell environment cannot be read");
		if (inShell.length > 0)
			return paused(`Provider or account settings are present in the login shell: ${inShell.join(", ")}`);
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
};

/**
 * Process ids whose working directory is inside `root`. `undefined` means
 * that the list is not complete, which the caller must treat as unknown.
 */
export const processesUnder = async (run: Run, root: string): Promise<ReadonlyArray<number> | undefined> => {
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	// lsof prints real paths, so a symlink in `root` must be resolved first.
	const real = Result.try(() => realpathSync(root));
	if (Result.isFailure(real)) return undefined;
	const listed = await run(["lsof", "-a", "-d", "cwd", "-Fpn", "-u", String(uid)], { timeoutMs: 15_000 });
	// lsof exits 1 when some processes cannot be read; its output is still complete for this user.
	if (listed.timedOut === true || listed.exitCode === undefined || listed.exitCode > 1 || listed.stdout === "")
		return undefined;
	const base = real.success;
	const found: number[] = [];
	let pid: number | undefined;
	for (const line of listed.stdout.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid !== undefined) {
			const path = line.slice(1);
			if ((path === base || path.startsWith(base + sep)) && Number.isSafeInteger(pid) && pid !== process.pid)
				found.push(pid);
		}
	}
	return found;
};

/**
 * Descendants of the agent process that Harnessy started for this task. The
 * agent is the one process whose command names the task's private settings
 * file. Other processes of the owner never match, even inside the worktree.
 */
export const agentDescendants = (psOutput: string, settingsPath: string): ReadonlyArray<number> => {
	const rows = psOutput
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.filter((match) => match !== null)
		.map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: match[3] ?? "" }));
	const found = new Set<number>(rows.filter((row) => row.command.includes(settingsPath)).map((row) => row.pid));
	for (let added = true; added; ) {
		added = false;
		for (const row of rows)
			if (found.has(row.parent) && !found.has(row.pid)) {
				found.add(row.pid);
				added = true;
			}
	}
	found.delete(process.pid);
	return [...found].sort((left, right) => left - right);
};

/**
 * An idle terminal shell: a login or plain shell with no child process. The
 * runner's pane keeps such a shell in the worktree after the agent ends, and
 * it does no work. A shell that runs anything has a child, so it is not idle.
 */
export const idleShells = (psOutput: string): ReadonlySet<number> => {
	const rows = psOutput
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.filter((match) => match !== null)
		.map((match) => ({ pid: Number(match[1]), parent: Number(match[2]), command: (match[3] ?? "").trim() }));
	const parents = new Set(rows.map((row) => row.parent));
	return new Set(
		rows
			.filter((row) => /^-?(\/[\w./-]*\/)?(zsh|bash|sh|fish)$/.test(row.command) && !parents.has(row.pid))
			.map((row) => row.pid),
	);
};

export interface LiveHostOptions {
	readonly config: EngineeringHostConfig;
	/** Folder of the owner host profile. The agent may not read or edit it. */
	readonly configRoot: string;
	readonly work: WorkDeps;
	/** Private controller state folder, outside every worktree. */
	readonly stateRoot: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	/** True when the controller holds this launch in a terminal state. */
	readonly launchSettled?: (launchId: string) => boolean;
}

const profileOf = (config: EngineeringHostConfig, repository: EngineeringJob["repository"]) =>
	config.profiles.find((entry) => entry.id === repository);

const identityOf = (run: EngineeringRun): string => `harnessy-work:${run.id}`;

export interface VerifyCandidateInput {
	readonly run: Run;
	readonly platform: string;
	readonly profile: EngineeringHostProfile;
	readonly baseRevision: string;
	readonly headSha: string;
	/** Private folder for the evidence files. */
	readonly evidenceRoot: string;
	/**
	 * Private folder for the temporary export and scratch space. It must be
	 * outside every denied folder: a program resolves the real path of each
	 * parent folder of its files, and the sandbox hides the denied folders.
	 */
	readonly workRoot: string;
	/** Folders that the checks may not read: controller state, owner profile, credentials. */
	readonly deniedRoots: ReadonlyArray<string>;
	readonly now: () => number;
}

const sandboxQuote = (path: string): string => {
	if ([...path].some((character) => character.charCodeAt(0) < 32)) throw new Error("Invalid sandbox path");
	return JSON.stringify(path);
};

/**
 * Seatbelt profile for the checks. Candidate code can run inside it (tests,
 * build steps), so it gets no network, no write outside its own export and
 * scratch folders, and no read of controller state or credentials.
 */
export const verificationSandboxProfile = (
	exportRoot: string,
	scratch: string,
	deniedRoots: ReadonlyArray<string>,
): string =>
	[
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		'(deny file-write* (subpath "/"))',
		`(allow file-write* (subpath ${sandboxQuote(exportRoot)}) (subpath ${sandboxQuote(scratch)}) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
		...deniedRoots.map((path) => `(deny file-read* file-write* (subpath ${sandboxQuote(path)}))`),
		// The export and scratch folders are allowed last, after every deny rule.
		`(allow file-read* file-write* (subpath ${sandboxQuote(exportRoot)}) (subpath ${sandboxQuote(scratch)}))`,
	].join("\n");

/**
 * Judge one exact revision with the host-owned commands.
 *
 * - A candidate that changes a check definition is rejected, so that the
 *   commands mean what the host profile says.
 * - The commands run in a new export of the revision that Harnessy makes.
 *   The worker's own worktree and its copied dependencies are not used.
 * - Dependencies come from the host checkout, which the agent cannot write.
 * - Each command runs in a sandbox with an empty environment.
 */
export const verifyCandidate = async (
	input: VerifyCandidateInput,
): Promise<
	| { readonly verdict: "pass"; readonly evidenceDigest: string; readonly evidencePath: string }
	| { readonly verdict: "reject"; readonly reason: string }
> => {
	const { run, profile, headSha, baseRevision, now } = input;
	if (input.platform !== "darwin")
		return { verdict: "reject", reason: "Sandboxed verification is not qualified on this host platform" };
	if (!/^[a-f0-9]{40}$/.test(headSha) || !/^[a-f0-9]{40}$/.test(baseRevision))
		return { verdict: "reject", reason: "The candidate or base revision is not an exact commit" };
	const root = Result.try(() => realpathSync(profile.root));
	if (Result.isFailure(root)) return { verdict: "reject", reason: "The host checkout is unavailable" };
	const changed = await run(["git", "-C", root.success, "diff", "--name-only", "-z", `${baseRevision}...${headSha}`], {
		timeoutMs: 60_000,
	});
	if (changed.exitCode !== 0) return { verdict: "reject", reason: "The candidate diff cannot be read" };
	const paths = changed.stdout.split("\0").filter((path) => path !== "");
	if (paths.length === 0) return { verdict: "reject", reason: "The candidate changes nothing" };
	const protectedPaths = protectedChanges(profile, paths);
	if (protectedPaths.length > 0)
		return {
			verdict: "reject",
			reason: `The candidate changes check definitions, which needs a person: ${protectedPaths.slice(0, 5).join(", ")}`,
		};
	mkdirSync(input.evidenceRoot, { recursive: true, mode: 0o700 });
	const evidenceRoot = realpathSync(input.evidenceRoot);
	const stamp = `${headSha}-${now()}`;
	mkdirSync(input.workRoot, { recursive: true, mode: 0o700 });
	const workRoot = realpathSync(input.workRoot);
	const denied = input.deniedRoots.filter((path) => existsSync(path)).map((path) => realpathSync(path));
	if (denied.some((path) => workRoot === path || workRoot.startsWith(path + sep)))
		return { verdict: "reject", reason: "The verification work folder is inside a denied folder" };
	const exportRoot = join(workRoot, "export", stamp);
	const scratch = join(workRoot, "scratch", stamp);
	mkdirSync(dirname(exportRoot), { recursive: true, mode: 0o700 });
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const added = await run(["git", "-C", root.success, "worktree", "add", "--detach", exportRoot, headSha], {
		timeoutMs: 120_000,
	});
	if (added.exitCode !== 0) return { verdict: "reject", reason: "The candidate revision cannot be exported" };
	const results: Array<Readonly<Record<string, unknown>>> = [];
	let failure: string | undefined;
	const listed = await run(gitArgv.ignoredDirs(root.success), { timeoutMs: 120_000 });
	if (listed.exitCode !== 0) failure = "The host dependency folders cannot be listed";
	for (const path of failure === undefined ? parseDepDirs(listed.stdout) : []) {
		// A dependency folder nested in another one arrives with its parent.
		if (existsSync(join(exportRoot, path))) continue;
		mkdirSync(dirname(join(exportRoot, path)), { recursive: true });
		const copied = await run(cloneArgv(input.platform, join(root.success, path), join(exportRoot, path)).argv, {
			timeoutMs: 300_000,
		});
		if (copied.exitCode !== 0) {
			failure = `A host dependency folder cannot be copied: ${path}`;
			break;
		}
	}
	const sandbox = verificationSandboxProfile(exportRoot, realpathSync(scratch), denied);
	for (const argv of failure === undefined ? profile.verify : []) {
		const startedAt = now();
		const result = await run(
			[
				"/usr/bin/env",
				"-i",
				`PATH=${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
				`HOME=${scratch}`,
				`TMPDIR=${scratch}`,
				"LANG=C",
				"TZ=UTC",
				"CI=1",
				"/usr/bin/sandbox-exec",
				"-p",
				sandbox,
				...argv,
			],
			{ cwd: exportRoot, timeoutMs: profile.verifyTimeoutMinutes * 60_000 },
		);
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
		if (result.exitCode !== 0) {
			failure = `A required check failed: ${argv.join(" ")}`;
			break;
		}
	}
	const exported = await run(["git", "-C", exportRoot, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
	if (failure === undefined && exported.stdout.trim() !== headSha) failure = "The export moved during verification";
	await run(["git", "-C", root.success, "worktree", "remove", "--force", exportRoot], { timeoutMs: 120_000 });
	const passed = failure === undefined && results.length === profile.verify.length;
	const evidence = `${JSON.stringify(
		{
			schema: "harnessy.engineering.verification.v2",
			repository: profile.id,
			baselineRevision: baseRevision,
			candidateRevision: headSha,
			evaluatorDigest: profileEvaluatorDigest(profile),
			isolation: "macos-seatbelt: no network, writes only in a host export and scratch, empty environment",
			changedPaths: paths.length,
			verdict: passed ? "pass" : "reject",
			...(failure === undefined ? {} : { failure }),
			results,
		},
		null,
		2,
	)}\n`;
	const evidencePath = join(evidenceRoot, `${stamp}.json`);
	writeFileSync(evidencePath, evidence, { mode: 0o600 });
	return passed
		? { verdict: "pass", evidenceDigest: sha256(evidence), evidencePath }
		: { verdict: "reject", reason: `${failure ?? "Verification is incomplete"}; evidence: ${evidencePath}` };
};

const PULL_REQUEST_URL =
	/^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})\/pull\/([1-9][0-9]{0,9})$/;

export interface CandidateMetricsInput {
	/** A read-only GitHub source, normally `githubReadOnlySource`. */
	readonly source: ReadOnlySource;
	readonly profile: EngineeringHostProfile;
	/** The pull request URL from the runner's private state, not from the worker's report. */
	readonly pullRequestUrl: string;
	readonly headSha: string;
	readonly now: () => number;
}

/**
 * Judge the exact candidate pull request head with the collected metrics that
 * the profile requires.
 *
 * - The pull request must be in the declared repository of the product.
 * - Every collected value must name the candidate as the pull request head.
 * - A required metric that is not observed fails, and an observed value must
 *   meet the profile limit, as `collectionGate` decides.
 *
 * The record keeps the full collection, the requirements and the gate result.
 */
export const gateCandidateMetrics = async (
	input: CandidateMetricsInput,
): Promise<{
	readonly verdict: "pass" | "reject";
	readonly reason: string;
	readonly record?: Readonly<Record<string, unknown>>;
}> => {
	const { profile, headSha } = input;
	const requirements = profile.requiredMetrics ?? [];
	if (requirements.length === 0) return { verdict: "reject", reason: "The profile requires no collected metric" };
	if (profile.id === "harnessy-v2")
		return { verdict: "reject", reason: "Collected metrics are qualified only for Garden and WorkStream" };
	const match = PULL_REQUEST_URL.exec(input.pullRequestUrl);
	const repository = match?.[1];
	if (match === null || repository !== PRODUCT_REPOSITORIES[profile.id])
		return { verdict: "reject", reason: "The pull request is not in the declared repository of the product" };
	const pullRequest = Number(match[2]);
	// The declared base fixes the required check set: a pull request with another base fails collection.
	const collected = await collectPullRequestChecks({
		source: input.source,
		repository,
		pullRequest,
		expectedBase: profile.base,
		now: input.now,
	});
	const collection = assembleCollection({ product: profile.id, repository, collected, now: input.now });
	const subjects = collected.map((entry) => entry.provenance.subject);
	const gate = collectionGate(
		collection,
		requirements.map((entry) => ({ metricId: entry.metric, threshold: entry.threshold })),
	);
	// Each fact must be present and exact. A missing fact fails, as a different one does.
	const reasons = [
		...(subjects.some((subject) => subject.headSha !== headSha) ? ["collected_head_is_not_the_candidate"] : []),
		...(subjects.some((subject) => subject.baseRef !== profile.base)
			? ["collected_base_is_not_the_declared_base"]
			: []),
		...(subjects.some((subject) => subject.state !== "open") ? ["pull_request_is_not_open"] : []),
		...gate.reasons,
	];
	const passed = reasons.length === 0;
	const record = {
		schema: "harnessy.engineering.candidate-metrics.v1",
		repository,
		pullRequest,
		candidateRevision: headSha,
		requirements,
		verdict: passed ? "pass" : "reject",
		reasons,
		collection,
	};
	return passed
		? { verdict: "pass", reason: "Every required collected metric is observed and meets its limit", record }
		: { verdict: "reject", reason: `A required collected metric fails: ${reasons.join(", ")}`, record };
};

/**
 * Review findings that are not inline threads: each review with its state,
 * and each conversation comment. The text is kept as a digest and a short
 * start, because it is untrusted input.
 */
export const reviewDisposition = (
	pull: unknown,
): {
	readonly changesRequested: boolean;
	readonly findings: ReadonlyArray<{
		readonly kind: "review" | "comment";
		readonly author: string;
		readonly state: string;
		readonly bodyDigest: string;
		readonly bodyStart: string;
	}>;
} => {
	const value = (typeof pull === "object" && pull !== null ? pull : {}) as Readonly<Record<string, unknown>>;
	const entries = (key: string, kind: "review" | "comment") =>
		(Array.isArray(value[key]) ? value[key] : []).map((entry: unknown) => {
			const item = (typeof entry === "object" && entry !== null ? entry : {}) as Readonly<Record<string, unknown>>;
			const author = (typeof item.author === "object" && item.author !== null ? item.author : {}) as Readonly<
				Record<string, unknown>
			>;
			const body = typeof item.body === "string" ? item.body : "";
			return {
				kind,
				author: typeof author.login === "string" ? author.login.slice(0, 100) : "unknown",
				state: typeof item.state === "string" ? item.state : kind === "comment" ? "COMMENTED" : "UNKNOWN",
				bodyDigest: sha256(body),
				bodyStart: body.replace(/\s+/g, " ").slice(0, 200),
			};
		});
	const findings = [...entries("reviews", "review"), ...entries("comments", "comment")];
	// The latest review of each author counts: a later approval replaces an earlier request.
	const latest = new Map<string, string>();
	for (const finding of findings) if (finding.kind === "review") latest.set(finding.author, finding.state);
	return {
		changesRequested:
			value.reviewDecision === "CHANGES_REQUESTED" || [...latest.values()].includes("CHANGES_REQUESTED"),
		findings,
	};
};

/** Outcomes of the existing runner that mean "a checked pull request exists". */
const DELIVERED_HANDOFFS = new Set(["merge_timeout"]);

/** The few facts this module needs from the runner's private state file. */
const savedWork = (
	work: Pick<WorkDeps, "stateRoot">,
	taskId: string,
):
	| { readonly present: false }
	| {
			readonly present: true;
			readonly readable: boolean;
			readonly launchId?: string;
			readonly pushedSha?: string;
			readonly prUrl?: string;
	  } => {
	const path = join(work.stateRoot, taskId, "state.json");
	if (!existsSync(path)) return { present: false };
	const parsed = Result.try((): unknown => JSON.parse(readFileSync(path, "utf8")));
	if (Result.isFailure(parsed) || typeof parsed.success !== "object" || parsed.success === null)
		return { present: true, readable: false };
	const state = parsed.success as Readonly<Record<string, unknown>>;
	const binding = (typeof state.binding === "object" && state.binding !== null ? state.binding : {}) as Readonly<
		Record<string, unknown>
	>;
	const pr = (typeof state.pr === "object" && state.pr !== null ? state.pr : {}) as Readonly<Record<string, unknown>>;
	return {
		present: true,
		readable: true,
		...(typeof binding.launchId === "string" ? { launchId: binding.launchId } : {}),
		...(typeof state.pushedSha === "string" ? { pushedSha: state.pushedSha } : {}),
		...(typeof pr.url === "string" ? { prUrl: pr.url } : {}),
	};
};

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
	// A sibling of the state folder: private, hidden from the agent, and not hidden from the checks.
	const verificationWork = `${stateRoot}-verification-work`;
	const home = homedir();
	const deniedRoots = [
		stateRoot,
		options.configRoot,
		work.stateRoot,
		join(home, ".claude"),
		join(home, ".ssh"),
		join(home, ".config"),
		join(home, ".aws"),
		join(home, ".gnupg"),
		join(home, "Library", "Keychains"),
	];
	const settingsOf = (run: EngineeringRun): string => join(work.stateRoot, run.job.taskId, "agent-settings.json");
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
	const check = (profile: EngineeringHostProfile, baseRevision: string, headSha: string) =>
		verifyCandidate({
			run: work.run,
			platform: work.platform,
			profile,
			baseRevision,
			headSha,
			evidenceRoot,
			workRoot: verificationWork,
			deniedRoots,
			now: work.now,
		});
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
		if (work.platform !== "darwin")
			return { status: "paused", reason: "This host platform is not qualified", sourceRevision: "", ...digests };
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
		for (const tool of ["herdr", "claude", "gh", "/usr/bin/sandbox-exec"]) {
			const found = await work.run(["which", tool], { timeoutMs: 10_000 });
			if (found.exitCode !== 0)
				return { status: "paused", reason: `Required tool is missing: ${tool}`, sourceRevision, ...digests };
		}
		// The runner needs the WorkStream command. A stopped local service must pause admission,
		// not fail a reserved run and spend an attempt.
		const workstream = await work.run([...profile.workstreamCli, "--version"], { timeoutMs: 30_000 });
		if (workstream.exitCode !== 0)
			return { status: "paused", reason: "The WorkStream command is unavailable", sourceRevision, ...digests };
		if (job.proofOnlyResume === undefined || job.sourceRevision === sourceRevision)
			return { status: "ready", reason: "Host probes passed", sourceRevision, ...digests };
		// Exit 0 means ancestor, exit 1 means not an ancestor; any other exit fails closed.
		const ancestor = await work.run(
			["git", "-C", root, "merge-base", "--is-ancestor", job.sourceRevision, sourceRevision],
			{ timeoutMs: 30_000 },
		);
		return {
			status: "ready",
			reason: "Host probes passed",
			sourceRevision,
			pinnedSourceIsAncestor: ancestor.exitCode === 0,
			...digests,
		};
	};
	/** Record a limit reply as soon as a stopped agent is seen, on every settlement path. */
	const noteLimit = (taskId: string): boolean => {
		const resultPath = join(work.stateRoot, taskId, "result.json");
		if (!existsSync(resultPath)) return true;
		const limit = limitPauseFromResult(readFileSync(resultPath, "utf8"), work.now());
		if (limit === undefined) return true;
		return Result.isSuccess(Result.try(() => recordProviderPause(stateRoot, limit.until, limit.reason, work.now())));
	};
	const inspect = async (run: EngineeringRun): Promise<HostProcessObservation> => {
		const worktree = worktreeOf(run);
		if (worktree === undefined) return { state: "unknown", reason: "No host profile for the run" };
		const saved = savedWork(work, run.job.taskId);
		// The runner refuses a task whose saved state belongs to another launch, before any effect.
		// When that other launch is settled and this runner has returned, the saved state says
		// nothing about this run, and only the process checks below decide.
		const foreign =
			saved.present &&
			saved.readable &&
			saved.launchId !== undefined &&
			saved.launchId !== run.id &&
			run.runnerReturned &&
			options.launchSettled?.(saved.launchId) === true;
		if (saved.present && !foreign && (!saved.readable || saved.launchId !== run.id))
			return { state: "unknown", reason: "The saved work state is unreadable or belongs to another launch" };
		const table = await work.run(["ps", "-A", "-o", "pid=,ppid=,command="], { timeoutMs: 15_000 });
		if (table.exitCode !== 0 || table.timedOut === true || table.stdout === "")
			return { state: "unknown", reason: "Host processes cannot be listed" };
		if (agentDescendants(table.stdout, settingsOf(run)).length > 0)
			return { state: "active", identity: identityOf(run) };
		const under = existsSync(worktree) ? await processesUnder(work.run, worktree) : [];
		if (under === undefined) return { state: "unknown", reason: "Host processes cannot be listed" };
		const idle = idleShells(table.stdout);
		const live = under.filter((pid) => !idle.has(pid));
		if (live.length > 0) return { state: "active", identity: identityOf(run) };
		let paneStatus = "no work state";
		let agentExitCode: number | undefined;
		if (foreign)
			paneStatus = `no work state of this launch; the saved state belongs to settled launch ${saved.launchId}`;
		else if (saved.present) {
			const pane = await inspectWorkProcess(run.job.taskId, work);
			paneStatus = pane.status;
			if (pane.status === "unknown") {
				if (pane.pane === undefined) return { state: "unknown", reason: "The saved work state cannot be read" };
				// A recorded pane without its completion line can still hold the agent. It is idle
				// only when the terminal itself reports that its shell is the one foreground process.
				const info = await work.run(["herdr", "pane", "process-info", "--pane", pane.pane], { timeoutMs: 10_000 });
				const parsed = Result.try((): unknown => JSON.parse(info.stdout));
				const facts =
					info.exitCode === 0 && Result.isSuccess(parsed)
						? (parsed.success as { result?: { process_info?: Record<string, unknown> } }).result?.process_info
						: undefined;
				const foreground = Array.isArray(facts?.foreground_processes) ? facts.foreground_processes : undefined;
				const idlePane =
					typeof facts?.shell_pid === "number" &&
					foreground !== undefined &&
					foreground.length > 0 &&
					foreground.every(
						(entry: unknown) =>
							typeof entry === "object" && entry !== null && "pid" in entry && entry.pid === facts.shell_pid,
					) &&
					idle.has(facts.shell_pid);
				if (!idlePane) return { state: "active", identity: identityOf(run) };
				paneStatus = "idle shell, no completion line";
			}
			agentExitCode = pane.exitCode;
		} else if (!run.runnerReturned)
			// Without any saved state, only a returned runner shows that nothing was launched.
			return { state: "unknown", reason: "The runner has not returned and saved no work state" };
		if (!noteLimit(run.job.taskId)) return { state: "unknown", reason: "A provider limit pause cannot be recorded" };
		return {
			state: "stopped",
			identity: identityOf(run),
			evidence: JSON.stringify({
				observedAt: work.now(),
				pane: paneStatus,
				...(agentExitCode === undefined ? {} : { agentExitCode }),
				agentProcesses: 0,
				processesUnderWorktree: 0,
				idleShellsUnderWorktree: under.length,
				limit: "A process that left the agent's process tree and the worktree directory is not observed",
			}),
		};
	};
	const cancel = async (run: EngineeringRun): Promise<void> => {
		const saved = savedWork(work, run.job.taskId);
		// Another launch, or a manual run of the same task, is never interrupted.
		if (!saved.present || !saved.readable || saved.launchId !== run.id) return;
		const pane = await inspectWorkProcess(run.job.taskId, work);
		if (pane.pane !== undefined) await work.run(herdrArgv.interrupt(pane.pane), { timeoutMs: 10_000 });
		const table = await work.run(["ps", "-A", "-o", "pid=,ppid=,command="], { timeoutMs: 15_000 });
		if (table.exitCode !== 0) return;
		// Only the agent that Harnessy started for this task, and its descendants, receive a signal.
		for (const pid of agentDescendants(table.stdout, settingsOf(run))) Result.try(() => process.kill(pid, "SIGTERM"));
	};
	const verify: EngineeringControllerDeps["verify"] = async (run, outcome?: WorkOutcome) => {
		const profile = profileOf(config, run.job.repository);
		if (profile === undefined) return { verdict: "reject", reason: "No host profile for the run" };
		const pause = Result.try(() => readPause(stateRoot));
		if (Result.isFailure(pause) || (pause.success !== undefined && pause.success.recordedAt >= run.reservedAt))
			return { verdict: "reject", reason: "A subscription limit stopped the agent" };
		if (outcome === undefined) return { verdict: "reject", reason: "The runner returned no outcome" };
		const report = outcome.report;
		// The runner's own report is kept, so that a stopped run can be understood later.
		writePrivateJson(join(stateRoot, "outcomes", `${run.id}.json`), {
			schema: "harnessy.engineering.runner-outcome.v1",
			runId: run.id,
			recordedAt: work.now(),
			exitCode: outcome.exitCode,
			report,
		});
		const delivered =
			outcome.exitCode === 0 || (typeof report.reason === "string" && DELIVERED_HANDOFFS.has(report.reason));
		if (!delivered)
			return {
				verdict: "reject",
				reason: `The runner stopped: ${typeof report.reason === "string" ? report.reason : typeof report.status === "string" ? report.status : "unknown"}${typeof report.detail === "string" ? ` (${report.detail.slice(0, 300)})` : ""}`,
			};
		// The candidate is the revision that Harnessy pushed, from its own private state.
		const saved = savedWork(work, run.job.taskId);
		if (!saved.present || !saved.readable || saved.launchId !== run.id)
			return { verdict: "reject", reason: "The saved work state does not belong to this run" };
		const headSha = saved.pushedSha ?? "";
		if (!/^[a-f0-9]{40}$/.test(headSha) || saved.prUrl === undefined || report.pr_url !== saved.prUrl)
			return { verdict: "reject", reason: "No pushed candidate with a pull request is on record" };
		const pull = await work.run(
			["gh", "pr", "view", saved.prUrl, "--json", "headRefOid,baseRefName,state,reviewDecision,reviews,comments"],
			{ timeoutMs: 60_000 },
		);
		const pullFacts = Result.try((): unknown => JSON.parse(pull.stdout));
		if (
			pull.exitCode !== 0 ||
			Result.isFailure(pullFacts) ||
			typeof pullFacts.success !== "object" ||
			pullFacts.success === null ||
			!("headRefOid" in pullFacts.success) ||
			pullFacts.success.headRefOid !== headSha
		)
			return { verdict: "reject", reason: "The pull request head is not the pushed candidate" };
		// Review summaries and conversation comments are findings outside inline threads. They are
		// kept with the run, and a request for changes rejects the outcome.
		const disposition = reviewDisposition(pullFacts.success);
		writePrivateJson(join(stateRoot, "reviews", `${run.id}.json`), {
			schema: "harnessy.engineering.review-disposition.v1",
			runId: run.id,
			candidateRevision: headSha,
			recordedAt: work.now(),
			...disposition,
		});
		if (disposition.changesRequested)
			return { verdict: "reject", reason: "A reviewer requested changes on the pull request" };
		// The pull request must target the declared base, whose rules judge it.
		if (!("baseRefName" in pullFacts.success) || pullFacts.success.baseRefName !== profile.base)
			return { verdict: "reject", reason: "The pull request base is not the declared base" };
		const checked = await check(profile, run.job.sourceRevision, headSha);
		if (checked.verdict === "reject") return checked;
		let evidenceDigest = checked.evidenceDigest;
		if (profile.requiredMetrics !== undefined) {
			// The collected metrics read the checks of the exact pull request head, after the host commands pass.
			const gated = await gateCandidateMetrics({
				source: githubReadOnlySource(work.run),
				profile,
				pullRequestUrl: saved.prUrl,
				headSha,
				now: work.now,
			}).catch((cause: unknown) => ({
				verdict: "reject" as const,
				reason: `The collected metrics cannot be read: ${(cause instanceof Error ? cause.message : "unknown error").slice(0, 200)}`,
				record: undefined,
			}));
			if (gated.record === undefined) return { verdict: "reject", reason: gated.reason };
			const text = `${JSON.stringify({ runId: run.id, recordedAt: work.now(), ...gated.record }, null, 2)}\n`;
			const path = join(stateRoot, "collections", `${run.id}.json`);
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, text, { mode: 0o600 });
			chmodSync(path, 0o600);
			if (gated.verdict === "reject") return { verdict: "reject", reason: `${gated.reason}; evidence: ${path}` };
			// The receipt binds the host-command evidence and the collection record together.
			evidenceDigest = sha256(JSON.stringify([checked.evidenceDigest, sha256(text)]));
		}
		return {
			verdict: "pass",
			evidenceDigest,
			runId: run.id,
			grantId: run.grantId,
			baselineRevision: run.job.sourceRevision,
			candidateRevision: headSha,
			evaluatorDigest: profileEvaluatorDigest(profile),
			workloadDigest: profileWorkloadDigest(profile),
		};
	};
	const reviewCandidate: NonNullable<WorkDeps["reviewCandidate"]> = async (candidate) => {
		const rejected = { verdict: "reject" as const, headSha: candidate.headSha, evidenceDigest: "" };
		const profile = config.profiles.find((entry) => resolve(entry.root) === resolve(candidate.repository));
		if (profile === undefined) return rejected;
		const base = await work.run(
			["git", "-C", resolve(profile.root), "merge-base", `origin/${profile.base}`, candidate.headSha],
			{ timeoutMs: 30_000 },
		);
		if (base.exitCode !== 0) return rejected;
		const checked = await check(profile, base.stdout.trim(), candidate.headSha);
		if (checked.verdict !== "pass") return rejected;
		if (profile.reviewer === "claude") {
			const diff = await work.run(
				["git", "-C", resolve(profile.root), "diff", "--no-color", `${base.stdout.trim()}...${candidate.headSha}`],
				{ timeoutMs: 60_000 },
			);
			if (diff.exitCode !== 0) return rejected;
			mkdirSync(verificationWork, { recursive: true, mode: 0o700 });
			const outcome = await runAgentReview(work.run, diff.stdout, verificationWork);
			// A limit reply in the reviewer's output pauses the loop like one from the worker.
			const limit = limitPauseFromResult(outcome.output, work.now());
			if (limit !== undefined) recordProviderPause(stateRoot, limit.until, limit.reason, work.now());
			writePrivateJson(join(stateRoot, "agent-reviews", `${candidate.headSha}-${work.now()}.json`), {
				schema: "harnessy.engineering.agent-review.v1",
				candidateRevision: candidate.headSha,
				baselineRevision: base.stdout.trim(),
				status: outcome.status,
				...(outcome.status === "reviewed" ? { review: outcome.review } : { reason: outcome.reason }),
				note: "The reviewer can only block. The host commands in the sandbox are the authority.",
			});
			if (outcome.status !== "reviewed" || outcome.review.verdict !== "pass") return rejected;
		}
		return { verdict: "pass", headSha: candidate.headSha, evidenceDigest: checked.evidenceDigest };
	};
	return {
		now: work.now,
		profiles,
		work: {
			...work,
			executionGuard: guard,
			reviewCandidate,
			protectedPaths: [stateRoot, verificationWork, options.configRoot],
		},
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
