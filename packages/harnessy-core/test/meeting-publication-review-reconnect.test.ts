import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { validateMeetingPublicationWriteGrant } from "../src/jarvis/meeting-publication/authority.ts";
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
	MeetingPublicationGoogle,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: Array<string> = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const call = async (
	origin: string,
	path: string,
	cookie?: string,
	fields?: Record<string, string>,
	requestOrigin = origin,
) => {
	const response = await fetch(`${origin}${path}`, {
		redirect: "manual",
		method: fields === undefined ? "GET" : "POST",
		headers: {
			...(cookie === undefined ? {} : { Cookie: cookie }),
			...(fields === undefined
				? {}
				: { Origin: requestOrigin, "Content-Type": "application/x-www-form-urlencoded" }),
		},
		...(fields === undefined ? {} : { body: new URLSearchParams(fields).toString() }),
	});
	return { status: response.status, headers: response.headers, body: await response.text() };
};
const csrfFrom = (body: string) => {
	const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(body)?.[1];
	if (csrf === undefined) throw new Error("missing csrf");
	return csrf;
};
const fixture = (mode: MeetingPublicationReviewMode = "full", supported = true) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-reconnect-review-"));
	roots.push(root);
	mkdirSync(join(root, "notes"), { mode: 0o700 });
	writeFileSync(
		join(root, "notes", "meeting.md"),
		"# Review meeting\n\n## Metadata\n- Project: alpha\n- Date: 2026-09-04\n- Fingerprint: reconnect\n\n## Executive Summary\nA retained decision.\n",
		{ mode: 0o600 },
	);
	const config = new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 60,
		reviewMaxSessions: 2,
		reviewMaxBodyBytes: 8192,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder",
		discordChannelId: "channel",
	});
	const state = {
		now: Date.parse("2026-09-05T12:00:00Z"),
		starts: 0,
		completions: [] as Array<string>,
		cancels: 0,
		healthy: false,
		checks: 0,
		failure: false,
		authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
		completionWait: undefined as Promise<void> | undefined,
		completionStarted: () => {},
	};
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const guard = (grant: Parameters<typeof validateMeetingPublicationWriteGrant>[0]) =>
		validateMeetingPublicationWriteGrant(grant, "provider_google_reconnect").pipe(
			Effect.mapError(
				() =>
					new MeetingPublicationProviderError({
						stage: "google",
						code: "invalid_grant",
						retryable: false,
						retryAfterSeconds: null,
					}),
			),
		);
	const deps = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationReviewRandom.liveLayer,
		Layer.succeed(MeetingPublicationClock, { now: Effect.sync(() => state.now) }),
		Layer.succeed(MeetingPublicationGoogle, {
			preflight: Effect.sync(() => {
				state.checks += 1;
				return state.healthy;
			}),
			upsert: () => Effect.die("reconnect must not publish"),
			close: Effect.void,
			...(supported
				? {
						startReconnect: (redirectUri: string, grant: Parameters<typeof guard>[0]) =>
							Effect.gen(function* () {
								yield* guard(grant);
								expect(new URL(redirectUri).pathname).toBe("/google-reconnect/callback");
								state.starts += 1;
								return {
									state: `fixture_reconnect_state_${state.starts}`,
									authorizationUrl: state.authorizationUrl,
									complete: (code: string, fresh: Parameters<typeof guard>[0]) =>
										Effect.gen(function* () {
											yield* guard(fresh);
											expect(fresh).not.toBe(grant);
											state.completions.push(code);
											state.completionStarted();
											if (state.completionWait !== undefined)
												yield* Effect.promise(() => state.completionWait as Promise<void>);
											if (state.failure) {
												state.healthy = false;
												return yield* new MeetingPublicationProviderError({
													stage: "google",
													code: "identity_mismatch",
													retryable: false,
													retryAfterSeconds: null,
												});
											}
											state.healthy = true;
										}),
									cancel: (fresh: Parameters<typeof guard>[0]) =>
										guard(fresh).pipe(
											Effect.andThen(
												Effect.sync(() => {
													state.cancels += 1;
												}),
											),
										),
								};
							}),
					}
				: {}),
		}),
		Layer.succeed(MeetingPublicationDiscord, {
			preflight: Effect.succeed(true),
			upsert: () => Effect.die("reconnect must not publish"),
			close: Effect.void,
		}),
		Layer.succeed(MeetingPublicationNotifier, { notify: () => Effect.succeed(true), close: Effect.void }),
	);
	const services = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(deps));
	const review = MeetingPublicationReviewServer.layer(
		config,
		mode,
		mode === "full" ? { maxItems: 1 } : undefined,
	).pipe(Layer.provideMerge(services));
	return {
		state,
		config,
		run: <A>(
			test: (
				origin: string,
				service: MeetingPublicationService["Service"],
				store: MeetingPublicationStore["Service"],
			) => Promise<A>,
		) =>
			Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const host = yield* MeetingPublicationReviewServer;
						const service = yield* MeetingPublicationService;
						const store = yield* MeetingPublicationStore;
						yield* service.scan();
						return yield* Effect.promise(() => test(host.address.origin, service, store));
					}).pipe(Effect.provide(review)),
				),
			),
	};
};
const login = async (origin: string, statePath: string) => {
	const token = readFileSync(join(statePath, "meeting-publication-v2-review.token"), "utf8").trim();
	const exchange = await call(origin, `/exchange?token=${token}`);
	expect(exchange.headers.get("set-cookie")).toContain("SameSite=Strict");
	const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
	if (cookie === undefined) throw new Error("missing cookie");
	const page = await call(origin, "/", cookie);
	return { cookie, csrf: csrfFrom(page.body) };
};

