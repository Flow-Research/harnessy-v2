import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { benchmarkHarnessy } from "../engineering/benchmark.ts";
import { engineeringJobSchema } from "../engineering/contracts.ts";
import { EngineeringStore, engineeringGrant } from "../engineering/store.ts";
import { causeMessage, HarnessError } from "../errors.ts";

const statePath = () =>
	join(
		process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
		"harnessy",
		"engineering",
		"controller.sqlite",
	);

/** Local owner commands do not start a worker or grant remote callers access. */
export const makeEngineeringCommand = (defaultPath: () => string = statePath, clock: () => number = Date.now) => {
	const database = Flag.String("database").pipe(
		Flag.withDefault(defaultPath()),
		Flag.withDescription("Private controller SQLite database."),
	);
	const useStore = <A>(path: string, operation: (store: EngineeringStore) => A) =>
		Effect.try({
			try: () => {
				const store = new EngineeringStore(path);
				try {
					return operation(store);
				} finally {
					store.close();
				}
			},
			catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
		}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value))));
	const status = Command.make("status", { database }, (flags) =>
		useStore(flags.database, (store) => ({
			schema: "harnessy.engineering.status.v1",
			observedAt: clock(),
			activeRun: store.active() ?? null,
			approvedJobs: store.approvedJobs(clock()),
			notice: "Local controller state only. Host availability and termination require live observation.",
		})),
	);
	const events = Command.make("events", { database, after: Flag.Int("after").pipe(Flag.withDefault(0)) }, (flags) =>
		useStore(flags.database, (store) => ({
			schema: "harnessy.engineering.events.v1",
			events: store.events(flags.after),
		})),
	);
	const approve = Command.make(
		"approve",
		{ database, job: Flag.String("job"), minutes: Flag.Int("expires-minutes").pipe(Flag.withDefault(135)) },
		(flags) =>
			useStore(flags.database, (store) => {
				if (flags.minutes < 1 || flags.minutes > 24 * 60)
					throw new Error("Grant lifetime must be between 1 and 1440 minutes");
				const input = readFileSync(flags.job, "utf8");
				if (Buffer.byteLength(input) > 16_384) throw new Error("Job file exceeds the input limit");
				const job = engineeringJobSchema.parse(JSON.parse(input));
				const issuedAt = clock();
				const grant = engineeringGrant(job, issuedAt, issuedAt + flags.minutes * 60_000);
				store.approve(job, grant, issuedAt);
				return {
					schema: "harnessy.engineering.approval.v1",
					jobId: job.id,
					grant,
					notice:
						"Approval permits this exact job. Provider allowance, isolation and live source checks still control launch.",
				};
			}),
	);
	const cancel = Command.make("cancel", { database, run: Flag.String("run") }, (flags) =>
		useStore(flags.database, (store) => store.requestCancellation(flags.run, clock())),
	);
	const revoke = Command.make("revoke", { database, grant: Flag.String("grant") }, (flags) =>
		useStore(flags.database, (store) => {
			store.revoke(flags.grant, clock());
			return { grantId: flags.grant, state: "revoked", termination: "not-confirmed" };
		}),
	);
	const benchmark = Command.make("benchmark").pipe(
		Command.withSubcommands([
			Command.make(
				"harnessy",
				{
					profile: Flag.Literals("profile", ["pure-task-operations", "preparation-plan", "local-status"]).pipe(
						Flag.withDefault("pure-task-operations"),
						Flag.withDescription(
							"Fixed local profile. Full startup, full task preparation, and remote status are unsupported.",
						),
					),
					baseline: Flag.String("baseline").pipe(Flag.withDescription("Canonical baseline Harnessy Git root.")),
					candidate: Flag.String("candidate").pipe(Flag.withDescription("Canonical candidate Harnessy Git root.")),
					output: Flag.String("output").pipe(
						Flag.withDescription(
							"New artifact directory under an existing private owner directory, outside both Git roots.",
						),
					),
					seconds: Flag.Int("timeout-seconds").pipe(Flag.withDefault(300)),
				},
				(flags) =>
					Effect.tryPromise({
						try: (signal) =>
							benchmarkHarnessy({
								profile: flags.profile,
								baseline: flags.baseline,
								candidate: flags.candidate,
								output: flags.output,
								timeoutMs: flags.seconds * 1000,
								signal,
							}),
						catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
					}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value)))),
			),
		]),
		Command.withDescription(
			"Measure pure-task-operations, preparation-plan, or local-status in protected local custody. Full startup, full task preparation, and remote status are unsupported.",
		),
	);
	return Command.make("engineering").pipe(
		Command.withSubcommands([status, events, approve, cancel, revoke, benchmark]),
		Command.withDescription("Inspect engineering work and manage exact-job approval and cancellation receipts"),
	);
};

export const engineeringCommand = makeEngineeringCommand();
