import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	type MeetingPublicationWriteGrant,
	validateMeetingPublicationWriteGrant,
} from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS,
	verifyMeetingPublicationFullReviewInput,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import {
	type MeetingPublicationFullReviewRuntimeHost,
	type MeetingPublicationWorkerProviderFactory,
	runAuthorizedMeetingPublicationFullReview,
	runAuthorizedMeetingPublicationWorker,
} from "../src/jarvis/meeting-publication/operational-runtime.ts";
import {
	MeetingPublicationDiscord,
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationNotifier,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";
import { createMeetingPublicationFullReviewAuthorizationFixture } from "./support/meeting-full-review-runtime-fixture.ts";

const roots: Array<string> = [];
const activeFibers: Array<Fiber.Fiber<void, unknown>> = [];

const markdown = (summary: string) => `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-04
- Fingerprint: full-review

## Executive Summary
${summary}

## Meeting Purpose
Ship the bounded full review.
`;

afterEach(async () => {
	for (const fiber of activeFibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (root: string, reviewPort = 0) =>
	new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort,
		reviewSessionSeconds: 60,
		reviewMaxSessions: 4,
		reviewMaxBodyBytes: 8_192,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "fixture-folder",
		discordChannelId: "123456789012345678",
	});

const setup = async (
	options: {
		readonly reviewPort?: number;
		readonly runtimeMode?: "bounded" | "long_running";
		readonly authBlocked?: boolean;
		readonly approved?: boolean;
	} = {},
) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-full-review-runtime-"));
	roots.push(root);
	chmodSync(root, 0o700);
	for (const directory of ["notes", "credentials", "private"]) {
		mkdirSync(join(root, directory), { mode: 0o700 });
		chmodSync(join(root, directory), 0o700);
	}
	const notePath = join(root, "notes", "meeting.md");
	writeFileSync(notePath, markdown("Review this meeting before dispatch."), { mode: 0o600 });
	chmodSync(notePath, 0o600);
	const config = makeConfig(root, options.reviewPort);
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const note = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const store = yield* MeetingPublicationStore;
				const note = yield* source.read(notePath);
				if (options.authBlocked || options.approved) {
					const now = new Date().toISOString();
					yield* store.upsert(note, now);
					yield* store.approve(note.itemId, note.sourceHash, "Preserved reviewed summary.", now);
					if (!options.authBlocked) return note;
					const claim = yield* store.claim(now, new Date(Date.parse(now) + 60_000).toISOString());
					if (claim === null) return yield* Effect.die("missing seeded claim");
					yield* store.recordGoogle(claim, "existing-doc", "https://docs.example.test/existing-doc", now);
					yield* store.markFailure(claim, "discord", "authentication_failed", null, now);
				}
				return note;
			}).pipe(
				Effect.provide(
					Layer.merge(
						MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
						MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
					),
				),
			),
		),
	);
	const engineStatePath = join(root, "engine.sqlite3");
	const engine = new DatabaseSync(engineStatePath, { allowExtension: false });
	try {
		engine.exec("CREATE TABLE fixture_connection (name TEXT PRIMARY KEY) STRICT;");
	} finally {
		engine.close();
	}
	chmodSync(engineStatePath, 0o600);
	const installationRoot = realpathSync(
		join(dirname(fileURLToPath(import.meta.url)), "../src/jarvis/meeting-publication"),
	);
	const artifactAnchors = {
		core: join(installationRoot, "operational-input.ts"),
		host: join(installationRoot, "operational-runtime.ts"),
		sdk: join(installationRoot, "service.ts"),
		dependencies: join(installationRoot, "authority.ts"),
	};
	const authorization = createMeetingPublicationFullReviewAuthorizationFixture({
		privateRoot: join(root, "private"),
		config,
		credentialDirectory: join(root, "credentials"),
		engineStatePath,
		installationRoot,
		artifactAnchors,
		runtimeMode: options.runtimeMode,
	});
	return { root, config, notePath, note, authorization };
};

const stateDatabasePath = (fixture: Awaited<ReturnType<typeof setup>>) =>
	join(fixture.config.statePath as string, "meeting-publication.sqlite3");

const stateRow = (fixture: Awaited<ReturnType<typeof setup>>) => {
	const database = new DatabaseSync(stateDatabasePath(fixture), { readOnly: true, allowExtension: false });
	try {
		return database.prepare("SELECT * FROM publication_items WHERE item_id=?").get(fixture.note.itemId) as
			| Record<string, unknown>
			| undefined;
	} finally {
		database.close();
	}
};

const replayState = (path: string) => {
	const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
	try {
		return {
			consumed: Number(database.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count),
			leases: Number(database.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count),
		};
	} finally {
		database.close();
	}
};

const makeGate = () => {
	let signalStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	let release: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { started, signalStarted, released, release };
};

