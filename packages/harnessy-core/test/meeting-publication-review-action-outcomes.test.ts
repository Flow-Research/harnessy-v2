import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import type { MeetingPublicationWriteOperation } from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import {
	type MeetingPublicationItem,
	MeetingPublicationProviderError,
} from "../src/jarvis/meeting-publication/models.ts";
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

// In-process review server over a fixture source directory and a temporary
// SQLite store. Providers are in-memory fakes; nothing here spawns a process.

const roots: Array<string> = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		chmodSync(join(root, "notes"), 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});

const note = (fingerprint: string, summary = "We aligned on the release.") => `# Weekly Sync ${fingerprint}

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: ${fingerprint}

## Executive Summary
${summary}

## Meeting Purpose
Ship the safe publication foundation.
`;

const makeConfig = (root: string) =>
	new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 1_000_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 600,
		reviewMaxSessions: 4,
		reviewMaxBodyBytes: 1_000_000,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

type ServiceShape = MeetingPublicationService["Service"];

interface Harness {
	readonly origin: string;
	readonly session: string;
	readonly csrf: string;
	readonly items: Record<string, MeetingPublicationItem>;
	readonly store: MeetingPublicationStore["Service"];
	readonly service: ServiceShape;
	readonly writes: Array<MeetingPublicationWriteOperation>;
	readonly calls: { google: number; discord: number };
}

const fixtureLayers = (
	config: JarvisMeetingPublicationConfig,
	writes: Array<MeetingPublicationWriteOperation>,
	calls: Harness["calls"],
	denied: ReadonlySet<MeetingPublicationWriteOperation>,
	override: Partial<ServiceShape>,
) => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config, {
		allows: (operation) => !denied.has(operation),
		onAuthorize: (operation) => {
			if (operation !== "review_serve") writes.push(operation);
		},
	});
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(
			MeetingPublicationClock,
			MeetingPublicationClock.of({ now: Effect.succeed(Date.parse("2026-09-04T12:00:00.000Z")) }),
		),
		Layer.succeed(
			MeetingPublicationGoogle,
			MeetingPublicationGoogle.of({
				preflight: Effect.succeed(true),
				upsert: (input) =>
					Effect.sync(() => {
						calls.google += 1;
						return new MeetingPublicationGoogleCheckpoint({
							docId: `doc-${input.itemId}`,
							docUrl: `https://docs.example.test/${input.itemId}`,
						});
					}),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationDiscord,
			MeetingPublicationDiscord.of({
				preflight: Effect.succeed(true),
				upsert: (input) =>
					Effect.sync(() => {
						calls.discord += 1;
						return new MeetingPublicationDiscordCheckpoint({
							channelId: "channel-id",
							messageId: `message-${input.itemId}`,
						});
					}),
				close: Effect.void,
			}),
		),
		Layer.succeed(
			MeetingPublicationNotifier,
			MeetingPublicationNotifier.of({ notify: () => Effect.succeed(true), close: Effect.void }),
		),
	);
	const base = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
	// The review server sees the overridden service; the test body and the store
	// share the same memoized base instances.
	const reviewed = Layer.effect(
		MeetingPublicationService,
		Effect.gen(function* () {
			const real = yield* MeetingPublicationService;
			return MeetingPublicationService.of({ ...real, ...override });
		}),
	).pipe(Layer.provide(base));
	let counter = 0;
	const random = Layer.succeed(
		MeetingPublicationReviewRandom,
		MeetingPublicationReviewRandom.of({
			bytes: (length) =>
				Effect.sync(() => createHash("sha256").update(`outcome-random-${counter++}`).digest().subarray(0, length)),
		}),
	);
	return MeetingPublicationReviewServer.layer(config).pipe(
		Layer.provide(reviewed),
		Layer.provideMerge(Layer.merge(base, random)),
	);
};

interface HttpResult {
	readonly status: number;
	readonly location: string | undefined;
	readonly cookie: string | undefined;
	readonly body: string;
}