describe("same-owner Google reconnect review", () => {
	it("keeps callback inert and completes only from the original authenticated CSRF session without publishing or reapproving", async () => {
		const f = fixture();
		await f.run(async (origin, service, store) => {
			const [item] = await Effect.runPromise(store.list());
			if (item === undefined) throw new Error("missing item");
			await Effect.runPromise(service.approve(item.itemId, item.sourceHash, "Retained reviewed purpose."));
			const now = new Date(f.state.now).toISOString();
			const claim = await Effect.runPromise(store.claim(now, new Date(f.state.now + 60000).toISOString()));
			if (claim === null) throw new Error("missing claim");
			await Effect.runPromise(store.markFailure(claim, "google", "authentication_failed", null, now));
			await Effect.runPromise(service.worker(0));
			const before = await Effect.runPromise(store.list());
			const session = await login(origin, f.config.statePath as string);
			const started = await call(origin, "/google-reconnect/start", session.cookie, { csrf: session.csrf });
			expect(started.status).toBe(200);
			expect(started.headers.get("content-security-policy")).toContain("form-action 'self'");
			expect(started.body).toContain('href="https://accounts.google.com/');
			expect(started.headers.get("location")).toBeNull();
			const callback = await call(
				origin,
				"/google-reconnect/callback?state=fixture_reconnect_state_1&code=SECRET_CODE",
			);
			expect(callback.status).toBe(200);
			expect(callback.body).not.toContain("SECRET_CODE");
			expect(callback.body).not.toContain(session.csrf);
			expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
			expect(f.state.completions).toEqual([]);
			expect((await call(origin, "/google-reconnect/complete", undefined, { csrf: session.csrf })).status).toBe(401);
			const other = await login(origin, f.config.statePath as string);
			expect((await call(origin, "/google-reconnect/confirm", other.cookie)).status).toBe(404);
			expect((await call(origin, "/google-reconnect/complete", other.cookie, { csrf: other.csrf })).status).toBe(
				409,
			);
			expect((await call(origin, "/google-reconnect/complete", session.cookie, { csrf: "bad" })).status).toBe(403);
			expect(
				(
					await call(
						origin,
						"/google-reconnect/complete",
						session.cookie,
						{ csrf: session.csrf },
						"https://example.test",
					)
				).status,
			).toBe(403);
			const confirm = await call(origin, "/google-reconnect/confirm", session.cookie);
			expect(confirm.status).toBe(200);
			expect(confirm.body).not.toContain("SECRET_CODE");
			expect(confirm.headers.get("referrer-policy")).toBe("same-origin");
			expect((await call(origin, "/google-reconnect/complete", session.cookie, { csrf: session.csrf })).status).toBe(
				200,
			);
			expect(f.state.completions).toEqual(["SECRET_CODE"]);
			expect(await Effect.runPromise(store.list())).toEqual(before);
			expect(
				(await Effect.runPromise(store.providerHealth())).find((h) => h.provider === "google")?.failure,
			).toBeNull();
			expect((await call(origin, "/google-reconnect/complete", session.cookie, { csrf: session.csrf })).status).toBe(
				409,
			);
		});
	});
	it("rejects malformed, wrong-state, replayed and oversized callbacks without provider exchange", async () => {
		const f = fixture();
		await f.run(async (origin) => {
			const s = await login(origin, f.config.statePath as string);
			expect((await call(origin, "/google-reconnect/start", undefined, { csrf: s.csrf })).status).toBe(401);
			expect(
				(await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf }, "https://example.test")).status,
			).toBe(403);
			expect((await call(origin, "/google-reconnect/start", s.cookie, { csrf: "bad" })).status).toBe(403);
			expect(f.state.starts).toBe(0);
			await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf });
			for (const query of [
				"state=wrong&code=x",
				"state=fixture_reconnect_state_1&state=x&code=y",
				"state=fixture_reconnect_state_1&code=%00",
				`state=fixture_reconnect_state_1&code=${"x".repeat(4097)}`,
			])
				expect((await call(origin, `/google-reconnect/callback?${query}`)).status).toBeGreaterThanOrEqual(400);
			expect(
				(await call(origin, "/google-reconnect/callback?state=fixture_reconnect_state_1&code=valid")).status,
			).toBe(200);
			expect(
				(await call(origin, "/google-reconnect/callback?state=fixture_reconnect_state_1&code=replay")).status,
			).toBe(409);
			expect(f.state.completions).toEqual([]);
		});
	});
	for (const invalidation of ["logout", "expiry", "eviction", "cancel"] as const)
		it(`invalidates pending reconnect on ${invalidation}`, async () => {
			const f = fixture();
			await f.run(async (origin) => {
				const s = await login(origin, f.config.statePath as string);
				await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf });
				if (invalidation === "logout") await call(origin, "/logout", s.cookie, { csrf: s.csrf });
				if (invalidation === "cancel") await call(origin, "/google-reconnect/cancel", s.cookie, { csrf: s.csrf });
				if (invalidation === "expiry") {
					f.state.now += 60001;
					await call(origin, "/", s.cookie);
				}
				if (invalidation === "eviction") {
					f.state.now += 1;
					await login(origin, f.config.statePath as string);
					f.state.now += 1;
					await login(origin, f.config.statePath as string);
				}
				expect(
					(await call(origin, "/google-reconnect/callback?state=fixture_reconnect_state_1&code=stale")).status,
				).toBe(409);
				expect(f.state.completions).toEqual([]);
				expect(f.state.cancels).toBe(1);
			});
		});
	for (const [mode, supported] of [
		["decision_only", true],
		["full", false],
	] as const)
		it(`does not expose reconnect in ${mode}, supported=${supported}`, async () => {
			const f = fixture(mode, supported);
			await f.run(async (origin) => {
				const s = await login(origin, f.config.statePath as string);
				expect((await call(origin, "/", s.cookie)).body).not.toContain('action="/google-reconnect/start"');
				expect((await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf })).status).toBe(404);
				expect(f.state.starts).toBe(0);
			});
		});
	it("rejects unsafe authorization URLs without rendering them", async () => {
		const f = fixture();
		f.state.authorizationUrl = "https://evil.example/steal";
		await f.run(async (origin) => {
			const s = await login(origin, f.config.statePath as string);
			const result = await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf });
			expect(result.status).toBe(409);
			expect(result.body).not.toContain("evil.example");
			expect(f.state.cancels).toBe(1);
		});
	});
	it("consumes failed completions and never marks identity mismatch healthy", async () => {
		const f = fixture();
		f.state.failure = true;
		f.state.healthy = true;
		await f.run(async (origin, service, store) => {
			await Effect.runPromise(service.worker(0));
			expect(
				(await Effect.runPromise(store.providerHealth())).find((h) => h.provider === "google")?.failure,
			).toBeNull();
			const before = await Effect.runPromise(store.list());
			const s = await login(origin, f.config.statePath as string);
			await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf });
			await call(origin, "/google-reconnect/callback?state=fixture_reconnect_state_1&code=wrong_account");
			expect((await call(origin, "/google-reconnect/complete", s.cookie, { csrf: s.csrf })).status).toBe(500);
			expect((await call(origin, "/google-reconnect/complete", s.cookie, { csrf: s.csrf })).status).toBe(409);
			expect(f.state.completions).toEqual(["wrong_account"]);
			expect(await Effect.runPromise(store.list())).toEqual(before);
			expect(
				(await Effect.runPromise(store.providerHealth())).find((h) => h.provider === "google")?.failure,
			).not.toBeNull();
		});
	});
	it("drops pending callback handles when the review owner closes", async () => {
		const f = fixture();
		await f.run(async (origin) => {
			const s = await login(origin, f.config.statePath as string);
			expect((await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf })).status).toBe(200);
		});
		await f.run(async (origin) => {
			expect(
				(await call(origin, "/google-reconnect/callback?state=fixture_reconnect_state_1&code=stale")).status,
			).toBe(409);
			const s = await login(origin, f.config.statePath as string);
			expect((await call(origin, "/google-reconnect/complete", s.cookie, { csrf: s.csrf })).status).toBe(409);
			expect(f.state.completions).toEqual([]);
		});
	});
	it("serializes completion with worker health and rejects overlapping completion", async () => {
		const f = fixture();
		let release = () => {};
		f.state.completionWait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			f.state.completionStarted = resolve;
		});
		await f.run(async (origin, service) => {
			const s = await login(origin, f.config.statePath as string);
			await call(origin, "/google-reconnect/start", s.cookie, { csrf: s.csrf });
			await call(origin, "/google-reconnect/callback?state=fixture_reconnect_state_1&code=once");
			const completed = call(origin, "/google-reconnect/complete", s.cookie, { csrf: s.csrf });
			await started;
			const checks = f.state.checks;
			const worker = Effect.runPromise(service.worker(0));
			try {
				expect((await call(origin, "/google-reconnect/complete", s.cookie, { csrf: s.csrf })).status).toBe(409);
				expect(f.state.checks).toBe(checks);
				expect(f.state.healthy).toBe(false);
			} finally {
				release();
			}
			expect((await completed).status).toBe(200);
			await worker;
			expect(f.state.completions).toEqual(["once"]);
			expect(f.state.healthy).toBe(true);
		});
	});
});
