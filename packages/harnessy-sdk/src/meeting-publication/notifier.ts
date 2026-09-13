import { type ChildProcess, spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
	type MeetingProviderHealth,
	type MeetingPublicationFailureStage,
	MeetingPublicationNotifier,
	MeetingPublicationProviderError,
	type MeetingPublicationWriteGrant,
	validateMeetingPublicationWriteGrant,
} from "@harnessy/core/meeting-publication";
import { Effect, Layer } from "effect";

export type LocalMeetingPublicationNotifierConfig =
	| { readonly kind: "unavailable" }
	| {
			readonly kind: "terminal-notifier";
			readonly executablePath: string;
			readonly reviewOpen?: { readonly executablePath: string; readonly statePath: string };
			readonly timeoutMillis?: number;
			readonly terminationGraceMillis?: number;
	  }
	| {
			readonly kind: "osascript";
			readonly executablePath: string;
			readonly timeoutMillis?: number;
			readonly terminationGraceMillis?: number;
	  }
	| {
			/** Cross-platform process fixture; never selected by production composition. */
			readonly kind: "test-process";
			readonly executablePath: string;
			readonly scriptPath: string;
			readonly timeoutMillis?: number;
			readonly terminationGraceMillis?: number;
	  };

const safeExecutable = (value: string) =>
	isAbsolute(value) && value.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(value);

const boundedTimeout = (value: number | undefined) =>
	value !== undefined && Number.isSafeInteger(value) && value >= 100 && value <= 30_000 ? value : 5_000;

const boundedTerminationGrace = (value: number | undefined) =>
	value !== undefined && Number.isSafeInteger(value) && value >= 50 && value <= 5_000 ? value : 500;

const failureLabels: Record<MeetingPublicationFailureStage, string> = {
	configuration: "configuration",
	source: "meeting source",
	store: "state storage",
	notification: "notifications",
	google: "Google",
	discord: "Discord",
};

const messageFor = (
	kind: "review" | "error",
	count: number,
	health?: MeetingProviderHealth,
	failureStages: ReadonlyArray<MeetingPublicationFailureStage> = [],
) =>
	health !== undefined
		? `${health.provider} (${health.account}): ${health.failure === null ? "connection recovered" : `${health.failure} check failed`}. ${count} meetings affected. Last successful check: ${health.lastSuccessAt ?? "none"}.${health.failure === null ? " Eligible approved meetings will resume automatically." : health.failure === "authentication" ? " Check the native connection credentials; sign in again if required." : health.failure === "transient" ? " Harnessy will check again automatically." : " Check the account and permissions in Harnessy connections."}`
		: kind === "review"
			? `${count} meeting publication item${count === 1 ? " awaits" : "s await"} review.`
			: `${count} meeting publication item${count === 1 ? " requires" : "s require"} attention.${failureStages.length === 0 ? "" : ` Failed stage: ${[...new Set(failureStages)].map((stage) => failureLabels[stage]).join(", ")}.`} Publication is not complete. Open review for details; reconcile delivery receipts before retrying.`;

const requireNotificationGrant = (grant: MeetingPublicationWriteGrant) =>
	validateMeetingPublicationWriteGrant(grant, "provider_notification").pipe(
		Effect.mapError(
			() =>
				new MeetingPublicationProviderError({
					stage: "notification",
					code: "invalid_grant",
					retryable: false,
					retryAfterSeconds: null,
				}),
		),
		Effect.asVoid,
	);

/**
 * Node-only, no-shell local notifier. It passes only a bounded kind/count
 * message to an explicitly configured executable and truthfully returns false
 * when the process cannot be started, times out, or exits non-zero.
 */
