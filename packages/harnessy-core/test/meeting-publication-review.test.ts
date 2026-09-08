import { createHash } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import type { MeetingPublicationWriteOperation } from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
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
const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (root: string, overrides: Partial<JarvisMeetingPublicationConfig> = {}) =>
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
		reviewMaxBodyBytes: 256,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
		...overrides,
	});

const markdown = (
	options: { title?: string; fingerprint?: string; summary?: string; purpose?: string } = {},
) => `# ${options.title ?? "Weekly Sync"}

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: ${options.fingerprint ?? "weekly-sync"}

## Executive Summary
${options.summary ?? "We aligned on the release."}

## Meeting Purpose
${options.purpose ?? "Ship the safe publication foundation."}
`;

interface ReviewState {
	now: number;
	closed: { google: number; discord: number; notifier: number };
	calls: { google: number; discord: number; notifier: number };
}

const makeState = (): ReviewState => ({
	now: Date.parse("2026-09-04T12:00:00.000Z"),
	closed: { google: 0, discord: 0, notifier: 0 },
	calls: { google: 0, discord: 0, notifier: 0 },
});

const testRandomLayer = () => {
	let counter = 0;
	return Layer.succeed(
		MeetingPublicationReviewRandom,
		MeetingPublicationReviewRandom.of({
			bytes: (length) =>
				Effect.sync(() => createHash("sha256").update(`review-random-${counter++}`).digest().subarray(0, length)),
		}),
	);
};

const repeatedRandomLayer = Layer.succeed(
	MeetingPublicationReviewRandom,
	MeetingPublicationReviewRandom.of({ bytes: (length) => Effect.succeed(Buffer.alloc(length, 7)) }),
);

const makeServiceLayer = (
	config: JarvisMeetingPublicationConfig,
	state: ReviewState,
	authority = meetingPublicationTestWriteAuthorityLayer(config),
) => {
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, MeetingPublicationClock.of({ now: Effect.sync(() => state.now) })),
		Layer.succeed(
			MeetingPublicationGoogle,
			MeetingPublicationGoogle.of({
				preflight: Effect.succeed(true),
				upsert: (input) =>
					Effect.sync(() => {
						state.calls.google += 1;
						return new MeetingPublicationGoogleCheckpoint({
							docId: input.existingDocId ?? `doc-${input.itemId}`,
							docUrl: `https://docs.example.test/${input.itemId}`,
						});
					}),
				close: Effect.sync(() => {
					state.closed.google += 1;
				}),
			}),
		),
		Layer.succeed(
			MeetingPublicationDiscord,
			MeetingPublicationDiscord.of({
				preflight: Effect.succeed(true),
				upsert: (input) =>
					Effect.sync(() => {
						state.calls.discord += 1;
						return new MeetingPublicationDiscordCheckpoint({
							channelId: input.existingChannelId ?? "channel-id",
							messageId: input.existingMessageId ?? `message-${input.itemId}`,
						});
					}),
				close: Effect.sync(() => {
					state.closed.discord += 1;
				}),
			}),
		),
		Layer.succeed(
			MeetingPublicationNotifier,
			MeetingPublicationNotifier.of({
				notify: () =>
					Effect.sync(() => {
						state.calls.notifier += 1;
						return true;
					}),
				close: Effect.sync(() => {
					state.closed.notifier += 1;
				}),
			}),
		),
	);
	return MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
};

const makeReviewLayer = (config: JarvisMeetingPublicationConfig, state: ReviewState) =>
	MeetingPublicationReviewServer.layer(config).pipe(
		Layer.provideMerge(Layer.merge(makeServiceLayer(config, state), testRandomLayer())),
	);

const makeReviewLayerWithRandom = (
	config: JarvisMeetingPublicationConfig,
	state: ReviewState,
	randomLayer: Layer.Layer<MeetingPublicationReviewRandom>,
) =>
	MeetingPublicationReviewServer.layer(config).pipe(
		Layer.provideMerge(Layer.merge(makeServiceLayer(config, state), randomLayer)),
	);

const makeDecisionOnlyReviewLayer = (
	config: JarvisMeetingPublicationConfig,
	state: ReviewState,
	authority = meetingPublicationTestWriteAuthorityLayer(config),
) =>
	MeetingPublicationReviewServer.layer(config, "decision_only").pipe(
		Layer.provideMerge(Layer.merge(makeServiceLayer(config, state, authority), testRandomLayer())),
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
		readonly contentLength?: string;
	} = {},
) =>
	new Promise<HttpResult>((resolveRequest, rejectRequest) => {
		const target = new URL(origin);
		const headers: Record<string, string> = { Host: options.host ?? target.host };
		if (options.cookie !== undefined) headers.Cookie = options.cookie;
		if (options.origin !== undefined) headers.Origin = options.origin;
		if (options.contentType !== undefined) headers["Content-Type"] = options.contentType;
		if (options.body !== undefined) {
			headers["Content-Length"] = options.contentLength ?? String(Buffer.byteLength(options.body));
		} else if (options.contentLength !== undefined) headers["Content-Length"] = options.contentLength;
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
		if (options.body !== undefined) outgoing.end(options.body);
		else outgoing.end();
	});

