import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import * as Result from "effect/Result";
import { benchmarkHarnessy } from "../engineering/benchmark.ts";
import { buildNullCalibration } from "../engineering/calibration.ts";
import { engineeringJobSchema } from "../engineering/contracts.ts";
import { EngineeringController } from "../engineering/controller.ts";
import {
	appendServiceReport,
	EXTRA_USAGE_FILE,
	liveControllerDeps,
	PROVIDER_PAUSE_FILE,
	profileEvaluatorDigest,
	profileWorkloadDigest,
	readHostConfig,
} from "../engineering/live.ts";
import { runEngineeringService } from "../engineering/service.ts";
import { EngineeringStore, engineeringGrant } from "../engineering/store.ts";
import { causeMessage, HarnessError } from "../errors.ts";
import { liveWorkDeps, type WorkDeps } from "../work/run.ts";

const statePath = () =>
	join(
		process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
		"harnessy",
		"engineering",
		"controller.sqlite",
	);

/** A process without a home folder, such as a sandboxed benchmark, must still build the command. */
const hostConfigPath = () => {
	const base =
		process.env.XDG_CONFIG_HOME ?? (process.env.HOME === undefined ? undefined : join(process.env.HOME, ".config"));
	return base === undefined ? "host.json" : join(base, "harnessy", "engineering", "host.json");
};

/**
 * `status`, `events`, `approve`, `cancel`, `revoke` and `benchmark` start no
 * worker. `tick` and `serve` can start one worker for an approved job, and only
 * when every host probe and the included-allowance check pass.
 */
