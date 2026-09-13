import { Clock, Deferred, Result, Schema, Semaphore } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { JarvisMeetingPublicationConfig } from "../config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	MeetingPublicationWriteBinding,
	type MeetingPublicationWriteGrant,
	resolveMeetingPublicationWriteBinding,
} from "./authority.ts";
import { authorizeMeetingPublicationWrite } from "./authority-check.ts";
import {
	MeetingPublicationConfigError,
	type MeetingPublicationFailureStage,
	type MeetingPublicationItem,
	type MeetingPublicationNote,
	MeetingPublicationPreflightCheck,
	MeetingPublicationPreflightResult,
	MeetingPublicationProviderError,
	MeetingPublicationReviewError,
	MeetingPublicationScanResult,
	type MeetingPublicationSourceError,
	MeetingPublicationTransitionError,
	MeetingPublicationWorkerResult,
	transitionMeetingPublication,
} from "./models.ts";
import { MeetingPublicationSource } from "./notes.ts";
import { classifyMeetingProviderFailure, type MeetingProviderHealth } from "./provider-health.ts";
import {
	MEETING_PUBLICATION_DELIVERY_UNCERTAIN,
	MeetingPublicationStore,
	type MeetingPublicationStoreFailure,
} from "./store.ts";

export class MeetingPublicationClock extends Context.Service<
	MeetingPublicationClock,
	{ readonly now: Effect.Effect<number> }
>()("@harnessy/core/MeetingPublicationClock") {
	static readonly liveLayer = Layer.succeed(
		MeetingPublicationClock,
		MeetingPublicationClock.of({ now: Clock.currentTimeMillis }),
	);

	static testLayer(now: number) {
		return Layer.succeed(MeetingPublicationClock, MeetingPublicationClock.of({ now: Effect.succeed(now) }));
	}
}

export class MeetingPublicationGoogleCheckpoint extends Schema.Class<MeetingPublicationGoogleCheckpoint>(
	"MeetingPublicationGoogleCheckpoint",
)({ docId: Schema.String, docUrl: Schema.String }) {}

export class MeetingPublicationDiscordCheckpoint extends Schema.Class<MeetingPublicationDiscordCheckpoint>(
	"MeetingPublicationDiscordCheckpoint",
)({ channelId: Schema.String, messageId: Schema.String }) {}

export interface MeetingPublicationGoogleRequest {
	readonly itemId: string;
	readonly title: string;
	readonly meetingDate: string;
	readonly sourceHash: string;
	readonly markdown: string;
	readonly existingDocId: string | null;
}

export interface MeetingPublicationDiscordRequest {
	readonly itemId: string;
	readonly sourceHash: string;
	readonly title: string;
	readonly meetingDate: string;
	readonly googleDocUrl: string;
	readonly purpose: string;
	readonly existingChannelId: string | null;
	readonly existingMessageId: string | null;
}

export type MeetingPublicationPublishOneResult =
	| {
			readonly status: "published";
			readonly itemId: string;
			readonly sourceHash: string;
	  }
	| {
			readonly status: "not_published";
			readonly itemId: string;
			readonly sourceHash: string;
	  };

export interface MeetingPublicationGoogleReconnect {
	readonly state: string;
	readonly authorizationUrl: string;
	readonly complete: (
		code: string,
		grant: MeetingPublicationWriteGrant,
	) => Effect.Effect<void, MeetingPublicationProviderError>;
	readonly cancel: (grant: MeetingPublicationWriteGrant) => Effect.Effect<void, MeetingPublicationProviderError>;
}

export interface MeetingPublicationReconnect {
	readonly state: string;
	readonly authorizationUrl: string;
	readonly complete: (
		code: string,
	) => Effect.Effect<void, MeetingPublicationProviderError | MeetingPublicationStoreFailure>;
	readonly cancel: () => Effect.Effect<void, MeetingPublicationProviderError | MeetingPublicationStoreFailure>;
}

