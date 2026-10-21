import * as Result from "effect/Result";

/**
 * Pure building blocks for `harnessy work`: tool requirements, argv builders,
 * output parsers, the stop rule and the proof shape. Nothing here spawns a
 * process or touches the filesystem, so every rule is unit-testable.
 */

/** One external tool the build loop needs before it touches any task. */
export interface WorkTool {
	/** Stable name used in reports and install hints. */
	readonly name: string;
	/** Executable resolved from PATH. The WorkStream entry is replaced by `--workstream-cli`. */
	readonly executable: string;
	/** Read-only arguments that prove the tool runs. */
	readonly probeArgs: ReadonlyArray<string>;
	/** Minimum semantic version, when the loop depends on newer behavior. */
	readonly minVersion?: string;
	/** Install hint per `process.platform`, with `default` as the fallback. */
	readonly install: Readonly<Record<string, string>>;
}

/**
 * Tools required by `harnessy work`. Kept as one declarative constant so it can
 * move into a capability manifest that `harnessy deps check` reads.
 */
export const WORK_TOOLS: ReadonlyArray<WorkTool> = [
	{
		name: "herdr",
		executable: "herdr",
		probeArgs: ["--version"],
		minVersion: "0.9.0",
		install: {
			darwin: "brew install herdr",
			linux: "curl -fsSL https://herdr.dev/install.sh | sh",
			default: "See https://herdr.dev for install instructions",
		},
	},
	{
		name: "claude",
		executable: "claude",
		probeArgs: ["--version"],
		install: { default: "npm i -g @anthropic-ai/claude-code" },
	},
	{
		name: "gh",
		executable: "gh",
		probeArgs: ["--version"],
		install: {
			darwin: "brew install gh",
			default: "See https://github.com/cli/cli#installation",
		},
	},
	{
		name: "git",
		executable: "git",
		probeArgs: ["--version"],
		install: { darwin: "xcode-select --install", default: "Install git with the system package manager" },
	},
	{
		name: "workstream",
		executable: "workstream",
		probeArgs: ["--help"],
		install: { default: "Install the WorkStream CLI from the workstream repository (cli/)" },
	},
];

/** Result of one preflight probe. */
export interface ToolCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly version?: string;
	readonly problem?: string;
	readonly hint?: string;
}

/** First `x.y.z` in a version banner such as `herdr 0.9.1` or `2.1.3 (Claude Code)`. */
export const parseVersion = (output: string): string | undefined => /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0];

/** Numeric `x.y.z` comparison; returns a negative, zero or positive number. */
export const compareVersions = (left: string, right: string): number => {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
};

/** Install hint for one tool on one platform. */
export const installHint = (tool: WorkTool, platform: string): string =>
	tool.install[platform] ?? tool.install.default ?? `Install ${tool.name}`;

/** Judge one probe. `exitCode` is undefined when the executable could not be spawned. */
export const checkTool = (
	tool: WorkTool,
	probe: { readonly exitCode: number | undefined; readonly stdout: string; readonly stderr: string },
	platform: string,
): ToolCheck => {
	const failed = (problem: string, version?: string): ToolCheck => ({
		name: tool.name,
		ok: false,
		problem,
		hint: installHint(tool, platform),
		...(version === undefined ? {} : { version }),
	});
	if (probe.exitCode === undefined) return failed("not found on PATH");
	if (probe.exitCode !== 0) return failed(`probe exited ${probe.exitCode}`);
	const version = parseVersion(`${probe.stdout}\n${probe.stderr}`);
	if (tool.minVersion !== undefined) {
		if (version === undefined) return failed(`version unknown; ${tool.minVersion} or newer required`);
		if (compareVersions(version, tool.minVersion) < 0)
			return failed(`version ${version} is older than ${tool.minVersion}`, version);
	}
	return { name: tool.name, ok: true, ...(version === undefined ? {} : { version }) };
};

