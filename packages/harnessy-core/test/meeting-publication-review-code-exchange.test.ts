import { createHash, createHmac } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	MeetingPublicationReviewRandom,
	MeetingPublicationReviewServer,
	meetingPublicationReviewExchangePrefix,
	meetingPublicationReviewIdentityDomain,
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

// The single-use code exchange and identity challenge used by
// harnessy-meeting-review-open. In-process server only; nothing is spawned.

const roots: Array<string> = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
		reviewMaxSessions: 16,
		reviewMaxBodyBytes: 256,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

const reviewLayer = (config: JarvisMeetingPublicationConfig) => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	let counter = 0;
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, MeetingPublicationClock.of({ now: Effect.sync(() => Date.now()) })),
		Layer.succeed(
			MeetingPublicationGoogle,
			MeetingPublicationGoogle.of({
				preflight: Effect.succeed(true),
				upsert: (input) =>
					Effect.succeed(
						new MeetingPublicationGoogleCheckpoint({
							docId: `doc-${input.itemId}`,
							docUrl: `https://docs.example.test/${input.itemId}`,
						}),
					),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationDiscord,
			MeetingPublicationDiscord.of({
				preflight: Effect.succeed(true),
				upsert: (input) =>
					Effect.succeed(
						new MeetingPublicationDiscordCheckpoint({
							channelId: "channel-id",
							messageId: `message-${input.itemId}`,
						}),
					),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationNotifier,
			MeetingPublicationNotifier.of({ notify: () => Effect.succeed(true), close: Effect.void }),
		),
	);
	const random = Layer.succeed(
		MeetingPublicationReviewRandom,
		MeetingPublicationReviewRandom.of({
			bytes: (length) =>
				Effect.sync(() => createHash("sha256").update(`code-exchange-${counter++}`).digest().subarray(0, length)),
		}),
	);
	return MeetingPublicationReviewServer.layer(config).pipe(
		Layer.provideMerge(
			Layer.merge(MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies)), random),
		),
	);
};

interface HttpResult {
	readonly status: number;
	readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
	readonly body: string;
}

const call = (origin: string, path: string, headers: Record<string, string> = {}) =>
	new Promise<HttpResult>((resolveRequest, rejectRequest) => {
		const target = new URL(origin);
		const outgoing = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				method: "GET",
				headers: { Host: target.host, ...headers },
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
		outgoing.end();
	});

/** Run `body` against a live review server for a fresh, owner-only state root. */
const withReview = <A>(
	body: (context: { origin: string; port: number; root: string; state: string; token: string }) => Promise<A>,
): Promise<A> => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-code-exchange-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	const config = makeConfig(root);
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const review = yield* MeetingPublicationReviewServer;
				const state = config.statePath as string;
				const token = readFileSync(join(state, "meeting-publication-v2-review.token"), "utf8").trim();
				return yield* Effect.promise(() =>
					body({ origin: review.address.origin, port: review.address.port, root, state, token }),
				);
			}).pipe(Effect.provide(reviewLayer(config))),
		),
	);
};

const code = (seed: string) => createHash("sha256").update(seed).digest("base64url").slice(0, 43);
const exchangePath = (state: string, value: string) =>
	join(state, `${meetingPublicationReviewExchangePrefix}${createHash("sha256").update(value).digest("hex")}`);
/** What harnessy-meeting-review-open creates: an empty 0600 file named by the code's hash. */
const issue = (state: string, value: string) => {
	const path = exchangePath(state, value);
	writeFileSync(path, "", { mode: 0o600, flag: "wx" });
	chmodSync(path, 0o600);
	return path;
};
const sessionCookie = (response: HttpResult) => {
	const header = response.headers["set-cookie"];
	const first = Array.isArray(header) ? header[0] : header;
	return typeof first === "string" ? (first.split(";", 1)[0] ?? "") : "";
};
const nonce = "0123456789abcdef".repeat(4);
const expectedProof = (token: string, port: number, value = nonce) =>
	createHmac("sha256", token).update(`${meetingPublicationReviewIdentityDomain}:${port}:${value}`).digest("hex");

describe("meeting review identity challenge", () => {
	it("answers with an HMAC of the token bound to the listening port and nonce", async () => {
		await withReview(async ({ origin, port, token }) => {
			const response = await call(origin, `/identity?nonce=${nonce}`);
			expect(response.status).toBe(200);
			expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
			expect(response.headers["cache-control"]).toBe("no-store");
			expect(response.headers["set-cookie"]).toBeUndefined();
			expect(response.body).toBe(expectedProof(token, port));
			expect(response.body).not.toContain(token);
			// Bound to this port: the proof for any other port differs, so a relay cannot reuse it.
			expect(response.body).not.toBe(expectedProof(token, port + 1));
			// Bound to the nonce: a fresh nonce gives a fresh proof.
			const other = "f".repeat(64);
			expect((await call(origin, `/identity?nonce=${other}`)).body).toBe(expectedProof(token, port, other));
		});
	});

	it("rejects malformed nonces, extra parameters and a foreign Host without a proof", async () => {
		await withReview(async ({ origin, port, token }) => {
			for (const path of [
				"/identity",
				"/identity?nonce=",
				`/identity?nonce=${nonce.toUpperCase()}`,
				`/identity?nonce=${nonce.slice(1)}`,
				`/identity?nonce=${nonce}0`,
				`/identity?nonce=${nonce}&nonce=${nonce}`,
				`/identity?nonce=${nonce}&token=${token}`,
				`/identity?nonce=%C3%A9${nonce.slice(2)}`,
				`/identity?nonce=%zz`,
			]) {
				const response = await call(origin, path);
				expect(response.status, path).toBe(400);
				expect(response.body).not.toContain(expectedProof(token, port));
			}
			const foreign = await call(origin, `/identity?nonce=${nonce}`, { Host: "attacker.example" });
			expect(foreign.status).toBe(400);
			expect(foreign.body).not.toContain(expectedProof(token, port));
		});
	});
});

