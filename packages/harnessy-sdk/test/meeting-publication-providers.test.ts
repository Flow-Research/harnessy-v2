import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";
import { AuthTemplateSlug, ConnectionName, createExecutor, IntegrationSlug } from "@executor-js/sdk/core";
import { Effect, Layer, Result } from "effect";

import { makeTestConfig } from "../../../executor/packages/core/sdk/src/test-config.ts";
import { JarvisMeetingPublicationConfig } from "../../harnessy-core/src/jarvis/config-model.ts";
import {
	MeetingPublicationWriteAuthority,
	type MeetingPublicationWriteGrant,
	type MeetingPublicationWriteOperation,
	resolveMeetingPublicationWriteBinding,
} from "../../harnessy-core/src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../../harnessy-core/src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationSource } from "../../harnessy-core/src/jarvis/meeting-publication/notes.ts";
import {
	MeetingPublicationClock,
	MeetingPublicationDiscord,
	MeetingPublicationGoogle,
	MeetingPublicationNotifier,
	MeetingPublicationService,
} from "../../harnessy-core/src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../../harnessy-core/src/jarvis/meeting-publication/store.ts";
import { harnessyEngineHandle } from "../src/engine/adapter.ts";
import type { HarnessyEngineHandle } from "../src/engine/compose.ts";
import {
	guardedMeetingPublicationFetch,
	withMeetingPublicationMutationGuard,
} from "../src/meeting-publication/mutation-guard.ts";
import { localMeetingPublicationNotifierLayer } from "../src/meeting-publication/notifier.ts";
import {
	engineMeetingPublicationDiscordLayer,
	engineMeetingPublicationGoogleLayer,
} from "../src/meeting-publication/providers.ts";
import {
	type MeetingProviderTransportConfig,
	parseRetryAfterSeconds,
	resolveMeetingProviderTransport,
} from "../src/meeting-publication/transport.ts";
import {
	DISCORD_MEETING_AUTH_TEMPLATE,
	DISCORD_MEETING_INTEGRATION,
	discordMeetingPublicationPlugin,
	formatDiscordMeetingMessage,
} from "../src/plugins/discord-meeting-publication.ts";
import {
	GOOGLE_MEETING_INTEGRATION,
	GOOGLE_MEETING_TEST_AUTH_TEMPLATE,
	googleMeetingPublicationPlugin,
} from "../src/plugins/google-meeting-publication.ts";
import {
	type FailureResponse,
	makeWireState,
	nonceFrom,
	startWireServer,
	type WireState,
} from "./support/meeting-provider-wire.ts";

const roots: Array<string> = [];
interface ProviderParityFixture {
	readonly providerCases: {
		readonly httpFailures: ReadonlyArray<{
			readonly id: string;
			readonly status: number;
			readonly code: string;
			readonly retryable: boolean;
			readonly retryAfter?: string;
			readonly retryAfterSeconds: number | null;
		}>;
		readonly retryPolicy: {
			readonly providerMaxAttempts: number | null;
			readonly terminalAttemptSchedulesRetry: boolean;
		};
		readonly unsafeLoopbackOrigins: ReadonlyArray<string>;
		readonly discordContent: {
			readonly maxCodePoints: number;
			readonly maxBytes: number;
			readonly escapesMarkupBeforeMeasuring: boolean;
		};
	};
}
const providerParity = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "../../harnessy-core/fixtures/jarvis-v1/meeting-publication-parity.json"),
		"utf8",
	),
) as ProviderParityFixture;

const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-meeting-providers-"));
	roots.push(root);
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

interface EngineTestContext {
	readonly handle: HarnessyEngineHandle;
	readonly approveGooglePolicy: Effect.Effect<void, unknown>;
	readonly credentialDirectory: string;
	readonly executorDbPath: string;
	readonly globalElicitations: { count: number };
}

const withEngine = <A>(
	root: string,
	transport: MeetingProviderTransportConfig,
	use: (context: EngineTestContext) => Effect.Effect<A, unknown>,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const credentialDirectory = join(root, "credentials");
			const executorDirectory = join(root, "executor");
			const plugins = [
				googleMeetingPublicationPlugin({ transport }),
				discordMeetingPublicationPlugin({ transport }),
				fileSecretsPlugin({ directory: credentialDirectory }),
			] as const;
			const config = makeTestConfig({ plugins, dataDir: executorDirectory, subject: null });
			yield* Effect.acquireRelease(
				Effect.promise(async () => {
					await config.testDb.warm();
					return config.testDb;
				}),
				(testDb) => Effect.promise(() => testDb.close()),
			);
			const globalElicitations = { count: 0 };
			const executor = yield* Effect.acquireRelease(
				createExecutor({
					...config,
					onElicitation: () => {
						globalElicitations.count += 1;
						return Effect.succeed({ action: "decline" as const });
					},
				}),
				(resource) => resource.close().pipe(Effect.orDie),
			);
			yield* executor["harnessy-google-meeting-publication"].register();
			yield* executor["harnessy-discord-meeting-publication"].register();
			yield* executor.connections.create({
				owner: "org",
				integration: IntegrationSlug.make(GOOGLE_MEETING_INTEGRATION),
				name: ConnectionName.make("meetings-google"),
				template: AuthTemplateSlug.make(GOOGLE_MEETING_TEST_AUTH_TEMPLATE),
				values: { token: "GOOGLE_TOKEN_SENTINEL" },
			});
			yield* executor.connections.create({
				owner: "org",
				integration: IntegrationSlug.make(DISCORD_MEETING_INTEGRATION),
				name: ConnectionName.make("meetings-discord"),
				template: AuthTemplateSlug.make(DISCORD_MEETING_AUTH_TEMPLATE),
				values: { token: "DISCORD_TOKEN_SENTINEL" },
			});
			const handle = harnessyEngineHandle(executor);
			return yield* use({
				handle,
				approveGooglePolicy: executor.policies
					.create({
						owner: "org",
						pattern: `${GOOGLE_MEETING_INTEGRATION}.*.*.upsert`,
						action: "approve",
					})
					.pipe(Effect.asVoid),
				credentialDirectory,
				executorDbPath: join(executorDirectory, "test.db"),
				globalElicitations,
			});
		}),
	);

const makeCoreConfig = (root: string, channelId: string) =>
	new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 64_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 900,
		reviewMaxSessions: 64,
		reviewMaxBodyBytes: 4_096,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "Published/Meetings",
		discordChannelId: channelId,
	});

