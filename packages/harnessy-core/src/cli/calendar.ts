import { Console, Option } from "effect";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import {
	applyCalendarPlan,
	inspectCalendarRecovery,
	inspectLegacyCalendarRecovery,
	reconcileCalendarPlan,
	resolveCalendarRecovery,
	retireLegacyCalendarRecovery,
} from "../jarvis/calendar/apply.ts";
import { gwsCalendarProvider } from "../jarvis/calendar/gws-provider.ts";
import { inspectCalendarPlan } from "../jarvis/calendar/plan.ts";

export const jarvisCalendarCommand = Command.make("calendar").pipe(
	Command.withSubcommands([
		Command.make("inspect", { plan: Flag.string("plan") }, ({ plan }) =>
			Effect.try(() => inspectCalendarPlan(plan)).pipe(
				Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
			),
		).pipe(Command.withDescription("Inspect and fingerprint a saved calendar plan without provider calls or writes")),
		Command.make(
			"recovery-inspect",
			{
				plan: Flag.string("plan"),
				approvedSha256: Flag.string("approve-sha256"),
				googleExecutable: Flag.string("google-executable"),
				googleConfig: Flag.string("google-config"),
				googleAccount: Flag.string("google-account"),
			},
			({ plan, approvedSha256, googleExecutable, googleConfig, googleAccount }) =>
				Effect.tryPromise({
					try: async () =>
						await inspectCalendarRecovery(
							plan,
							approvedSha256,
							gwsCalendarProvider(googleExecutable, googleConfig, googleAccount),
						),
					catch: (cause) => (cause instanceof Error ? cause : new Error("Calendar recovery inspection failed")),
				}).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2)))),
		).pipe(
			Command.withDescription(
				"Classify confirmed, uncertain and never-attempted blocks and fingerprint the exact recovery state",
			),
		),
		Command.make(
			"recovery-resolve",
			{
				plan: Flag.string("plan"),
				approvedSha256: Flag.string("approve-sha256"),
				approvedRecoverySha256: Flag.string("approve-recovery-sha256"),
				resolution: Flag.string("resolution"),
				residualPlan: Flag.string("residual-plan").pipe(Flag.optional),
				googleExecutable: Flag.string("google-executable"),
				googleConfig: Flag.string("google-config"),
				googleAccount: Flag.string("google-account"),
			},
			({
				plan,
				approvedSha256,
				approvedRecoverySha256,
				resolution,
				residualPlan,
				googleExecutable,
				googleConfig,
				googleAccount,
			}) =>
				Effect.tryPromise({
					try: async () => {
						if (resolution !== "retire" && resolution !== "residual")
							throw new Error("Calendar recovery resolution must be retire or residual");
						return await resolveCalendarRecovery(
							plan,
							approvedSha256,
							approvedRecoverySha256,
							gwsCalendarProvider(googleExecutable, googleConfig, googleAccount),
							{ action: resolution, residualPlanPath: Option.getOrUndefined(residualPlan) },
						);
					},
					catch: (cause) => (cause instanceof Error ? cause : new Error("Calendar recovery resolution failed")),
				}).pipe(Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2)))),
		).pipe(
			Command.withDescription(
				"Retire an approved incomplete delivery, optionally writing a review-only plan for never-attempted blocks",
			),
		),
		Command.make(
			"legacy-recovery-inspect",
			{
				plan: Flag.string("plan"),
				approvedSha256: Flag.string("approve-sha256"),
			},
			({ plan, approvedSha256 }) =>
				Effect.try(() => inspectLegacyCalendarRecovery(plan, approvedSha256)).pipe(
					Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
				),
		).pipe(Command.withDescription("Inspect and fingerprint a preserved V1 calendar apply report")),
		Command.make(
			"legacy-recovery-retire",
			{
				plan: Flag.string("plan"),
				approvedSha256: Flag.string("approve-sha256"),
				approvedRecoverySha256: Flag.string("approve-recovery-sha256"),
			},
			({ plan, approvedSha256, approvedRecoverySha256 }) =>
				Effect.try(() => retireLegacyCalendarRecovery(plan, approvedSha256, approvedRecoverySha256)).pipe(
					Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2))),
				),
		).pipe(Command.withDescription("Retire an approved V1 apply report while preserving it as non-native evidence")),
		...(["apply", "reconcile"] as const).map((operation) =>
			Command.make(
				operation,
				{
					plan: Flag.string("plan"),
					approvedSha256: Flag.string("approve-sha256"),
					googleExecutable: Flag.string("google-executable"),
					googleConfig: Flag.string("google-config"),
					googleAccount: Flag.string("google-account"),
				},
				({ plan, approvedSha256, googleExecutable, googleConfig, googleAccount }) =>
					Effect.tryPromise({
						try: async () =>
							await (operation === "apply" ? applyCalendarPlan : reconcileCalendarPlan)(
								plan,
								approvedSha256,
								gwsCalendarProvider(googleExecutable, googleConfig, googleAccount),
							),
						catch: (cause) => (cause instanceof Error ? cause : new Error("Calendar operation failed")),
					}).pipe(
						Effect.flatMap((result) =>
							Console.log(JSON.stringify(result, null, 2)).pipe(
								Effect.flatMap(() =>
									"reconciled" in result && !result.reconciled
										? Effect.fail(new Error("Calendar reconciliation incomplete; no retry authorized"))
										: Effect.void,
								),
							),
						),
					),
			).pipe(
				Command.withDescription(
					operation === "apply"
						? "Apply the explicitly approved plan once; uncertain delivery requires reconciliation"
						: "Reconcile exact provider receipts without creating or retrying events",
				),
			),
		),
	] as const),
);
