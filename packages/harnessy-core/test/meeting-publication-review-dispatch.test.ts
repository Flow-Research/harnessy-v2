import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	type MeetingPublicationReviewMode,
	MeetingPublicationReviewRandom,
	MeetingPublicationReviewServer,
} from "../src/jarvis/meeting-publication/review.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-dispatch-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	return root;
};

const makeConfig = (root: string) =>
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
		reviewPort: 0,
		reviewSessionSeconds: 60,
		reviewMaxSessions: 4,
		reviewMaxBodyBytes: 1_024,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

const markdown = (title: string, fingerprint: string) => `# ${title}

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: ${fingerprint}

## Executive Summary
We aligned on the release.

## Meeting Purpose
Ship the safe publication foundation.
`;

interface TestState {
	now: number;
	readonly calls: Array<"google" | "discord" | "notification">;
	readonly preflightCalls: Array<"google" | "discord">;
	googlePreflight: boolean;
	discordPreflight: boolean;
	readonly googleGate?: {
		readonly started: Promise<void>;
		readonly wait: Promise<void>;
		readonly signalStarted: () => void;
	};
	discordFailure: boolean;
}

const makeState = (): TestState => ({
	now: Date.parse("2026-09-04T12:00:00.000Z"),
	calls: [],
	preflightCalls: [],
	googlePreflight: true,
	discordPreflight: true,
	discordFailure: false,
});

const makeGate = () => {
	let signalStarted: () => void = () => undefined;
	let release: () => void = () => undefined;
	const started = new Promise<void>((resolveStarted) => {
		signalStarted = resolveStarted;
	});
	const wait = new Promise<void>((resolveWait) => {
		release = resolveWait;
	});
	return { started, wait, signalStarted, release };
};

const testRandomLayer = () => {
	let counter = 0;
	return Layer.succeed(
		MeetingPublicationReviewRandom,
		MeetingPublicationReviewRandom.of({
			bytes: (length) =>
				Effect.sync(() => createHash("sha256").update(`dispatch-random-${counter++}`).digest().subarray(0, length)),
		}),
	);
};