const providerFactory = (
	fixture: Awaited<ReturnType<typeof setup>>,
	options: {
		readonly googleGate?: ReturnType<typeof makeGate>;
		readonly startupGate?: ReturnType<typeof makeGate>;
		readonly beforeDiscordPreflight?: () => void;
		readonly discordUnavailable?: boolean;
		readonly uncertainStage?: "google" | "discord";
		readonly reconnect?: { readonly beforeComplete?: () => void };
	} = {},
) => {
	const calls = {
		make: 0,
		google: [] as Array<{ readonly itemId: string; readonly sourceHash: string }>,
		googleCompleted: 0,
		discord: [] as Array<{ readonly itemId: string; readonly sourceHash: string; readonly purpose: string }>,
		notifications: 0,
		closed: 0,
		reconnectStarted: 0,
		reconnectCompleted: 0,
		reconnectGrants: [] as Array<MeetingPublicationWriteGrant>,
	};
	let googleReady = options.reconnect === undefined;
	const providerError = (stage: "google" | "discord" | "notification") =>
		new MeetingPublicationProviderError({
			stage,
			code: "authorization_revoked",
			retryable: false,
			retryAfterSeconds: null,
		});
	const validate = (
		grant: MeetingPublicationWriteGrant,
		operation: "provider_google" | "provider_discord",
		item: { readonly itemId: string; readonly sourceHash: string },
	) =>
		validateMeetingPublicationWriteGrant(grant, operation, item).pipe(
			Effect.mapError(() => providerError(operation === "provider_google" ? "google" : "discord")),
		);
	const factory: MeetingPublicationWorkerProviderFactory = {
		artifactAnchors: fixture.authorization.providerArtifactAnchors,
		make: (binding) =>
			Effect.sync(() => {
				calls.make += 1;
				expect(binding.sourcePath).toBe(fixture.config.sourcePath);
				expect(binding.statePath).toBe(fixture.config.statePath);
				return Layer.mergeAll(
					Layer.succeed(
						MeetingPublicationGoogle,
						MeetingPublicationGoogle.of({
							preflight: Effect.gen(function* () {
								options.startupGate?.signalStarted();
								if (options.startupGate !== undefined)
									yield* Effect.promise(() => options.startupGate!.released);
								return yield* googleReady
									? Effect.succeed(true)
									: Effect.fail(
											new MeetingPublicationProviderError({
												stage: "google",
												code: "authentication_failed",
												retryable: false,
												retryAfterSeconds: null,
											}),
										);
							}),
							...(options.reconnect === undefined
								? {}
								: {
										startReconnect: (redirectUri: string, grant: MeetingPublicationWriteGrant) =>
											Effect.gen(function* () {
												yield* validateMeetingPublicationWriteGrant(
													grant,
													"provider_google_reconnect",
												).pipe(Effect.mapError(() => providerError("google")));
												expect(grant.binding.item).toBeUndefined();
												expect(new URL(redirectUri).pathname).toBe("/google-reconnect/callback");
												calls.reconnectStarted += 1;
												calls.reconnectGrants.push(grant);
												return {
													state: "signed_fixture_reconnect_state_1234",
													authorizationUrl:
														"https://accounts.google.com/o/oauth2/v2/auth?state=signed_fixture_reconnect_state_1234",
													complete: (code: string, fresh: MeetingPublicationWriteGrant) =>
														Effect.gen(function* () {
															options.reconnect?.beforeComplete?.();
															yield* validateMeetingPublicationWriteGrant(
																fresh,
																"provider_google_reconnect",
															).pipe(Effect.mapError(() => providerError("google")));
															expect(code).toBe("synthetic-consent-code");
															expect(fresh).not.toBe(grant);
															calls.reconnectGrants.push(fresh);
															calls.reconnectCompleted += 1;
															googleReady = true;
														}),
													cancel: (fresh: MeetingPublicationWriteGrant) =>
														validateMeetingPublicationWriteGrant(fresh, "provider_google_reconnect").pipe(
															Effect.mapError(() => providerError("google")),
															Effect.asVoid,
														),
												};
											}),
									}),
							upsert: (request, grant) =>
								Effect.gen(function* () {
									yield* validate(grant, "provider_google", request);
									calls.google.push({ itemId: request.itemId, sourceHash: request.sourceHash });
									options.googleGate?.signalStarted();
									if (options.googleGate !== undefined) {
										yield* Effect.promise(() => options.googleGate!.released);
									}
									calls.googleCompleted += 1;
									if (options.uncertainStage === "google")
										return yield* new MeetingPublicationProviderError({
											stage: "google",
											code: "delivery_uncertain",
											retryable: false,
											retryAfterSeconds: null,
										});
									return new MeetingPublicationGoogleCheckpoint({
										docId: `doc-${request.itemId}`,
										docUrl: `https://docs.example.test/${request.itemId}`,
									});
								}),
							close: Effect.sync(() => {
								calls.closed += 1;
							}),
						}),
					),
					Layer.succeed(
						MeetingPublicationDiscord,
						MeetingPublicationDiscord.of({
							preflight: Effect.sync(() => {
								options.beforeDiscordPreflight?.();
								return !options.discordUnavailable;
							}),
							upsert: (request, grant) =>
								validate(grant, "provider_discord", request).pipe(
									Effect.andThen(
										Effect.sync(() => {
											calls.discord.push({
												itemId: request.itemId,
												sourceHash: request.sourceHash,
												purpose: request.purpose,
											});
											return new MeetingPublicationDiscordCheckpoint({
												channelId: request.existingChannelId ?? fixture.config.discordChannelId ?? "",
												messageId: request.existingMessageId ?? `message-${request.itemId}`,
											});
										}),
									),
									Effect.flatMap((checkpoint) =>
										options.uncertainStage === "discord"
											? Effect.fail(
													new MeetingPublicationProviderError({
														stage: "discord",
														code: "delivery_uncertain",
														retryable: false,
														retryAfterSeconds: null,
													}),
												)
											: Effect.succeed(checkpoint),
									),
								),
							close: Effect.sync(() => {
								calls.closed += 1;
							}),
						}),
					),
					Layer.succeed(
						MeetingPublicationNotifier,
						MeetingPublicationNotifier.of({
							notify: (_kind, _count, grant) =>
								validateMeetingPublicationWriteGrant(grant, "provider_notification").pipe(
									Effect.mapError(() => providerError("notification")),
									Effect.tap(() =>
										Effect.sync(() => {
											calls.notifications += 1;
										}),
									),
									Effect.as(false),
								),
							close: Effect.sync(() => {
								calls.closed += 1;
							}),
						}),
					),
				);
			}),
	};
	return { calls, factory };
};

interface HttpResult {
	readonly status: number;
	readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
	readonly body: string;
}