export class MeetingPublicationGoogle extends Context.Service<
	MeetingPublicationGoogle,
	{
		readonly preflight: Effect.Effect<boolean, MeetingPublicationProviderError>;
		readonly startReconnect?: (
			redirectUri: string,
			grant: MeetingPublicationWriteGrant,
		) => Effect.Effect<MeetingPublicationGoogleReconnect, MeetingPublicationProviderError>;
		readonly upsert: (
			request: MeetingPublicationGoogleRequest,
			grant: MeetingPublicationWriteGrant,
		) => Effect.Effect<MeetingPublicationGoogleCheckpoint, MeetingPublicationProviderError>;
		readonly close: Effect.Effect<void>;
	}
>()("@harnessy/core/MeetingPublicationGoogle") {}

export class MeetingPublicationDiscord extends Context.Service<
	MeetingPublicationDiscord,
	{
		readonly preflight: Effect.Effect<boolean, MeetingPublicationProviderError>;
		readonly upsert: (
			request: MeetingPublicationDiscordRequest,
			grant: MeetingPublicationWriteGrant,
		) => Effect.Effect<MeetingPublicationDiscordCheckpoint, MeetingPublicationProviderError>;
		readonly close: Effect.Effect<void>;
	}
>()("@harnessy/core/MeetingPublicationDiscord") {}

export class MeetingPublicationNotifier extends Context.Service<
	MeetingPublicationNotifier,
	{
		readonly notify: (
			kind: "review" | "error",
			count: number,
			grant: MeetingPublicationWriteGrant,
			health?: MeetingProviderHealth,
			failureStages?: ReadonlyArray<MeetingPublicationFailureStage>,
		) => Effect.Effect<boolean, MeetingPublicationProviderError>;
		readonly close: Effect.Effect<void>;
	}
>()("@harnessy/core/MeetingPublicationNotifier") {}

const iso = (millis: number) => new Date(millis).toISOString();
const plusSeconds = (millis: number, seconds: number) => iso(millis + Math.max(1, seconds) * 1000);
const minusSeconds = (millis: number, seconds: number) => iso(millis - Math.max(1, seconds) * 1000);
const configurationChecks = (config: JarvisMeetingPublicationConfig) => {
	const checks: Array<MeetingPublicationPreflightCheck> = [];
	const add = (name: string, passed: boolean, code: string) =>
		checks.push(new MeetingPublicationPreflightCheck({ name, passed, required: true, code }));
	add("enabled", config.enabled, config.enabled ? "ok" : "disabled");
	add("source", config.sourcePath !== null, config.sourcePath === null ? "missing_source_path" : "ok");
	add("state", config.statePath !== null, config.statePath === null ? "missing_state_path" : "ok");
	add("project", config.project !== null, config.project === null ? "missing_project" : "ok");
	add("cutover", config.cutoverDate !== null, config.cutoverDate === null ? "missing_cutover_date" : "ok");
	add(
		"google_owner",
		config.googleOwnerEmail !== null,
		config.googleOwnerEmail === null ? "missing_google_owner" : "ok",
	);
	add(
		"google_folder",
		config.googleDriveFolder !== null,
		config.googleDriveFolder === null ? "missing_google_folder" : "ok",
	);
	add(
		"discord_channel",
		config.discordChannelId !== null,
		config.discordChannelId === null ? "missing_discord_channel" : "ok",
	);
	return checks;
};

const requireEnabledConfig = (config: JarvisMeetingPublicationConfig) => {
	const failed = configurationChecks(config).find((check) => !check.passed);
	return failed === undefined
		? Effect.void
		: Effect.fail(
				new MeetingPublicationConfigError({
					code: Schema.decodeUnknownSync(MeetingPublicationConfigError.fields.code)(failed.code),
				}),
			);
};

export const MEETING_PUBLICATION_PURPOSE_MAX_LENGTH = 280;

const providerRetryAt = (now: number, error: MeetingPublicationProviderError) =>
	error.retryable ? plusSeconds(now, error.retryAfterSeconds ?? 60) : null;

