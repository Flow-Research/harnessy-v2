import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
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

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	type MeetingPublicationWriteGrant,
	validateMeetingPublicationWriteGrant,
} from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import { MEETING_PUBLICATION_FULL_REVIEW_OPERATIONS } from "../src/jarvis/meeting-publication/operational-input.ts";
import {
	type MeetingPublicationReviewRuntimeHost,
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
	options: { readonly reviewPort?: number; readonly runtimeMode?: "bounded" | "long_running" } = {},
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
				yield* MeetingPublicationStore;
				return yield* source.read(notePath);
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
	return { started, signalStarted };
};

const providerFactory = (
	fixture: Awaited<ReturnType<typeof setup>>,
	options: { readonly googleGate?: ReturnType<typeof makeGate> } = {},
) => {
	const calls = {
		make: 0,
		google: [] as Array<{ readonly itemId: string; readonly sourceHash: string }>,
		googleCompleted: 0,
		discord: [] as Array<{ readonly itemId: string; readonly sourceHash: string; readonly purpose: string }>,
		notifications: 0,
		closed: 0,
	};
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
							preflight: Effect.succeed(true),
							upsert: (request, grant) =>
								Effect.gen(function* () {
									yield* validate(grant, "provider_google", request);
									calls.google.push({ itemId: request.itemId, sourceHash: request.sourceHash });
									options.googleGate?.signalStarted();
									if (options.googleGate !== undefined) {
										yield* Effect.never;
									}
									calls.googleCompleted += 1;
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
							preflight: Effect.succeed(true),
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
) => {
	let publishAddress: ((address: { readonly origin: string }) => void) | undefined;
	const address = new Promise<{ readonly origin: string }>((resolve) => {
		publishAddress = resolve;
	});
	const host: MeetingPublicationReviewRuntimeHost = {
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
		expect(provider.calls.notifications).toBe(0);
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