const makeServiceLayer = (config: JarvisMeetingPublicationConfig, state: TestState) => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, MeetingPublicationClock.of({ now: Effect.sync(() => state.now) })),
		Layer.succeed(
			MeetingPublicationGoogle,
			MeetingPublicationGoogle.of({
				preflight: Effect.sync(() => {
					state.preflightCalls.push("google");
					return state.googlePreflight;
				}),
				upsert: (input) =>
					Effect.gen(function* () {
						state.calls.push("google");
						state.googleGate?.signalStarted();
						if (state.googleGate !== undefined)
							yield* Effect.promise(() => state.googleGate?.wait ?? Promise.resolve());
						return new MeetingPublicationGoogleCheckpoint({
							docId: input.existingDocId ?? `doc-${input.itemId}`,
							docUrl: `https://docs.example.test/${input.itemId}`,
						});
					}),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationDiscord,
			MeetingPublicationDiscord.of({
				preflight: Effect.sync(() => {
					state.preflightCalls.push("discord");
					return state.discordPreflight;
				}),
				upsert: (input) => {
					state.calls.push("discord");
					return state.discordFailure
						? Effect.fail(
								new MeetingPublicationProviderError({
									stage: "discord",
									code: "dispatch_test_failure",
									retryable: false,
									retryAfterSeconds: null,
								}),
							)
						: Effect.succeed(
								new MeetingPublicationDiscordCheckpoint({
									channelId: input.existingChannelId ?? "channel-id",
									messageId: input.existingMessageId ?? `message-${input.itemId}`,
								}),
							);
				},
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationNotifier,
			MeetingPublicationNotifier.of({
				notify: () =>
					Effect.sync(() => {
						state.calls.push("notification");
						return true;
					}),
				close: Effect.void,
			}),
		),
	);
	return MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
};

const makeReviewLayer = (
	config: JarvisMeetingPublicationConfig,
	state: TestState,
	mode: MeetingPublicationReviewMode = "full",
	dispatch?: { readonly maxItems: number },
) =>
	MeetingPublicationReviewServer.layer(config, mode, dispatch).pipe(
		Layer.provideMerge(Layer.merge(makeServiceLayer(config, state), testRandomLayer())),
	);

interface HttpResult {
	readonly status: number;
	readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
	readonly body: string;
}

const call = (
	origin: string,
	path: string,
	options: {
		readonly method?: string;
		readonly cookie?: string;
		readonly body?: string;
		readonly host?: string;
		readonly origin?: string;
		readonly contentType?: string;
	} = {},
) =>
	new Promise<HttpResult>((resolveRequest, rejectRequest) => {
		const target = new URL(origin);
		const headers: Record<string, string> = { Host: options.host ?? target.host };
		if (options.cookie !== undefined) headers.Cookie = options.cookie;
		if (options.origin !== undefined) headers.Origin = options.origin;
		if (options.contentType !== undefined) headers["Content-Type"] = options.contentType;
		if (options.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(options.body));
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
		outgoing.setTimeout(3_000, () => outgoing.destroy(new Error("request timeout")));
		outgoing.on("error", rejectRequest);
		outgoing.end(options.body);
	});

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

const post = (origin: string, cookie: string, path: string, body: string, overrides: Parameters<typeof call>[2] = {}) =>
	call(origin, path, {
		method: "POST",
		cookie,
		origin,
		contentType: "application/x-www-form-urlencoded",
		body,
		...overrides,
	});

const csrfFrom = (body: string) => {
	const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(body)?.[1];
	if (csrf === undefined) throw new Error("missing csrf");
	return csrf;
};

const authenticate = async (origin: string, statePath: string) => {
	const token = readFileSync(join(statePath, "meeting-publication-v2-review.token"), "utf8").trim();
	const response = await call(origin, `/exchange?token=${encodeURIComponent(token)}`);
	const cookieHeader = response.headers["set-cookie"];
	const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(";", 1)[0];
	if (cookie === undefined) throw new Error("missing session cookie");
	return cookie;
};

const approve = (origin: string, cookie: string, csrf: string, itemId: string, sourceHash: string) =>
	post(
		origin,
		cookie,
		`/approve/${itemId}`,
		form({ csrf, item_id: itemId, source_hash: sourceHash, purpose: "Reviewer-approved dispatch purpose" }),
	);

describe("MeetingPublicationReviewServer manual dispatch", () => {
	it("runs authenticated full-review preflight without changing source or queue bytes", async () => {
		const root = makeRoot();
		const notePath = join(root, "notes", "one.md");
		writeFileSync(notePath, markdown("First sync", "first-sync"));
		const config = makeConfig(root);
		const state = makeState();
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					yield* service.scan();
					const cookie = yield* Effect.promise(() =>
						authenticate(review.address.origin, config.statePath as string),
					);
					const inbox = yield* Effect.promise(() => call(review.address.origin, "/", { cookie }));
					const body = form({ csrf: csrfFrom(inbox.body) });
					const before = {
						database: readFileSync(store.dbPath),
						note: readFileSync(notePath),
						entries: readdirSync(config.sourcePath as string),
					};
					const ready = yield* Effect.promise(() => post(review.address.origin, cookie, "/preflight", body));
					state.googlePreflight = false;
					const mismatch = yield* Effect.promise(() => post(review.address.origin, cookie, "/preflight", body));
					return {
						inbox,
						ready,
						mismatch,
						before,
						after: {
							database: readFileSync(store.dbPath),
							note: readFileSync(notePath),
							entries: readdirSync(config.sourcePath as string),
						},
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state, "full", { maxItems: 1 }))),
			),
		);

		expect(result.inbox.body).toContain('form method="post" action="/preflight"');
		expect(result.ready.status).toBe(200);
		expect(result.ready.body).toContain("Ready to publish");
		expect(result.ready.body).toMatch(/<span>Google<\/span><strong>Pass<\/strong><code>ok<\/code>/u);
		expect(result.ready.body).toMatch(/<span>Discord<\/span><strong>Pass<\/strong><code>ok<\/code>/u);
		expect(result.mismatch.status).toBe(200);
		expect(result.mismatch.body).toContain("Publication is not ready");
		expect(result.mismatch.body).toMatch(/<span>Google<\/span><strong>Fail<\/strong><code>unavailable<\/code>/u);
		for (const response of [result.ready, result.mismatch]) {
			expect(response.body).toContain("No meeting was approved or published.");
			expect(response.body).not.toContain(root);
			expect(response.body).not.toContain("owner@example.test");
			expect(response.body).not.toContain("channel-id");
		}
		expect(result.after.database.equals(result.before.database)).toBe(true);
		expect(result.after.note.equals(result.before.note)).toBe(true);
		expect(result.after.entries).toEqual(result.before.entries);
		expect(state.preflightCalls).toEqual(["google", "discord", "google", "discord"]);
		expect(state.calls).toEqual([]);
	});

	it("rejects unauthenticated, cross-origin, invalid-CSRF, and decision-only preflight", async () => {
		const root = makeRoot();
		const notePath = join(root, "notes", "one.md");
		writeFileSync(notePath, markdown("First sync", "first-sync"));
		const config = makeConfig(root);
		const state = makeState();
		const controls = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					yield* service.scan();
					const cookie = yield* Effect.promise(() =>
						authenticate(review.address.origin, config.statePath as string),
					);
					const inbox = yield* Effect.promise(() => call(review.address.origin, "/", { cookie }));
					const body = form({ csrf: csrfFrom(inbox.body) });
					const before = { database: readFileSync(store.dbPath), note: readFileSync(notePath) };
					return {
						responses: yield* Effect.all(
							[
								Effect.promise(() =>
									call(review.address.origin, "/preflight", {
										method: "POST",
										origin: review.address.origin,
										contentType: "application/x-www-form-urlencoded",
										body,
									}),
								),
								Effect.promise(() =>
									post(review.address.origin, cookie, "/preflight", body, {
										origin: "http://127.0.0.1:9",
									}),
								),
								Effect.promise(() => post(review.address.origin, cookie, "/preflight", form({ csrf: "x" }))),
							],
							{ concurrency: 1 },
						),
						before,
						after: { database: readFileSync(store.dbPath), note: readFileSync(notePath) },
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state, "full", { maxItems: 1 }))),
			),
		);
		expect(controls.responses.map((response) => response.status)).toEqual([401, 403, 403]);
		expect(controls.after.database.equals(controls.before.database)).toBe(true);
		expect(controls.after.note.equals(controls.before.note)).toBe(true);
		expect(state.preflightCalls).toEqual([]);
		expect(state.calls).toEqual([]);

		const decisionRoot = makeRoot();
		const decisionNotePath = join(decisionRoot, "notes", "one.md");
		writeFileSync(decisionNotePath, markdown("Decision sync", "decision-sync"));
		const decisionConfig = makeConfig(decisionRoot);
		const decisionState = makeState();
		const decision = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					yield* service.scan();
					const cookie = yield* Effect.promise(() =>
						authenticate(review.address.origin, decisionConfig.statePath as string),
					);
					const inbox = yield* Effect.promise(() => call(review.address.origin, "/", { cookie }));
					const before = { database: readFileSync(store.dbPath), note: readFileSync(decisionNotePath) };
					const response = yield* Effect.promise(() =>
						post(review.address.origin, cookie, "/preflight", form({ csrf: csrfFrom(inbox.body) })),
					);
					return {
						inbox,
						response,
						before,
						after: { database: readFileSync(store.dbPath), note: readFileSync(decisionNotePath) },
					};
				}).pipe(Effect.provide(makeReviewLayer(decisionConfig, decisionState, "decision_only"))),
			),
		);
		expect(decision.inbox.body).not.toContain('action="/preflight"');
		expect(decision.response.status).toBe(404);
		expect(decision.after.database.equals(decision.before.database)).toBe(true);
		expect(decision.after.note.equals(decision.before.note)).toBe(true);
		expect(decisionState.preflightCalls).toEqual([]);
		expect(decisionState.calls).toEqual([]);
	});

	it("authenticates one bounded dispatch and reports exact remaining work", async () => {
		const root = makeRoot();
		writeFileSync(join(root, "notes", "one.md"), markdown("First sync", "first-sync"));
		writeFileSync(join(root, "notes", "two.md"), markdown("Second sync", "second-sync"));
		const config = makeConfig(root);
		const state = makeState();
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					yield* service.scan();
					const before = yield* store.list();
					const cookie = yield* Effect.promise(() =>
						authenticate(review.address.origin, config.statePath as string),
					);
					const itemPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${before[0]?.itemId ?? "missing"}`, { cookie }),
					);
					const csrf = csrfFrom(itemPage.body);
					const first = before[0];
					const second = before[1];
					if (first === undefined || second === undefined) return yield* Effect.die("missing review items");
					const firstApproval = yield* Effect.promise(() =>
						approve(review.address.origin, cookie, csrf, first.itemId, first.sourceHash),
					);
					const secondApproval = yield* Effect.promise(() =>
						approve(review.address.origin, cookie, csrf, second.itemId, second.sourceHash),
					);
					const inbox = yield* Effect.promise(() => call(review.address.origin, "/", { cookie }));
					const dispatchBody = form({ csrf: csrfFrom(inbox.body) });
					const controls = yield* Effect.all(
						[
							Effect.promise(() =>
								call(review.address.origin, "/dispatch", {
									method: "POST",
									origin: review.address.origin,
									contentType: "application/x-www-form-urlencoded",
									body: dispatchBody,
								}),
							),
							Effect.promise(() =>
								post(review.address.origin, cookie, "/dispatch", dispatchBody, {
									origin: "http://127.0.0.1:9",
								}),
							),
							Effect.promise(() =>
								post(review.address.origin, cookie, "/dispatch", dispatchBody, { host: "127.0.0.1:9" }),
							),
							Effect.promise(() => post(review.address.origin, cookie, "/dispatch", form({ csrf: "x" }))),
							Effect.promise(() =>
								post(review.address.origin, cookie, "/dispatch", `${dispatchBody}&max_items=100`),
							),
						],
						{ concurrency: 1 },
					);
					const callsBeforeDispatch = [...state.calls];
					const dispatched = yield* Effect.promise(() =>
						post(review.address.origin, cookie, "/dispatch", dispatchBody),
					);
					return {
						firstApproval,
						secondApproval,
						inbox,
						controls,
						callsBeforeDispatch,
						dispatched,
						after: yield* store.list(),
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state, "full", { maxItems: 1 }))),
			),
		);

		expect(result.firstApproval.status).toBe(303);
		expect(result.secondApproval.status).toBe(303);
		expect(result.inbox.status).toBe(200);
		expect(result.inbox.body).toContain('form method="post" action="/dispatch"');
		expect(result.inbox.body).toContain("up to 1 approved meeting");
		expect(result.inbox.body).not.toContain('name="max_items"');
		expect(result.controls.map((control) => control.status)).toEqual([401, 403, 400, 403, 400]);
		expect(result.callsBeforeDispatch).toEqual([]);
		expect(result.dispatched.status).toBe(200);
		expect(result.dispatched.body).toContain("Dispatch run finished");
		expect(result.dispatched.body).toContain("Queued work may remain.");
		expect(result.dispatched.body).toMatch(/<span>Source notes scanned<\/span><strong>2<\/strong>/u);
		expect(result.dispatched.body).toMatch(/<span>Published<\/span><strong>1<\/strong>/u);
		expect(result.dispatched.body).toMatch(/<span>Failed<\/span><strong>0<\/strong>/u);
		expect(result.dispatched.body).toMatch(/<span>Waiting for review<\/span><strong>0<\/strong>/u);
		expect(result.after.filter((item) => item.status === "published")).toHaveLength(1);
		expect(result.after.filter((item) => item.status === "approved")).toHaveLength(1);
		expect(state.calls).toEqual(["google", "discord"]);
	});

	it("rejects overlapping dispatch and review mutations, then releases the gate after failure", async () => {
		const root = makeRoot();
		writeFileSync(join(root, "notes", "one.md"), markdown("First sync", "first-sync"));
		writeFileSync(join(root, "notes", "two.md"), markdown("Second sync", "second-sync"));
		const config = makeConfig(root);
		const gate = makeGate();
		const state: TestState = { ...makeState(), googleGate: gate, discordFailure: true };
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					yield* service.scan();
					const items = yield* store.list();
					const approved = items[0];
					const pending = items[1];
					if (approved === undefined || pending === undefined) return yield* Effect.die("missing review items");
					const cookie = yield* Effect.promise(() =>
						authenticate(review.address.origin, config.statePath as string),
					);
					const approvedPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${approved.itemId}`, { cookie }),
					);
					const csrf = csrfFrom(approvedPage.body);
					yield* Effect.promise(() =>
						approve(review.address.origin, cookie, csrf, approved.itemId, approved.sourceHash),
					);
					const dispatchRequest = post(review.address.origin, cookie, "/dispatch", form({ csrf }));
					yield* Effect.promise(() => gate.started);
					const overlappingDispatch = yield* Effect.promise(() =>
						post(review.address.origin, cookie, "/dispatch", form({ csrf })),
					);
					const overlappingReject = yield* Effect.promise(() =>
						post(
							review.address.origin,
							cookie,
							`/reject/${pending.itemId}`,
							form({ csrf, item_id: pending.itemId, source_hash: pending.sourceHash }),
						),
					);
					gate.release();
					const dispatched = yield* Effect.promise(() => dispatchRequest);
					const releasedReject = yield* Effect.promise(() =>
						post(
							review.address.origin,
							cookie,
							`/reject/${pending.itemId}`,
							form({ csrf, item_id: pending.itemId, source_hash: pending.sourceHash }),
						),
					);
					return {
						approvedItemId: approved.itemId,
						pendingItemId: pending.itemId,
						overlappingDispatch,
						overlappingReject,
						dispatched,
						releasedReject,
						after: yield* store.list(),
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state, "full", { maxItems: 1 }))),
			),
		);

		expect(result.overlappingDispatch.status).toBe(409);
		expect(result.overlappingReject.status).toBe(409);
		expect(result.dispatched.status).toBe(200);
		expect(result.dispatched.body).toMatch(/<span>Published<\/span><strong>0<\/strong>/u);
		expect(result.dispatched.body).toMatch(/<span>Failed<\/span><strong>1<\/strong>/u);
		expect(result.releasedReject.status).toBe(303);
		expect(result.after.find((item) => item.itemId === result.approvedItemId)?.status).toBe("blocked");
		expect(result.after.find((item) => item.itemId === result.pendingItemId)?.status).toBe("rejected");
		expect(state.calls).toEqual(["notification", "google", "discord", "notification"]);
	});

	it("interrupts and drains a stalled dispatch before server teardown completes", async () => {
		const root = makeRoot();
		writeFileSync(join(root, "notes", "one.md"), markdown("First sync", "first-sync"));
		const config = makeConfig(root);
		const gate = makeGate();
		const state: TestState = { ...makeState(), googleGate: gate };
		const running = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing review item");
					const cookie = yield* Effect.promise(() =>
						authenticate(review.address.origin, config.statePath as string),
					);
					const itemPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie }),
					);
					const csrf = csrfFrom(itemPage.body);
					yield* Effect.promise(() => approve(review.address.origin, cookie, csrf, item.itemId, item.sourceHash));
					const requestResult = post(review.address.origin, cookie, "/dispatch", form({ csrf })).then(
						(response) => ({ response, rejected: false as const }),
						() => ({ response: null, rejected: true as const }),
					);
					yield* Effect.promise(() => gate.started);
					return { dbPath: store.dbPath, itemId: item.itemId, requestResult };
				}).pipe(Effect.provide(makeReviewLayer(config, state, "full", { maxItems: 1 }))),
			),
		);

		const requestResult = await running.requestResult;
		expect(requestResult.rejected || requestResult.response?.status === 500).toBe(true);
		expect(state.calls).toEqual(["google"]);
		gate.release();
		await new Promise<void>((resolveTick) => setImmediate(resolveTick));
		expect(state.calls).toEqual(["google"]);
		const database = new DatabaseSync(running.dbPath, { readOnly: true });
		const stored = database
			.prepare(
				"SELECT status, google_doc_id, google_doc_url, discord_channel_id, discord_message_id FROM publication_items WHERE item_id = ?",
			)
			.get(running.itemId) as
			| {
					status: string;
					google_doc_id: string | null;
					google_doc_url: string | null;
					discord_channel_id: string | null;
					discord_message_id: string | null;
			  }
			| undefined;
		database.close();
		expect(stored).toEqual({
			status: "publishing",
			google_doc_id: null,
			google_doc_url: null,
			discord_channel_id: null,
			discord_message_id: null,
		});
	});

	it("keeps dispatch absent by default and rejects invalid or decision-only dispatch configuration", async () => {
		const root = makeRoot();
		writeFileSync(join(root, "notes", "one.md"), markdown("First sync", "first-sync"));
		const config = makeConfig(root);
		const state = makeState();
		const absent = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const review = yield* MeetingPublicationReviewServer;
					yield* service.scan();
					const cookie = yield* Effect.promise(() =>
						authenticate(review.address.origin, config.statePath as string),
					);
					const inbox = yield* Effect.promise(() => call(review.address.origin, "/", { cookie }));
					const rejected = yield* Effect.promise(() =>
						post(review.address.origin, cookie, "/dispatch", form({ csrf: csrfFrom(inbox.body) })),
					);
					return { inbox, rejected };
				}).pipe(Effect.provide(makeReviewLayer(config, state))),
			),
		);
		expect(absent.inbox.body).not.toContain('action="/dispatch"');
		expect(absent.rejected.status).toBe(404);
		expect(state.calls).toEqual([]);

		for (const [mode, maxItems] of [
			["decision_only", 1],
			["full", 0],
			["full", 101],
			["full", 1.5],
		] as const) {
			const invalidRoot = makeRoot();
			const invalidConfig = makeConfig(invalidRoot);
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Effect.gen(function* () {
						yield* MeetingPublicationReviewServer;
					}).pipe(Effect.provide(makeReviewLayer(invalidConfig, makeState(), mode, { maxItems }))),
				),
			);
			expect(exit._tag, `${mode}:${maxItems}`).toBe("Failure");
		}
	});
});