/** Split `--workstream-cli` on whitespace into an argv prefix. */
export const splitCli = (value: string): ReadonlyArray<string> => {
	const parts = value
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0);
	if (parts.length === 0) throw new Error("--workstream-cli must name an executable");
	return parts;
};

/** WorkStream argv builders. Every call asks for JSON output. */
export const wsArgv = {
	show: (ws: ReadonlyArray<string>, task: string) => [...ws, "-o", "json", "task", "show", task],
	claim: (ws: ReadonlyArray<string>, task: string, key: string) => [
		...ws,
		"-o",
		"json",
		"task",
		"claim",
		task,
		"--idempotency-key",
		key,
	],
	start: (ws: ReadonlyArray<string>, task: string, key: string) => [
		...ws,
		"-o",
		"json",
		"task",
		"start",
		task,
		"--idempotency-key",
		key,
	],
	prepare: (
		ws: ReadonlyArray<string>,
		input: {
			readonly task: string;
			readonly assignment: string;
			readonly summary: string;
			readonly attestation: string;
			readonly file: string;
			readonly key: string;
		},
	) => [
		...ws,
		"-o",
		"json",
		"task",
		"prepare",
		input.task,
		"--assignment",
		input.assignment,
		"--summary",
		input.summary,
		"--attestation",
		input.attestation,
		"--file",
		input.file,
		"--idempotency-key",
		input.key,
	],
	submit: (
		ws: ReadonlyArray<string>,
		input: {
			readonly task: string;
			readonly assignment: string;
			readonly admission: string;
			readonly summary: string;
			readonly attestation: string;
		},
	) => [
		...ws,
		"-o",
		"json",
		"task",
		"submit",
		input.task,
		"--assignment",
		input.assignment,
		"--admission",
		input.admission,
		"--summary",
		input.summary,
		"--attestation",
		input.attestation,
	],
};

/** git argv builders. */
export const gitArgv = {
	fetch: (repo: string) => ["git", "-C", repo, "fetch", "origin"],
	worktreeAdd: (repo: string, worktree: string, branch: string, base: string) => [
		"git",
		"-C",
		repo,
		"worktree",
		"add",
		worktree,
		"-b",
		branch,
		`origin/${base}`,
	],
	newCommitCount: (worktree: string, base: string) => [
		"git",
		"-C",
		worktree,
		"rev-list",
		"--count",
		`origin/${base}..HEAD`,
	],
	head: (worktree: string) => ["git", "-C", worktree, "rev-parse", "HEAD"],
	push: (worktree: string, branch: string) => ["git", "-C", worktree, "push", "-u", "origin", branch],
};

/** gh argv builders. Callers run them with the worktree as cwd. */
export const ghArgv = {
	repo: () => ["gh", "repo", "view", "--json", "nameWithOwner"],
	prCreate: (base: string, branch: string, title: string, bodyFile: string) => [
		"gh",
		"pr",
		"create",
		"--base",
		base,
		"--head",
		branch,
		"--title",
		title,
		"--body-file",
		bodyFile,
	],
	checksWatch: (pr: number) => ["gh", "pr", "checks", String(pr), "--watch"],
	prList: (branch: string) => [
		"gh",
		"pr",
		"list",
		"--head",
		branch,
		"--state",
		"all",
		"--json",
		"number,url",
		"--limit",
		"1",
	],
	runList: (commit: string) => [
		"gh",
		"run",
		"list",
		"--commit",
		commit,
		"--json",
		"url,conclusion,headSha",
		"--limit",
		"1",
	],
	prView: (pr: number) => ["gh", "pr", "view", String(pr), "--json", "state,mergedAt,mergeCommit,headRefOid"],
};

/** Literal printed by the pane run line; the regex cannot match the echoed command (`$?`). */
export const EXIT_MARKER = "HSY_WORK_EXIT=";
export const EXIT_MARKER_REGEX = "HSY_WORK_EXIT=[0-9]+";

