import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
		reviewMaxBodyBytes: 256,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

const markdown = (title: string, date: string, fingerprint: string) => `# ${title}

## Metadata
- Project: alpha
- Date: ${date}
- Fingerprint: ${fingerprint}

## Executive Summary
We aligned on the release.

## Meeting Purpose
Ship the safe publication foundation.
`;

interface HttpResult {
	readonly status: number;
	readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
	readonly body: string;
}

const call = (origin: string, path: string, cookie?: string) =>
	new Promise<HttpResult>((resolveRequest, rejectRequest) => {
		const target = new URL(origin);
		const outgoing = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				headers: { Host: target.host, ...(cookie === undefined ? {} : { Cookie: cookie }) },
			},
			(response) => {
				const chunks: Array<Buffer> = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => {
					resolveRequest({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		outgoing.setTimeout(3_000, () => outgoing.destroy(new Error("request timeout")));
		outgoing.on("error", rejectRequest);
		outgoing.end();
	});

const cookieFrom = (response: HttpResult) => {
	const header = response.headers["set-cookie"];
	const first = Array.isArray(header) ? header[0] : header;
	if (first === undefined) throw new Error("missing cookie");
	return first.split(";", 1)[0] as string;
};

const makeLayer = (config: JarvisMeetingPublicationConfig, now: number) => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	let randomCounter = 0;
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, MeetingPublicationClock.of({ now: Effect.succeed(now) })),
		Layer.succeed(
			MeetingPublicationGoogle,
			MeetingPublicationGoogle.of({
				preflight: Effect.succeed(true),
				upsert: (input) =>
					Effect.succeed(
						new MeetingPublicationGoogleCheckpoint({
							docId: input.existingDocId ?? `doc-${input.itemId}`,
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
							channelId: input.existingChannelId ?? "channel-id",
							messageId: input.existingMessageId ?? `message-${input.itemId}`,
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
	const service = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
	const random = Layer.succeed(
		MeetingPublicationReviewRandom,
		MeetingPublicationReviewRandom.of({
			bytes: (length) =>
				Effect.sync(() =>
					createHash("sha256").update(`review-attention-${randomCounter++}`).digest().subarray(0, length),
				),
		}),
	);
	return MeetingPublicationReviewServer.layer(config, "decision_only").pipe(
		Layer.provideMerge(Layer.merge(service, random)),
	);
};

describe("MeetingPublicationReviewServer dispatch attention", () => {
	it("shows retrying and blocked work with safe diagnostics and keeps GET requests read-only", async () => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-attention-"));
		roots.push(root);
		mkdirSync(join(root, "notes"));
		const retryPath = join(root, "notes", "retry.md");
		const blockedPath = join(root, "notes", "blocked.md");
		writeFileSync(retryPath, markdown("Retry meeting", "2026-09-03", "retry-meeting"));
		writeFileSync(blockedPath, markdown("Blocked meeting", "2026-09-02", "blocked-meeting"));
		const config = makeConfig(root);
		const now = Date.parse("2026-09-04T12:00:00.000Z");

		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const review = yield* MeetingPublicationReviewServer;
					const scan = yield* service.scan();
					const scanned = yield* store.list();
					const retry = scanned.find((item) => item.notePath === retryPath);
					const blocked = scanned.find((item) => item.notePath === blockedPath);
					if (scan.itemIds.length !== 2 || retry === undefined || blocked === undefined) {
						return yield* Effect.die("missing scanned items");
					}
					const nowIso = new Date(now).toISOString();
					const leaseUntil = new Date(now + 60_000).toISOString();
					yield* service.approve(retry.itemId, retry.sourceHash);
					const retryClaim = yield* store.claimExact(retry.itemId, retry.sourceHash, nowIso, leaseUntil);
					if (retryClaim === null) return yield* Effect.die("missing retry claim");
					const retrying = yield* store.markFailure(
						retryClaim,
						"google",
						"provider_timeout_must_not_render",
						new Date(now + 300_000).toISOString(),
						nowIso,
					);
					yield* service.approve(blocked.itemId, blocked.sourceHash);
					const blockedClaim = yield* store.claimExact(blocked.itemId, blocked.sourceHash, nowIso, leaseUntil);
					if (blockedClaim === null) return yield* Effect.die("missing blocked claim");
					const blockedItem = yield* store.markFailure(
						blockedClaim,
						"discord",
						"terminal_secret_must_not_render",
						null,
						nowIso,
					);
					const token = readFileSync(
						join(config.statePath as string, "meeting-publication-v2-review.token"),
						"utf8",
					).trim();
					const exchange = yield* Effect.promise(() =>
						call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
					);
					const session = cookieFrom(exchange);
					const before = readFileSync(store.dbPath);
					const inbox = yield* Effect.promise(() => call(review.address.origin, "/", session));
					const item = yield* Effect.promise(() =>
						call(review.address.origin, `/item/${blockedItem.itemId}`, session),
					);
					return {
						retrying,
						blockedItem,
						inbox,
						item,
						before,
						after: readFileSync(store.dbPath),
						stored: yield* store.list(),
					};
				}).pipe(Effect.provide(makeLayer(config, now))),
			),
		);

		expect(result.inbox.status).toBe(200);
		expect(result.inbox.body).toContain("Dispatch needs attention");
		expect(result.inbox.body).toContain("Retry scheduled");
		expect(result.inbox.body).toContain("Blocked");
		expect(result.inbox.body).toContain("Google stage");
		expect(result.inbox.body).toContain("Discord stage");
		expect(result.inbox.body).toContain(`Diagnostic ${result.retrying.failureCode}`);
		expect(result.inbox.body).toContain(`Diagnostic ${result.blockedItem.failureCode}`);
		expect(result.inbox.body).toContain("<details><summary>Technical details</summary>");
		expect(result.inbox.body).toContain("<span>Approved</span><strong>1</strong>");
		expect(result.inbox.body).toContain("<span>Blocked</span><strong>1</strong>");
		expect(result.inbox.body).not.toContain("local review and dispatch queue is clear");
		expect(result.inbox.body).not.toContain("provider_timeout_must_not_render");
		expect(result.inbox.body).not.toContain("terminal_secret_must_not_render");
		expect(result.inbox.body).not.toContain(root);
		expect(result.item.status).toBe(200);
		expect(result.item.body).toContain('<details class="metadata-card"><summary>Meeting metadata</summary>');
		expect(result.item.body.match(/<h1>Blocked meeting<\/h1>/gu)).toHaveLength(1);
		expect(result.after.equals(result.before)).toBe(true);
		expect(result.stored).toEqual(expect.arrayContaining([result.retrying, result.blockedItem]));
	});

	for (const status of ["approved", "publishing"] as const) {
		it(`does not claim dispatch is clear when only ${status} work remains`, async () => {
			const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-active-"));
			roots.push(root);
			mkdirSync(join(root, "notes"));
			writeFileSync(join(root, "notes", "meeting.md"), markdown("Active meeting", "2026-09-03", "active"));
			const config = makeConfig(root);
			const now = Date.parse("2026-09-04T12:00:00.000Z");
			const result = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const service = yield* MeetingPublicationService;
						const store = yield* MeetingPublicationStore;
						const review = yield* MeetingPublicationReviewServer;
						yield* service.scan();
						const item = (yield* store.list())[0];
						if (item === undefined) return yield* Effect.die("missing item");
						yield* service.approve(item.itemId, item.sourceHash);
						if (status === "publishing") {
							yield* store.claimExact(
								item.itemId,
								item.sourceHash,
								new Date(now).toISOString(),
								new Date(now + 60_000).toISOString(),
							);
						}
						const token = readFileSync(
							join(config.statePath as string, "meeting-publication-v2-review.token"),
							"utf8",
						).trim();
						const exchange = yield* Effect.promise(() =>
							call(review.address.origin, `/exchange?token=${encodeURIComponent(token)}`),
						);
						const before = readFileSync(store.dbPath);
						const inbox = yield* Effect.promise(() => call(review.address.origin, "/", cookieFrom(exchange)));
						return { inbox, before, after: readFileSync(store.dbPath), item: yield* store.get(item.itemId) };
					}).pipe(Effect.provide(makeLayer(config, now))),
				),
			);
			expect(result.item?.status).toBe(status);
			expect(result.inbox.status).toBe(200);
			expect(result.inbox.body).toContain("No meetings are waiting for review");
			expect(result.inbox.body).toContain("See queue status below for dispatch progress.");
			expect(result.inbox.body).not.toContain("queue is clear");
			expect(result.inbox.body).toContain(
				`<span>${status === "approved" ? "Approved" : "Publishing"}</span><strong>1</strong>`,
			);
			expect(result.after.equals(result.before)).toBe(true);
		});
	}
});
