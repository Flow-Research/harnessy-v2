import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { causeMessage, HarnessError } from "../errors.ts";
import { MAX_REVIEW_NOTES, splitCli } from "../work/logic.ts";
import { liveWorkDeps, runWork, type WorkDeps } from "../work/run.ts";

const positive = (name: string, value: number): number => {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`);
	return value;
};

const reviewNotes = (value: string): string => {
	const notes = value.trim();
	if (notes === "" || notes.length > MAX_REVIEW_NOTES)
		throw new Error(`--revise needs review notes of 1 to ${MAX_REVIEW_NOTES} characters`);
	return notes;
};

/** Build `harnessy work` around injected dependencies; tests pass a fake runner. */
export const makeWorkCommand = (deps: () => WorkDeps) =>
	Command.make(
		"work",
		{
			task: Flag.string("task").pipe(Flag.withDescription("WorkStream task UUID.")),
			repo: Flag.string("repo").pipe(Flag.withDefault("."), Flag.withDescription("Target repository checkout.")),
			base: Flag.string("base").pipe(
				Flag.withDefault("dev"),
				Flag.withDescription("Base branch for the work branch and PR."),
			),
			budgetUsd: Flag.float("budget-usd").pipe(
				Flag.withDefault(5),
				Flag.withDescription("Agent spend limit in USD."),
			),
			maxMinutes: Flag.integer("max-minutes").pipe(
				Flag.withDefault(45),
				Flag.withDescription("Wall-clock limit for the agent run, in minutes."),
			),
			mergeWaitHours: Flag.float("merge-wait-hours").pipe(
				Flag.withDefault(24),
				Flag.withDescription("How long to wait for the PR to be merged, in hours."),
			),
			workstreamCli: Flag.string("workstream-cli").pipe(
				Flag.withDefault("workstream"),
				Flag.withDescription(
					"WorkStream CLI argv prefix, split on whitespace (e.g. 'workstream-local --as agent').",
				),
			),
			taskUrl: Flag.string("task-url").pipe(
				Flag.optional,
				Flag.withDescription("WorkStream task link for the PR body."),
			),
			agentAllow: Flag.string("agent-allow").pipe(
				Flag.optional,
				Flag.withDescription(
					"Extra Claude Code tool rules for tests and formatting, e.g. 'Bash(node_modules/.bin/vitest run *),Bash(node_modules/.bin/biome check *),Bash(node_modules/.bin/biome format --write *)'. npx is not allowed; name the installed binary. The commands run in Claude Code's OS sandbox (macOS, or Linux with bubblewrap and socat): writes only in the worktree, no network; elsewhere the run is refused. Warning: sandboxed commands can still write Claude Code's shared /tmp/claude-<uid>; do not use on repositories with untrusted contributors.",
				),
			),
			agentDeps: Flag.choice("agent-deps", ["clone"]).pipe(
				Flag.optional,
				Flag.withDescription(
					"'clone' gives the agent's worktree a private copy-on-write copy of --repo's ignored node_modules and dist directories, so --agent-allow test and format commands can run. Off by default.",
				),
			),
			revise: Flag.string("revise").pipe(
				Flag.optional,
				Flag.withDescription(
					"Send the unpushed commit back to the agent with these review notes. Spend counts against --budget-usd.",
				),
			),
			approvePush: Flag.boolean("approve-push").pipe(
				Flag.withDescription(
					"Push the locally reviewed commit and open a draft PR. Without it the run stops for review.",
				),
			),
			dryRun: Flag.boolean("dry-run").pipe(
				Flag.withDescription("Run preflight and print the plan without side effects."),
			),
			json: Flag.boolean("json").pipe(Flag.withDescription("Print the final report as one JSON line.")),
		},
		(flags) =>
			Effect.gen(function* () {
				const outcome = yield* Effect.tryPromise({
					try: () =>
						runWork(
							{
								task: flags.task,
								repo: flags.repo,
								base: flags.base,
								budgetUsd: positive("budget-usd", flags.budgetUsd),
								maxMinutes: positive("max-minutes", flags.maxMinutes),
								mergeWaitHours: positive("merge-wait-hours", flags.mergeWaitHours),
								workstreamCli: splitCli(flags.workstreamCli),
								...(Option.isSome(flags.taskUrl) ? { taskUrl: flags.taskUrl.value } : {}),
								...(Option.isSome(flags.agentAllow) ? { agentAllow: flags.agentAllow.value } : {}),
								...(Option.isSome(flags.agentDeps) ? { agentDeps: flags.agentDeps.value } : {}),
								...(Option.isSome(flags.revise) ? { revise: reviewNotes(flags.revise.value) } : {}),
								approvePush: flags.approvePush,
								dryRun: flags.dryRun,
							},
							deps(),
						),
					catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
				});
				yield* Console.log(flags.json ? JSON.stringify(outcome.report) : JSON.stringify(outcome.report, null, 2));
				if (outcome.exitCode !== 0)
					yield* Effect.sync(() => {
						process.exitCode = outcome.exitCode;
					});
			}),
	).pipe(Command.withDescription("Run one WorkStream task through an agent, a reviewed PR and a proof submission"));

export const workCommand = makeWorkCommand(liveWorkDeps);