/** herdr 0.9.x argv builders. */
export const herdrArgv = {
	workspaceCreate: (cwd: string, task: string) => [
		"herdr",
		"workspace",
		"create",
		"--cwd",
		cwd,
		"--label",
		`work-${task}`,
		"--no-focus",
	],
	paneRun: (pane: string, line: string) => ["herdr", "pane", "run", pane, line],
	waitOutput: (pane: string, timeoutMs: number) => [
		"herdr",
		"pane",
		"wait-output",
		pane,
		"--regex",
		EXIT_MARKER_REGEX,
		"--timeout",
		String(timeoutMs),
	],
	interrupt: (pane: string) => ["herdr", "pane", "send-keys", pane, "ctrl+c"],
};

/** Structured output the agent must return. */
export const AGENT_RESULT_SCHEMA = {
	type: "object",
	properties: {
		outcome: { type: "string", enum: ["done", "blocked"] },
		reason: { type: "string" },
	},
	required: ["outcome", "reason"],
	additionalProperties: false,
} as const;

/** Git commands the unattended agent may run; everything else that would prompt is denied. */
export const AGENT_ALLOWED_TOOLS =
	"Bash(git add *),Bash(git commit *),Bash(git status *),Bash(git diff *),Bash(git log *)";
export const AGENT_DISALLOWED_TOOLS = "Bash(git push *)";

const SHELL_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** POSIX single-quote one word for the herdr pane line. */
export const shellWord = (word: string): string =>
	word !== "" && SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/**
 * The only shell string in the loop: herdr types it into an interactive pane.
 * Paths are relative to the pane cwd (the task worktree) and every word is
 * quoted, so task text never reaches the shell.
 */
export const agentRunLine = (budgetUsd: number, extraAllowedTools?: string): string => {
	const argv = [
		"claude",
		"-p",
		"--max-budget-usd",
		String(budgetUsd),
		"--output-format",
		"json",
		"--permission-mode",
		"acceptEdits",
		"--permission-prompts",
		"none",
		"--allowedTools",
		extraAllowedTools === undefined || extraAllowedTools.trim() === ""
			? AGENT_ALLOWED_TOOLS
			: `${AGENT_ALLOWED_TOOLS},${extraAllowedTools.trim()}`,
		"--disallowedTools",
		AGENT_DISALLOWED_TOOLS,
		"--json-schema",
		JSON.stringify(AGENT_RESULT_SCHEMA),
	];
	return `${argv.map(shellWord).join(" ")} < .harnessy-work/prompt.md > .harnessy-work/result.json; echo ${EXIT_MARKER}$?`;
};

/** Exit code from the matched `HSY_WORK_EXIT=<n>` line in herdr's wait-output JSON. */
export const parseExitMarker = (waitOutputJson: string): number | undefined => {
	const value = parseJson(waitOutputJson);
	const line = field(field(value, "result"), "matched_line");
	const match = typeof line === "string" ? /HSY_WORK_EXIT=(\d+)/.exec(line) : null;
	return match?.[1] === undefined ? undefined : Number(match[1]);
};

/** WorkStream task fields the prompt and PR need. */
export interface WorkTask {
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly acceptanceCriteria?: string;
}

/** Parse `task show -o json`. */
export const parseTask = (json: string, id: string): WorkTask => {
	const value = parseJson(json);
	const title = field(value, "title");
	const description = field(value, "description");
	if (typeof title !== "string" || typeof description !== "string")
		throw new Error("WorkStream task show returned no title or description");
	const acceptance = field(value, "acceptance_criteria");
	return { id, title, description, ...(typeof acceptance === "string" ? { acceptanceCriteria: acceptance } : {}) };
};

/** Assignment id from `task claim -o json` (`{task, assignment:{id}}`). */
export const parseAssignment = (json: string): string => {
	const id = field(field(parseJson(json), "assignment"), "id");
	if (typeof id !== "string" || id === "") throw new Error("WorkStream task claim returned no assignment id");
	return id;
};