const makeTestGrant = (
	config: JarvisMeetingPublicationConfig,
	operation: MeetingPublicationWriteOperation,
	item?: { readonly itemId: string; readonly sourceHash: string },
	options: { readonly isActive?: () => boolean } = {},
): Promise<MeetingPublicationWriteGrant> => {
	const authority = meetingPublicationTestWriteAuthorityLayer(config, options);
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* MeetingPublicationWriteAuthority;
			const baseBinding = yield* resolveMeetingPublicationWriteBinding(config, operation);
			const binding =
				item === undefined ? baseBinding : Object.freeze({ ...baseBinding, item: Object.freeze(item) });
			return yield* service.authorize(operation, binding);
		}).pipe(Effect.provide(authority)),
	);
};

const runProviderCore = <A>(
	root: string,
	wire: WireState,
	handle: HarnessyEngineHandle,
	now: { value: number },
	effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore>,
) => {
	const config = makeCoreConfig(root, wire.channelId);
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	const dependencies = Layer.mergeAll(
		authority,
		MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
		MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
		Layer.succeed(MeetingPublicationClock, MeetingPublicationClock.of({ now: Effect.sync(() => now.value) })),
		localMeetingPublicationNotifierLayer({ kind: "unavailable" }),
		engineMeetingPublicationGoogleLayer({
			handle,
			owner: "org",
			connection: "meetingsGoogle",
			expectedOwnerEmail: "owner@example.test",
			folderPath: "Published/Meetings",
		}),
		engineMeetingPublicationDiscordLayer({
			handle,
			owner: "org",
			connection: "meetingsDiscord",
			expectedChannelId: wire.channelId,
		}),
	);
	return Effect.scoped(
		effect.pipe(Effect.provide(MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies)))),
	);
};

const note = (summary: string, purpose: string) => `# Provider Integration Meeting

## Metadata
- Project: alpha
- Date: 2026-09-04
- Fingerprint: provider-integration

## Executive Summary
${summary}

## Meeting Purpose
${purpose}
`;

const readDirectoryText = (root: string): string =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"))
		.join("\n");

const failureFrom = (result: unknown) => {
	if (!isRecord(result) || result.ok !== false || !isRecord(result.error)) {
		throw new Error(`expected a safe tool failure, received ${JSON.stringify(result)}`);
	}
	const details = isRecord(result.error.details) ? result.error.details : {};
	return {
		code: result.error.code,
		status: result.error.status,
		retryable: result.error.retryable,
		retryAfterSeconds: details.retryAfterSeconds,
	};
};

const waitForFile = async (path: string) => {
	const deadline = Date.now() + 2_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for process fixture ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

const processIsRunning = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code !== "ESRCH";
	}
};

const googleUpsertArgs = (overrides: Readonly<Record<string, unknown>> = {}) => ({
	itemId: "a".repeat(24),
	sourceHash: "b".repeat(64),
	title: "Approved provider fixture",
	meetingDate: "2026-09-04",
	markdown: "# Approved provider fixture\n\nReviewed body.",
	existingDocId: null,
	expectedOwnerEmail: "owner@example.test",
	folderPath: "Published/Meetings",
	...overrides,
});

