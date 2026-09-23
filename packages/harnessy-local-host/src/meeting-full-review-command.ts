import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	inspectMeetingPublicationService,
	type MeetingPublicationFullReviewRuntimeInput,
	type MeetingPublicationServiceRevocation,
	type MeetingPublicationServiceStatus,
	type MeetingPublicationSmokeRuntimeError,
	type MeetingPublicationSmokeRuntimeErrorCode,
	revokeStoppedMeetingPublicationService,
} from "@harnessy/core/meeting-publication";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
	isSafeAbsoluteMeetingCommandPath,
	parseMeetingRuntimeCommandInput,
	parseSavedMeetingServiceInput,
} from "./meeting-command-input.ts";
import { runLocalHostMeetingFullReview } from "./meeting-runtime.ts";
import {
	controlMeetingServiceFiles,
	enrollMeetingService,
	installMeetingServiceFiles,
	prepareMeetingService,
	setupMeetingService,
	waitMeetingServiceStopped,
} from "./meeting-service-enrollment.ts";

export type MeetingFullReviewCommandResult =
	| {
			readonly exitCode: 0;
			readonly value?:
				| MeetingPublicationServiceStatus
				| MeetingPublicationServiceRevocation
				| {
						readonly kind: "harnessy.meeting-publication.service-disabled";
						readonly activation: MeetingPublicationServiceStatus["activation"];
						readonly reconciliationRequired: boolean;
				  }
				| {
						readonly kind: "harnessy.meeting-publication.launch-agent";
						readonly label: string;
						readonly plist: string;
				  }
				| ReturnType<typeof enrollMeetingService>
				| ReturnType<typeof controlMeetingServiceFiles>
				| ReturnType<typeof installMeetingServiceFiles>
				| ReturnType<typeof setupMeetingService>
				| ReturnType<typeof prepareMeetingService>;
	  }
	| {
			readonly exitCode: 1;
			readonly value: {
				readonly error: "meeting_full_review_failed";
				readonly code: MeetingPublicationSmokeRuntimeErrorCode | "invalid_arguments";
			};
	  };

/** Service mode selects its own signed enrollment, never an unsigned bypass. */
export const parseMeetingFullReviewCommandInput = (
	args: ReadonlyArray<string>,
): Effect.Effect<
	MeetingPublicationFullReviewRuntimeInput & { readonly communityConfig?: string },
	"invalid_arguments"
> => {
	let communityConfig: string | undefined;
	if (args.includes("--community-service-config")) {
		if (
			args[0] !== "--service" ||
			args.length !== 5 ||
			args[1] !== "--input" ||
			args[3] !== "--community-service-config" ||
			!args[4] ||
			!isSafeAbsoluteMeetingCommandPath(args[4])
		)
			return Effect.fail("invalid_arguments" as const);
		communityConfig = args[4];
		args = args.slice(0, 3);
	}
	const service = ["--service", "--service-status", "--service-revoke", "--service-launch-agent"].includes(
		args[0] ?? "",
	);
	const parsed =
		service && args.length === 3 && args[1] === "--input" && args[2] !== undefined
			? parseSavedMeetingServiceInput(args[2])
			: parseMeetingRuntimeCommandInput(service ? args.slice(1) : args);
	return parsed.pipe(
		Effect.map((input) => ({
			...input,
			...(service ? { mode: "service" as const } : {}),
			...(communityConfig === undefined ? {} : { communityConfig }),
		})),
	);
};