/** Preparation receipt from `task prepare -o json`. */
export interface Preparation {
	readonly status: string;
	readonly admissionId?: string;
}

/** Statuses after which replaying the same preparation cannot become ready. */
export const TERMINAL_PREPARATION_STATUSES: ReadonlySet<string> = new Set([
	"conflict",
	"integrity_mismatch",
	"missing",
	"absent_replay_required",
	"stale",
]);

export const parsePreparation = (json: string): Preparation => {
	const value = parseJson(json);
	const status = field(value, "submission_bundle_preparation_status");
	if (typeof status !== "string") throw new Error("WorkStream task prepare returned no status");
	const admission = field(value, "admission_id");
	return { status, ...(typeof admission === "string" ? { admissionId: admission } : {}) };
};

/** Parsed agent `result.json` or the reason it cannot be trusted. */
export type AgentResult =
	| {
			readonly ok: true;
			readonly costUsd: number;
			readonly outcome: "done" | "blocked";
			readonly reason: string;
			readonly isError: boolean;
	  }
	| { readonly ok: false; readonly problem: "missing" | "malformed"; readonly detail: string };

/**
 * Parse Claude Code `--output-format json` output. The outcome comes from
 * `structured_output` (set by `--json-schema`), falling back to a JSON
 * `result` string.
 */
export const parseAgentResult = (text: string | undefined): AgentResult => {
	if (text === undefined || text.trim() === "")
		return { ok: false, problem: "missing", detail: "result.json is missing or empty" };
	const value = parseJson(text);
	if (value === undefined) return { ok: false, problem: "malformed", detail: "result.json is not JSON" };
	const cost = field(value, "total_cost_usd");
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
		return { ok: false, problem: "malformed", detail: "result.json has no total_cost_usd" };
	let structured = field(value, "structured_output");
	if (structured === undefined) {
		const result = field(value, "result");
		structured = typeof result === "string" ? parseJson(result) : undefined;
	}
	const outcome = field(structured, "outcome");
	const reason = field(structured, "reason");
	if ((outcome !== "done" && outcome !== "blocked") || typeof reason !== "string")
		return { ok: false, problem: "malformed", detail: "result.json has no outcome of done or blocked" };
	return { ok: true, costUsd: cost, outcome, reason, isError: field(value, "is_error") === true };
};

/** Why a run stops before any push. */
export type HandoffReason =
	| "timeout"
	| "agent_exit_nonzero"
	| "result_missing"
	| "result_malformed"
	| "agent_error"
	| "over_budget"
	| "blocked"
	| "no_commits"
	| "pr_closed"
	| "merge_timeout"
	| "ci_unresolved"
	| "preparation_failed"
	| "preparation_timeout";

export type StopDecision =
	| { readonly kind: "continue"; readonly costUsd: number; readonly reason: string }
	| { readonly kind: "handoff"; readonly reason: HandoffReason; readonly detail: string; readonly costUsd?: number };

/** Evidence collected after the agent pane returns or times out. */
export interface AgentEvidence {
	readonly timedOut: boolean;
	readonly exitCode?: number;
	readonly resultText?: string;
	readonly budgetUsd: number;
	readonly newCommits: number;
}

/** The stop rule. The first matching condition wins; only `continue` may push. */
export const evaluateStopRule = (evidence: AgentEvidence): StopDecision => {
	if (evidence.timedOut) return { kind: "handoff", reason: "timeout", detail: "wall-clock limit reached" };
	if (evidence.exitCode !== 0)
		return {
			kind: "handoff",
			reason: "agent_exit_nonzero",
			detail: `agent exited ${evidence.exitCode ?? "unknown"}`,
		};
	const result = parseAgentResult(evidence.resultText);
	if (!result.ok)
		return {
			kind: "handoff",
			reason: result.problem === "missing" ? "result_missing" : "result_malformed",
			detail: result.detail,
		};
	const costUsd = result.costUsd;
	if (result.isError) return { kind: "handoff", reason: "agent_error", detail: result.reason, costUsd };
	if (costUsd > evidence.budgetUsd)
		return {
			kind: "handoff",
			reason: "over_budget",
			detail: `cost ${costUsd} USD exceeds budget ${evidence.budgetUsd} USD`,
			costUsd,
		};
	if (result.outcome === "blocked") return { kind: "handoff", reason: "blocked", detail: result.reason, costUsd };
	if (evidence.newCommits <= 0)
		return { kind: "handoff", reason: "no_commits", detail: "agent made no new commits", costUsd };
	return { kind: "continue", costUsd, reason: result.reason };
};