const cookieFrom = (response: HttpResult) => {
	const header = response.headers["set-cookie"];
	const first = Array.isArray(header) ? header[0] : header;
	if (first === undefined) throw new Error("missing cookie");
	return { cookie: first.split(";", 1)[0] as string, attributes: first };
};

const csrfFrom = (body: string) => {
	const value = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(body)?.[1];
	if (value === undefined) throw new Error("missing csrf");
	return value;
};

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

const provePortReleased = (host: string, port: number) =>
	new Promise<void>((resolveProbe, rejectProbe) => {
		const probe = createServer();
		probe.once("error", rejectProbe);
		probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolveProbe()));
	});

describe("MeetingPublicationReviewServer", () => {
	it("limits decision-only review to exact state decisions and keeps source and providers idle", async () => {
		const root = makeRoot();
		const notePath = join(root, "notes", "meeting.md");
		const original = markdown({ summary: "Decision-only source." });
		writeFileSync(notePath, original);
		const config = makeConfig(root);
		const state = makeState();
		const operations: Array<MeetingPublicationWriteOperation> = [];
		const authority = meetingPublicationTestWriteAuthorityLayer(config, {
			onAuthorize: (operation) => operations.push(operation),
		});
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing item");
					const token = readFileSync(
						join(config.statePath as string, "meeting-publication-v2-review.token"),
						"utf8",
					).trim();
					const exchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchange).cookie;
					const itemPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					const csrf = csrfFrom(itemPage.body);
					const sourceBefore = readFileSync(notePath);
					const update = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/update-note/${item.itemId}`,
							form({
								csrf,
								item_id: item.itemId,
								source_hash: item.sourceHash,
								meeting_markdown: markdown({ summary: "MUST_NOT_WRITE" }),
							}),
						),
					);
					const restore = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/restore/${item.itemId}`,
							form({ csrf, item_id: item.itemId, source_hash: item.sourceHash }),
						),
					);
					const staleDecision = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/approve/${item.itemId}`,
							form({
								csrf,
								item_id: item.itemId,
								source_hash: "0".repeat(64),
								purpose: "Stale decision",
							}),
						),
					);
					const approval = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/approve/${item.itemId}`,
							form({
								csrf,
								item_id: item.itemId,
								source_hash: item.sourceHash,
								purpose: "Decision-only approval",
							}),
						),
					);
					return {
						itemPage,
						update,
						restore,
						staleDecision,
						approval,
						approved: yield* store.get(item.itemId),
						sourceUnchanged: sourceBefore.equals(readFileSync(notePath)),
					};
				}).pipe(Effect.provide(makeDecisionOnlyReviewLayer(config, state, authority))),
			),
		);

		expect(result.itemPage.status).toBe(200);
		expect(result.itemPage.body).toContain('<div class="review-grid">');
		expect(result.itemPage.body).toContain('<main class="card note-card">');
		expect(result.itemPage.body).toContain('<aside class="review-sidebar">');
		expect(result.itemPage.body).toContain('<span class="status-pill status-pending_review">Pending Review</span>');
		expect(result.itemPage.body).toContain("Decision-only source.");
		expect(result.itemPage.body).toContain("@media (max-width: 880px)");
		expect(result.itemPage.body).not.toContain("Flow Research");
		expect(result.itemPage.body).not.toContain("/update-note/");
		expect(result.itemPage.body).not.toContain('name="meeting_markdown"');
		expect(result.itemPage.body.match(/action="\/reject\//gu)).toHaveLength(1);
		expect(result.update.status).toBe(404);
		expect(result.restore.status).toBe(404);
		expect(result.staleDecision.status).toBe(409);
		expect(result.approval).toMatchObject({ status: 303, body: "" });
		expect(result.approved).toMatchObject({ status: "approved" });
		expect(result.sourceUnchanged).toBe(true);
		expect(state.calls).toEqual({ google: 0, discord: 0, notifier: 0 });
		expect(operations.filter((operation) => operation === "review_serve")).toHaveLength(7);
	});

	it("revalidates decision-only authority per request and clears sessions after revocation", async () => {
		const root = makeRoot();
		writeFileSync(join(root, "notes", "meeting.md"), markdown());
		const config = makeConfig(root);
		const state = makeState();
		let active = true;
		const operations: Array<MeetingPublicationWriteOperation> = [];
		const authority = meetingPublicationTestWriteAuthorityLayer(config, {
			isActive: () => active,
			onAuthorize: (operation) => operations.push(operation),
		});
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing item");
					const token = readFileSync(
						join(config.statePath as string, "meeting-publication-v2-review.token"),
						"utf8",
					).trim();
					const exchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchange).cookie;
					const itemPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					const csrf = csrfFrom(itemPage.body);
					active = false;
					const deniedGet = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					const deniedExchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const deniedDecision = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/reject/${item.itemId}`,
							form({ csrf, item_id: item.itemId, source_hash: item.sourceHash }),
						),
					);
					active = true;
					const cleared = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					return {
						deniedGet,
						deniedExchange,
						deniedDecision,
						cleared,
						current: yield* store.get(item.itemId),
					};
				}).pipe(Effect.provide(makeDecisionOnlyReviewLayer(config, state, authority))),
			),
		);

		for (const denied of [result.deniedGet, result.deniedExchange, result.deniedDecision]) {
			expect(denied.status).toBe(503);
			expect(denied.body).not.toContain("revoked");
		}
		expect(result.cleared.status).toBe(401);
		expect(result.current).toMatchObject({ status: "pending_review", approvedHash: null });
		expect(state.calls).toEqual({ google: 0, discord: 0, notifier: 0 });
		expect(operations.filter((operation) => operation === "review_serve")).toHaveLength(7);
	});

	it("shows only a current next-meeting title and keeps queue state unchanged on inbox reads", async () => {
		const root = makeRoot();
		const notePath = join(root, "notes", "meeting.md");
		writeFileSync(notePath, markdown({ title: "Current next meeting" }));
		const config = makeConfig(root);
		const state = makeState();
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing item");
					const token = readFileSync(
						join(config.statePath as string, "meeting-publication-v2-review.token"),
						"utf8",
					).trim();
					const exchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchange).cookie;
					const storedBefore = yield* store.get(item.itemId);
					const databaseBefore = readFileSync(store.dbPath);
					const current = yield* Effect.promise(() => call(review.address.origin, "/", { cookie: session }));
					const databaseAfterCurrent = readFileSync(store.dbPath);
					writeFileSync(notePath, markdown({ title: "Changed after collection" }));
					const stale = yield* Effect.promise(() => call(review.address.origin, "/", { cookie: session }));
					const databaseAfterStale = readFileSync(store.dbPath);
					unlinkSync(notePath);
					const missing = yield* Effect.promise(() => call(review.address.origin, "/", { cookie: session }));
					return {
						current,
						stale,
						missing,
						storedBefore,
						storedAfter: yield* store.get(item.itemId),
						databaseBefore,
						databaseAfterCurrent,
						databaseAfterStale,
						databaseAfterMissing: readFileSync(store.dbPath),
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state))),
			),
		);

		expect(result.current).toMatchObject({ status: 200 });
		expect(result.current.body).toContain("<h2>Current next meeting</h2>");
		expect(result.current.body).not.toContain("Meeting title unavailable");
		for (const unavailable of [result.stale, result.missing]) {
			expect(unavailable).toMatchObject({ status: 200 });
			expect(unavailable.body).toContain("<h2>Meeting title unavailable</h2>");
			expect(unavailable.body).not.toContain("Changed after collection");
		}
		expect(result.storedAfter).toEqual(result.storedBefore);
		for (const after of [result.databaseAfterCurrent, result.databaseAfterStale, result.databaseAfterMissing]) {
			expect(after.equals(result.databaseBefore)).toBe(true);
		}
		expect(state.calls).toEqual({ google: 0, discord: 0, notifier: 0 });
	});

	it("creates a protected bootstrap token and bounds session, logout, restart, and socket lifecycle", async () => {
		const root = makeRoot();
		writeFileSync(join(root, "notes", "meeting.md"), markdown());
		const config = makeConfig(root);
		const state = makeState();
		const first = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const tokenPath = join(config.statePath as string, "meeting-publication-v2-review.token");
					const token = readFileSync(tokenPath, "utf8").trim();
					const missing = yield* Effect.promise(() => call(review.address.origin, "/"));
					const wrongShort = yield* Effect.promise(() => call(review.address.origin, "/exchange?token=x"));
					const wrongEqual = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${"a".repeat(43)}`),
					);
					const exchanged = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchanged);
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing item");
					const itemPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session.cookie }),
					);
					state.now += 61_000;
					const expired = yield* Effect.promise(() =>
						call(review.address.origin, "/", { cookie: session.cookie }),
					);
					const secondExchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const secondSession = cookieFrom(secondExchange);
					const refreshedPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: secondSession.cookie }),
					);
					const logout = yield* Effect.promise(() =>
						post(
							review.address.origin,
							secondSession.cookie,
							"/logout",
							form({ csrf: csrfFrom(refreshedPage.body) }),
						),
					);
					const loggedOut = yield* Effect.promise(() =>
						call(review.address.origin, "/", { cookie: secondSession.cookie }),
					);
					const boundedSessions: Array<string> = [];
					for (let index = 0; index < 5; index += 1) {
						const next = yield* Effect.promise(() =>
							call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
						);
						boundedSessions.push(cookieFrom(next).cookie);
					}
					const evicted = yield* Effect.promise(() =>
						call(review.address.origin, "/", { cookie: boundedSessions[0] }),
					);
					const newest = yield* Effect.promise(() =>
						call(review.address.origin, "/", { cookie: boundedSessions[4] }),
					);
					return {
						address: review.address,
						token,
						tokenPath,
						missing,
						wrongShort,
						wrongEqual,
						exchanged,
						session,
						itemPage,
						expired,
						logout,
						loggedOut,
						evicted,
						newest,
						activeAtClose: boundedSessions[4] as string,
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state))),
			),
		);

		expect(first.address.host).toBe("127.0.0.1");
		expect(first.address.port).toBeGreaterThan(0);
		expect(first.missing.status).toBe(401);
		expect(first.wrongShort).toMatchObject({ status: 401, body: first.wrongEqual.body });
		expect(first.wrongEqual.status).toBe(401);
		expect(first.exchanged).toMatchObject({ status: 303, body: "" });
		expect(first.exchanged.headers.location).toBe("/");
		expect(first.exchanged.headers["referrer-policy"]).toBe("no-referrer");
		expect(first.exchanged.body).not.toContain(first.token);
		expect(first.session.cookie).not.toContain(first.token);
		expect(csrfFrom(first.itemPage.body)).not.toBe(first.token);
		expect(csrfFrom(first.itemPage.body)).not.toBe(first.session.cookie.split("=", 2)[1]);
		expect(first.itemPage.body).not.toContain(first.token);
		expect(first.session.attributes).toContain("HttpOnly");
		expect(first.session.attributes).toContain("SameSite=Strict");
		expect(first.session.attributes).toContain("Path=/");
		expect(first.session.attributes).toContain("Max-Age=60");
		expect(first.itemPage.status).toBe(200);
		expect(first.itemPage.headers["referrer-policy"]).toBe("same-origin");
		expect(first.newest.body).toContain('<header class="page-intro">');
		expect(first.newest.body).toContain('<section class="card queue-card">');
		expect(first.newest.body).toContain('<span class="count-badge">1 in queue</span>');
		expect(first.newest.body).toContain('<span class="status-pill status-pending_review">Pending Review</span>');
		expect(first.expired.status).toBe(401);
		expect(first.logout.status).toBe(303);
		expect(cookieFrom(first.logout).attributes).toContain("Max-Age=0");
		expect(first.loggedOut.status).toBe(401);
		expect(first.evicted.status).toBe(401);
		expect(first.newest.status).toBe(200);
		if (process.platform !== "win32") {
			expect(lstatSync(config.statePath as string).mode & 0o777).toBe(0o700);
			expect(lstatSync(first.tokenPath).mode & 0o777).toBe(0o600);
		}
		await provePortReleased(first.address.host, first.address.port);

		const restarted = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const review = yield* MeetingPublicationReviewServer;
					const store = yield* MeetingPublicationStore;
					const oldCookie = yield* Effect.promise(() =>
						call(review.address.origin, "/", { cookie: first.activeAtClose }),
					);
					const token = readFileSync(first.tokenPath, "utf8").trim();
					const exchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchange).cookie;
					const item = (yield* store.list())[0];
					if (item === undefined) return yield* Effect.die("missing restarted item");
					const itemPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					return { oldCookie, exchange, token, session, itemPage };
				}).pipe(Effect.provide(makeReviewLayer(config, state))),
			),
		);
		expect(restarted.oldCookie.status).toBe(401);
		expect(restarted.exchange.status).toBe(303);
		expect(restarted.exchange.headers["referrer-policy"]).toBe("no-referrer");
		expect(restarted.token).toBe(first.token);
		expect(restarted.session).not.toContain(first.token);
		expect(csrfFrom(restarted.itemPage.body)).not.toBe(first.token);
		expect(csrfFrom(restarted.itemPage.body)).not.toBe(restarted.session.split("=", 2)[1]);
		expect(restarted.itemPage.body).not.toContain(first.token);
		expect(restarted.itemPage.headers["referrer-policy"]).toBe("same-origin");
		expect(state.closed).toEqual({ google: 2, discord: 2, notifier: 2 });
	});

	it("rejects unsafe bind and token-file configurations before serving", async () => {
		for (const host of ["0.0.0.0", "localhost", "192.168.1.9", "127.0.0.1.example"] as const) {
			const root = makeRoot();
			const config = { ...makeConfig(root), reviewHost: host } as unknown as JarvisMeetingPublicationConfig;
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Effect.gen(function* () {
						yield* MeetingPublicationReviewServer;
					}).pipe(Effect.provide(makeReviewLayer(config, makeState()))),
				),
			);
			expect(exit._tag, host).toBe("Failure");
		}
		for (const unsafe of [
			{ reviewPort: -1 },
			{ reviewSessionSeconds: 59 },
			{ reviewMaxSessions: 0 },
			{ reviewMaxBodyBytes: 255 },
			{ reviewMaxBodyBytes: 1_000_001 },
		]) {
			const root = makeRoot();
			const config = { ...makeConfig(root), ...unsafe } as JarvisMeetingPublicationConfig;
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Effect.gen(function* () {
						yield* MeetingPublicationReviewServer;
					}).pipe(Effect.provide(makeReviewLayer(config, makeState()))),
				),
			);
			expect(exit._tag, JSON.stringify(unsafe)).toBe("Failure");
		}
		{
			const root = makeRoot();
			const config = makeConfig(root);
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Effect.gen(function* () {
						yield* MeetingPublicationReviewServer;
					}).pipe(Effect.provide(makeReviewLayerWithRandom(config, makeState(), repeatedRandomLayer))),
				),
			);
			expect(exit._tag, "repeated random bytes").toBe("Failure");
		}

		for (const variant of ["symlink", "hardlink", "malformed", "extra-newline", "permissive"] as const) {
			const root = makeRoot();
			const statePath = join(root, "state");
			mkdirSync(statePath, { mode: 0o700 });
			const tokenPath = join(statePath, "meeting-publication-v2-review.token");
			if (variant === "symlink" || variant === "hardlink") {
				const outside = join(root, "outside-token");
				writeFileSync(outside, `${"a".repeat(43)}\n`, { mode: 0o600 });
				if (variant === "symlink") symlinkSync(outside, tokenPath);
				else linkSync(outside, tokenPath);
			} else {
				const contents =
					variant === "malformed"
						? "not-a-token\n"
						: variant === "extra-newline"
							? `${"a".repeat(43)}\n\n`
							: `${"a".repeat(43)}\n`;
				writeFileSync(tokenPath, contents, { mode: variant === "permissive" ? 0o644 : 0o600 });
			}
			const config = makeConfig(root);
			const exit = await Effect.runPromiseExit(
				Effect.scoped(
					Effect.gen(function* () {
						yield* MeetingPublicationReviewServer;
					}).pipe(Effect.provide(makeReviewLayer(config, makeState()))),
				),
			);
			expect(exit._tag, variant).toBe("Failure");
		}
	});

	it("updates one canonical note through a separate secured action and keeps providers idle", async () => {
		const root = makeRoot();
		const notePath = join(root, "notes", "meeting.md");
		const originalMarkdown = markdown({ summary: "Original canonical summary." });
		writeFileSync(notePath, originalMarkdown, { mode: 0o640 });
		const config = makeConfig(root, { maxFileBytes: 1_000_000, reviewMaxBodyBytes: 1_000_000 });
		const state = makeState();
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const item = yield* store.get(scan.itemIds[0] as string);
					if (item === null) return yield* Effect.die("missing item");
					const token = readFileSync(
						join(config.statePath as string, "meeting-publication-v2-review.token"),
						"utf8",
					).trim();
					const exchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchange).cookie;
					const itemPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					const csrf = csrfFrom(itemPage.body);
					const summaryPrefix = "Reviewer-edited canonical summary.";
					const editedTemplate = markdown({ summary: summaryPrefix }).trim();
					const fillerLength = 50_000 - Array.from(editedTemplate).length;
					const editedCanonical = editedTemplate.replace(
						summaryPrefix,
						`${summaryPrefix}${"🙂".repeat(fillerLength)}`,
					);
					const editedInput = `\r\n${editedCanonical.replaceAll("\n", "\r\n")}\r\n`;
					const updateBody = form({
						csrf,
						item_id: item.itemId,
						source_hash: item.sourceHash,
						meeting_markdown: editedInput,
					});
					const updateBodyBytes = Buffer.byteLength(updateBody);
					const invalidEncodingPrefix = form({
						csrf,
						item_id: item.itemId,
						source_hash: item.sourceHash,
						meeting_markdown: "",
					});
					const noteBeforeInvalidEncoding = readFileSync(notePath);
					const databaseBeforeInvalidEncoding = readFileSync(store.dbPath);
					const invalidUtf8 = yield* Effect.promise(() =>
						post(review.address.origin, session, `/update-note/${item.itemId}`, `${invalidEncodingPrefix}%FF`),
					);
					const truncatedUtf8 = yield* Effect.promise(() =>
						post(review.address.origin, session, `/update-note/${item.itemId}`, `${invalidEncodingPrefix}%F0%9F`),
					);
					const malformedPercent = yield* Effect.promise(() =>
						post(review.address.origin, session, `/update-note/${item.itemId}`, `${invalidEncodingPrefix}%ZZ`),
					);
					const rejectedEncodingMutation = {
						note: !noteBeforeInvalidEncoding.equals(readFileSync(notePath)),
						database: !databaseBeforeInvalidEncoding.equals(readFileSync(store.dbPath)),
						calls: { ...state.calls },
					};
					const unknownField = yield* Effect.promise(() =>
						post(review.address.origin, session, `/update-note/${item.itemId}`, `${updateBody}&extra=x`),
					);
					const duplicateField = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/update-note/${item.itemId}`,
							`${updateBody}&meeting_markdown=duplicate`,
						),
					);
					const accepted = yield* Effect.promise(() =>
						post(review.address.origin, session, `/update-note/${item.itemId}`, updateBody),
					);
					const updated = yield* store.get(item.itemId);
					if (updated === null) return yield* Effect.die("missing updated item");
					const callsAfterEdit = { ...state.calls };
					const updatedPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					const stale = yield* Effect.promise(() =>
						post(review.address.origin, session, `/update-note/${item.itemId}`, updateBody),
					);
					const approval = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/approve/${item.itemId}`,
							form({
								csrf,
								item_id: item.itemId,
								source_hash: updated.sourceHash,
								purpose: "Separate owner approval",
							}),
						),
					);
					const claimed = yield* store.claim(
						new Date(state.now).toISOString(),
						new Date(state.now + 60_000).toISOString(),
					);
					if (claimed === null) return yield* Effect.die("missing claim");
					const blocked = yield* store.markFailure(
						claimed,
						"discord",
						"terminal",
						null,
						new Date(state.now).toISOString(),
					);
					const blockedPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${item.itemId}`, { cookie: session }),
					);
					const blockedEdit = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/update-note/${item.itemId}`,
							form({
								csrf,
								item_id: item.itemId,
								source_hash: blocked.sourceHash,
								meeting_markdown: markdown({ summary: "Blocked overwrite." }),
							}),
						),
					);
					return {
						itemPage,
						invalidUtf8,
						truncatedUtf8,
						malformedPercent,
						rejectedEncodingMutation,
						unknownField,
						duplicateField,
						accepted,
						updated,
						callsAfterEdit,
						updatedPage,
						stale,
						approval,
						blockedPage,
						blockedEdit,
						updateBodyBytes,
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state))),
			),
		);

		expect(result.itemPage.status).toBe(200);
		expect(result.itemPage.body).toContain(`action="/update-note/${result.updated.itemId}"`);
		expect(result.itemPage.body).toContain('name="meeting_markdown"');
		expect(result.itemPage.body).not.toContain('maxlength="50000"');
		expect(result.itemPage.body).toContain('data-max-code-points="50000"');
		expect(result.updateBodyBytes).toBeGreaterThan(65_536);
		expect(result.updateBodyBytes).toBeLessThanOrEqual(1_000_000);
		expect(result.invalidUtf8.status).toBe(400);
		expect(result.truncatedUtf8.status).toBe(400);
		expect(result.malformedPercent.status).toBe(400);
		expect(result.rejectedEncodingMutation).toEqual({
			note: false,
			database: false,
			calls: { google: 0, discord: 0, notifier: 0 },
		});
		expect(result.unknownField.status).toBe(400);
		expect(result.duplicateField.status).toBe(400);
		expect(result.accepted.status).toBe(303);
		expect(result.accepted.headers.location).toBe(`/item/${result.updated.itemId}`);
		expect(result.updated).toMatchObject({ status: "pending_review", approvedHash: null });
		expect(result.callsAfterEdit).toEqual({ google: 0, discord: 0, notifier: 0 });
		expect(result.updatedPage.body).toContain("Reviewer-edited canonical summary.");
		expect(result.stale.status).toBe(409);
		expect(result.approval.status).toBe(303);
		expect(result.blockedPage.body).not.toContain('name="meeting_markdown"');
		expect(result.blockedEdit.status).toBe(409);
		expect(state.calls).toEqual({ google: 0, discord: 0, notifier: 0 });
		expect(readFileSync(notePath, "utf8")).toContain("Reviewer-edited canonical summary.");
		if (process.platform !== "win32") expect(lstatSync(notePath).mode & 0o777).toBe(0o640);
	});

	it("enforces HTTP controls without mutation and changes exactly one explicitly approved item", async () => {
		const root = makeRoot();
		const dangerous = `**Reviewed emphasis** and *review context* with \`npm test\`.

- First decision
- Second decision

<script>alert(1)</script><img src=x onerror=alert(2)>
[unsafe link](javascript:bad)
![tracking pixel](https://tracker.example/pixel.png)
credential=TOP_SECRET`;
		writeFileSync(join(root, "notes", "one.md"), markdown({ summary: dangerous }));
		writeFileSync(
			join(root, "notes", "two.md"),
			markdown({ title: "Second Sync", fingerprint: "second-sync", summary: "Second safe summary." }),
		);
		const config = makeConfig(root);
		const state = makeState();
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const items = yield* store.list();
					const first = items.find((item) => item.notePath.endsWith("one.md"));
					const second = items.find((item) => item.notePath.endsWith("two.md"));
					if (first === undefined || second === undefined)
						return yield* Effect.die(`missing items ${scan.eligible}`);
					const token = readFileSync(
						join(config.statePath as string, "meeting-publication-v2-review.token"),
						"utf8",
					).trim();
					const exchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchange).cookie;
					const page = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${first.itemId}`, { cookie: session }),
					);
					const csrf = csrfFrom(page.body);
					const valid = form({
						csrf,
						item_id: first.itemId,
						source_hash: first.sourceHash,
						purpose: "Owner reviewed purpose",
					});
					const baseline = readFileSync(store.dbPath);
					const controls = yield* Effect.all(
						[
							Effect.promise(() => call(review.address.origin, "/")),
							Effect.promise(() =>
								call(review.address.origin, `/item/${first.itemId}`, { method: "HEAD", cookie: session }),
							),
							Effect.promise(() =>
								post(review.address.origin, session, `/approve/${first.itemId}`, valid.replace(csrf, "x")),
							),
							Effect.promise(() =>
								post(review.address.origin, session, `/approve/${first.itemId}`, valid, {
									origin: "http://127.0.0.1:9",
								}),
							),
							Effect.promise(() =>
								call(review.address.origin, `/approve/${first.itemId}`, {
									method: "POST",
									cookie: session,
									host: "127.0.0.1:9",
									origin: review.address.origin,
									contentType: "application/x-www-form-urlencoded",
									body: valid,
								}),
							),
							Effect.promise(() => call(review.address.origin, "/", { method: "PUT", cookie: session })),
							Effect.promise(() =>
								post(review.address.origin, session, `/approve/${first.itemId}`, valid, {
									contentType: "text/plain",
								}),
							),
							Effect.promise(() =>
								post(review.address.origin, session, `/approve/${first.itemId}`, "x".repeat(257)),
							),
							Effect.promise(() =>
								post(review.address.origin, session, `/approve/${first.itemId}`, `${valid}&csrf=${csrf}`),
							),
							Effect.promise(() =>
								post(review.address.origin, session, `/approve/${first.itemId}`, `${valid}&purpose=%ZZ`),
							),
							Effect.promise(() =>
								post(
									review.address.origin,
									session,
									`/approve/${first.itemId}`,
									form({
										csrf,
										item_id: second.itemId,
										source_hash: second.sourceHash,
										purpose: "Cross item",
									}),
								),
							),
							Effect.promise(() => post(review.address.origin, session, "/approve", valid)),
							Effect.promise(() =>
								post(
									review.address.origin,
									session,
									`/approve/${first.itemId}`,
									form({
										csrf,
										item_id: first.itemId,
										source_hash: first.sourceHash,
										purpose: "javascript:alert(1)",
									}),
								),
							),
						],
						{ concurrency: 1 },
					);
					const afterControls = readFileSync(store.dbPath);
					const accepted = yield* Effect.promise(() =>
						post(review.address.origin, session, `/approve/${first.itemId}`, valid),
					);
					const afterAccepted = yield* store.list();
					const claimed = yield* store.claim(
						new Date(state.now).toISOString(),
						new Date(state.now + 60_000).toISOString(),
					);
					if (claimed === null) return yield* Effect.die("claim failed");
					yield* store.markFailure(claimed, "discord", "terminal", null, new Date(state.now).toISOString());
					const blockedPage = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${first.itemId}`, { cookie: session }),
					);
					writeFileSync(join(root, "notes", "one.md"), markdown({ summary: "edited after review" }));
					const stale = yield* Effect.promise(() =>
						post(
							review.address.origin,
							session,
							`/archive/${first.itemId}`,
							form({ csrf: csrfFrom(blockedPage.body), item_id: first.itemId, source_hash: first.sourceHash }),
						),
					);
					return {
						exchange,
						page,
						controls,
						baseline,
						afterControls,
						accepted,
						afterAccepted,
						stale,
						refreshed: yield* store.get(first.itemId),
						dbPath: store.dbPath,
						token,
						firstPath: first.notePath,
					};
				}).pipe(Effect.provide(makeReviewLayer(config, state))),
			),
		);

		expect(result.page.status).toBe(200);
		expect(result.page.body).toContain("&lt;script&gt;");
		expect(result.page.body).not.toContain("<script>");
		expect(result.page.body).not.toContain("<img");
		const preview = result.page.body.slice(0, result.page.body.indexOf('<form method="post" action="/update-note/'));
		const renderedSummary = /<div class="summary-block markdown-body">([\s\S]*?)<\/div>/u.exec(result.page.body)?.[1];
		const renderedNote = /<article class="canonical-markdown markdown-body">([\s\S]*?)<\/article>/u.exec(
			result.page.body,
		)?.[1];
		expect(renderedSummary).toBeDefined();
		expect(renderedSummary).toContain("<strong>Reviewed emphasis</strong>");
		expect(renderedSummary).toContain("<em>review context</em>");
		expect(renderedSummary).toContain("<code>npm test</code>");
		expect(renderedSummary).toContain("<ul>");
		expect(renderedNote).toBeDefined();
		expect(renderedNote).not.toContain("<h1>Weekly Sync</h1>");
		expect(renderedNote).toContain('<details class="metadata-card"><summary>Meeting metadata</summary>');
		expect(renderedNote).toContain("<strong>Reviewed emphasis</strong>");
		expect(renderedNote).toContain("<em>review context</em>");
		expect(renderedNote).toContain("<code>npm test</code>");
		expect(renderedNote).toContain("<ul>");
		expect(renderedNote).toContain("[Image: tracking pixel]");
		for (const renderedMarkdown of [renderedSummary, renderedNote]) {
			expect(renderedMarkdown).not.toContain("<script");
			expect(renderedMarkdown).not.toContain("<img");
			expect(renderedMarkdown).not.toContain("<iframe");
			expect(renderedMarkdown).not.toContain("<svg");
			expect(renderedMarkdown).not.toContain("tracker.example");
			expect(renderedMarkdown).not.toContain('href="javascript:');
		}
		expect(preview).not.toContain("javascript:bad");
		expect(preview).not.toContain("TOP_SECRET");
		expect(result.page.body).toContain("javascript:bad");
		expect(result.page.body).toContain("credential=TOP_SECRET");
		expect(result.page.body).not.toContain(result.firstPath);
		const stylesheet = /<style>([\s\S]+)<\/style>/u.exec(result.page.body)?.[1];
		expect(stylesheet).toBeDefined();
		const stylesheetDigest = createHash("sha256")
			.update(stylesheet ?? "")
			.digest("base64");
		expect(result.page.headers["content-security-policy"]).toContain(`style-src 'sha256-${stylesheetDigest}'`);
		expect(result.controls.map((response) => response.status)).toEqual([
			401, 200, 403, 403, 400, 405, 415, 413, 400, 400, 409, 404, 409,
		]);
		expect(result.controls[1]?.body).toBe("");
		expect(result.afterControls.equals(result.baseline)).toBe(true);
		for (const response of [result.exchange, result.page, ...result.controls, result.accepted, result.stale]) {
			expect(response.headers["cache-control"]).toBe("no-store");
			expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline");
			expect(response.headers["x-content-type-options"]).toBe("nosniff");
			expect(response.headers["x-frame-options"]).toBe("DENY");
			expect(response.body).not.toContain(result.token);
		}
		expect(result.page.headers["referrer-policy"]).toBe("same-origin");
		expect(result.controls[1]?.headers["referrer-policy"]).toBe("same-origin");
		for (const response of [
			result.exchange,
			result.controls[0],
			...result.controls.slice(2),
			result.accepted,
			result.stale,
		]) {
			expect(response?.headers["referrer-policy"]).toBe("no-referrer");
		}
		expect(result.accepted.status).toBe(303);
		expect(result.afterAccepted.filter((item) => item.status === "approved")).toHaveLength(1);
		expect(result.afterAccepted.filter((item) => item.status === "pending_review")).toHaveLength(1);
		expect(result.afterAccepted.find((item) => item.status === "approved")?.discordPurposeOverride).toBe(
			"Owner reviewed purpose.",
		);
		expect(result.stale.status).toBe(409);
		expect(result.refreshed).toMatchObject({ status: "pending_review", discordPurposeOverride: null });
		const durable = readFileSync(result.dbPath).toString("latin1");
		for (const forbidden of [dangerous, "TOP_SECRET", result.token]) expect(durable).not.toContain(forbidden);
	});
});