const call = (origin: string, path: string, cookie?: string, body?: string) =>
	new Promise<HttpResult>((resolveRequest, rejectRequest) => {
		const target = new URL(origin);
		const headers: Record<string, string> = { Host: target.host };
		if (cookie !== undefined) headers.Cookie = cookie;
		if (body !== undefined) {
			headers.Origin = origin;
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			headers["Content-Length"] = String(Buffer.byteLength(body));
		}
		const outgoing = request(
			{ hostname: target.hostname, port: target.port, path, method: body === undefined ? "GET" : "POST", headers },
			(response) => {
				const chunks: Array<Buffer> = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => {
					const setCookie = response.headers["set-cookie"]?.[0];
					resolveRequest({
						status: response.statusCode ?? 0,
						location: response.headers.location,
						cookie: setCookie?.split(";", 1)[0],
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		outgoing.setTimeout(3_000, () => outgoing.destroy(new Error("request timeout")));
		outgoing.on("error", rejectRequest);
		outgoing.end(body);
	});

const withReview = <A>(
	notes: Record<string, string>,
	run: (harness: Harness) => Promise<A>,
	options: {
		readonly denied?: ReadonlyArray<MeetingPublicationWriteOperation>;
		readonly override?: Partial<ServiceShape>;
	} = {},
) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-outcome-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	for (const [name, markdown] of Object.entries(notes)) writeFileSync(join(root, "notes", `${name}.md`), markdown);
	const config = makeConfig(root);
	const writes: Array<MeetingPublicationWriteOperation> = [];
	const calls = { google: 0, discord: 0 };
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const service = yield* MeetingPublicationService;
				const store = yield* MeetingPublicationStore;
				const review = yield* MeetingPublicationReviewServer;
				yield* service.scan();
				const items: Record<string, MeetingPublicationItem> = {};
				for (const item of yield* store.list()) {
					const name = Object.keys(notes).find((key) => item.notePath.endsWith(`${key}.md`));
					if (name !== undefined) items[name] = item;
				}
				const token = readFileSync(
					join(config.statePath as string, "meeting-publication-v2-review.token"),
					"utf8",
				).trim();
				const origin = review.address.origin;
				const exchange = yield* Effect.promise(() => call(origin, `/exchange?token=${token}`));
				const session = exchange.cookie;
				if (session === undefined) return yield* Effect.die("missing session");
				const inbox = yield* Effect.promise(() => call(origin, "/", session));
				const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(inbox.body)?.[1];
				if (csrf === undefined) return yield* Effect.die("missing csrf");
				writes.length = 0;
				return yield* Effect.promise(() => run({ origin, session, csrf, items, store, service, writes, calls }));
			}).pipe(
				Effect.provide(fixtureLayers(config, writes, calls, new Set(options.denied ?? []), options.override ?? {})),
			),
		),
	);
};

const submit = (
	harness: Harness,
	action: "approve" | "reject" | "archive" | "update-note",
	item: MeetingPublicationItem,
	fields: Record<string, string> = {},
) => {
	const values: Record<string, string> = {
		csrf: harness.csrf,
		item_id: item.itemId,
		source_hash: item.sourceHash,
		...(action === "approve" ? { purpose: "Owner reviewed purpose." } : {}),
		...fields,
	};
	return call(harness.origin, `/${action}/${item.itemId}`, harness.session, new URLSearchParams(values).toString());
};

const current = async (harness: Harness, item: MeetingPublicationItem) => {
	const found = await Effect.runPromise(harness.store.get(item.itemId));
	if (found === null) throw new Error("missing item");
	return found;
};

const required = (items: Record<string, MeetingPublicationItem>, name: string) => {
	const item = items[name];
	if (item === undefined) throw new Error(`missing fixture item ${name}`);
	return item;
};

const captureLog = () => {
	const lines: Array<string> = [];
	vi.spyOn(console, "error").mockImplementation((...values: Array<unknown>) => {
		lines.push(values.map(String).join(" "));
	});
	return lines;
};