/** Attestation sent with both prepare and submit. */
export const ATTESTATION =
	"Original work; no confidential client data, credentials or copied source material; rights_confirmed.";

/** WorkStream packet text must be printable ASCII without edge whitespace. */
export const packetSummary = (title: string, task: string): string => {
	const ascii = title
		.replace(/[^\x20-\x7e]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200)
		.trim();
	return ascii === "" ? `Harnessy work for task ${task}` : ascii;
};

/** Prompt written to `<worktree>/.harnessy-work/prompt.md`. */
export const agentPrompt = (task: WorkTask): string =>
	[
		`# ${task.title}`,
		"",
		`WorkStream task: ${task.id}`,
		"",
		"## Description",
		"",
		task.description,
		...(task.acceptanceCriteria === undefined ? [] : ["", "## Acceptance criteria", "", task.acceptanceCriteria]),
		"",
		"## Instructions",
		"",
		"- Make the change this task asks for in the current repository.",
		"- Run the tests relevant to the change and fix failures. If your permissions deny a test command, say so in the reason; CI runs the full suite.",
		"- Commit the change with `git commit`. Do not push and do not open a pull request.",
		"- Do not add or commit anything under `.harnessy-work/`.",
		'- Finish with outcome "done" when the change is committed and tested.',
		'- Finish with outcome "blocked" and a short reason when you cannot complete the task safely.',
		"",
	].join("\n");