export const meetingPublicationDefaultPurpose = (note: MeetingPublicationNote) => {
	const match = /^#{2,6}\s+Meeting Purpose\s*$([\s\S]*?)(?=^#{1,6}\s+|(?![\s\S]))/im.exec(note.markdown);
	const text = (match?.[1] ?? note.title)
		.replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
		.replace(/[*_`>#]/g, "")
		.replace(/^\s*[-+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	const sentence = /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
	return sentence.length > 0 && !/[.!?]$/.test(sentence) ? `${sentence}.` : sentence;
};

/** Normalize the one bounded reviewer-authored sentence that may survive a retry. */
export const normalizeMeetingPublicationPurpose = Effect.fn("MeetingPublication.normalizePurpose")(function* (
	value: string,
) {
	const hasControlCharacter = Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
	if (
		hasControlCharacter ||
		/(?:^|\s)(?:(?:[a-z][a-z0-9+.-]*:)|\/\/)\S/iu.test(value) ||
		/[`*_~#[\]{}<>]/u.test(value)
	) {
		return yield* new MeetingPublicationReviewError({ code: "invalid_purpose" });
	}
	const compact = value.replace(/\s+/gu, " ").trim();
	if (compact.length === 0) return yield* new MeetingPublicationReviewError({ code: "invalid_purpose" });
	const sentence = /[.!?]$/u.test(compact) ? compact : `${compact}.`;
	if (Array.from(sentence).length > MEETING_PUBLICATION_PURPOSE_MAX_LENGTH) {
		return yield* new MeetingPublicationReviewError({ code: "invalid_purpose" });
	}
	return sentence;
});

/** Approval-gated, checkpointed meeting publication orchestration. */
export class MeetingPublicationService extends Context.Service<
	MeetingPublicationService,
	{
		/** Fatal owner stop on uncertain delivery or a failed claimed-outcome write. */
		readonly deliveryUncertain: Effect.Effect<never, MeetingPublicationProviderError>;
		readonly reconnectGoogle?: (
			redirectUri: string,
		) => Effect.Effect<MeetingPublicationReconnect, MeetingPublicationProviderError | MeetingPublicationStoreFailure>;
		readonly scan: (options?: {
			readonly sinceDays?: number;
			readonly dryRun?: boolean;
		}) => Effect.Effect<MeetingPublicationScanResult, MeetingPublicationStoreFailure>;
		readonly preflight: () => Effect.Effect<MeetingPublicationPreflightResult>;
		readonly approve: (
			itemId: string,
			reviewedHash: string,
			reviewedPurpose?: string,
		) => Effect.Effect<
			MeetingPublicationItem,
			| MeetingPublicationTransitionError
			| MeetingPublicationSourceError
			| MeetingPublicationStoreFailure
			| MeetingPublicationReviewError
		>;
		readonly updateNote: (
			itemId: string,
			reviewedHash: string,
			markdown: string,
		) => Effect.Effect<
			MeetingPublicationItem,
			MeetingPublicationTransitionError | MeetingPublicationSourceError | MeetingPublicationStoreFailure
		>;
		readonly reject: (
			itemId: string,
			reviewedHash?: string,
		) => Effect.Effect<
			MeetingPublicationItem,
			MeetingPublicationTransitionError | MeetingPublicationSourceError | MeetingPublicationStoreFailure
		>;
		readonly archive: (
			itemId: string,
			reviewedHash?: string,
		) => Effect.Effect<
			MeetingPublicationItem,
			MeetingPublicationTransitionError | MeetingPublicationSourceError | MeetingPublicationStoreFailure
		>;
		readonly restore: (itemId: string) => Effect.Effect<MeetingPublicationItem, MeetingPublicationStoreFailure>;
		readonly publishOne: (
			itemId: string,
			sourceHash: string,
		) => Effect.Effect<
			MeetingPublicationPublishOneResult,
			MeetingPublicationConfigError | MeetingPublicationProviderError | MeetingPublicationStoreFailure
		>;
		readonly worker: (
			maxItems?: number,
		) => Effect.Effect<
			MeetingPublicationWorkerResult,
			MeetingPublicationConfigError | MeetingPublicationProviderError | MeetingPublicationStoreFailure
		>;
	}