export const localMeetingPublicationNotifierLayer = (
	config: LocalMeetingPublicationNotifierConfig,
): Layer.Layer<MeetingPublicationNotifier> =>
	Layer.effect(
		MeetingPublicationNotifier,
		Effect.acquireRelease(
			Effect.sync(() => {
				interface TrackedProcess {
					readonly completion: Promise<boolean>;
					readonly stop: () => void;
				}
				const children = new Map<ChildProcess, TrackedProcess>();
				let closed = false;
				const deliver = (
					kind: "review" | "error",
					count: number,
					health?: MeetingProviderHealth,
					failureStages: ReadonlyArray<MeetingPublicationFailureStage> = [],
				): Effect.Effect<boolean> => {
					if (
						closed ||
						config.kind === "unavailable" ||
						!Number.isSafeInteger(count) ||
						count < (health === undefined ? 1 : 0) ||
						(health !== undefined &&
							(health.account.length > 320 || /[\u0000-\u001f\u007f]/u.test(health.account))) ||
						count > 1_000_000 ||
						failureStages.length > 6 ||
						failureStages.some((stage) => !Object.hasOwn(failureLabels, stage)) ||
						!safeExecutable(config.executablePath) ||
						(config.kind === "terminal-notifier" &&
							config.reviewOpen !== undefined &&
							(!safeExecutable(config.reviewOpen.executablePath) || !isAbsolute(config.reviewOpen.statePath))) ||
						(config.kind === "test-process" && !safeExecutable(config.scriptPath))
					) {
						return Effect.succeed(false);
					}
					return Effect.promise(() => {
						const message = messageFor(kind, count, health, failureStages);
						const args =
							config.kind === "terminal-notifier"
								? [
										"-title",
										"Harnessy meeting publication",
										"-message",
										message,
										"-group",
										health === undefined
											? kind === "error"
												? "harnessy-meeting-publication-error"
												: "harnessy-meeting-publication"
											: `harnessy-meeting-publication-${health.provider}`,
										...(config.kind === "terminal-notifier" && config.reviewOpen !== undefined
											? [
													"-execute",
													`${JSON.stringify(config.reviewOpen.executablePath)} --state-path ${JSON.stringify(config.reviewOpen.statePath)}`,
												]
											: []),
									]
								: config.kind === "osascript"
									? [
											"-e",
											`display notification ${JSON.stringify(message)} with title ${JSON.stringify("Harnessy meeting publication")}`,
										]
									: [config.scriptPath, kind, String(count)];
						let child: ChildProcess;
						try {
							child = spawn(config.executablePath, args, { shell: false, stdio: "ignore", windowsHide: true });
						} catch {
							return Promise.resolve(false);
						}
						let settled = false;
						let stopping = false;
						let timedOut = false;
						let timeout: ReturnType<typeof setTimeout> | undefined;
						let escalation: ReturnType<typeof setTimeout> | undefined;
						let resolveCompletion: (delivered: boolean) => void = () => undefined;
						const completion = new Promise<boolean>((resolve) => {
							resolveCompletion = resolve;
						});
						const processIsRunning = () => child.exitCode === null && child.signalCode === null;
						const settleAfterExit = (delivered: boolean) => {
							if (settled) return;
							settled = true;
							if (timeout !== undefined) clearTimeout(timeout);
							if (escalation !== undefined) clearTimeout(escalation);
							children.delete(child);
							resolveCompletion(delivered);
						};
						const stop = () => {
							if (stopping || !processIsRunning()) return;
							stopping = true;
							if (timeout !== undefined) clearTimeout(timeout);
							try {
								child.kill("SIGTERM");
							} catch {
								// The bounded escalation below still confirms process exit through close/error.
							}
							escalation = setTimeout(() => {
								if (!processIsRunning()) return;
								try {
									child.kill(process.platform === "win32" ? undefined : "SIGKILL");
								} catch {
									// Exit confirmation remains owned by the close/error handlers.
								}
							}, boundedTerminationGrace(config.terminationGraceMillis));
						};
						children.set(child, { completion, stop });
						child.once("error", () => settleAfterExit(false));
						child.once("close", (code) => settleAfterExit(!closed && !timedOut && code === 0));
						timeout = setTimeout(() => {
							timedOut = true;
							stop();
						}, boundedTimeout(config.timeoutMillis));
						return completion;
					});
				};
				const notify = (
					kind: "review" | "error",
					count: number,
					grant: MeetingPublicationWriteGrant,
					health?: MeetingProviderHealth,
					failureStages?: ReadonlyArray<MeetingPublicationFailureStage>,
				) =>
					requireNotificationGrant(grant).pipe(Effect.flatMap(() => deliver(kind, count, health, failureStages)));
				const close = Effect.promise(async () => {
					closed = true;
					const pending = [...children.values()];
					for (const child of pending) child.stop();
					await Promise.all(pending.map((child) => child.completion));
				});
				return MeetingPublicationNotifier.of({ notify, close });
			}),
			(service) => service.close,
		),
	);