/** Pull request body. */
export const prBody = (task: WorkTask, taskUrl: string | undefined, costUsd: number, agentReason: string): string =>
	[
		"## Summary",
		"",
		`Automated change for WorkStream task ${taskUrl === undefined ? `\`${task.id}\`` : `[${task.id}](${taskUrl})`}: ${task.title}`,
		"",
		"## Agent report",
		"",
		agentReason,
		"",
		`Agent cost: ${costUsd} USD.`,
		"",
		"Opened by `harnessy work`. Review and merge to let the loop submit proof to WorkStream.",
		"",
	].join("\n");

/** Pull request number from the URL `gh pr create` prints. */
export const parsePrUrl = (stdout: string): { readonly url: string; readonly number: number } => {
	const match = /(https:\/\/\S+\/pull\/(\d+))/.exec(stdout);
	if (match?.[1] === undefined || match[2] === undefined) throw new Error("gh pr create printed no pull request URL");
	return { url: match[1], number: Number(match[2]) };
};

/** CI run for `headSha` from `gh run list --json url,conclusion,headSha`; conclusion is "" while it runs. */
export const parseRunList = (
	json: string,
	headSha: string,
): { readonly url: string; readonly conclusion: string } | undefined => {
	const value = parseJson(json);
	const first: unknown = Array.isArray(value) ? value[0] : undefined;
	const url = field(first, "url");
	const conclusion = field(first, "conclusion");
	if (typeof url !== "string" || field(first, "headSha") !== headSha) return undefined;
	return { url, conclusion: typeof conclusion === "string" ? conclusion : "" };
};

/** Existing PR for the work branch from `gh pr list --head <branch> --state all --json number,url`. */
export const parsePrList = (json: string): { readonly url: string; readonly number: number } | undefined => {
	const value = parseJson(json);
	const first: unknown = Array.isArray(value) ? value[0] : undefined;
	const url = field(first, "url");
	const number = field(first, "number");
	return typeof url === "string" && typeof number === "number" ? { url, number } : undefined;
};

/** Pull request state from `gh pr view --json state,mergedAt,mergeCommit,headRefOid`. */
export interface PrState {
	readonly state: string;
	readonly mergeCommitSha?: string;
	readonly headSha?: string;
}

export const parsePrView = (json: string): PrState => {
	const value = parseJson(json);
	const state = field(value, "state");
	if (typeof state !== "string") throw new Error("gh pr view returned no state");
	const merge = field(field(value, "mergeCommit"), "oid");
	const head = field(value, "headRefOid");
	return {
		state,
		...(typeof merge === "string" ? { mergeCommitSha: merge } : {}),
		...(typeof head === "string" ? { headSha: head } : {}),
	};
};

/** `owner/name` from `gh repo view --json nameWithOwner`. */
export const parseRepoName = (json: string): string => {
	const name = field(parseJson(json), "nameWithOwner");
	if (typeof name !== "string") throw new Error("gh repo view returned no nameWithOwner");
	return name;
};

/** Proof submitted to WorkStream inside `proof.zip`. */
export interface WorkProof {
	readonly schema: "harnessy.work.proof.v1";
	readonly task_id: string;
	readonly repo: string;
	readonly commit_sha: string;
	readonly merge_commit_sha: string;
	readonly pr_url: string;
	readonly ci_run_url: string;
	readonly ci_conclusion: string;
	readonly merged: true;
	readonly cost_usd: number;
	readonly duration_seconds: number;
}

export const buildProof = (input: Omit<WorkProof, "schema" | "merged">): WorkProof => ({
	schema: "harnessy.work.proof.v1",
	task_id: input.task_id,
	repo: input.repo,
	commit_sha: input.commit_sha,
	merge_commit_sha: input.merge_commit_sha,
	pr_url: input.pr_url,
	ci_run_url: input.ci_run_url,
	ci_conclusion: input.ci_conclusion,
	merged: true,
	cost_usd: input.cost_usd,
	duration_seconds: input.duration_seconds,
});

/** Persisted resume state in `<worktree>/.harnessy-work/state.json`. */
export interface WorkState {
	readonly schema: "harnessy.work.state.v1";
	readonly taskId: string;
	readonly startedAt: number;
	readonly keys: { readonly claim: string; readonly start: string; readonly prepare: string };
	readonly summary: string;
	readonly assignmentId?: string;
	readonly started?: boolean;
	readonly pane?: string;
	readonly agent?: { readonly costUsd: number; readonly reason: string };
	readonly repo?: string;
	readonly pr?: { readonly url: string; readonly number: number };
	readonly reviewRequested?: boolean;
	readonly ci?: { readonly url: string; readonly conclusion: string };
	readonly merge?: { readonly headSha: string; readonly mergeCommitSha: string };
	readonly admissionId?: string;
	readonly submission?: unknown;
}

export const parseState = (text: string, task: string): WorkState | undefined => {
	const value = parseJson(text);
	const keys = field(value, "keys");
	if (
		field(value, "schema") !== "harnessy.work.state.v1" ||
		field(value, "taskId") !== task ||
		typeof field(keys, "claim") !== "string" ||
		typeof field(keys, "start") !== "string" ||
		typeof field(keys, "prepare") !== "string" ||
		typeof field(value, "summary") !== "string" ||
		typeof field(value, "startedAt") !== "number"
	)
		return undefined;
	return value as WorkState;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** WorkStream task selectors are UUIDs; this also keeps the id safe in paths and branch names. */
export const isTaskId = (value: string): boolean => UUID.test(value);

/** JSON.parse that returns undefined instead of throwing. */
export const parseJson = (text: string): unknown => {
	const parsed = Result.try((): unknown => JSON.parse(text));
	return Result.isSuccess(parsed) ? parsed.success : undefined;
};

/** Read one property of an unknown JSON object. */
export const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