const call = (
	origin: string,
	path: string,
	options: { readonly method?: string; readonly cookie?: string; readonly body?: string } = {},
) =>
	new Promise<HttpResult>((resolveRequest, rejectRequest) => {
		const target = new URL(origin);
		const headers: Record<string, string> = { Host: target.host };
		if (options.cookie !== undefined) headers.Cookie = options.cookie;
		if (options.body !== undefined) {
			headers.Origin = origin;
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			headers["Content-Length"] = String(Buffer.byteLength(options.body));
		}
		const outgoing = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				method: options.method ?? "GET",
				headers,
			},
			(response) => {
				const chunks: Array<Buffer> = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () =>
					resolveRequest({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		outgoing.setTimeout(10_000, () => outgoing.destroy(new Error("request timeout")));
		outgoing.on("error", rejectRequest);
		outgoing.end(options.body);
	});

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const post = (origin: string, cookie: string, path: string, values: Record<string, string>) =>
	call(origin, path, { method: "POST", cookie, body: form(values) });

const cookieFrom = (response: HttpResult) => {
	const header = response.headers["set-cookie"];
	const first = Array.isArray(header) ? header[0] : header;
	if (first === undefined) throw new Error("missing review cookie");
	return first.split(";", 1)[0] as string;
};

const csrfFrom = (body: string) => {
	const value = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(body)?.[1];
	if (value === undefined) throw new Error("missing review csrf");
	return value;
};

const startFullReview = async (
	fixture: Awaited<ReturnType<typeof setup>>,
	provider: ReturnType<typeof providerFactory>,
	drain?: MeetingPublicationFullReviewRuntimeHost["drain"],
) => {
	let publishAddress: ((address: { readonly origin: string }) => void) | undefined;
	const address = new Promise<{ readonly origin: string }>((resolve) => {
		publishAddress = resolve;
	});
	const host: MeetingPublicationFullReviewRuntimeHost = {
		...(drain === undefined ? {} : { drain }),
		artifactAnchors: {
			host: fixture.authorization.providerArtifactAnchors.host,
			dependencies: fixture.authorization.providerArtifactAnchors.dependencies,
		},
		onReady: (ready) => Effect.sync(() => publishAddress?.(ready)),
	};
	const fiber = Effect.runFork(
		fixture.authorization.withSystem(
			runAuthorizedMeetingPublicationFullReview(fixture.authorization.input, provider.factory, host),
		),
	);
	activeFibers.push(fiber);
	const ready = await Promise.race([
		address,
		Effect.runPromise(Fiber.await(fiber)).then((exit) => {
			throw new Error(`full review exited before ready: ${JSON.stringify(exit)}`);
		}),
	]);
	return { fiber, address: ready };
};

const authenticate = async (fixture: Awaited<ReturnType<typeof setup>>, origin: string) => {
	const token = readFileSync(
		join(fixture.config.statePath as string, "meeting-publication-v2-review.token"),
		"utf8",
	).trim();
	const exchange = await call(origin, `/exchange?token=${encodeURIComponent(token)}`);
	return cookieFrom(exchange);
};

const approveForDispatch = async (fixture: Awaited<ReturnType<typeof setup>>, origin: string) => {
	const cookie = await authenticate(fixture, origin);
	const page = await call(origin, `/item/${fixture.note.itemId}`, { cookie });
	const csrf = csrfFrom(page.body);
	const approved = await post(origin, cookie, `/approve/${fixture.note.itemId}`, {
		csrf,
		item_id: fixture.note.itemId,
		source_hash: String(stateRow(fixture)?.source_hash),
		purpose: "Reviewer-approved full-review dispatch purpose",
	});
	return { cookie, csrf, approved };
};

const settleWithin = async <A>(promise: Promise<A>, milliseconds = 4_000) =>
	Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("operation did not settle")), milliseconds);
		}),
	]);