/** Inert macOS configuration; launchd never restarts an uncertain/crashed writer. */
export const renderMeetingServiceLaunchAgent = (
	nodePath: string,
	cliPath: string,
	inputPath: string,
	logDirectory?: string,
	communityConfig?: string,
): string => {
	const xml = (value: string) =>
		value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&apos;");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>org.harnessy.meeting-publication</string>
<key>ProgramArguments</key><array>
${[nodePath, cliPath, "--service", "--input", inputPath, ...(communityConfig === undefined ? [] : ["--community-service-config", communityConfig])].map((value) => `<string>${xml(value)}</string>`).join("\n")}
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>45</integer>
${logDirectory === undefined ? "" : `<key>StandardOutPath</key><string>${xml(join(logDirectory, "stdout.log"))}</string>\n<key>StandardErrorPath</key><string>${xml(join(logDirectory, "stderr.log"))}</string>`}
</dict></plist>\n`;
};

/** Explicit CLI-owned graceful stop; keep the listener until the entire owner scope closes. */
export const makeMeetingFullReviewSignalDrain = Effect.fn("MeetingFullReviewCommand.signalDrain")(function* (
	mode: "finite" | "service" = "finite",
) {
	const requested = yield* Deferred.make<void>();
	const signals = mode === "service" ? (["SIGUSR2", "SIGINT", "SIGTERM"] as const) : (["SIGUSR2"] as const);
	const listener = () => {
		Effect.runSync(Deferred.succeed(requested, undefined));
	};
	yield* Effect.acquireRelease(
		Effect.sync(() => {
			for (const signal of signals) process.on(signal, listener);
		}),
		() =>
			Effect.sync(() => {
				for (const signal of signals) process.off(signal, listener);
			}),
	);
	return { requested: Deferred.await(requested), timeoutMs: 30_000 } as const;
});

/** Separate full-review argv consumer; decision-only imports remain SDK-free. */
export const runMeetingFullReviewCommand: (
	args: ReadonlyArray<string>,
	onReady: Parameters<typeof runLocalHostMeetingFullReview>[1],
	drain?: Parameters<typeof runLocalHostMeetingFullReview>[2],
) => Effect.Effect<MeetingFullReviewCommandResult> = (args, onReady, drain) => {
	if (
		["--service-launch-agent", "--service-install", "--service-enable", "--service-disable"].includes(args[0] ?? "")
	) {
		const install = args[0] !== "--service-launch-agent";
		const communityConfig = args.at(-2) === "--community-service-config" ? args.at(-1) : undefined;
		if (communityConfig !== undefined) args = args.slice(0, -2);
		if (
			process.platform !== "darwin" ||
			(communityConfig !== undefined && !isSafeAbsoluteMeetingCommandPath(communityConfig)) ||
			args.length !== (install ? 5 : 3) ||
			args[1] !== "--input" ||
			args[2] === undefined ||
			(install && (args[3] !== "--directory" || !args[4]))
		) {
			return Effect.succeed({
				exitCode: 1,
				value: { error: "meeting_full_review_failed", code: "invalid_arguments" },
			});
		}
		const inputPath = args[2];
		return parseSavedMeetingServiceInput(inputPath).pipe(
			Effect.flatMap(inspectMeetingPublicationService),
			Effect.flatMap((status) =>
				Effect.try({
					try: (): MeetingFullReviewCommandResult => {
						if (
							args[0] !== "--service-disable" &&
							(status.revoked || !["not_started", "cleanly_stopped"].includes(status.activation))
						)
							throw new Error("invalid_state");
						const plist = renderMeetingServiceLaunchAgent(
							process.execPath,
							fileURLToPath(new URL("./meeting-full-review-cli.js", import.meta.url)),
							inputPath,
							install ? args[4] : undefined,
							communityConfig,
						);
						return {
							exitCode: 0,
							value:
								args[0] === "--service-enable" || args[0] === "--service-disable"
									? controlMeetingServiceFiles(
											args[4]!,
											plist,
											undefined,
											args[0] === "--service-disable" ? "disable" : "enable",
										)
									: install
										? installMeetingServiceFiles(args[4]!, plist)
										: {
												kind: "harnessy.meeting-publication.launch-agent",
												label: "org.harnessy.meeting-publication",
												plist,
											},
						};
					},
					catch: () => "invalid_input" as const,
				}),
			),
			Effect.flatMap((result) =>
				args[0] !== "--service-disable"
					? Effect.succeed(result)
					: Effect.tryPromise({
							try: () => waitMeetingServiceStopped(),
							catch: () => "service_stop_unconfirmed" as const,
						}).pipe(
							Effect.flatMap(() => parseSavedMeetingServiceInput(inputPath)),
							Effect.flatMap(inspectMeetingPublicationService),
							Effect.map(
								(status): MeetingFullReviewCommandResult => ({
									exitCode: 0,
									value: {
										kind: "harnessy.meeting-publication.service-disabled",
										activation: status.activation,
										reconciliationRequired: !["not_started", "cleanly_stopped"].includes(status.activation),
									},
								}),
							),
						),
			),
			Effect.catch(() =>
				Effect.succeed({
					exitCode: 1 as const,
					value: { error: "meeting_full_review_failed" as const, code: "invalid_input" as const },
				}),
			),
		);
	}
	if (args[0] === "--enroll-service" || args[0] === "--prepare-service" || args[0] === "--setup-service")
		return Effect.sync((): MeetingFullReviewCommandResult => {
			try {
				return {
					exitCode: 0,
					value:
						args[0] === "--setup-service"
							? setupMeetingService(args.slice(1))
							: args[0] === "--prepare-service"
								? prepareMeetingService(args.slice(1))
								: enrollMeetingService(args.slice(1)),
				};
			} catch {
				return { exitCode: 1, value: { error: "meeting_full_review_failed", code: "invalid_input" } };
			}
		});
	return parseMeetingFullReviewCommandInput(args).pipe(
		Effect.flatMap(
			({
				communityConfig,
				...input
			}): Effect.Effect<MeetingFullReviewCommandResult, MeetingPublicationSmokeRuntimeError> =>
				args[0] === "--service-status"
					? inspectMeetingPublicationService(input).pipe(Effect.map((value) => ({ exitCode: 0, value })))
					: args[0] === "--service-revoke"
						? revokeStoppedMeetingPublicationService(input).pipe(Effect.map((value) => ({ exitCode: 0, value })))
						: runLocalHostMeetingFullReview(input, onReady, drain, communityConfig).pipe(
								Effect.map(() => ({ exitCode: 0 })),
							),
		),
		Effect.catchIf(
			(_cause): _cause is MeetingPublicationSmokeRuntimeError | "invalid_arguments" => true,
			(cause) => {
				const code =
					cause === "invalid_arguments"
						? cause
						: typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
							? (cause.code as MeetingPublicationSmokeRuntimeErrorCode)
							: "review_failed";
				return Effect.succeed({
					exitCode: 1,
					value: { error: "meeting_full_review_failed", code },
				} satisfies MeetingFullReviewCommandResult);
			},
		),
	);
};