>()("@harnessy/core/MeetingPublicationService") {
	static layer(config: JarvisMeetingPublicationConfig) {
		return Layer.effect(
			MeetingPublicationService,
			Effect.gen(function* () {
				const authority = yield* MeetingPublicationWriteAuthority;
				const binding = yield* resolveMeetingPublicationWriteBinding(config, "service_worker");
				const source = yield* MeetingPublicationSource;
				const store = yield* MeetingPublicationStore;
				const clock = yield* MeetingPublicationClock;
				const notifier = yield* MeetingPublicationNotifier;
				const google = yield* MeetingPublicationGoogle;
				const startReconnect = google.startReconnect;
				const discord = yield* MeetingPublicationDiscord;
				const workerLock = yield* Semaphore.make(1);
				const uncertain = yield* Deferred.make<MeetingPublicationProviderError>();
				const requireCertainDelivery = Effect.gen(function* () {
					const pending = (yield* store.list()).find(
						(item) => item.failureCode === MEETING_PUBLICATION_DELIVERY_UNCERTAIN || item.status === "publishing",
					);
					if (pending !== undefined) {
						return yield* new MeetingPublicationProviderError({
							stage: pending.failureStage === "discord" ? "discord" : "google",
							code: "delivery_uncertain",
							retryable: false,
							retryAfterSeconds: null,
						});
					}
				});
				yield* Effect.addFinalizer(() =>
					Effect.all([notifier.close, google.close, discord.close], { discard: true }),
				);

				const refreshCurrentForReview = Effect.fn("MeetingPublicationService.refreshCurrentForReview")(function* (
					itemId: string,
					event: "update" | "approve" | "reject" | "archive",
					reviewedHash?: string,
				) {
					const item = yield* store.get(itemId);
					if (item === null) {
						return yield* new MeetingPublicationTransitionError({ from: "archived", event });
					}
					const note = yield* source.read(item.notePath);
					const refreshed = yield* store.upsert(note, iso(yield* clock.now));
					if (refreshed.changed || (reviewedHash !== undefined && note.sourceHash !== reviewedHash)) {
						return yield* new MeetingPublicationTransitionError({ from: item.status, event });
					}
					return { item: refreshed.item, note } as const;
				});

				const scan = Effect.fn("MeetingPublicationService.scan")(function* (
					options: { readonly sinceDays?: number; readonly dryRun?: boolean } = {},
				) {
					const now = yield* clock.now;
					const discovery = yield* source.discover(now, options.sinceDays);
					let created = 0;
					let changed = 0;
					let unchanged = 0;
					let archivedInvalid = 0;
					if (!options.dryRun) {
						archivedInvalid = yield* store.archivePaths(discovery.excludedPaths, iso(now));
						for (const note of discovery.notes) {
							const current = yield* store.get(note.itemId);
							if (
								current !== null &&
								current.sourceHash === note.sourceHash &&
								current.notePath === note.path &&
								current.meetingDate === note.meetingDate &&
								current.project === note.project
							) {
								unchanged += 1;
								continue;
							}
							const result = yield* store.upsert(note, iso(now));
							if (result.created) created += 1;
							else if (result.changed) changed += 1;
							else unchanged += 1;
						}
					}
					return new MeetingPublicationScanResult({
						filesSeen: discovery.filesSeen,
						eligible: discovery.notes.length,
						created,
						changed,
						unchanged,
						archivedInvalid,
						exclusions: { ...discovery.exclusions },
						itemIds: discovery.notes.map((note) => note.itemId),
						dryRun: options.dryRun ?? false,
					});
				});

				const notifyDue = Effect.fn("MeetingPublicationService.notifyDue")(function* () {
					const now = yield* clock.now;
					const due = yield* store.dueNotifications(minusSeconds(now, config.reminderSeconds));
					const health = yield* store.providerHealth();
					for (const kind of ["review", "error"] as const) {
						const items = due.filter(
							(item) =>
								(item.status === "pending_review") === (kind === "review") &&
								!health.some(
									(provider) => provider.provider === item.failureStage && provider.failure !== null,
								),
						);
						if (items.length === 0) continue;
						const grant = yield* authorizeMeetingPublicationWrite(authority, "provider_notification", binding);
						const failureStages =
							kind === "error"
								? [...new Set(items.flatMap((item) => (item.failureStage === null ? [] : [item.failureStage])))]
								: undefined;
						if (yield* notifier.notify(kind, items.length, grant, undefined, failureStages)) {
							yield* store.markNotified(items, iso(yield* clock.now));
						}
					}
				});

				const checkProviderHealth = Effect.fn("MeetingPublicationService.checkProviderHealth")(function* (
					force = false,
					resume = true,
				) {
					const now = yield* clock.now;
					const previous = yield* store.providerHealth();
					let ready = true;
					for (const [provider, account, preflight] of [
						["google", config.googleOwnerEmail ?? "", google.preflight],
						["discord", config.discordChannelId ?? "", discord.preflight],
					] as const) {
						const prior = previous.find((row) => row.provider === provider && row.account === account);
						let health: MeetingProviderHealth;
						if (!force && prior !== undefined && now - Date.parse(prior.checkedAt) < 60_000) health = prior;
						else {
							const result = yield* preflight.pipe(Effect.result);
							const failure = Result.isFailure(result)
								? classifyMeetingProviderFailure(result.failure.code)
								: result.success
									? null
									: "other";
							health = {
								provider,
								account,
								failure,
								checkedAt: iso(now),
								lastSuccessAt: failure === null ? iso(now) : (prior?.lastSuccessAt ?? null),
								incidentAt: failure === null ? null : (prior?.incidentAt ?? iso(now)),
								notifiedAt: prior?.failure === failure ? (prior?.notifiedAt ?? null) : null,
								recoveryPending:
									failure === null && (prior?.failure != null || prior?.recoveryPending === true),
							};
							yield* store.recordProviderHealth(health);
						}
						if (health.failure !== null) ready = false;
						if (resume && health.failure === null) {
							for (const item of yield* store.list("blocked")) {
								if (item.failureStage !== provider || item.approvedHash === null) continue;
								const note = yield* source.read(item.notePath).pipe(Effect.result);
								if (Result.isFailure(note)) continue;
								if (note.success.sourceHash !== item.approvedHash) {
									yield* store.upsert(note.success, iso(now));
									continue;
								}
								yield* store.resumeAuthBlocked(item, iso(now));
							}
						}
						if (
							(health.failure !== null || health.recoveryPending) &&
							(health.notifiedAt === null ||
								now - Date.parse(health.notifiedAt) >= config.reminderSeconds * 1000)
						) {
							const count = (yield* store.list()).filter(
								(item) => item.status === "approved" || item.status === "blocked",
							).length;
							const grant = yield* authorizeMeetingPublicationWrite(authority, "provider_notification", binding);
							const notified = yield* notifier.notify("error", count, grant, health).pipe(Effect.result);
							if (Result.isSuccess(notified) && notified.success)
								yield* store.recordProviderHealth({ ...health, notifiedAt: iso(now), recoveryPending: false });
						}
					}
					return ready;
				});
				const recordAuthFailure = Effect.fn("MeetingPublicationService.recordAuthFailure")(function* (
					error: MeetingPublicationProviderError,
					now: number,
				) {
					const failure = classifyMeetingProviderFailure(error.code);
					if (
						!["authentication", "identity", "credential_store"].includes(failure) ||
						error.stage === "notification"
					)
						return;
					const account =
						error.stage === "google" ? (config.googleOwnerEmail ?? "") : (config.discordChannelId ?? "");
					const prior = (yield* store.providerHealth()).find(
						(row) => row.provider === error.stage && row.account === account,
					);
					yield* store.recordProviderHealth({
						provider: error.stage,
						account,
						failure,
						checkedAt: iso(now),
						lastSuccessAt: prior?.lastSuccessAt ?? null,
						incidentAt: prior?.incidentAt ?? iso(now),
						notifiedAt: prior?.failure === failure ? prior.notifiedAt : null,
						recoveryPending: false,
					});
				});

				const publishClaimed = Effect.fn("MeetingPublicationService.publishClaimed")(
					function* (item: MeetingPublicationItem, monitorHealth = false) {
						const noteResult = yield* source.read(item.notePath).pipe(Effect.result);
						if (Result.isFailure(noteResult)) {
							yield* store.markFailure(item, "source", noteResult.failure.code, null, iso(yield* clock.now));
							return "recorded_failure" as const;
						}
						const note = noteResult.success;
						if (item.approvedHash === null || note.sourceHash !== item.approvedHash) {
							// No provider has been called. Record that known outcome with the exact
							// live claim before allowing a later scan to reconcile changed source.
							yield* store.markFailure(item, "source", "source_changed", null, iso(yield* clock.now));
							return "stale" as const;
						}
						const itemBinding = new MeetingPublicationWriteBinding({
							...binding,
							item: { itemId: item.itemId, sourceHash: note.sourceHash },
						});
						let googleCheckpoint: MeetingPublicationGoogleCheckpoint;
						if (
							item.googleDocId !== null &&
							item.googleDocUrl !== null &&
							item.googleSourceHash === note.sourceHash
						) {
							googleCheckpoint = new MeetingPublicationGoogleCheckpoint({
								docId: item.googleDocId,
								docUrl: item.googleDocUrl,
							});
						} else {
							const googleGrant = yield* authorizeMeetingPublicationWrite(
								authority,
								"provider_google",
								itemBinding,
							);
							yield* store.getClaim(item, iso(yield* clock.now));
							const googleResult = yield* google
								.upsert(
									{
										itemId: item.itemId,
										title: note.title,
										meetingDate: note.meetingDate,
										sourceHash: note.sourceHash,
										markdown: note.markdown,
										existingDocId: item.googleDocId,
									},
									googleGrant,
								)
								.pipe(Effect.result);
							const completedAt = yield* clock.now;
							if (Result.isFailure(googleResult)) {
								const error = googleResult.failure;
								if (error.code === "delivery_uncertain") {
									yield* store
										.markFailure(item, "google", error.code, null, iso(completedAt))
										.pipe(Effect.ensuring(Deferred.succeed(uncertain, error)), Effect.uninterruptible);
									return yield* error;
								}
								yield* store.markFailure(
									item,
									"google",
									error.code,
									providerRetryAt(completedAt, error),
									iso(completedAt),
								);
								if (monitorHealth) yield* recordAuthFailure(error, completedAt);
								return "recorded_failure" as const;
							}
							googleCheckpoint = googleResult.success;
							yield* store.recordGoogle(item, googleCheckpoint.docId, googleCheckpoint.docUrl, iso(completedAt));
						}
						const discordGrant = yield* authorizeMeetingPublicationWrite(
							authority,
							"provider_discord",
							itemBinding,
						);
						const checkpointed = yield* store.getClaim(item, iso(yield* clock.now));
						const discordResult = yield* discord
							.upsert(
								{
									itemId: item.itemId,
									sourceHash: note.sourceHash,
									title: note.title,
									meetingDate: note.meetingDate,
									googleDocUrl: googleCheckpoint.docUrl,
									purpose: checkpointed.discordPurposeOverride ?? meetingPublicationDefaultPurpose(note),
									existingChannelId: checkpointed.discordChannelId,
									existingMessageId: checkpointed.discordMessageId,
								},
								discordGrant,
							)
							.pipe(Effect.result);
						const completedAt = yield* clock.now;
						if (Result.isFailure(discordResult)) {
							const error = discordResult.failure;
							if (error.code === "delivery_uncertain") {
								yield* store
									.markFailure(item, "discord", error.code, null, iso(completedAt))
									.pipe(Effect.ensuring(Deferred.succeed(uncertain, error)), Effect.uninterruptible);
								return yield* error;
							}
							yield* store.markFailure(
								item,
								"discord",
								error.code,
								providerRetryAt(completedAt, error),
								iso(completedAt),
							);
							if (monitorHealth) yield* recordAuthFailure(error, completedAt);
							return "recorded_failure" as const;
						}
						yield* store.recordDiscord(
							item,
							discordResult.success.channelId,
							discordResult.success.messageId,
							iso(completedAt),
						);
						yield* store.markPublished(item, iso(yield* clock.now));
						return "published" as const;
					},
					Effect.onError(() =>
						// A failed checkpoint must stop manual dispatch's owner immediately too.
						// Retained publishing state prevents a fresh owner from retrying even
						// when persisting a separate uncertainty marker is impossible.
						Deferred.succeed(
							uncertain,
							new MeetingPublicationProviderError({
								stage: "google",
								code: "delivery_uncertain",
								retryable: false,
								retryAfterSeconds: null,
							}),
						),
					),
				);

				return MeetingPublicationService.of({
					deliveryUncertain: Deferred.await(uncertain).pipe(Effect.flatMap(Effect.fail)),
					...(startReconnect === undefined
						? {}
						: {
								reconnectGoogle: Effect.fn("MeetingPublicationService.reconnectGoogle")(function* (
									redirectUri: string,
								) {
									const grant = yield* authorizeMeetingPublicationWrite(
										authority,
										"provider_google_reconnect",
										binding,
									);
									const flow = yield* startReconnect(redirectUri, grant);
									let consumed = false;
									const take = () =>
										Effect.sync(() => {
											if (consumed) return false;
											consumed = true;
											return true;
										});
									return {
										state: flow.state,
										authorizationUrl: flow.authorizationUrl,
										complete: Effect.fn("MeetingPublicationService.completeReconnect")(function* (
											code: string,
										) {
											if (!(yield* take()))
												return yield* new MeetingPublicationProviderError({
													stage: "google",
													code: "reconnect_consumed",
													retryable: false,
													retryAfterSeconds: null,
												});
											const fresh = yield* authorizeMeetingPublicationWrite(
												authority,
												"provider_google_reconnect",
												binding,
											);
											const completed = yield* flow.complete(code, fresh).pipe(Effect.result);
											yield* authorizeMeetingPublicationWrite(
												authority,
												"provider_google_reconnect",
												binding,
											);
											// Refresh health, but leave approval recovery/publication to a later worker pass.
											if (Result.isFailure(completed)) {
												yield* checkProviderHealth(true, false).pipe(Effect.result);
												return yield* completed.failure;
											}
											yield* checkProviderHealth(true, false);
										}, workerLock.withPermits(1)),
										cancel: Effect.fn("MeetingPublicationService.cancelReconnect")(function* () {
											if (!(yield* take())) return;
											const fresh = yield* authorizeMeetingPublicationWrite(
												authority,
												"provider_google_reconnect",
												binding,
											);
											yield* flow.cancel(fresh);
										}, workerLock.withPermits(1)),
									};
								}, workerLock.withPermits(1)),
							}),
					scan,
					preflight: Effect.fn("MeetingPublicationService.preflight")(function* () {
						const checks = configurationChecks(config);
						if (checks.every((check) => check.passed)) {
							const discovered = yield* source.discover(yield* clock.now);
							checks.push(
								new MeetingPublicationPreflightCheck({
									name: "note_quality",
									passed: Object.keys(discovered.exclusions).every((code) => code === "before_cutoff"),
									required: true,
									code: Object.keys(discovered.exclusions).every((code) => code === "before_cutoff")
										? "ok"
										: "unsafe_notes",
								}),
							);
							for (const [name, result] of [
								["google", yield* google.preflight.pipe(Effect.result)],
								["discord", yield* discord.preflight.pipe(Effect.result)],
							] as const) {
								checks.push(
									new MeetingPublicationPreflightCheck({
										name,
										passed: Result.isSuccess(result) && result.success,
										required: true,
										code: Result.isFailure(result)
											? result.failure.code
											: result.success
												? "ok"
												: "unavailable",
									}),
								);
							}
						}
						return new MeetingPublicationPreflightResult({
							ready: checks.every((check) => !check.required || check.passed),
							checks,
						});
					}, workerLock.withPermits(1)),
					approve: Effect.fn("MeetingPublicationService.approve")(function* (
						itemId: string,
						reviewedHash: string,
						reviewedPurpose?: string,
					) {
						const { note } = yield* refreshCurrentForReview(itemId, "approve", reviewedHash);
						let discordPurposeOverride: string | null = null;
						if (reviewedPurpose !== undefined) {
							const normalized = yield* normalizeMeetingPublicationPurpose(reviewedPurpose);
							if (normalized !== meetingPublicationDefaultPurpose(note)) discordPurposeOverride = normalized;
						}
						return yield* store.approve(itemId, reviewedHash, discordPurposeOverride, iso(yield* clock.now));
					}),
					updateNote: Effect.fn("MeetingPublicationService.updateNote")(function* (
						itemId: string,
						reviewedHash: string,
						markdown: string,
					) {
						const { item } = yield* refreshCurrentForReview(itemId, "update", reviewedHash);
						yield* transitionMeetingPublication(item.status, "update");
						const note = yield* source.update({
							path: item.notePath,
							markdown,
							expectedItemId: item.itemId,
							expectedSourceHash: reviewedHash,
						});
						// The canonical file commits before SQLite. If this upsert fails, the
						// next scan observes the new source hash and repairs the pending row;
						// providers remain gated on a later, explicit approval.
						const updated = yield* store.upsert(note, iso(yield* clock.now));
						if (updated.created || updated.item.itemId !== item.itemId) {
							return yield* new MeetingPublicationTransitionError({ from: item.status, event: "update" });
						}
						return updated.item;
					}),
					reject: Effect.fn("MeetingPublicationService.reject")(function* (itemId: string, reviewedHash?: string) {
						const { note } = yield* refreshCurrentForReview(itemId, "reject", reviewedHash);
						return yield* store.reject(itemId, note.sourceHash, iso(yield* clock.now));
					}),
					archive: Effect.fn("MeetingPublicationService.archive")(function* (
						itemId: string,
						reviewedHash?: string,
					) {
						const { note } = yield* refreshCurrentForReview(itemId, "archive", reviewedHash);
						return yield* store.archive(itemId, note.sourceHash, iso(yield* clock.now));
					}),
					restore: Effect.fn("MeetingPublicationService.restore")(function* (itemId: string) {
						return yield* store.restore(itemId, iso(yield* clock.now));
					}),
					publishOne: Effect.fn("MeetingPublicationService.publishOne")(function* (
						itemId: string,
						sourceHash: string,
					) {
						yield* requireCertainDelivery;
						const itemBinding = new MeetingPublicationWriteBinding({
							...binding,
							item: { itemId, sourceHash },
						});
						yield* authorizeMeetingPublicationWrite(authority, "service_worker", itemBinding);
						if (!config.enabled) return { status: "not_published", itemId, sourceHash } as const;
						yield* requireEnabledConfig(config);
						const current = yield* store.get(itemId);
						if (current === null || current.sourceHash !== sourceHash || current.approvedHash !== sourceHash) {
							return { status: "not_published", itemId, sourceHash } as const;
						}
						const note = yield* source.read(current.notePath).pipe(Effect.result);
						if (
							Result.isFailure(note) ||
							note.success.itemId !== itemId ||
							note.success.sourceHash !== sourceHash
						) {
							return { status: "not_published", itemId, sourceHash } as const;
						}
						const now = yield* clock.now;
						const item = yield* store.claimExact(
							itemId,
							sourceHash,
							iso(now),
							plusSeconds(now, config.leaseSeconds),
						);
						if (item === null) return { status: "not_published", itemId, sourceHash } as const;
						return (yield* publishClaimed(item)) === "published"
							? ({ status: "published", itemId, sourceHash } as const)
							: ({ status: "not_published", itemId, sourceHash } as const);
					}, workerLock.withPermits(1)),
					worker: Effect.fn("MeetingPublicationService.worker")(function* (maxItems = 10) {
						yield* requireCertainDelivery;
						yield* authorizeMeetingPublicationWrite(authority, "service_worker", binding);
						if (!config.enabled) {
							const counts = yield* store.counts();
							return new MeetingPublicationWorkerResult({
								scanned: 0,
								published: 0,
								failed: 0,
								pendingReview: counts.pending_review ?? 0,
							});
						}
						yield* requireEnabledConfig(config);
						const scanned = yield* scan();
						const providersReady = yield* checkProviderHealth();
						yield* notifyDue();
						let published = 0;
						let failed = 0;
						for (let index = 0; providersReady && index < maxItems; index += 1) {
							const now = yield* clock.now;
							const item = yield* store.claim(iso(now), plusSeconds(now, config.leaseSeconds));
							if (item === null) break;
							const outcome = yield* publishClaimed(item, true);
							if (outcome === "published") published += 1;
							else {
								failed += 1;
								if (outcome === "recorded_failure") {
									const stillReady = yield* checkProviderHealth();
									yield* notifyDue();
									if (!stillReady) break;
								}
							}
						}
						const counts = yield* store.counts();
						return new MeetingPublicationWorkerResult({
							scanned: scanned.eligible,
							published,
							failed,
							pendingReview: counts.pending_review ?? 0,
						});
					}, workerLock.withPermits(1)),
				});
			}),
		);
	}
}
