import { Console, Effect, Option } from "effect";
import * as Result from "effect/Result";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { type AttestDeps, initKey, liveAttestDeps, type Outcome, runAttest, verifyFile } from "../attest/run.ts";
import { causeMessage, HarnessError } from "../errors.ts";
import { splitCli } from "../work/logic.ts";
import { execRun } from "../work/run.ts";

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Print the result as one JSON line."));

const harnessError = (cause: unknown) => new HarnessError({ message: causeMessage(cause), cause });

/** Fail the command with a plain message, or pass the success value on. */
const orFail = <A>(result: Result.Result<A, string>) =>
	Result.isSuccess(result)
		? Effect.succeed(result.success)
		: Effect.fail(new HarnessError({ message: result.failure }));

const setExitCode = (code: number) =>
	Effect.sync(() => {
		if (code !== 0) process.exitCode = code;
	});

const runText = (report: Readonly<Record<string, unknown>>): string => {
	const list = (key: string) => report[key] as ReadonlyArray<string>;
	const lines = [
		String(report.notice),
		`Signer: ${String(report.signer)}`,
		`Folder: ${String(report.out)}`,
		`${list("created").length} new, ${list("unchanged").length} already present, ${list("conflicts").length} conflicting, of ${String(report.contributions)} contributions.`,
		...list("created").map((path) => `created  ${path}`),
		...list("conflicts").map((path) => `CONFLICT ${path} (differs from what this key signs now; not replaced)`),
	];
	return lines.join("\n");
};

const print = (json: boolean, outcome: Outcome, text: (report: Readonly<Record<string, unknown>>) => string) =>
	Console.log(json ? JSON.stringify(outcome.report) : text(outcome.report)).pipe(
		Effect.andThen(setExitCode(outcome.exitCode)),
	);

/** Build `harnessy attest` around injected dependencies; tests pass a fake runner and a temporary state root. */
export const makeAttestCommand = (deps: () => AttestDeps) => {
	const keyInit = Command.make("init", { json: jsonFlag }, ({ json }) =>
		Effect.try({ try: () => initKey(deps()), catch: harnessError }).pipe(
			Effect.flatMap((outcome) =>
				print(json, outcome, (report) =>
					report.status === "created"
						? `Created a TEST signing key (test certificates only).\nSigner address: ${String(report.address)}\nKey file: ${String(report.path)}`
						: `${String(report.message)}\nKey file: ${String(report.path)}`,
				),
			),
		),
	).pipe(Command.withDescription("Create the TEST signing key; prints only its signer address"));

	const run = Command.make(
		"run",
		{
			project: Flag.string("project").pipe(Flag.withDescription("WorkStream project UUID.")),
			workstreamCli: Flag.string("workstream-cli").pipe(
				Flag.withDefault("workstream"),
				Flag.withDescription("WorkStream CLI argv prefix, split on whitespace (e.g. 'ws-agent')."),
			),
			out: Flag.string("out").pipe(
				Flag.optional,
				Flag.withDescription("Certificate folder (default ~/.local/state/harnessy/attest/<project>)."),
			),
			json: jsonFlag,
		},
		(flags) =>
			Effect.gen(function* () {
				const workstreamCli = yield* Effect.try({ try: () => splitCli(flags.workstreamCli), catch: harnessError });
				const result = yield* Effect.tryPromise({
					try: () =>
						runAttest(
							{
								project: flags.project,
								workstreamCli,
								...(Option.isSome(flags.out) ? { out: flags.out.value } : {}),
							},
							deps(),
						),
					catch: harnessError,
				});
				yield* print(flags.json, yield* orFail(result), runText);
			}),
	).pipe(Command.withDescription("Sign a TEST certificate for each accepted WorkStream contribution without one"));

	const verify = Command.make(
		"verify",
		{
			file: Argument.string("file"),
			attester: Flag.string("attester").pipe(
				Flag.optional,
				Flag.withDescription("Expected signer address (default: the local TEST key's address)."),
			),
			json: jsonFlag,
		},
		({ file, attester, json }) =>
			Effect.gen(function* () {
				const verdict = yield* orFail(
					yield* Effect.try({
						try: () => verifyFile(file, Option.getOrUndefined(attester), deps()),
						catch: harnessError,
					}),
				);
				const outcome: Outcome = { exitCode: verdict.valid ? 0 : 1, report: { file, ...verdict } };
				yield* print(json, outcome, () =>
					verdict.valid
						? `VALID test certificate for contribution ${verdict.contribution.contributionId}, signed by ${verdict.signer} (attestation ${verdict.uid}).`
						: `INVALID: ${verdict.reason}`,
				);
			}),
	).pipe(Command.withDescription("Check a certificate's signature, signer and schema"));

	return Command.make("attest").pipe(
		Command.withSubcommands([
			Command.make("key").pipe(
				Command.withSubcommands([keyInit] as const),
				Command.withDescription("Manage the TEST signing key"),
			),
			run,
			verify,
		] as const),
		Command.withDescription("Signed TEST certificates of accepted WorkStream contributions (EAS off-chain format)"),
	);
};

export const attestCommand = makeAttestCommand(() => liveAttestDeps(execRun));