describe("meeting publication authorized full-review runtime", () => {
	for (const drift of ["content", "replacement", "non-executable"] as const) {
		it(`rejects post-start ${drift} drift of a signed launcher outside the artifact root`, async () => {
			const fixture = await setup();
			const notifierPath = join(fixture.root, "external-notifier");
			const launcherPath = join(fixture.root, "external-review-open");
			const bytes = "#!/bin/sh\nexit 0\n";
			const bind = (path: string) => {
				writeFileSync(path, bytes, { mode: 0o700 });
				const stat = lstatSync(path, { bigint: true });
				return {
					path,
					device: stat.dev.toString(),
					inode: stat.ino.toString(),
					sha256: createHash("sha256").update(bytes).digest("hex"),
				};
			};
			const notifier = bind(notifierPath);
			const launcher = bind(launcherPath);
			fixture.authorization.resign((payload) => {
				payload.notifier = {
					kind: "terminal-notifier",
					executable: notifier,
					reviewOpen: { executable: launcher, statePath: fixture.config.statePath as string },
				};
			});
			const provider = providerFactory(fixture);
			const running = await startFullReview(fixture, provider);
			const cookie = await authenticate(fixture, running.address.origin);
			expect((await call(running.address.origin, "/", { cookie })).status).toBe(200);
			const before = stateRow(fixture);
			const notifications = provider.calls.notifications;
			if (drift === "content") writeFileSync(launcherPath, "#!/bin/sh\nexit 1\n");
			else if (drift === "non-executable") chmodSync(launcherPath, 0o600);
			else {
				const replacement = join(fixture.root, "replacement");
				writeFileSync(replacement, bytes, { mode: 0o700 });
				renameSync(replacement, launcherPath);
				expect(lstatSync(launcherPath, { bigint: true }).ino.toString()).not.toBe(launcher.inode);
			}
			expect((await call(running.address.origin, "/", { cookie })).status).toBe(503);
			expect(stateRow(fixture)).toEqual(before);
			expect(provider.calls.notifications).toBe(notifications);
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			await Effect.runPromise(Fiber.interrupt(running.fiber));
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		});
	}
	it("preserves the signed immutable notification launcher and rejects launcher or state drift", async () => {
		const fixture = await setup();
		const executablePath = join(fixture.root, "review-open");
		writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const stat = lstatSync(executablePath, { bigint: true });
		const executable = {
			path: executablePath,
			device: stat.dev.toString(),
			inode: stat.ino.toString(),
			sha256: createHash("sha256").update(readFileSync(executablePath)).digest("hex"),
		};
		const reviewOpen = { executable, statePath: fixture.config.statePath as string };
		const notifierPath = join(fixture.root, "notifier");
		writeFileSync(notifierPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		const notifierStat = lstatSync(notifierPath, { bigint: true });
		const notifierExecutable = {
			...executable,
			path: notifierPath,
			device: notifierStat.dev.toString(),
			inode: notifierStat.ino.toString(),
		};
		fixture.authorization.resign((payload) => {
			payload.notifier = { kind: "terminal-notifier", executable: notifierExecutable, reviewOpen };
		});
		const payload = fixture.authorization.payload;
		const observation = {
			...payload.runtime,
			uid: BigInt(payload.runtime.uid),
			now: Date.parse(payload.issuedAt) + 1_000,
			monotonic: 0n,
		};
		const verified = verifyMeetingPublicationFullReviewInput(fixture.authorization.input, observation);
		const notifier = verified.providerBinding.notifier;
		if (notifier.kind === "unavailable") throw new Error("missing signed notifier");
		expect(notifier.reviewOpen).toEqual(reviewOpen);
		expect(Object.isFrozen(notifier.reviewOpen)).toBe(true);
		expect(Object.isFrozen(notifier.reviewOpen?.executable)).toBe(true);
		expect(notifier.reviewOpen).not.toBe(
			verified.authorization.notifier.kind === "unavailable"
				? undefined
				: verified.authorization.notifier.reviewOpen,
		);
		fixture.authorization.resign((draft) => {
			draft.notifier = {
				kind: "terminal-notifier",
				executable: notifierExecutable,
				reviewOpen: { ...reviewOpen, statePath: fixture.root },
			};
		});
		expect(() => verifyMeetingPublicationFullReviewInput(fixture.authorization.input, observation)).toThrowError(
			expect.objectContaining({ code: "invalid_input" }),
		);
		fixture.authorization.resign((draft) => {
			draft.notifier = { kind: "terminal-notifier", executable: notifierExecutable, reviewOpen };
		});
		writeFileSync(executablePath, "#!/bin/sh\nexit 1\n");
		expect(() => verifyMeetingPublicationFullReviewInput(fixture.authorization.input, observation)).toThrowError(
			expect.objectContaining({ code: "artifact_drift" }),
		);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	for (const stage of ["google", "discord"] as const) {
		it(`stops the owning runtime after manual ${stage} delivery uncertainty`, async () => {
			const fixture = await setup({ approved: true });
			const before = stateRow(fixture);
			const provider = providerFactory(fixture, { uncertainStage: stage });
			const running = await startFullReview(fixture, provider);
			const cookie = await authenticate(fixture, running.address.origin);
			const csrf = csrfFrom((await call(running.address.origin, "/", { cookie })).body);
			const response = post(running.address.origin, cookie, "/dispatch", { csrf }).catch(() => null);
			const exit = await settleWithin(Effect.runPromise(Fiber.await(running.fiber)));
			expect(Exit.isFailure(exit)).toBe(true);
			await settleWithin(response);
			expect(stateRow(fixture)).toMatchObject({
				status: "blocked",
				failure_stage: stage,
				next_attempt_at: null,
				approved_hash: before?.approved_hash,
				approved_at: before?.approved_at,
				attempts: 1,
				discord_message_id: null,
			});
			expect(provider.calls.google).toHaveLength(1);
			expect(provider.calls.discord).toHaveLength(stage === "discord" ? 1 : 0);
			expect(provider.calls.closed).toBe(3);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			await expect(call(running.address.origin, "/")).rejects.toThrow();
		});
	}

	it.effect("stops the scheduled owner rather than retrying uncertain delivery", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.now());
			const fixture = yield* Effect.promise(() =>
				setup({ approved: true, reviewPort: 18_775, runtimeMode: "long_running" }),
			);
			const provider = providerFactory(fixture, { uncertainStage: "google" });
			const ready = makeGate();
			const fiber = yield* fixture.authorization
				.withSystem(
					runAuthorizedMeetingPublicationFullReview(fixture.authorization.input, provider.factory, {
						artifactAnchors: fixture.authorization.providerArtifactAnchors,
						onReady: () => Effect.sync(() => ready.signalStarted()),
					}),
				)
				.pipe(Effect.forkScoped);
			yield* Effect.promise(() => settleWithin(ready.started));
			yield* TestClock.adjust("60 seconds");
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit)).toBe(true);
			yield* TestClock.adjust("300 seconds");
			expect(provider.calls.google).toHaveLength(1);
			expect(provider.calls.discord).toHaveLength(0);
			expect(provider.calls.closed).toBe(3);
			expect(stateRow(fixture)).toMatchObject({ status: "blocked", attempts: 1, next_attempt_at: null });
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		}),
	);
	for (const runtimeMode of [undefined, "bounded", "long_running"] as const) {
		it(`exposes only verified ${runtimeMode ?? "default-bounded"} readiness metadata after startup preflight`, async () => {
			const fixture = await setup({ runtimeMode, reviewPort: runtimeMode === "long_running" ? 18_774 : 0 });
			const startup = makeGate();
			const ready = makeGate();
			const observed: Array<Parameters<MeetingPublicationFullReviewRuntimeHost["onReady"]>[0]> = [];
			const provider = providerFactory(fixture, { startupGate: startup });
			const fiber = Effect.runFork(
				fixture.authorization.withSystem(
					runAuthorizedMeetingPublicationFullReview(fixture.authorization.input, provider.factory, {
						artifactAnchors: fixture.authorization.providerArtifactAnchors,
						onReady: (metadata) =>
							Effect.sync(() => {
								observed.push(metadata);
								ready.signalStarted();
							}),
					}),
				),
			);
			activeFibers.push(fiber);
			await settleWithin(startup.started);
			expect(observed).toEqual([]);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
			startup.release();
			await settleWithin(
				Promise.race([
					ready.started,
					Effect.runPromise(Fiber.await(fiber)).then(() => {
						throw new Error("runtime exited before readiness");
					}),
				]),
			);
			expect(observed).toHaveLength(1);
			const metadata = observed[0];
			if (metadata === undefined) throw new Error("missing readiness metadata");
			expect(metadata).toEqual({
				host: "127.0.0.1",
				port: Number(new URL(metadata.origin).port),
				origin: `http://127.0.0.1:${metadata.port}`,
				authorizationId: fixture.authorization.payload.authorizationId,
				expiresAt: fixture.authorization.payload.expiresAt,
				runtimeMode: runtimeMode ?? "bounded",
			});
			expect(Object.keys(metadata).sort()).toEqual([
				"authorizationId",
				"expiresAt",
				"host",
				"origin",
				"port",
				"runtimeMode",
			]);
			const serialized = JSON.stringify(metadata);
			const token = readFileSync(
				join(fixture.config.statePath as string, "meeting-publication-v2-review.token"),
				"utf8",
			).trim();
			for (const privateValue of [
				fixture.authorization.payload.nonce,
				fixture.authorization.payload.keyId,
				fixture.authorization.input.trustedKeyring.path,
				fixture.authorization.payload.credentials.directory,
				fixture.note.markdown,
				token,
			])
				expect(serialized).not.toContain(privateValue);
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			await Effect.runPromise(Fiber.interrupt(fiber));
			expect(observed).toHaveLength(1);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		});
	}

	for (const cleanup of ["complete", "revoked", "expired"] as const) {
		it(`waits for provider-owner cleanup (${cleanup}) and never reports stale authority as drained`, async () => {
			const fixture = await setup({ approved: true });
			const stop = makeGate();
			const close = makeGate();
			const provider = providerFactory(fixture);
			const underlying = provider.factory.make;
			const factory: MeetingPublicationWorkerProviderFactory = {
				...provider.factory,
				make: (binding) =>
					Effect.gen(function* () {
						yield* Effect.acquireRelease(Effect.void, () =>
							Effect.promise(async () => {
								close.signalStarted();
								await close.released;
							}),
						);
						return yield* underlying(binding);
					}),
			};
			const running = await startFullReview(
				fixture,
				{ ...provider, factory },
				{
					requested: Effect.promise(() => stop.released),
					timeoutMs: 5_000,
				},
			);
			let finished = false;
			const completion = Effect.runPromise(Fiber.await(running.fiber)).then((exit) => {
				finished = true;
				return exit;
			});
			stop.release();
			await settleWithin(close.started);
			try {
				expect(finished).toBe(false);
				expect(provider.calls.closed).toBe(3);
				expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
				await expect(call(running.address.origin, "/")).rejects.toThrow();
				if (cleanup === "revoked") fixture.authorization.revoke();
				if (cleanup === "expired") fixture.authorization.advanceTimeBy(6 * 60_000);
			} finally {
				close.release();
			}
			const exit = await settleWithin(completion);
			expect(Exit.isSuccess(exit)).toBe(cleanup === "complete");
			if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "revoked" });
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		});
	}

	it.effect("drains an active scheduled worker without starting another tick", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(Date.now());
			const fixture = yield* Effect.promise(() =>
				setup({ approved: true, reviewPort: 18_773, runtimeMode: "long_running" }),
			);
			const gate = makeGate();
			const stop = makeGate();
			const ready = makeGate();
			const provider = providerFactory(fixture, { googleGate: gate });
			let origin = "";
			const fiber = yield* fixture.authorization
				.withSystem(
					runAuthorizedMeetingPublicationFullReview(fixture.authorization.input, provider.factory, {
						artifactAnchors: fixture.authorization.providerArtifactAnchors,
						onReady: (address) =>
							Effect.sync(() => {
								origin = address.origin;
								ready.signalStarted();
							}),
						drain: { requested: Effect.promise(() => stop.released), timeoutMs: 60_000 },
					}),
				)
				.pipe(Effect.forkScoped);
			yield* Effect.raceFirst(
				Effect.promise(() => ready.started),
				Fiber.join(fiber).pipe(Effect.andThen(Effect.die("not ready"))),
			);
			yield* TestClock.adjust("60 seconds");
			yield* Effect.promise(() => settleWithin(gate.started));
			// Advancing the scheduling clock does not finish cooperative artifact
			// validation. Observe the actual admitted provider before testing drain.
			expect(stateRow(fixture)?.status).toBe("publishing");
			stop.release();
			yield* Effect.promise(() => expect.poll(async () => (await call(origin, "/")).status).toBe(503));
			writeFileSync(
				join(fixture.config.sourcePath as string, "late.md"),
				markdown("Late unreviewed note").replace("full-review", "late-note"),
				{ mode: 0o600 },
			);
			// Reach the next tick boundary without reaching the independently bounded drain deadline.
			yield* TestClock.adjust("59 seconds");
			expect(provider.calls.google).toHaveLength(1);
			expect(provider.calls.closed).toBe(0);
			gate.release();
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(provider.calls.googleCompleted).toBe(1);
			expect(provider.calls.discord).toHaveLength(1);
			expect(provider.calls.closed).toBe(3);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			const database = new DatabaseSync(stateDatabasePath(fixture), { readOnly: true });
			try {
				expect(database.prepare("SELECT count(*) AS count FROM publication_items").get()?.count).toBe(1);
			} finally {
				database.close();
			}
		}),
	);

	for (const outcome of ["complete", "deadline", "revoked", "expired"] as const) {
		it(`drains an admitted dispatch (${outcome}), rejects new work, and waits for cleanup`, async () => {
			const fixture = await setup({ approved: true });
			const before = stateRow(fixture);
			const gate = makeGate();
			const stop = makeGate();
			const provider = providerFactory(fixture, { googleGate: gate });
			const running = await startFullReview(fixture, provider, {
				requested: Effect.promise(() => stop.released),
				timeoutMs: outcome === "deadline" ? 150 : 5_000,
			});
			const cookie = await authenticate(fixture, running.address.origin);
			const csrf = csrfFrom((await call(running.address.origin, "/", { cookie })).body);
			const dispatch = post(running.address.origin, cookie, "/dispatch", { csrf }).catch(() => null);
			await settleWithin(gate.started);
			stop.release();
			stop.release();
			await expect.poll(async () => (await call(running.address.origin, "/", { cookie })).status).toBe(503);
			expect((await post(running.address.origin, cookie, "/dispatch", { csrf })).status).toBe(503);
			expect((await post(running.address.origin, cookie, "/google-reconnect/start", { csrf })).status).toBe(503);
			expect(provider.calls.google).toHaveLength(1);
			expect(provider.calls.closed).toBe(0);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
			if (outcome === "complete") gate.release();
			if (outcome === "revoked") fixture.authorization.revoke();
			if (outcome === "expired") fixture.authorization.advanceTimeBy(6 * 60_000);
			const exit = await settleWithin(Effect.runPromise(Fiber.await(running.fiber)));
			expect(Exit.isSuccess(exit)).toBe(outcome === "complete");
			if (Exit.isFailure(exit)) {
				expect(Cause.squash(exit.cause)).toMatchObject({
					code: outcome === "deadline" ? "review_failed" : "revoked",
				});
			}
			await settleWithin(dispatch);
			expect(stateRow(fixture)).toMatchObject({
				status: outcome === "complete" ? "published" : "publishing",
				approved_hash: before?.approved_hash,
				approved_at: before?.approved_at,
				attempts: 1,
				google_doc_id: outcome === "complete" ? `doc-${fixture.note.itemId}` : null,
				discord_message_id: outcome === "complete" ? `message-${fixture.note.itemId}` : null,
			});
			expect(provider.calls.googleCompleted).toBe(outcome === "complete" ? 1 : 0);
			expect(provider.calls.discord).toHaveLength(outcome === "complete" ? 1 : 0);
			expect(provider.calls.closed).toBe(3);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			expect(
				existsSync(join(fixture.config.statePath as string, "meeting-publication-v2-review.rendezvous.json")),
			).toBe(false);
			await expect(call(running.address.origin, "/")).rejects.toThrow();
		});
	}

	for (const early of ["before-start", "during-startup"] as const) {
		it(`accepts ${early} drain without exposing readiness or a review rendezvous`, async () => {
			const fixture = await setup({ approved: true });
			const before = stateRow(fixture);
			const startup = makeGate();
			const stop = makeGate();
			const provider = providerFactory(fixture, { startupGate: startup });
			let ready = 0;
			if (early === "before-start") stop.release();
			const fiber = Effect.runFork(
				fixture.authorization.withSystem(
					runAuthorizedMeetingPublicationFullReview(fixture.authorization.input, provider.factory, {
						artifactAnchors: fixture.authorization.providerArtifactAnchors,
						onReady: () =>
							Effect.sync(() => {
								ready += 1;
							}),
						drain: { requested: Effect.promise(() => stop.released), timeoutMs: 5_000 },
					}),
				),
			);
			activeFibers.push(fiber);
			await settleWithin(startup.started);
			stop.release();
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			expect(ready).toBe(0);
			expect(provider.calls.closed).toBe(0);
			startup.release();
			const exit = await settleWithin(Effect.runPromise(Fiber.await(fiber)));
			expect(Exit.isSuccess(exit)).toBe(true);
			expect(ready).toBe(0);
			expect(stateRow(fixture)).toEqual(before);
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			expect(provider.calls.closed).toBe(3);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			expect(
				existsSync(join(fixture.config.statePath as string, "meeting-publication-v2-review.rendezvous.json")),
			).toBe(false);
		});
	}

	for (const timeoutMs of [0, -1, 60_001, Number.NaN, 0.5]) {
		it(`rejects invalid drain bound ${timeoutMs} before acquiring an owner`, async () => {
			const fixture = await setup();
			const provider = providerFactory(fixture);
			const result = await Effect.runPromise(
				fixture.authorization
					.withSystem(
						runAuthorizedMeetingPublicationFullReview(fixture.authorization.input, provider.factory, {
							artifactAnchors: fixture.authorization.providerArtifactAnchors,
							onReady: () => Effect.die("unexpected readiness"),
							drain: { requested: Effect.never, timeoutMs },
						}),
					)
					.pipe(Effect.result),
			);
			expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
			expect(provider.calls.make).toBe(0);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
		});
	}

	for (const outcome of ["verified", "revoked", "expired"] as const) {
		it(`uses fresh signed reconnect authority (${outcome}) without changing approved meetings or receipts`, async () => {
			const fixture = await setup({ approved: true });
			const before = stateRow(fixture);
			const provider = providerFactory(fixture, {
				reconnect: {
					beforeComplete: () => {
						if (outcome === "revoked") fixture.authorization.revoke();
						if (outcome === "expired") fixture.authorization.advanceTimeBy(6 * 60_000);
					},
				},
			});
			const running = await startFullReview(fixture, provider);
			const origin = running.address.origin;
			const cookie = await authenticate(fixture, origin);
			const inbox = await call(origin, "/", { cookie });
			const csrf = csrfFrom(inbox.body);
			expect(inbox.body).toContain("Credentials rejected");
			const started = await post(origin, cookie, "/google-reconnect/start", { csrf });
			expect(started.status).toBe(200);
			expect(provider.calls.reconnectStarted).toBe(1);
			const callback = await call(
				origin,
				"/google-reconnect/callback?state=signed_fixture_reconnect_state_1234&code=synthetic-consent-code",
			);
			expect(callback.status).toBe(200);
			expect(callback.body).not.toContain(csrf);
			expect(callback.body).not.toContain("synthetic-consent-code");
			expect(provider.calls.reconnectCompleted).toBe(0);
			// Revocation may close the owner before its HTTP error response is flushed.
			const finished = await post(origin, cookie, "/google-reconnect/complete", { csrf }).catch((error: unknown) => {
				if (outcome === "verified") throw error;
				expect(error).toMatchObject({ code: "ECONNRESET" });
				return null;
			});
			if (finished !== null) expect(finished.status).toBe(outcome === "verified" ? 200 : 500);
			if (outcome !== "verified") {
				const exit = await settleWithin(Effect.runPromise(Fiber.await(running.fiber)));
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ code: "revoked" });
			}
			expect(provider.calls.reconnectCompleted).toBe(outcome === "verified" ? 1 : 0);
			expect(stateRow(fixture)).toEqual(before);
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			if (outcome === "verified") {
				const refreshed = await call(origin, "/", { cookie });
				expect(refreshed.body).not.toContain("Credentials rejected");
				expect((await post(origin, cookie, "/google-reconnect/complete", { csrf })).status).toBe(409);
				expect(provider.calls.reconnectCompleted).toBe(1);
			}
			await Effect.runPromise(Fiber.interrupt(running.fiber));
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			for (const grant of provider.calls.reconnectGrants) {
				const result = await Effect.runPromise(
					validateMeetingPublicationWriteGrant(grant, "provider_google_reconnect").pipe(Effect.result),
				);
				expect(result).toMatchObject({ _tag: "Failure", failure: { code: "revoked" } });
			}
		});
	}

	it("resumes a signed auth-blocked approval without repeating Google or asking for approval again", async () => {
		const fixture = await setup({ authBlocked: true });
		const before = stateRow(fixture);
		expect(before).toMatchObject({ status: "blocked", attempts: 1, google_doc_id: "existing-doc" });
		const provider = providerFactory(fixture);
		const running = await startFullReview(fixture, provider);
		expect(stateRow(fixture)).toMatchObject({
			status: "approved",
			attempts: 1,
			approved_at: before?.approved_at,
			approved_hash: before?.approved_hash,
			discord_purpose_override: before?.discord_purpose_override,
			google_doc_id: before?.google_doc_id,
		});
		expect(provider.calls.google).toEqual([]);
		expect(provider.calls.discord).toEqual([]);
		const cookie = await authenticate(fixture, running.address.origin);
		const inbox = await call(running.address.origin, "/", { cookie });
		const csrf = csrfFrom(inbox.body);
		const dispatched = await post(running.address.origin, cookie, "/dispatch", { csrf });
		expect(dispatched.status).toBe(200);
		expect(dispatched.body).toMatch(/<span>Published<\/span><strong>1<\/strong>/u);
		expect(provider.calls.google).toEqual([]);
		expect(provider.calls.discord).toEqual([
			{ itemId: fixture.note.itemId, sourceHash: fixture.note.sourceHash, purpose: "Preserved reviewed summary." },
		]);
		expect(stateRow(fixture)).toMatchObject({
			status: "published",
			attempts: 2,
			approved_at: before?.approved_at,
			approved_hash: before?.approved_hash,
			source_hash: before?.source_hash,
			google_doc_id: before?.google_doc_id,
			google_doc_url: before?.google_doc_url,
			google_source_hash: before?.google_source_hash,
			discord_message_id: `message-${fixture.note.itemId}`,
		});
		const repeated = await post(running.address.origin, cookie, "/dispatch", { csrf });
		expect(repeated.status).toBe(200);
		expect(repeated.body).toMatch(/<span>Published<\/span><strong>0<\/strong>/u);
		expect(provider.calls.discord).toHaveLength(1);
		await Effect.runPromise(Fiber.interrupt(running.fiber));
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	for (const invalidation of ["revoked", "expired"] as const) {
		it(`does not resume an auth-blocked approval when signed authority becomes ${invalidation} during health verification`, async () => {
			const fixture = await setup({ authBlocked: true });
			const before = stateRow(fixture);
			let checked = 0;
			const provider = providerFactory(fixture, {
				beforeDiscordPreflight: () => {
					checked += 1;
					if (invalidation === "revoked") fixture.authorization.revoke();
					else fixture.authorization.advanceTimeBy(6 * 60_000);
				},
			});
			await expect(startFullReview(fixture, provider)).rejects.toThrow("full review exited before ready");
			expect(checked).toBe(1);
			expect(stateRow(fixture)).toEqual(before);
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			expect(provider.calls.closed).toBe(3);
		});
	}

	for (const approved of [false, true]) {
		it(`shows unavailable provider health at startup without claiming ${approved ? "approved" : "pending"} work`, async () => {
			const fixture = await setup({ approved });
			const before = stateRow(fixture);
			const provider = providerFactory(fixture, { discordUnavailable: true });
			const running = await startFullReview(fixture, provider);
			const row = stateRow(fixture);
			expect(row).toMatchObject({
				status: approved ? "approved" : "pending_review",
				attempts: 0,
				approved_hash: approved ? fixture.note.sourceHash : null,
				approved_at: approved ? before?.approved_at : null,
			});
			const database = new DatabaseSync(stateDatabasePath(fixture), { readOnly: true });
			try {
				expect(
					database.prepare("SELECT account,failure FROM provider_health WHERE provider='discord'").get(),
				).toMatchObject({
					account: fixture.config.discordChannelId,
					failure: "other",
				});
			} finally {
				database.close();
			}
			const cookie = await authenticate(fixture, running.address.origin);
			const inbox = await call(running.address.origin, "/", { cookie });
			expect(inbox.status).toBe(200);
			expect(inbox.body).toContain(fixture.config.discordChannelId);
			expect(inbox.body).toContain("<h3>Discord</h3><p><strong>Connection check failed</strong>");
			expect(provider.calls.notifications).toBeGreaterThan(0);
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			await Effect.runPromise(Fiber.interrupt(running.fiber));
		});
	}

	it.effect("closes the review owner when a recurring scan fails instead of silently losing dispatch", () =>
		Effect.gen(function* () {
			const fixture = yield* Effect.promise(() => setup({ reviewPort: 18_772, runtimeMode: "long_running" }));
			const provider = providerFactory(fixture);
			let publishAddress: (origin: string) => void = () => undefined;
			const address = new Promise<string>((resolve) => {
				publishAddress = resolve;
			});
			const fiber = yield* fixture.authorization
				.withSystem(
					runAuthorizedMeetingPublicationFullReview(fixture.authorization.input, provider.factory, {
						artifactAnchors: {
							host: fixture.authorization.providerArtifactAnchors.host,
							dependencies: fixture.authorization.providerArtifactAnchors.dependencies,
						},
						onReady: (ready) => Effect.sync(() => publishAddress(ready.origin)),
					}),
				)
				.pipe(Effect.forkScoped);
			const origin = yield* Effect.raceFirst(
				Effect.promise(() => address),
				Fiber.join(fiber).pipe(Effect.andThen(Effect.die("review exited before readiness"))),
			);
			yield* TestClock.adjust("60 seconds");
			expect(stateRow(fixture)?.status).toBe("pending_review");
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			const database = new DatabaseSync(stateDatabasePath(fixture), { allowExtension: false });
			try {
				// Keep the authorized file identity but make the next real Store scan fail.
				database.exec("DROP TABLE publication_items");
			} finally {
				database.close();
			}
			yield* TestClock.adjust("60 seconds");
			const result = yield* Fiber.await(fiber);
			expect(Exit.isFailure(result)).toBe(true);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			expect(provider.calls.closed).toBe(3);
			expect(provider.calls.google).toEqual([]);
			expect(provider.calls.discord).toEqual([]);
			expect(
				existsSync(join(fixture.config.statePath as string, "meeting-publication-v2-review.rendezvous.json")),
			).toBe(false);
			yield* Effect.promise(() => expect(call(origin, "/")).rejects.toThrow());
		}),
	);

	it("edits, purpose-approves, and dispatches one exact item in one signed session", async () => {
		const fixture = await setup();
		const provider = providerFactory(fixture);
		expect(fixture.authorization.payload.operations).toEqual([...MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS]);
		const running = await startFullReview(fixture, provider);
		const cookie = await authenticate(fixture, running.address.origin);
		const page = await call(running.address.origin, `/item/${fixture.note.itemId}`, { cookie });
		expect(page.status).toBe(200);
		const csrf = csrfFrom(page.body);
		const editedMarkdown = markdown("The reviewer corrected this summary before dispatch.");
		const updated = await post(running.address.origin, cookie, `/update-note/${fixture.note.itemId}`, {
			csrf,
			item_id: fixture.note.itemId,
			source_hash: fixture.note.sourceHash,
			meeting_markdown: editedMarkdown,
		});
		expect(updated.status).toBe(303);
		const editedHash = createHash("sha256").update(editedMarkdown).digest("hex");
		expect(readFileSync(fixture.notePath, "utf8")).toBe(editedMarkdown);
		expect(stateRow(fixture)).toMatchObject({ status: "pending_review", source_hash: editedHash });
		const approved = await post(running.address.origin, cookie, `/approve/${fixture.note.itemId}`, {
			csrf,
			item_id: fixture.note.itemId,
			source_hash: editedHash,
			purpose: "Reviewer-approved full-review dispatch purpose",
		});
		expect(approved.status).toBe(303);
		const dispatched = await post(running.address.origin, cookie, "/dispatch", { csrf });

		expect(dispatched.status).toBe(200);
		expect(dispatched.body).toMatch(/<span>Source notes scanned<\/span><strong>1<\/strong>/u);
		expect(dispatched.body).toMatch(/<span>Published<\/span><strong>1<\/strong>/u);
		expect(dispatched.body).toMatch(/<span>Failed<\/span><strong>0<\/strong>/u);
		expect(dispatched.body).toMatch(/<span>Waiting for review<\/span><strong>0<\/strong>/u);
		expect(provider.calls.google).toEqual([{ itemId: fixture.note.itemId, sourceHash: editedHash }]);
		expect(provider.calls.googleCompleted).toBe(1);
		expect(provider.calls.discord).toEqual([
			{
				itemId: fixture.note.itemId,
				sourceHash: editedHash,
				purpose: "Reviewer-approved full-review dispatch purpose.",
			},
		]);
		expect(provider.calls.notifications).toBe(1);
		expect(stateRow(fixture)).toMatchObject({
			status: "published",
			source_hash: editedHash,
			approved_hash: editedHash,
			discord_purpose_override: null,
			google_source_hash: editedHash,
			google_doc_id: `doc-${fixture.note.itemId}`,
			discord_message_id: `message-${fixture.note.itemId}`,
			attempts: 1,
		});
		await Effect.runPromise(Fiber.interrupt(running.fiber));
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		expect(provider.calls.closed).toBe(3);
	});

	it("rejects worker-domain input without acquiring providers or a full-review lease", async () => {
		const fixture = await setup();
		const workerInput = fixture.authorization.createCompetingWorkerInput();
		const provider = providerFactory(fixture);
		let ready = 0;
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(
					runAuthorizedMeetingPublicationFullReview(workerInput, provider.factory, {
						artifactAnchors: {
							host: fixture.authorization.providerArtifactAnchors.host,
							dependencies: fixture.authorization.providerArtifactAnchors.dependencies,
						},
						onReady: () =>
							Effect.sync(() => {
								ready += 1;
							}),
					}),
				)
				.pipe(Effect.result),
		);

		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
		expect(provider.calls.make).toBe(0);
		expect(ready).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	it("rejects an older signed full-review operation list rather than implicitly granting credential writes", async () => {
		const fixture = await setup();
		fixture.authorization.resign((payload) => {
			payload.operations = payload.operations.filter((operation) => operation !== "provider_google_reconnect");
		});
		const provider = providerFactory(fixture);
		await expect(startFullReview(fixture, provider)).rejects.toThrow("full review exited before ready");
		expect(provider.calls.make).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
	});

	it("denies a competing signed worker while full review owns the shared replay lease", async () => {
		const fixture = await setup();
		const fullProvider = providerFactory(fixture);
		const running = await startFullReview(fixture, fullProvider);
		const workerInput = fixture.authorization.createCompetingWorkerInput();
		const workerProvider = providerFactory(fixture);
		const result = await Effect.runPromise(
			fixture.authorization
				.withSystem(runAuthorizedMeetingPublicationWorker(workerInput, workerProvider.factory))
				.pipe(Effect.result),
		);

		expect(result).toMatchObject({ _tag: "Failure", failure: { code: "lease_unavailable" } });
		expect(workerProvider.calls.make).toBe(0);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 1 });
		const cookie = await authenticate(fixture, running.address.origin);
		expect((await call(running.address.origin, "/", { cookie })).status).toBe(200);
		await Effect.runPromise(Fiber.interrupt(running.fiber));
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it("starts explicit long-running review on a fixed port and revokes the owner", async () => {
		const fixture = await setup({ reviewPort: 18_771, runtimeMode: "long_running" });
		const provider = providerFactory(fixture);
		const running = await startFullReview(fixture, provider);
		expect(new URL(running.address.origin).port).toBe("18771");
		const rendezvous = join(fixture.config.statePath as string, "meeting-publication-v2-review.rendezvous.json");
		expect(existsSync(rendezvous)).toBe(true);
		fixture.authorization.revoke();
		const result = await settleWithin(Effect.runPromise(Fiber.await(running.fiber)));
		expect(Exit.isFailure(result)).toBe(true);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		expect(existsSync(rendezvous)).toBe(false);
	});

	for (const shutdown of ["interrupt", "revoke"] as const) {
		it(`${shutdown}s an in-flight dispatch before a second provider or checkpoint and closes the lease`, async () => {
			const fixture = await setup();
			const gate = makeGate();
			const provider = providerFactory(fixture, { googleGate: gate });
			const running = await startFullReview(fixture, provider);
			const session = await approveForDispatch(fixture, running.address.origin);
			expect(session.approved.status).toBe(303);
			const dispatch = post(running.address.origin, session.cookie, "/dispatch", { csrf: session.csrf }).then(
				(response) => response,
				() => null,
			);
			await settleWithin(gate.started);
			if (shutdown === "revoke") {
				fixture.authorization.revoke();
				const runtimeResult = await settleWithin(Effect.runPromise(Fiber.await(running.fiber)));
				expect(Exit.isFailure(runtimeResult)).toBe(true);
				if (Exit.isFailure(runtimeResult)) {
					expect(Cause.squash(runtimeResult.cause)).toMatchObject({ code: "revoked" });
				}
			} else {
				await Effect.runPromise(Fiber.interrupt(running.fiber));
			}
			await settleWithin(dispatch);
			expect(provider.calls.google).toHaveLength(1);
			expect(provider.calls.googleCompleted).toBe(0);
			expect(provider.calls.discord).toEqual([]);
			expect(stateRow(fixture)).toMatchObject({
				status: "publishing",
				attempts: 1,
				google_doc_id: null,
				discord_message_id: null,
			});
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			expect(provider.calls.closed).toBe(3);
			await expect(call(running.address.origin, "/")).rejects.toThrow();
		});
	}
});