describe("meeting publication provider integrations", () => {
	it("publishes, checkpoints across restart, updates in place, and keeps sensitive bytes out of state", async () => {
		const root = makeRoot();
		mkdirSync(join(root, "notes"));
		const notePath = join(root, "notes", "meeting.md");
		const firstBody = note("NOTE_CONTENT_SENTINEL initial decision.", "PURPOSE_SENTINEL ship safely.");
		writeFileSync(notePath, firstBody);
		const wire = makeWireState();
		const server = await startWireServer(wire);
		wire.failures.push({
			method: "POST",
			path: `/channels/${wire.channelId}/messages`,
			status: 429,
			headers: { "retry-after": "invalid" },
			body: { message: "UPSTREAM_ERROR_BODY_SENTINEL", retry_after: 1 },
		});
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
			timeoutMillis: 2_000,
			maxResponseBytes: 32_000,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle, credentialDirectory, executorDbPath, globalElicitations }) =>
					Effect.gen(function* () {
						const directGooglePreflight = yield* Effect.result(
							handle.execute("tools.google-meeting-publication.org.meetingsGoogle.preflight", {
								expectedOwnerEmail: "owner@example.test",
							}),
						);
						const directDiscordPreflight = yield* Effect.result(
							handle.execute("tools.discord-meeting-publication.org.meetingsDiscord.preflight", {
								expectedChannelId: wire.channelId,
							}),
						);
						expect(directGooglePreflight._tag, JSON.stringify(directGooglePreflight)).toBe("Success");
						expect(directDiscordPreflight._tag, JSON.stringify(directDiscordPreflight)).toBe("Success");
						const config = makeCoreConfig(root, wire.channelId);
						const authority = meetingPublicationTestWriteAuthorityLayer(config);
						let now = Date.parse("2026-09-04T12:00:00.000Z");
						const dependencies = () =>
							Layer.mergeAll(
								authority,
								MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
								MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
								Layer.succeed(
									MeetingPublicationClock,
									MeetingPublicationClock.of({ now: Effect.sync(() => now) }),
								),
								localMeetingPublicationNotifierLayer({ kind: "unavailable" }),
								engineMeetingPublicationGoogleLayer({
									handle,
									owner: "org",
									connection: "meetingsGoogle",
									expectedOwnerEmail: "owner@example.test",
									folderPath: "Published/Meetings",
								}),
								engineMeetingPublicationDiscordLayer({
									handle,
									owner: "org",
									connection: "meetingsDiscord",
									expectedChannelId: wire.channelId,
								}),
							);
						const runCore = <A>(
							effect: Effect.Effect<A, unknown, MeetingPublicationService | MeetingPublicationStore>,
						) =>
							Effect.scoped(
								effect.pipe(
									Effect.provide(
										MeetingPublicationService.layer(config).pipe(Layer.provideMerge(dependencies())),
									),
								),
							);

						const first = yield* runCore(
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const store = yield* MeetingPublicationStore;
								const preflight = yield* service.preflight();
								const scan = yield* service.scan();
								const pending = yield* store.get(scan.itemIds[0] as string);
								if (pending === null) return yield* Effect.die("missing item");
								yield* service.approve(pending.itemId, pending.sourceHash);
								const result = yield* service.worker();
								return { preflight, result, item: yield* store.get(pending.itemId), itemId: pending.itemId };
							}),
						);
						expect(first.preflight.ready, JSON.stringify(first.preflight)).toBe(true);
						expect(first.result.failed).toBe(1);
						expect(first.item).toMatchObject({
							status: "approved",
							failureStage: "discord",
							googleSourceHash: first.item?.sourceHash,
						});
						const googleWritesAfterFailure = wire.requests.filter(
							(request) => request.method !== "GET" && !request.path.includes("/channels/"),
						).length;

						now += 2_000;
						const restarted = yield* runCore(
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const result = yield* service.worker();
								return { result, item: yield* (yield* MeetingPublicationStore).get(first.itemId) };
							}),
						);
						expect(restarted.result.published).toBe(1);
						expect(restarted.item?.status).toBe("published");
						expect(
							wire.requests.filter((request) => request.method !== "GET" && !request.path.includes("/channels/"))
								.length,
						).toBe(googleWritesAfterFailure);

						writeFileSync(
							notePath,
							note("NOTE_CONTENT_SENTINEL revised decision.", "PURPOSE_SENTINEL @everyone **revise** safely."),
						);
						now += 1_000;
						const updated = yield* runCore(
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const store = yield* MeetingPublicationStore;
								yield* service.scan();
								const pending = yield* store.get(first.itemId);
								if (pending === null) return yield* Effect.die("missing changed item");
								yield* service.approve(pending.itemId, pending.sourceHash);
								const result = yield* service.worker();
								return { result, item: yield* store.get(first.itemId) };
							}),
						);
						expect(updated.result.published).toBe(1);
						expect(updated.item?.googleDocId).toBe(restarted.item?.googleDocId);
						expect(updated.item?.discordMessageId).toBe(restarted.item?.discordMessageId);
						expect(wire.files.size).toBe(5);
						expect(wire.messagesByNonce.size).toBe(1);
						expect(
							wire.requests.filter(
								(request) => request.method === "POST" && /\/files\/[^/]+\/permissions$/u.test(request.path),
							),
						).toHaveLength(1);
						const discordCreates = wire.requests.filter(
							(request) => request.method === "POST" && request.path === `/channels/${wire.channelId}/messages`,
						);
						expect(discordCreates).toHaveLength(2);
						for (const request of discordCreates) {
							expect(request.body).toMatchObject({
								enforce_nonce: true,
								allowed_mentions: { parse: [] },
							});
						}
						const createNonces = discordCreates.map((request) => nonceFrom(request.body));
						expect(new Set(createNonces).size).toBe(1);
						expect(createNonces[0]).not.toBe(first.itemId);
						expect(createNonces.every((nonce) => nonce.length > 0 && nonce.length <= 25)).toBe(true);
						const message = [...wire.messagesByNonce.values()][0];
						expect(message?.content).toContain("\\@everyone");
						expect(message?.content).not.toContain(" @everyone");
						expect(message?.content).toContain(
							`https://docs.google.com/document/d/${updated.item?.googleDocId}/view`,
						);
						expect(message?.content).not.toContain("NOTE_CONTENT_SENTINEL");
						const googleBatchBodies = wire.requests
							.filter((request) => request.method === "POST" && request.path.endsWith(":batchUpdate"))
							.map((request) => JSON.stringify(request.body));
						expect(googleBatchBodies).toHaveLength(2);
						expect(googleBatchBodies[1]).toContain("deleteContentRange");
						expect(googleBatchBodies[1]).toContain("revised decision");
						for (const request of wire.requests) {
							expect(request.authorization).toBe(
								request.path.startsWith("/channels/") || request.path === "/users/@me"
									? "Bot DISCORD_TOKEN_SENTINEL"
									: "Bearer GOOGLE_TOKEN_SENTINEL",
							);
						}
						expect(
							wire.requests.some(
								(request) =>
									request.method === "PATCH" &&
									request.path === `/channels/${wire.channelId}/messages/${updated.item?.discordMessageId}`,
							),
						).toBe(true);
						expect(globalElicitations.count).toBe(0);

						const credentials = readDirectoryText(credentialDirectory);
						expect(credentials).toContain("GOOGLE_TOKEN_SENTINEL");
						expect(credentials).toContain("DISCORD_TOKEN_SENTINEL");
						const executorBytes = readFileSync(executorDbPath).toString("latin1");
						const meetingBytes = readFileSync(join(root, "state", "meeting-publication.sqlite3")).toString(
							"latin1",
						);
						for (const value of [
							"NOTE_CONTENT_SENTINEL",
							"PURPOSE_SENTINEL",
							"UPSTREAM_ERROR_BODY_SENTINEL",
							"UPSTREAM_SUCCESS_BODY_SENTINEL",
						]) {
							expect(credentials).not.toContain(value);
							expect(executorBytes).not.toContain(value);
							expect(meetingBytes).not.toContain(value);
						}
						for (const token of ["GOOGLE_TOKEN_SENTINEL", "DISCORD_TOKEN_SENTINEL"]) {
							expect(executorBytes).not.toContain(token);
							expect(meetingBytes).not.toContain(token);
						}
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("persists HTTP 408 retries without imposing a V2-only queue cap", async () => {
		const root = makeRoot();
		mkdirSync(join(root, "notes"));
		writeFileSync(join(root, "notes", "meeting.md"), note("Retry the provider safely.", "Publish after recovery."));
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const timeoutCase = providerParity.providerCases.httpFailures.find((entry) => entry.status === 408);
		if (timeoutCase === undefined) throw new Error("generated HTTP 408 provider case is missing");
		const retryAttempts = 6;
		expect(providerParity.providerCases.retryPolicy.providerMaxAttempts).toBeNull();
		for (let attempt = 0; attempt < retryAttempts; attempt += 1) {
			wire.failures.push({
				method: "GET",
				path: "/about",
				status: timeoutCase.status,
				headers: timeoutCase.retryAfter === undefined ? {} : { "retry-after": timeoutCase.retryAfter },
				body: { message: "HTTP_408_BODY_MUST_NOT_PERSIST" },
			});
		}
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const now = { value: Date.parse("2026-09-04T12:00:00.000Z") };
						const first = yield* runProviderCore(
							root,
							wire,
							handle,
							now,
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const store = yield* MeetingPublicationStore;
								const scan = yield* service.scan();
								const pending = yield* store.get(scan.itemIds[0] as string);
								if (pending === null) return yield* Effect.die("missing 408 item");
								yield* service.approve(pending.itemId, pending.sourceHash);
								yield* service.worker(1);
								return { itemId: pending.itemId, item: yield* store.get(pending.itemId) };
							}),
						);
						const snapshots = [first.item];
						for (let attempt = 1; attempt < retryAttempts; attempt += 1) {
							now.value += (timeoutCase.retryAfterSeconds ?? 60) * 1_000 + 1;
							const item = yield* runProviderCore(
								root,
								wire,
								handle,
								now,
								Effect.gen(function* () {
									yield* (yield* MeetingPublicationService).worker(1);
									return yield* (yield* MeetingPublicationStore).get(first.itemId);
								}),
							);
							snapshots.push(item);
						}
						for (const [index, item] of snapshots.entries()) {
							expect(item?.failureStage).toBe("google");
							expect(item?.attempts).toBe(index + 1);
							expect(item?.status).toBe("approved");
							expect(item?.nextAttemptAt).not.toBeNull();
						}
						expect(wire.requests.filter((request) => request.path === "/about")).toHaveLength(retryAttempts);
						expect(wire.files.size).toBe(0);
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("recovers post-commit Google and Discord lost responses without duplicate creates", async () => {
		const root = makeRoot();
		mkdirSync(join(root, "notes"));
		writeFileSync(join(root, "notes", "first.md"), note("First lost response.", "Publish the first result."));
		const wire = makeWireState();
		wire.lostGoogleDocumentCreateResponses = 1;
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const now = { value: Date.parse("2026-09-04T12:00:00.000Z") };
						const googleLost = yield* runProviderCore(
							root,
							wire,
							handle,
							now,
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const store = yield* MeetingPublicationStore;
								const scan = yield* service.scan();
								const pending = yield* store.get(scan.itemIds[0] as string);
								if (pending === null) return yield* Effect.die("missing Google lost-response item");
								yield* service.approve(pending.itemId, pending.sourceHash);
								yield* service.worker(1);
								return { itemId: pending.itemId, item: yield* store.get(pending.itemId) };
							}),
						);
						expect(googleLost.item).toMatchObject({ status: "approved", googleDocId: null });
						now.value += 61_000;
						const googleRecovered = yield* runProviderCore(
							root,
							wire,
							handle,
							now,
							Effect.gen(function* () {
								yield* (yield* MeetingPublicationService).worker(1);
								return yield* (yield* MeetingPublicationStore).get(googleLost.itemId);
							}),
						);
						expect(googleRecovered?.status).toBe("published");
						const firstDocumentCreates = wire.requests.filter(
							(request) =>
								request.method === "POST" &&
								request.path === "/files" &&
								isRecord(request.body) &&
								isRecord(request.body.appProperties) &&
								request.body.appProperties.harnessyMeetingItemId === googleLost.itemId,
						);
						expect(firstDocumentCreates).toHaveLength(1);
						const discordCreatesBeforeLostResponse = wire.requests.filter(
							(request) => request.method === "POST" && request.path === `/channels/${wire.channelId}/messages`,
						).length;

						const secondBody = note("Second lost response.", "Publish the second result.")
							.replace("Provider Integration Meeting", "Second Provider Integration Meeting")
							.replace("provider-integration", "provider-integration-2");
						writeFileSync(join(root, "notes", "second.md"), secondBody);
						wire.lostDiscordMessageCreateResponses = 1;
						now.value += 1_000;
						const discordLost = yield* runProviderCore(
							root,
							wire,
							handle,
							now,
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const store = yield* MeetingPublicationStore;
								yield* service.scan();
								const pending = (yield* store.list()).find((item) => item.status === "pending_review");
								if (pending === undefined) return yield* Effect.die("missing Discord lost-response item");
								yield* service.approve(pending.itemId, pending.sourceHash);
								yield* service.worker(1);
								return { itemId: pending.itemId, item: yield* store.get(pending.itemId) };
							}),
						);
						expect(discordLost.item).toMatchObject({ status: "approved", discordMessageId: null });
						expect(discordLost.item?.googleDocId).not.toBeNull();
						now.value += 61_000;
						const discordRecovered = yield* runProviderCore(
							root,
							wire,
							handle,
							now,
							Effect.gen(function* () {
								yield* (yield* MeetingPublicationService).worker(1);
								return yield* (yield* MeetingPublicationStore).get(discordLost.itemId);
							}),
						);
						expect(discordRecovered?.status).toBe("published");
						const discordCreates = wire.requests
							.filter(
								(request) =>
									request.method === "POST" && request.path === `/channels/${wire.channelId}/messages`,
							)
							.slice(discordCreatesBeforeLostResponse);
						expect(discordCreates).toHaveLength(2);
						for (const request of discordCreates) {
							expect(request.body).toMatchObject({ enforce_nonce: true });
						}
						const discordNonces = discordCreates.map((request) => nonceFrom(request.body));
						expect(new Set(discordNonces).size).toBe(1);
						expect(discordNonces[0]).not.toBe(discordLost.itemId);
						expect(discordNonces.every((nonce) => nonce.length > 0 && nonce.length <= 25)).toBe(true);
						expect(wire.messagesByNonce.has(discordNonces[0] ?? "")).toBe(true);
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("does not checkpoint an earlier Discord revision after its create response is lost", async () => {
		const root = makeRoot();
		mkdirSync(join(root, "notes"));
		const notePath = join(root, "notes", "meeting.md");
		writeFileSync(notePath, note("Initial source revision.", "Publish the initial revision."));
		const wire = makeWireState();
		wire.lostDiscordMessageCreateResponses = 1;
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const now = { value: Date.parse("2026-09-04T12:00:00.000Z") };
						const lost = yield* runProviderCore(
							root,
							wire,
							handle,
							now,
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const store = yield* MeetingPublicationStore;
								const scan = yield* service.scan();
								const pending = yield* store.get(scan.itemIds[0] as string);
								if (pending === null) return yield* Effect.die("missing revised-source fixture item");
								yield* service.approve(pending.itemId, pending.sourceHash);
								yield* service.worker(1);
								return { itemId: pending.itemId, item: yield* store.get(pending.itemId) };
							}),
						);
						expect(lost.item).toMatchObject({
							status: "approved",
							failureStage: "discord",
							discordMessageId: null,
						});
						expect(wire.messagesByNonce.size).toBe(1);
						expect([...wire.messagesByNonce.values()][0]?.content).toContain("Publish the initial revision.");

						writeFileSync(notePath, note("Revised source revision.", "Publish only the revised revision."));
						now.value += 61_000;
						const revised = yield* runProviderCore(
							root,
							wire,
							handle,
							now,
							Effect.gen(function* () {
								const service = yield* MeetingPublicationService;
								const store = yield* MeetingPublicationStore;
								yield* service.scan();
								const pending = yield* store.get(lost.itemId);
								if (pending === null) return yield* Effect.die("missing revised fixture item");
								yield* service.approve(pending.itemId, pending.sourceHash);
								yield* service.worker(1);
								return { sourceHash: pending.sourceHash, item: yield* store.get(pending.itemId) };
							}),
						);
						expect(revised.item).toMatchObject({
							status: "published",
							sourceHash: revised.sourceHash,
							approvedHash: revised.sourceHash,
						});
						const creates = wire.requests.filter(
							(request) => request.method === "POST" && request.path === `/channels/${wire.channelId}/messages`,
						);
						expect(creates).toHaveLength(2);
						const nonces = creates.map((request) => nonceFrom(request.body));
						expect(nonces[0]).not.toBe(nonces[1]);
						expect(nonces.every((nonce) => nonce.length > 0 && nonce.length <= 25)).toBe(true);
						expect(wire.messagesByNonce.size).toBe(2);
						const published = [...wire.messagesByNonce.values()].find(
							(message) => message.id === revised.item?.discordMessageId,
						);
						expect(published?.content).toContain("Publish only the revised revision.");
						expect(published?.content).not.toContain("Publish the initial revision.");
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("prevalidates scoped approval proof even when policy bypasses elicitation", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle, approveGooglePolicy, globalElicitations }) =>
					Effect.gen(function* () {
						yield* approveGooglePolicy;
						const args = {
							itemId: "a".repeat(24),
							sourceHash: "b".repeat(64),
							title: "Approved title",
							meetingDate: "2026-09-04",
							markdown: "NOTE_CONTENT_SENTINEL",
							existingDocId: null,
							expectedOwnerEmail: "owner@example.test",
							folderPath: "Published/Meetings",
						};
						const result = yield* Effect.result(
							handle.executeApprovedMeetingMutation(
								"tools.google-meeting-publication.org.meetingsGoogle.upsert",
								args,
								{ itemId: args.itemId, sourceHash: "c".repeat(64) },
							),
						);
						expect(Result.isFailure(result)).toBe(true);
						expect(wire.requests).toHaveLength(0);
						expect(globalElicitations.count).toBe(0);
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("fails exact owner case mismatch before every Google write", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		wire.ownerEmail = "Owner@example.test";
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						return yield* Effect.gen(function* () {
							const google = yield* MeetingPublicationGoogle;
							const result = yield* Effect.result(google.preflight);
							expect(Result.isFailure(result)).toBe(true);
							expect(wire.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
						}).pipe(
							Effect.provide(
								engineMeetingPublicationGoogleLayer({
									handle,
									owner: "org",
									connection: "meetingsGoogle",
									expectedOwnerEmail: "owner@example.test",
									folderPath: "Published/Meetings",
								}),
							),
						);
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("classifies bounded loopback transport failures without leaking response bodies", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
			timeoutMillis: 20,
			maxResponseBytes: 128,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const preflightFailure = (failure: FailureResponse) => {
							wire.failures.push(failure);
							return handle
								.execute("tools.google-meeting-publication.org.meetingsGoogle.preflight", {
									expectedOwnerEmail: "owner@example.test",
								})
								.pipe(Effect.map(failureFrom));
						};

						for (const [status, code] of [
							[401, "authentication_failed"],
							[403, "permission_denied"],
							[404, "provider_not_found"],
						] as const) {
							const failure = yield* preflightFailure({
								method: "GET",
								path: "/about",
								status,
								body: { message: "SECRET_PROVIDER_FAILURE_BODY" },
							});
							expect(failure).toEqual({ code, status, retryable: false, retryAfterSeconds: null });
						}

						const deltaRateLimit = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 429,
							headers: { "retry-after": "7" },
							body: { message: "SECRET_PROVIDER_FAILURE_BODY" },
						});
						expect(deltaRateLimit).toEqual({
							code: "rate_limited",
							status: 429,
							retryable: true,
							retryAfterSeconds: 7,
						});

						const bodyRateLimit = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 429,
							headers: { "retry-after": "9" },
							body: { retry_after: 3, message: "SECRET_PROVIDER_FAILURE_BODY" },
						});
						expect(bodyRateLimit.retryAfterSeconds).toBe(3);

						const invalidRateLimit = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 429,
							headers: { "retry-after": "invalid" },
							body: { retry_after: -5, message: "SECRET_PROVIDER_FAILURE_BODY" },
						});
						expect(invalidRateLimit.retryAfterSeconds).toBe(60);

						const unavailable = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 503,
							headers: { "retry-after": "4" },
							body: { message: "SECRET_PROVIDER_FAILURE_BODY" },
						});
						expect(unavailable).toEqual({
							code: "provider_unavailable",
							status: 503,
							retryable: true,
							retryAfterSeconds: 4,
						});

						const redirect = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 302,
							headers: { location: "https://provider-secret.invalid/credential" },
							body: { message: "SECRET_PROVIDER_FAILURE_BODY" },
						});
						expect(redirect).toEqual({
							code: "unsafe_redirect",
							status: 302,
							retryable: false,
							retryAfterSeconds: null,
						});

						const malformed = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 200,
							rawBody: "{SECRET_PROVIDER_FAILURE_BODY",
						});
						expect(malformed.code).toBe("invalid_response");
						expect(malformed.retryable).toBe(true);

						const oversized = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 200,
							headers: { "content-length": "2048" },
							rawBody: JSON.stringify({ user: { emailAddress: "owner@example.test" } }),
						});
						expect(oversized.code).toBe("response_too_large");

						const timedOut = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 200,
							body: { user: { emailAddress: "owner@example.test" } },
							delayMillis: 80,
						});
						expect(timedOut.code).toBe("timeout");

						const network = yield* preflightFailure({
							method: "GET",
							path: "/about",
							status: 200,
							closeConnection: true,
						});
						expect(network.code).toBe("network_error");

						const serialized = JSON.stringify([
							deltaRateLimit,
							bodyRateLimit,
							invalidRateLimit,
							unavailable,
							redirect,
							malformed,
							oversized,
							timedOut,
							network,
						]);
						expect(serialized).not.toContain("SECRET_PROVIDER_FAILURE_BODY");
						expect(serialized).not.toContain("provider-secret.invalid");
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("rejects Discord channel identity mismatch before mutation", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		wire.channelResponseId = "666666666666666666";
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					handle
						.execute("tools.discord-meeting-publication.org.meetingsDiscord.preflight", {
							expectedChannelId: wire.channelId,
						})
						.pipe(
							Effect.map((result) => {
								expect(failureFrom(result).code).toBe("identity_mismatch");
								expect(wire.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
								return undefined;
							}),
						),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("detects duplicate Google matches and performs no duplicate document write", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const args = googleUpsertArgs();
						const first = yield* handle.executeApprovedMeetingMutation(
							"tools.google-meeting-publication.org.meetingsGoogle.upsert",
							args,
							{ itemId: String(args.itemId), sourceHash: String(args.sourceHash) },
						);
						expect(isRecord(first) && first.ok).toBe(true);
						const writes = wire.requests.filter((request) => request.method !== "GET").length;
						wire.duplicateDocumentMatches = true;
						const duplicate = yield* handle.executeApprovedMeetingMutation(
							"tools.google-meeting-publication.org.meetingsGoogle.upsert",
							args,
							{ itemId: String(args.itemId), sourceHash: String(args.sourceHash) },
						);
						expect(failureFrom(duplicate).code).toBe("duplicate_resource");
						expect(wire.requests.filter((request) => request.method !== "GET")).toHaveLength(writes);
					}),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("uses the checkpointed Discord channel for update and rejects extra URLs before I/O", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		const itemId = "a".repeat(24);
		const sourceHash = "b".repeat(64);
		const messageId = "700000000000000001";
		wire.messagesByNonce.set(itemId, { id: messageId, channelId: wire.channelId, content: "old" });
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		const discordGrant = await makeTestGrant(makeCoreConfig(root, wire.channelId), "provider_discord", {
			itemId,
			sourceHash,
		});
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const discord = yield* MeetingPublicationDiscord;
						const updated = yield* discord.upsert(
							{
								itemId,
								sourceHash,
								title: "Stable channel",
								meetingDate: "2026-09-04",
								googleDocUrl: "https://docs.google.com/document/d/document-5/view",
								purpose: "Notify the approved team",
								existingChannelId: wire.channelId,
								existingMessageId: messageId,
							},
							discordGrant,
						);
						expect(updated).toMatchObject({ channelId: wire.channelId, messageId });
						expect(
							wire.requests.some(
								(request) =>
									request.method === "PATCH" &&
									request.path === `/channels/${wire.channelId}/messages/${messageId}`,
							),
						).toBe(true);

						const requestCount = wire.requests.length;
						const invalid = yield* Effect.result(
							discord.upsert(
								{
									itemId,
									sourceHash,
									title: "Unsafe extra URL",
									meetingDate: "2026-09-04",
									googleDocUrl: "https://docs.google.com/document/d/document-5/view",
									purpose: "Also visit https://unexpected.example.test",
									existingChannelId: null,
									existingMessageId: null,
								},
								discordGrant,
							),
						);
						expect(Result.isFailure(invalid)).toBe(true);
						expect(wire.requests).toHaveLength(requestCount);
					}).pipe(
						Effect.provide(
							engineMeetingPublicationDiscordLayer({
								handle,
								owner: "org",
								connection: "meetingsDiscord",
								expectedChannelId: "777777777777777777",
							}),
						),
					),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("rejects valid grants for another item or revision before real loopback provider I/O", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const itemId = "a".repeat(24);
		const sourceHash = "b".repeat(64);
		const config = makeCoreConfig(root, wire.channelId);
		const googleGrant = await makeTestGrant(config, "provider_google", {
			itemId: "c".repeat(24),
			sourceHash,
		});
		const discordGrant = await makeTestGrant(config, "provider_discord", {
			itemId,
			sourceHash: "d".repeat(64),
		});
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const google = yield* MeetingPublicationGoogle;
						const discord = yield* MeetingPublicationDiscord;
						const results = [
							yield* Effect.result(
								google.upsert(
									{
										itemId,
										sourceHash,
										title: "Wrong item grant",
										meetingDate: "2026-09-04",
										markdown: "No provider write.",
										existingDocId: null,
									},
									googleGrant,
								),
							),
							yield* Effect.result(
								discord.upsert(
									{
										itemId,
										sourceHash,
										title: "Wrong revision grant",
										meetingDate: "2026-09-04",
										googleDocUrl: "https://docs.google.com/document/d/safe/view",
										purpose: "No provider write.",
										existingChannelId: null,
										existingMessageId: null,
									},
									discordGrant,
								),
							),
						];
						for (const result of results) {
							expect(result._tag).toBe("Failure");
							if (result._tag === "Failure") {
								expect(result.failure).toMatchObject({ code: "invalid_grant", retryable: false });
							}
						}
						expect(wire.requests).toHaveLength(0);
					}).pipe(
						Effect.provide(
							Layer.mergeAll(
								engineMeetingPublicationGoogleLayer({
									handle,
									owner: "org",
									connection: "meetingsGoogle",
									expectedOwnerEmail: "owner@example.test",
									folderPath: "Published/Meetings",
								}),
								engineMeetingPublicationDiscordLayer({
									handle,
									owner: "org",
									connection: "meetingsDiscord",
									expectedChannelId: wire.channelId,
								}),
							),
						),
					),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("revalidates a live grant before each provider write and before a later retry", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const itemId = "a".repeat(24);
		const sourceHash = "b".repeat(64);
		const config = makeCoreConfig(root, wire.channelId);
		let active = true;
		const grant = await makeTestGrant(config, "provider_google", { itemId, sourceHash }, { isActive: () => active });
		wire.onRequest = ({ method }) => {
			if (method !== "GET") active = false;
		};
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle }) =>
					Effect.gen(function* () {
						const google = yield* MeetingPublicationGoogle;
						const request = {
							itemId,
							sourceHash,
							title: "Revoked publication",
							meetingDate: "2026-09-04",
							markdown: "The later writes must not run.",
							existingDocId: null,
						};
						const first = yield* Effect.result(google.upsert(request, grant));
						expect(first).toMatchObject({
							_tag: "Failure",
							failure: { code: "invalid_grant", retryable: false },
						});
						const writesAfterRevocation = wire.requests.filter(({ method }) => method !== "GET");
						expect(writesAfterRevocation).toHaveLength(1);

						const retry = yield* Effect.result(google.upsert(request, grant));
						expect(retry).toMatchObject({
							_tag: "Failure",
							failure: { code: "invalid_grant", retryable: false },
						});
						expect(wire.requests.filter(({ method }) => method !== "GET")).toHaveLength(1);
					}).pipe(
						Effect.provide(
							engineMeetingPublicationGoogleLayer({
								handle,
								owner: "org",
								connection: "meetingsGoogle",
								expectedOwnerEmail: "owner@example.test",
								folderPath: "Published/Meetings",
							}),
						),
					),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("isolates concurrent native-fetch guards and clears them after every invocation", async () => {
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const request = (path: string, asRequest: boolean) =>
			Effect.tryPromise({
				try: () =>
					asRequest
						? guardedMeetingPublicationFetch(new Request(`${server.origin}${path}`, { method: "POST" }))
						: guardedMeetingPublicationFetch(`${server.origin}${path}`, { method: "POST" }),
				catch: (cause) => cause,
			});
		try {
			const [denied, allowed] = await Effect.runPromise(
				Effect.all(
					[
						Effect.result(
							withMeetingPublicationMutationGuard(
								request("/oauth-denied", true),
								Effect.fail(new Error("PRIVATE_AUTHORITY_DETAIL")),
							),
						),
						Effect.result(withMeetingPublicationMutationGuard(request("/oauth-allowed", false), Effect.void)),
					],
					{ concurrency: "unbounded" },
				),
			);
			expect(denied._tag).toBe("Failure");
			if (denied._tag === "Failure") {
				expect(String(denied.failure)).toContain("authorization was rejected");
				expect(String(denied.failure)).not.toContain("PRIVATE_AUTHORITY_DETAIL");
			}
			expect(allowed._tag).toBe("Success");
			expect(wire.requests.map(({ path }) => path)).toEqual(["/oauth-allowed"]);

			await guardedMeetingPublicationFetch(`${server.origin}/outside-invocation`, { method: "POST" });
			expect(wire.requests.map(({ path }) => path)).toEqual(["/oauth-allowed", "/outside-invocation"]);
		} finally {
			await server.close();
		}
	});

	it("rejects invalid grants before SDK provider and notifier side effects", async () => {
		const root = makeRoot();
		const config = makeCoreConfig(root, "777777777777777777");
		const wrongOperationGrant = await makeTestGrant(config, "provider_google", {
			itemId: "a".repeat(24),
			sourceHash: "b".repeat(64),
		});
		const missingGrant = undefined as unknown as MeetingPublicationWriteGrant;
		const fabricatedGrant = {
			operation: "provider_discord",
			binding: { sourcePath: config.sourcePath, statePath: config.statePath },
		} as unknown as MeetingPublicationWriteGrant;
		let engineMutations = 0;
		const handle = {
			execute: () => Effect.succeed({ ok: true, data: true }),
			executeApprovedMeetingMutation: () =>
				Effect.sync(() => {
					engineMutations += 1;
					return { ok: true, data: {} };
				}),
		} as unknown as HarnessyEngineHandle;
		const recordPath = join(root, "invalid-grant-notifier.json");
		const scriptPath = join(root, "invalid-grant-notifier.cjs");
		writeFileSync(scriptPath, `require("node:fs").writeFileSync(${JSON.stringify(recordPath)}, "unexpected spawn");`);
		const results = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const google = yield* MeetingPublicationGoogle;
					const discord = yield* MeetingPublicationDiscord;
					const notifier = yield* MeetingPublicationNotifier;
					return {
						google: yield* Effect.result(
							google.upsert(
								{
									itemId: "a".repeat(24),
									title: "No write",
									meetingDate: "2026-09-04",
									sourceHash: "b".repeat(64),
									markdown: "No write",
									existingDocId: null,
								},
								missingGrant,
							),
						),
						discord: yield* Effect.result(
							discord.upsert(
								{
									itemId: "a".repeat(24),
									sourceHash: "b".repeat(64),
									title: "No write",
									meetingDate: "2026-09-04",
									googleDocUrl: "https://docs.google.com/document/d/safe/view",
									purpose: "No write.",
									existingChannelId: null,
									existingMessageId: null,
								},
								fabricatedGrant,
							),
						),
						notifier: yield* Effect.result(notifier.notify("review", 1, wrongOperationGrant)),
					};
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							engineMeetingPublicationGoogleLayer({
								handle,
								owner: "org",
								connection: "meetingsGoogle",
								expectedOwnerEmail: "owner@example.test",
								folderPath: "Published/Meetings",
							}),
							engineMeetingPublicationDiscordLayer({
								handle,
								owner: "org",
								connection: "meetingsDiscord",
								expectedChannelId: "777777777777777777",
							}),
							localMeetingPublicationNotifierLayer({
								kind: "test-process",
								executablePath: process.execPath,
								scriptPath,
							}),
						),
					),
				),
			),
		);
		for (const result of Object.values(results)) {
			expect(result._tag).toBe("Failure");
			if (result._tag === "Failure") expect(result.failure).toMatchObject({ code: "invalid_grant" });
		}
		expect(engineMutations).toBe(0);
		expect(existsSync(recordPath)).toBe(false);
	});

	it("maps deleted Executor credential material to a terminal provider failure", async () => {
		const root = makeRoot();
		const wire = makeWireState();
		const server = await startWireServer(wire);
		const transport = {
			kind: "test-loopback",
			googleDriveBaseUrl: server.origin,
			googleDocsBaseUrl: server.origin,
			discordBaseUrl: server.origin,
		} as const;
		try {
			await Effect.runPromise(
				withEngine(root, transport, ({ handle, credentialDirectory }) =>
					Effect.gen(function* () {
						rmSync(credentialDirectory, { recursive: true, force: true });
						const google = yield* MeetingPublicationGoogle;
						const result = yield* Effect.result(google.preflight);
						expect(Result.isFailure(result)).toBe(true);
						if (Result.isFailure(result)) {
							expect(result.failure).toMatchObject({
								stage: "google",
								code: "missing_credential",
								retryable: false,
								retryAfterSeconds: null,
							});
						}
						expect(wire.requests).toHaveLength(0);
					}).pipe(
						Effect.provide(
							engineMeetingPublicationGoogleLayer({
								handle,
								owner: "org",
								connection: "meetingsGoogle",
								expectedOwnerEmail: "owner@example.test",
								folderPath: "Published/Meetings",
							}),
						),
					),
				),
			);
		} finally {
			await server.close();
		}
	});

	it("runs the content-free notifier process fixture and terminates bounded hangs", async () => {
		const root = makeRoot();
		const notificationGrant = await makeTestGrant(
			makeCoreConfig(root, "777777777777777777"),
			"provider_notification",
		);
		const recordPath = join(root, "notifier-args.json");
		const successScript = join(root, "notifier-success.cjs");
		writeFileSync(
			successScript,
			`require("node:fs").writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));`,
		);
		const delivered = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const notifier = yield* MeetingPublicationNotifier;
					return yield* notifier.notify("review", 2, notificationGrant);
				}).pipe(
					Effect.provide(
						localMeetingPublicationNotifierLayer({
							kind: "test-process",
							executablePath: process.execPath,
							scriptPath: successScript,
							timeoutMillis: 2_000,
						}),
					),
				),
			),
		);
		expect(delivered).toBe(true);
		expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual(["review", "2"]);

		const hangingPidPath = join(root, "notifier-hang.pid");
		const hangingScript = join(root, "notifier-hang.cjs");
		writeFileSync(
			hangingScript,
			`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(hangingPidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
		);
		const timedOut = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const notifier = yield* MeetingPublicationNotifier;
					return yield* notifier.notify("error", 1, notificationGrant);
				}).pipe(
					Effect.provide(
						localMeetingPublicationNotifierLayer({
							kind: "test-process",
							executablePath: process.execPath,
							scriptPath: hangingScript,
							timeoutMillis: 100,
							terminationGraceMillis: 100,
						}),
					),
				),
			),
		);
		expect(timedOut).toBe(false);
		expect(existsSync(hangingPidPath)).toBe(true);
		const timedOutPid = Number(readFileSync(hangingPidPath, "utf8"));
		const runningAfterTimeout = processIsRunning(timedOutPid);
		if (runningAfterTimeout) process.kill(timedOutPid, "SIGKILL");
		expect(runningAfterTimeout).toBe(false);

		const scopePidPath = join(root, "notifier-scope.pid");
		const scopeScript = join(root, "notifier-scope.cjs");
		writeFileSync(
			scopeScript,
			`process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(scopePidPath)}, String(process.pid)); setInterval(() => {}, 1000);`,
		);
		const scopePid = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const notifier = yield* MeetingPublicationNotifier;
					yield* notifier.notify("error", 1, notificationGrant).pipe(Effect.forkScoped);
					yield* Effect.promise(() => waitForFile(scopePidPath));
					return Number(readFileSync(scopePidPath, "utf8"));
				}).pipe(
					Effect.provide(
						localMeetingPublicationNotifierLayer({
							kind: "test-process",
							executablePath: process.execPath,
							scriptPath: scopeScript,
							timeoutMillis: 2_000,
							terminationGraceMillis: 100,
						}),
					),
				),
			),
		);
		const runningAfterScopeClose = processIsRunning(scopePid);
		if (runningAfterScopeClose) process.kill(scopePid, "SIGKILL");
		expect(runningAfterScopeClose).toBe(false);
	});

	it("binds terminal notifications to the fixed review opener without a bearer", async () => {
		const root = makeRoot();
		const notificationGrant = await makeTestGrant(
			makeCoreConfig(root, "888888888888888888"),
			"provider_notification",
		);
		const recordPath = join(root, "terminal-notifier-args.json");
		const notifierPath = join(root, "terminal-notifier-fixture");
		const reviewOpenPath = join(root, "review-open-fixture");
		const statePath = join(root, "state");
		writeFileSync(
			notifierPath,
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o700 },
		);
		writeFileSync(reviewOpenPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		chmodSync(notifierPath, 0o700);
		chmodSync(reviewOpenPath, 0o700);

		const delivered = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const notifier = yield* MeetingPublicationNotifier;
					return yield* notifier.notify("review", 1, notificationGrant);
				}).pipe(
					Effect.provide(
						localMeetingPublicationNotifierLayer({
							kind: "terminal-notifier",
							executablePath: notifierPath,
							reviewOpen: { executablePath: reviewOpenPath, statePath },
							timeoutMillis: 2_000,
						}),
					),
				),
			),
		);
		expect(delivered).toBe(true);
		expect(JSON.parse(readFileSync(recordPath, "utf8"))).toEqual([
			"-title",
			"Harnessy meeting publication",
			"-message",
			"1 meeting publication item awaits review.",
			"-group",
			"harnessy-meeting-publication",
			"-execute",
			`${JSON.stringify(reviewOpenPath)} --state-path ${JSON.stringify(statePath)}`,
		]);
		expect(readFileSync(recordPath, "utf8")).not.toContain("meeting-publication-v2-review.token");
	});

	it("executes generated unsafe-origin and Discord size-boundary cases", () => {
		for (const origin of providerParity.providerCases.unsafeLoopbackOrigins) {
			expect(
				resolveMeetingProviderTransport({
					kind: "test-loopback",
					googleDriveBaseUrl: origin,
					googleDocsBaseUrl: "http://127.0.0.1:9001",
					discordBaseUrl: "http://127.0.0.1:9002",
				}),
				origin,
			).toBeNull();
		}
		const limits = providerParity.providerCases.discordContent;
		for (const purpose of ["x".repeat(3_000), "🙂".repeat(3_000), "@*[]()".repeat(1_000)]) {
			const content = formatDiscordMeetingMessage(
				purpose,
				"https://docs.google.com/document/d/document-boundary/view",
			);
			expect(Array.from(content).length).toBeLessThanOrEqual(limits.maxCodePoints);
			expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(limits.maxBytes);
			expect(content).toContain("https://docs.google.com/document/d/document-boundary/view");
		}
		const escaped = formatDiscordMeetingMessage(
			"@*[]()".repeat(1_000),
			"https://docs.google.com/document/d/document-boundary/view",
		);
		expect(escaped).toContain("\\@\\*\\[\\]\\(\\)");
		expect(limits.escapesMarkupBeforeMeasuring).toBe(true);
	});

	it("parses bounded Retry-After delta/date forms and rejects invalid values", () => {
		const now = Date.parse("2026-09-04T12:00:00.000Z");
		expect(parseRetryAfterSeconds("12", now)).toBe(12);
		expect(parseRetryAfterSeconds("Fri, 04 Sep 2026 12:00:09 GMT", now)).toBe(9);
		expect(parseRetryAfterSeconds("not-a-date", now)).toBeNull();
		expect(parseRetryAfterSeconds("999999", now)).toBe(3_600);
	});
});