describe("meeting review single-use code exchange", () => {
	it("redeems a fresh code once, deletes it and starts a working session", async () => {
		await withReview(async ({ origin, state }) => {
			const value = code("fresh");
			const path = issue(state, value);
			const exchanged = await call(origin, `/exchange?code=${value}`);
			expect(exchanged.status).toBe(303);
			expect(exchanged.headers.location).toBe("/");
			expect(exchanged.headers["referrer-policy"]).toBe("no-referrer");
			expect(String(exchanged.headers["set-cookie"])).toMatch(
				/^hsy_meeting_review=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=60$/u,
			);
			expect(existsSync(path)).toBe(false);
			const inbox = await call(origin, "/", { Cookie: sessionCookie(exchanged) });
			expect(inbox.status).toBe(200);
			expect(inbox.body).toContain("Meeting review");
			// Replay of the same code is refused and starts no session.
			const replay = await call(origin, `/exchange?code=${value}`);
			expect(replay.status).toBe(401);
			expect(replay.headers["set-cookie"]).toBeUndefined();
		});
	});

	it("keeps the long-lived token exchange working", async () => {
		await withReview(async ({ origin, token }) => {
			const exchanged = await call(origin, `/exchange?token=${token}`);
			expect(exchanged.status).toBe(303);
			expect((await call(origin, "/", { Cookie: sessionCookie(exchanged) })).status).toBe(200);
			expect((await call(origin, "/exchange?token=wrong")).status).toBe(401);
		});
	});

	it("refuses and revokes expired, loose-mode, non-empty and hard-linked codes", async () => {
		await withReview(async ({ origin, state, root }) => {
			const expired = code("expired");
			const expiredPath = issue(state, expired);
			const old = new Date(Date.now() - 2 * 60_000);
			utimesSync(expiredPath, old, old);
			const loose = code("loose");
			const loosePath = issue(state, loose);
			chmodSync(loosePath, 0o644);
			const filled = code("filled");
			const filledPath = issue(state, filled);
			writeFileSync(filledPath, "x");
			const linked = code("linked");
			const linkedPath = issue(state, linked);
			linkSync(linkedPath, join(root, "linked-copy"));
			for (const [value, path] of [
				[expired, expiredPath],
				[loose, loosePath],
				[filled, filledPath],
				[linked, linkedPath],
			] as const) {
				const response = await call(origin, `/exchange?code=${value}`);
				expect(response.status, value).toBe(401);
				expect(response.headers["set-cookie"]).toBeUndefined();
				// The bad file is removed, so the code cannot be retried.
				expect(existsSync(path), value).toBe(false);
			}
		});
	});

	it("refuses a symlinked exchange file without touching its target", async () => {
		await withReview(async ({ origin, state, root }) => {
			const value = code("symlink");
			const target = join(root, "target");
			writeFileSync(target, "", { mode: 0o600 });
			symlinkSync(target, exchangePath(state, value));
			const response = await call(origin, `/exchange?code=${value}`);
			expect(response.status).toBe(401);
			expect(existsSync(exchangePath(state, value))).toBe(false);
			expect(existsSync(target)).toBe(true);
		});
	});

	it("refuses unknown, malformed and ambiguous codes", async () => {
		await withReview(async ({ origin, state, token }) => {
			const value = code("ambiguous");
			const path = issue(state, value);
			expect((await call(origin, `/exchange?code=${code("never-issued")}`)).status).toBe(401);
			expect((await call(origin, `/exchange?code=${value.slice(1)}`)).status).toBe(401);
			expect((await call(origin, `/exchange?code=${value}&code=${value}`)).status).toBe(401);
			expect((await call(origin, `/exchange?code=${value}&token=${token}`)).status).toBe(400);
			expect((await call(origin, `/exchange?code=${value}&extra=1`)).status).toBe(400);
			expect((await call(origin, `/exchange?code=${encodeURIComponent("é")}`)).status).toBe(401);
			// None of the refused requests consumed the issued code.
			expect(existsSync(path)).toBe(true);
			expect((await call(origin, `/exchange?code=${value}`)).status).toBe(303);
		});
	});

	it("lets exactly one of many concurrent redemptions win", async () => {
		await withReview(async ({ origin, state }) => {
			const value = code("concurrent");
			issue(state, value);
			const responses = await Promise.all(Array.from({ length: 12 }, () => call(origin, `/exchange?code=${value}`)));
			const statuses = responses.map((response) => response.status).sort();
			expect(statuses.filter((status) => status === 303)).toHaveLength(1);
			expect(statuses.filter((status) => status === 401)).toHaveLength(11);
			expect(responses.filter((response) => response.headers["set-cookie"] !== undefined)).toHaveLength(1);
		});
	});
});