export const makeEngineeringCommand = (
	defaultPath: () => string = statePath,
	clock: () => number = Date.now,
	workDeps: () => WorkDeps = liveWorkDeps,
) => {
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
					calibration: Flag.String("calibration").pipe(
						Flag.optional,
						Flag.withDescription(
							"Null calibration file of this profile on this host, from 'engineering calibrate'. With it the decision uses the exact signed-rank interval. A file that does not match is refused.",
						),
					),
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
								...(Option.isSome(flags.calibration)
									? { calibration: JSON.parse(readFileSync(flags.calibration.value, "utf8")) }
									: {}),
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
	const calibrate = Command.make(
		"calibrate",
		{
			reports: Flag.String("reports").pipe(
				Flag.withDescription(
					"Folder with one sub-folder for each benchmark run in which baseline and candidate were the same source.",
				),
			),
			profile: Flag.Literals("profile", ["pure-task-operations", "preparation-plan", "local-status"]).pipe(
				Flag.withDefault("pure-task-operations"),
			),
			output: Flag.String("output").pipe(Flag.withDescription("New calibration file.")),
		},
		(flags) =>
			Effect.try({
				try: () => {
					const reports = readdirSync(flags.reports)
						.sort()
						.map((name) => join(flags.reports, name, "reports", "benchmark.json"))
						.filter((path) => existsSync(path) && readFileSync(path, "utf8").trim() !== "")
						.map((path): unknown => JSON.parse(readFileSync(path, "utf8")));
					const calibration = buildNullCalibration(reports, flags.profile, clock());
					writeFileSync(flags.output, `${JSON.stringify(calibration, null, 2)}\n`, { flag: "wx", mode: 0o600 });
					return {
						schema: calibration.schema,
						experiments: calibration.experiments,
						supported: Object.fromEntries(
							Object.entries(calibration.metrics).map(([id, metric]) => [id, metric.supported]),
						),
						output: flags.output,
					};
				},
				catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
			}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value)))),
	).pipe(
		Command.withDescription(
			"Build a null calibration from baseline against baseline benchmark reports of one profile on this host",
		),
	);
	const hostConfig = Flag.String("host-config").pipe(
		Flag.withDefault(hostConfigPath()),
		Flag.withDescription("Owner host profile file (mode 600): account, repositories and required checks."),
	);
	const withController = <A>(
		flags: { readonly database: string; readonly hostConfig: string },
		operation: (controller: EngineeringController, stateRoot: string) => Promise<A>,
	) =>
		Effect.tryPromise({
			try: async () => {
				const stateRoot = dirname(flags.database);
				const store = new EngineeringStore(flags.database);
				try {
					const deps = liveControllerDeps({
						config: readHostConfig(flags.hostConfig),
						configRoot: dirname(flags.hostConfig),
						work: workDeps(),
						stateRoot,
						environment: process.env,
						launchSettled: (launchId) =>
							Result.match(
								Result.try(() => store.get(launchId).state),
								{
									onFailure: () => false,
									onSuccess: (state) => ["succeeded", "failed", "cancelled"].includes(state),
								},
							),
					});
					return await operation(new EngineeringController(store, deps), stateRoot);
				} finally {
					store.close();
				}
			},
			catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
		});
	const tick = Command.make("tick", { database, hostConfig }, (flags) =>
		withController(flags, async (controller, stateRoot) => {
			const report = {
				schema: "harnessy.engineering.service.v1" as const,
				at: clock(),
				result: await controller.tick(),
			};
			appendServiceReport(stateRoot, report);
			return report;
		}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value)))),
	).pipe(
		Command.withDescription(
			"Run one admission check now. It can start one worker for an approved job and waits for that worker.",
		),
	);
	const serve = Command.make("serve", { database, hostConfig }, (flags) =>
		Effect.tryPromise({
			// The service owns its stop signal. An interrupt lets the current tick finish, so that
			// a running worker keeps its authority checks and the store closes cleanly.
			try: async () => {
				const stop = new AbortController();
				const onSignal = () => {
					process.stderr.write("Stopping after the current tick. The worker keeps its checks until then.\n");
					stop.abort();
				};
				process.once("SIGINT", onSignal);
				process.once("SIGTERM", onSignal);
				const stateRoot = dirname(flags.database);
				const store = new EngineeringStore(flags.database);
				try {
					const deps = liveControllerDeps({
						config: readHostConfig(flags.hostConfig),
						configRoot: dirname(flags.hostConfig),
						work: workDeps(),
						stateRoot,
						environment: process.env,
						launchSettled: (launchId) =>
							Result.match(
								Result.try(() => store.get(launchId).state),
								{
									onFailure: () => false,
									onSuccess: (state) => ["succeeded", "failed", "cancelled"].includes(state),
								},
							),
					});
					await runEngineeringService(
						new EngineeringController(store, deps),
						stop.signal,
						async (report) => appendServiceReport(stateRoot, report),
						clock,
					);
				} finally {
					process.removeListener("SIGINT", onSignal);
					process.removeListener("SIGTERM", onSignal);
					store.close();
				}
			},
			catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
		}),
	).pipe(
		Command.withDescription(
			"Run admission checks every 15 minutes until stopped. A stop waits for the current tick. The loop does not run while the computer sleeps.",
		),
	);
	const digests = Command.make("digests", { hostConfig }, (flags) =>
		Effect.try({
			try: () =>
				readHostConfig(flags.hostConfig).profiles.map((profile) => ({
					repository: profile.id,
					evaluatorDigest: profileEvaluatorDigest(profile),
					workloadDigest: profileWorkloadDigest(profile),
				})),
			catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
		}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value)))),
	).pipe(Command.withDescription("Print the evaluator and workload digests that a job for each repository must name"));
	const confirmExtraUsage = Command.make(
		"confirm-extra-usage-off",
		{ database, hostConfig, confirmedBy: Flag.Literals("confirmed-by", ["julian"]) },
		(flags) =>
			Effect.try({
				try: () => {
					const path = join(dirname(flags.database), EXTRA_USAGE_FILE);
					const record = {
						schema: "harnessy.engineering.extra-usage.v1",
						accountId: readHostConfig(flags.hostConfig).accountId,
						extraUsage: "off",
						confirmedBy: flags.confirmedBy,
						confirmedAt: clock(),
					};
					mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
					writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
					chmodSync(path, 0o600);
					return { ...record, notice: "Valid for 30 days. Only the account owner may record this." };
				},
				catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
			}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value)))),
	).pipe(
		Command.withDescription(
			"Record the owner's statement that extra usage billing is off for the subscription account",
		),
	);
	const clearPause = Command.make(
		"clear-provider-pause",
		{ database, confirmedBy: Flag.Literals("confirmed-by", ["julian"]) },
		(flags) =>
			Effect.try({
				try: () => {
					rmSync(join(dirname(flags.database), PROVIDER_PAUSE_FILE), { force: true });
					return { cleared: true, clearedBy: flags.confirmedBy, at: clock() };
				},
				catch: (cause) => new HarnessError({ message: causeMessage(cause), cause }),
			}).pipe(Effect.flatMap((value) => Console.log(JSON.stringify(value)))),
	).pipe(Command.withDescription("Remove a recorded subscription limit pause after the owner checked the limit"));
	return Command.make("engineering").pipe(
		Command.withSubcommands([
			status,
			events,
			approve,
			cancel,
			revoke,
			digests,
			calibrate,
			confirmExtraUsage,
			clearPause,
			tick,
			serve,
			benchmark,
		]),
		Command.withDescription(
			"Inspect engineering work, manage exact-job approval and cancellation, and run the bounded engineering loop",
		),
	);
};

export const engineeringCommand = makeEngineeringCommand();
