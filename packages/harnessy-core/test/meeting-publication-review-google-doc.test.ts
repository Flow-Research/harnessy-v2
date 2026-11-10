import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	MeetingPublicationReviewRandom,
	MeetingPublicationReviewServer,
} from "../src/jarvis/meeting-publication/review.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const markdown = `# Weekly review

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: review-doc

## Executive Summary
Release decisions.

## Meeting Purpose
Agree on release ownership.

## Actions
- Keep the complete note in the document.
`;

describe("meeting review Google Doc action", () => {
	it.each([
		"success",
		"landing",
		"landing-stale",
		"landing-unreadable",
		"landing-long",
		"landing-reject",
		"landing-approve",
		"landing-approve-stale",
		"landing-approve-csrf",
		"landing-reject-stale",
		"landing-reject-csrf",
		"csrf",
		"origin",
		"session",
		"stale",
		"approved",
		"unsafe-link",
		"provider-failure",
		"decision-only",
		"unsupported",
		"unsaved-fields",
		"get",
		...(process.env.HARNESSY_RECONNECT_BROWSER === "1"
			? ["browser" as const, "browser-landing" as const, "browser-reject" as const, "browser-approve" as const]
			: []),
	] as const)("preserves publication boundaries for %s", async (variant) => {
		const root = mkdtempSync(join(realpathSync(tmpdir()), "hsy-review-doc-"));
		roots.push(root);
		mkdirSync(join(root, "notes"));
		const notePath = join(root, "notes", "meeting.md");
		const canonical =
			variant === "landing-long"
				? markdown.replace(
						"Release decisions.",
						`<script>alert(1)</script> **Àlàáfíà** ${"🧪".repeat(650)} END_PRIVATE_TAIL`,
					)
				: markdown;
		writeFileSync(notePath, canonical);
		const config = new JarvisMeetingPublicationConfig({
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
			reviewMaxBodyBytes: 4096,
			googleOwnerEmail: "owner@example.test",
			googleDriveFolder: "folder-id",
			discordChannelId: "channel-id",
		});
		const calls: Array<{ itemId: string; hash: string }> = [];
		let publicationCalls = 0;
		const approvals: Array<{ itemId: string; hash: string; purpose: string | undefined }> = [];
		const authority = meetingPublicationTestWriteAuthorityLayer(config);
		const dependencies = Layer.mergeAll(
			authority,
			MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
			MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
			MeetingPublicationClock.testLayer(Date.parse("2026-09-04T12:00:00.000Z")),
			MeetingPublicationReviewRandom.liveLayer,
			Layer.succeed(
				MeetingPublicationGoogle,
				MeetingPublicationGoogle.of({
					preflight: Effect.succeed(true),
					close: Effect.void,
					upsert: () =>
						Effect.sync(() => {
							publicationCalls++;
							throw new Error("Publication must not run");
						}),
				}),
			),
			Layer.succeed(
				MeetingPublicationDiscord,
				MeetingPublicationDiscord.of({
					preflight: Effect.succeed(true),
					close: Effect.void,
					upsert: () =>
						Effect.sync(() => {
							publicationCalls++;
							throw new Error("Discord must not run");
						}),
				}),
			),
			Layer.succeed(
				MeetingPublicationNotifier,
				MeetingPublicationNotifier.of({ notify: () => Effect.succeed(true), close: Effect.void }),
			),
		);
		const realService = MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies));
		const service = Layer.effect(
			MeetingPublicationService,
			Effect.gen(function* () {
				const original = yield* MeetingPublicationService;
				return MeetingPublicationService.of({
					...original,
					approve: (itemId, hash, purpose) => {
						approvals.push({ itemId, hash, purpose });
						return original.approve(itemId, hash, purpose);
					},
					generateGoogleDoc:
						variant === "unsupported"
							? undefined
							: (itemId, hash) => {
									calls.push({ itemId, hash });
									return variant === "provider-failure"
										? Effect.fail(
												new MeetingPublicationProviderError({
													stage: "google",
													code: "delivery_uncertain",
													retryable: false,
													retryAfterSeconds: null,
												}),
											)
										: Effect.succeed(
												new MeetingPublicationGoogleCheckpoint({
													docId: "doc_123",
													docUrl:
														variant === "unsafe-link"
															? "javascript:alert(1)"
															: "https://docs.google.com/document/d/doc_123/edit",
												}),
											);
								},
				});
			}),
		).pipe(Layer.provideMerge(realService));
		const layer = MeetingPublicationReviewServer.layer(
			config,
			variant === "decision-only" ? "decision_only" : "full",
		).pipe(Layer.provideMerge(service));
		const result = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const publication = yield* MeetingPublicationService;
					const store = yield* MeetingPublicationStore;
					const server = yield* MeetingPublicationReviewServer;
					yield* publication.scan();
					const item = (yield* store.list())[0]!;
					const origin = server.address.origin;
					const token = readFileSync(
						join(config.statePath!, "meeting-publication-v2-review.token"),
						"utf8",
					).trim();
					if (variant.startsWith("browser")) {
						const before = yield* store.get(item.itemId);
						yield* Effect.promise(() =>
							promisify(execFile)(
								process.execPath,
								[
									join(process.cwd(), "../../scripts/check-meeting-review-concurrency-browser.mjs"),
									`${origin}/exchange?token=${token}`,
									item.itemId,
									variant === "browser-reject"
										? "reject"
										: variant === "browser-approve"
											? "approve"
											: "generate-google-doc",
									variant === "browser" ? "item" : "inbox",
								],
								{ env: process.env, timeout: 30_000 },
							),
						);
						return { page: "", item, before, after: yield* store.get(item.itemId), status: 200, body: "" };
					}
					const exchange = yield* Effect.promise(() =>
						fetch(`${origin}/exchange?token=${token}`, { redirect: "manual" }),
					);
					const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
					if (variant === "landing-unreadable")
						writeFileSync(notePath, markdown.replace("Release decisions.", "Changed source."));
					const inbox = yield* Effect.promise(async () =>
						(await fetch(`${origin}/`, { headers: { Cookie: cookie } })).text(),
					);
					if (variant.startsWith("landing")) {
						if (variant === "landing-unreadable") {
							expect(inbox).not.toContain(`action="/approve/${item.itemId}"`);
							expect(inbox).toContain("The saved note changed or could not be read");
							expect(inbox).not.toContain(`action="/generate-google-doc/${item.itemId}"`);
							expect(inbox).not.toContain(`action="/reject/${item.itemId}"`);
						} else {
							expect(inbox).toContain("Executive summary preview");
							expect(inbox).toContain("full saved meeting note, not just this preview");
							expect(inbox).toContain('<details class="quick-reject">');
							expect(inbox).toContain('<details class="quick-accept">');
							expect(inbox).toContain('name="purpose" value="Agree on release ownership."');
							expect(inbox).toContain("publication worker to send to Google Docs and Discord");
						}
						if (variant === "landing-long") {
							expect(inbox).toContain("Showing the first 600 characters");
							expect(inbox).toContain("&lt;script&gt;");
							expect(inbox).not.toContain("<script>");
							expect(inbox).not.toContain("END_PRIVATE_TAIL");
						}
					}
					const page = yield* Effect.promise(async () =>
						(await fetch(`${origin}/item/${item.itemId}`, { headers: { Cookie: cookie } })).text(),
					);
					const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(
						variant.startsWith("landing") ? inbox : page,
					)![1]!;
					if (
						variant === "stale" ||
						variant === "landing-stale" ||
						variant === "landing-reject-stale" ||
						variant === "landing-approve-stale"
					)
						writeFileSync(notePath, markdown.replace("Release decisions.", "Changed source."));
					if (variant === "approved") yield* publication.approve(item.itemId, item.sourceHash);
					const before = yield* store.get(item.itemId);
					const body = new URLSearchParams({
						csrf:
							variant === "csrf" || variant === "landing-reject-csrf" || variant === "landing-approve-csrf"
								? "invalid"
								: csrf,
						item_id: item.itemId,
						source_hash: item.sourceHash,
					});
					if (variant.startsWith("landing-approve"))
						body.set("purpose", /name="purpose" value="([^"]+)"/u.exec(inbox)![1]!);
					if (variant === "unsaved-fields") body.set("meeting_markdown", "unsaved edit");
					const response = yield* Effect.promise(() =>
						fetch(
							`${origin}/${variant.startsWith("landing-reject") ? "reject" : variant.startsWith("landing-approve") ? "approve" : "generate-google-doc"}/${item.itemId}`,
							{
								method: variant === "get" ? "GET" : "POST",
								redirect: "manual",
								headers: {
									Cookie: variant === "session" ? "" : cookie,
									Origin: variant === "origin" ? "https://attacker.test" : origin,
									"Content-Type": "application/x-www-form-urlencoded",
								},
								...(variant === "get" ? {} : { body: body.toString() }),
							},
						),
					);
					return {
						page,
						item,
						before,
						after: yield* store.get(item.itemId),
						status: response.status,
						body: yield* Effect.promise(() => response.text()),
					};
				}),
			).pipe(Effect.provide(layer)),
		);
		const expected = {
			browser: 200,
			"browser-landing": 200,
			"browser-reject": 200,
			"browser-approve": 200,
			"landing-approve": 303,
			"landing-approve-stale": 409,
			"landing-approve-csrf": 403,
			landing: 200,
			"landing-long": 200,
			"landing-stale": 409,
			"landing-unreadable": 409,
			"landing-reject": 303,
			"landing-reject-stale": 409,
			"landing-reject-csrf": 403,
			success: 200,
			csrf: 403,
			origin: 403,
			session: 401,
			stale: 409,
			approved: 409,
			"unsafe-link": 503,
			"provider-failure": 503,
			"decision-only": 404,
			unsupported: 404,
			"unsaved-fields": 400,
			get: 404,
		};
		expect(result.status).toBe(expected[variant]);
		expect(publicationCalls).toBe(0);
		if (variant === "landing-reject" || variant === "browser-reject") expect(result.after?.status).toBe("rejected");
		else if (variant === "landing-approve" || variant === "browser-approve") {
			expect(result.after?.status).toBe("approved");
			expect(result.after?.approvedHash).toBe(result.item.sourceHash);
			expect(approvals).toEqual([
				{ itemId: result.item.itemId, hash: result.item.sourceHash, purpose: "Agree on release ownership." },
			]);
		} else if (variant !== "landing-reject-stale" && variant !== "landing-approve-stale")
			expect(result.after).toEqual(result.before);
		else expect(result.after?.status).toBe("pending_review");
		expect(calls).toEqual(
			[
				"success",
				"landing",
				"landing-long",
				"unsafe-link",
				"provider-failure",
				"browser",
				"browser-landing",
			].includes(variant)
				? [{ itemId: result.item.itemId, hash: result.item.sourceHash }]
				: [],
		);
		if (variant.startsWith("browser") || variant.startsWith("landing")) return;
		if (variant === "decision-only" || variant === "unsupported")
			expect(result.page).not.toContain("Generate Google Doc");
		else {
			expect(result.page).toContain("Generate Google Doc");
			expect(result.page).toContain("use Update meeting note before generating");
			expect(result.page).toContain("configured Google account and folder permissions");
		}
		if (variant === "success") {
			expect(result.body).toContain(
				'href="https://docs.google.com/document/d/doc_123/edit" target="_blank" rel="noopener noreferrer"',
			);
			expect(result.body).toContain("The meeting remains unapproved. Nothing was sent to Discord.");
		}
		if (variant === "unsafe-link") expect(result.body).not.toContain("javascript:");
		if (variant === "provider-failure") expect(result.body).toContain("automatic retries are paused");
	});
});