describe("meeting review action outcomes", () => {
	it("answers a repeated decision with its current status and performs no second write", async () => {
		const result = await withReview({ a: note("a"), r: note("r"), x: note("x") }, async (harness) => {
			const [a, r, x] = [required(harness.items, "a"), required(harness.items, "r"), required(harness.items, "x")];
			const outcomes = [];
			for (const [action, item] of [
				["approve", a],
				["reject", r],
				["archive", x],
			] as const) {
				const first = await submit(harness, action, item);
				const writesAfterFirst = harness.writes.length;
				const second = await submit(harness, action, item);
				outcomes.push({
					action,
					first,
					second,
					secondWrites: harness.writes.slice(writesAfterFirst),
					after: await current(harness, item),
				});
			}
			return outcomes;
		});
		const expected = {
			approve: ["Already approved", "This meeting was already approved. No further action was taken.", "approved"],
			reject: ["Already rejected", "This meeting was already rejected. No further action was taken.", "rejected"],
			archive: ["Already archived", "This meeting was already archived. No further action was taken.", "archived"],
		} as const;
		for (const outcome of result) {
			const [heading, sentence, status] = expected[outcome.action];
			expect(outcome.first.status).toBe(303);
			expect(outcome.second.status).toBe(200);
			expect(outcome.second.body).toContain(`<h1>${heading}</h1>`);
			expect(outcome.second.body).toContain(sentence);
			expect(outcome.second.body).not.toContain("Review changed");
			expect(outcome.secondWrites).toEqual([]);
			expect(outcome.after.status).toBe(status);
		}
	});

	it("treats a repeated edited approval and a later published state as already handled", async () => {
		const result = await withReview({ a: note("a") }, async (harness) => {
			const a = required(harness.items, "a");
			const edited = note("a", "Reviewer edited summary.").replaceAll("\n", "\r\n");
			const first = await submit(harness, "approve", a, { meeting_markdown: edited });
			const writesAfterFirst = harness.writes.length;
			const second = await submit(harness, "approve", a, { meeting_markdown: edited });
			const secondWrites = harness.writes.slice(writesAfterFirst);
			const otherPurpose = await submit(harness, "approve", a, {
				meeting_markdown: edited,
				purpose: "A different decision.",
			});
			await Effect.runPromise(harness.service.worker(1));
			const published = await current(harness, a);
			const third = await submit(harness, "approve", a, { meeting_markdown: edited });
			return { first, second, secondWrites, published, third, otherPurpose };
		});
		expect(result.first.status).toBe(303);
		expect(result.second.status).toBe(200);
		expect(result.second.body).toContain("<h1>Already approved</h1>");
		expect(result.secondWrites).toEqual([]);
		expect(result.published.status).toBe("published");
		expect(result.third.status).toBe(200);
		expect(result.third.body).toContain("This meeting was already published. No further action was taken.");
		expect(result.otherPurpose.status).toBe(409);
		expect(result.otherPurpose.body).toContain(
			"This meeting was already approved, so its note can no longer be edited",
		);
	});

	it("keeps stale and no-longer-allowed decisions as 409 and names the current status", async () => {
		const result = await withReview({ a: note("a"), b: note("b") }, async (harness) => {
			const [a, b] = [required(harness.items, "a"), required(harness.items, "b")];
			const staleHash = await submit(harness, "approve", a, { source_hash: "0".repeat(64) });
			await submit(harness, "approve", b);
			const rejectApproved = await submit(harness, "reject", b);
			return { staleHash, rejectApproved, a: await current(harness, a), b: await current(harness, b) };
		});
		expect(result.staleHash.status).toBe(409);
		expect(result.staleHash.body).toContain("<h1>Review changed</h1>");
		expect(result.staleHash.body).toContain("The meeting note changed after this page was loaded.");
		expect(result.a.status).toBe("pending_review");
		expect(result.rejectApproved.status).toBe(409);
		expect(result.rejectApproved.body).toContain("This meeting was already approved. Reload the item");
		expect(result.b.status).toBe("approved");
	});

	it("rejects invalid reviewer input with 422 and a specific message, without saving", async () => {
		const result = await withReview({ a: note("a") }, async (harness) => {
			const a = required(harness.items, "a");
			const purpose = await submit(harness, "approve", a, { purpose: "See https://example.test now" });
			const tooLong = await submit(harness, "update-note", a, {
				meeting_markdown: note("a", "x".repeat(50_001)),
			});
			const identity = await submit(harness, "update-note", a, { meeting_markdown: note("renamed") });
			const empty = await submit(harness, "approve", a, { meeting_markdown: "   " });
			return {
				purpose,
				tooLong,
				identity,
				empty,
				note: readFileSync(a.notePath, "utf8"),
				after: await current(harness, a),
			};
		});
		expect(result.purpose.status).toBe(422);
		expect(result.purpose.body).toContain("<h1>Check the Discord purpose</h1>");
		expect(result.purpose.body).toContain("without links, Markdown symbols or control characters");
		expect(result.tooLong.status).toBe(422);
		expect(result.tooLong.body).toContain("The edited meeting note is longer than 50000 characters.");
		expect(result.tooLong.body).toContain("The note was not saved.");
		expect(result.identity.status).toBe(422);
		expect(result.identity.body).toContain("Keep the Project and Fingerprint metadata lines unchanged.");
		expect(result.empty.status).toBe(422);
		expect(result.empty.body).toContain("The edited meeting note is empty. Nothing was saved or approved.");
		expect(result.note).toBe(note("a"));
		expect(result.after).toMatchObject({ status: "pending_review", approvedHash: null });
	});

	it("reports an authority denial as paused publication with guidance and a safe log code", async () => {
		const log = captureLog();
		const result = await withReview(
			{ a: note("a") },
			async (harness) => {
				const a = required(harness.items, "a");
				return { response: await submit(harness, "reject", a), after: await current(harness, a) };
			},
			{ denied: ["store_reject"] },
		);
		expect(result.response.status).toBe(503);
		expect(result.response.body).toContain("<h1>Publication is paused</h1>");
		expect(result.response.body).toContain("does not currently hold meeting publication write authority");
		expect(result.response.body).toContain("The decision was not recorded.");
		expect(result.after.status).toBe("pending_review");
		expect(log).toEqual(["meeting-review action=reject outcome=paused code=authority:revoked"]);
	});

	it("reports an in-progress or uncertain delivery as paused publication", async () => {
		const log = captureLog();
		const result = await withReview({ a: note("a"), b: note("b") }, async (harness) => {
			const [a, b] = [required(harness.items, "a"), required(harness.items, "b")];
			await submit(harness, "approve", a);
			const now = "2026-09-04T12:00:00.000Z";
			const claimed = await Effect.runPromise(harness.store.claim(now, "2026-09-04T12:01:00.000Z"));
			if (claimed === null) throw new Error("claim failed");
			return { response: await submit(harness, "reject", b), after: await current(harness, b) };
		});
		expect(result.response.status).toBe(503);
		expect(result.response.body).toContain("<h1>Publication is paused</h1>");
		expect(result.response.body).toContain("A publication is in progress or its delivery outcome is uncertain");
		expect(result.after.status).toBe("pending_review");
		expect(log).toEqual(["meeting-review action=reject outcome=paused code=store:write_failed"]);
	});

	it("reports a provider reconnect requirement as paused publication without echoing provider text", async () => {
		const log = captureLog();
		const result = await withReview(
			{ a: note("a") },
			async (harness) => submit(harness, "approve", required(harness.items, "a")),
			{
				// approve's typed channel has no provider error; a provider failure can
				// only arrive untyped, which is how this fixture delivers it.
				override: {
					approve: () =>
						Effect.die(
							new MeetingPublicationProviderError({
								stage: "google",
								code: "reauth_required access_token=SECRET_PROVIDER_TOKEN",
								retryable: false,
								retryAfterSeconds: null,
							}),
						),
				},
			},
		);
		expect(result.status).toBe(503);
		expect(result.body).toContain("<h1>Publication is paused</h1>");
		expect(result.body).toContain("reconnect if it asks you to");
		expect(result.body).not.toContain("SECRET_PROVIDER_TOKEN");
		expect(log).toEqual(["meeting-review action=approve outcome=paused code=provider:google"]);
	});

	it("reports any other failure as 500 Unavailable and logs only an allow-listed code", async () => {
		const log = captureLog();
		const secret = "PRIVATE_NOTE_CONTENT token=SECRET_VALUE";
		const result = await withReview(
			{ a: note("a"), b: note("b") },
			async (harness) => {
				const [a, b] = [required(harness.items, "a"), required(harness.items, "b")];
				const defect = await submit(harness, "archive", a);
				chmodSync(join(b.notePath), 0o000);
				const unreadable = await submit(harness, "reject", b);
				chmodSync(join(b.notePath), 0o600);
				return { defect, unreadable, a: await current(harness, a), b: await current(harness, b) };
			},
			{ override: { archive: () => Effect.die(new Error(secret)) } },
		);
		for (const response of [result.defect, result.unreadable]) {
			expect(response.status).toBe(500);
			expect(response.body).toContain("<h1>Unavailable</h1>");
			expect(response.body).not.toContain("Review changed");
			expect(response.body).not.toContain(secret);
		}
		expect(result.a.status).toBe("pending_review");
		expect(result.b.status).toBe("pending_review");
		expect(log).toEqual([
			"meeting-review action=archive outcome=unavailable code=unexpected",
			"meeting-review action=reject outcome=unavailable code=source:read_error",
		]);
		expect(log.join("\n")).not.toContain("SECRET");
	});
});
