import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { acquireDataDirOwnership } from "../../../executor/apps/local/src/db/data-dir-ownership.ts";
import { makeHarnessyEngine } from "../src/engine.ts";
import { CURRENT_EXECUTOR_DATA_MIGRATIONS } from "../src/meeting-publication/existing-engine-store.ts";
import {
	type MeetingPublicationSetupConfig,
	type MeetingPublicationSetupHandle,
	type MeetingPublicationSetupTestOptions,
	openMeetingPublicationGoogleSetupForTest,
	openMeetingPublicationSetup,
	openMeetingPublicationSetupForTest,
} from "../src/meeting-publication/setup.ts";
import { meetingOAuthWire } from "./support/meeting-oauth-wire.ts";
import { makeWireState, startWireServer } from "./support/meeting-provider-wire.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const config = (): MeetingPublicationSetupConfig => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-setup-"));
	roots.push(root);
	return {
		directory: join(root, "executor"),
		credentialDirectory: join(root, "credentials"),
		tenant: "meeting-test",
		subject: "owner",
		google: {
			owner: "user",
			name: "meetingsgoogle",
			clientOwner: "org",
			clientSlug: "meeting-app",
			expectedOwnerEmail: "owner@example.test",
		},
		discord: { owner: "org", name: "meetingsdiscord", expectedChannelId: "555555555555555555" },
	};
};
const clientInput = {
	clientId: "test-client",
	clientSecret: "test-secret",
	redirectUri: "http://127.0.0.1:8777/setup/callback",
};
const prepareFixture = Effect.gen(function* () {
	const input = config();
	const wire = makeWireState();
	const provider = yield* Effect.acquireRelease(
		Effect.promise(() => startWireServer(wire)),
		(server) => Effect.promise(() => server.close()),
	);
	const oauth = yield* meetingOAuthWire;
	const options = {
		transport: {
			kind: "test-loopback" as const,
			googleDriveBaseUrl: provider.origin,
			googleDocsBaseUrl: provider.origin,
			discordBaseUrl: provider.origin,
		},
		authorizationUrl: oauth.authorizationEndpoint,
		tokenUrl: oauth.tokenEndpoint,
	};
	return { input, wire, oauth, options };
});
const fixture = Effect.gen(function* () {
	const prepared = yield* prepareFixture;
	const handle = yield* openMeetingPublicationSetupForTest(prepared.input, prepared.options);
	return { ...prepared, handle };
});
const continuationConfig = (input: MeetingPublicationSetupConfig) => ({
	...input,
	google: { ...input.google, expectedClientId: clientInput.clientId },
});
const preparePartial = (
	input: MeetingPublicationSetupConfig,
	options: MeetingPublicationSetupTestOptions,
	keepSession = false,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* openMeetingPublicationSetupForTest(input, options);
			yield* handle.connectDiscord("synthetic-discord-token");
			const consent = yield* handle.startGoogleConsent(clientInput);
			if (!keepSession) yield* consent.cancel();
		}),
	);
const preservedSetup = async (input: MeetingPublicationSetupConfig) => {
	const db = createClient({ url: pathToFileURL(join(input.directory, "data.db")).href });
	try {
		return {
			discord: (await db.execute("SELECT * FROM connection WHERE integration = 'discord-meeting-publication'")).rows,
			clients: (await db.execute("SELECT * FROM oauth_client ORDER BY slug")).rows,
			integrations: (await db.execute("SELECT * FROM integration ORDER BY slug")).rows,
			ledger: (await db.execute("SELECT * FROM data_migration ORDER BY name")).rows,
		};
	} finally {
		db.close();
	}
};

describe("explicit missing-Google setup continuation", () => {
	it("completes consent exactly once without changing Discord, app, integration or migration records", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { input, options, wire, oauth } = yield* prepareFixture;
					yield* preparePartial(input, options);
					const before = yield* Effect.promise(() => preservedSetup(input));
					const credentials = JSON.parse(
						readFileSync(join(input.credentialDirectory, "auth.json"), "utf8"),
					) as Record<string, string>;
					wire.requests.length = 0;
					yield* Effect.scoped(
						Effect.gen(function* () {
							const handle = yield* openMeetingPublicationGoogleSetupForTest(continuationConfig(input), options);
							expect(Object.keys(handle)).toEqual(["startGoogleConsent"]);
							const consent = yield* handle.startGoogleConsent({ redirectUri: clientInput.redirectUri });
							const callback = yield* oauth.completeAuthorizationCodeFlow({
								authorizationUrl: consent.authorizationUrl,
							});
							yield* consent.complete(callback.code);
							expect((yield* Effect.result(consent.complete(callback.code)))._tag).toBe("Failure");
						}),
					);
					expect(yield* Effect.promise(() => preservedSetup(input))).toEqual(before);
					const after = JSON.parse(readFileSync(join(input.credentialDirectory, "auth.json"), "utf8")) as Record<
						string,
						string
					>;
					for (const [id, value] of Object.entries(credentials)) expect(after[id]).toBe(value);
					expect(Object.keys(after).length).toBe(Object.keys(credentials).length + 2);
					expect(wire.requests.map((request) => [request.method, request.path])).toEqual([["GET", "/about"]]);
					expect(
						(yield* Effect.result(
							Effect.scoped(openMeetingPublicationGoogleSetupForTest(continuationConfig(input), options)),
						))._tag,
					).toBe("Failure");
				}),
			),
		);
	});

	it.each([
		"client-id",
		"client-owner",
		"invalid-owner-pair",
		"discord-owner",
		"active-session",
		"client-endpoint",
		"missing-client",
		"ledger",
	] as const)("rejects %s mismatch without altering preserved setup", async (mismatch) => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { input, options } = yield* prepareFixture;
					yield* preparePartial(input, options, mismatch === "active-session");
					if (["client-endpoint", "missing-client", "ledger"].includes(mismatch)) {
						const db = createClient({ url: pathToFileURL(join(input.directory, "data.db")).href });
						try {
							yield* Effect.promise(() =>
								db.execute(
									mismatch === "client-endpoint"
										? "UPDATE oauth_client SET token_url = 'https://wrong.example/token'"
										: mismatch === "missing-client"
											? "DELETE FROM oauth_client"
											: "DELETE FROM data_migration WHERE name = '2026-06-11-local-v1-to-v2'",
								),
							);
						} finally {
							db.close();
						}
					}
					const before = yield* Effect.promise(() => preservedSetup(input));
					const credentials = readFileSync(join(input.credentialDirectory, "auth.json"));
					const changed = continuationConfig(input);
					if (mismatch === "client-id") changed.google.expectedClientId = "wrong-client";
					if (mismatch === "client-owner") changed.google.clientOwner = "user";
					if (mismatch === "invalid-owner-pair") {
						changed.google.owner = "org";
						changed.google.clientOwner = "user";
					}
					if (mismatch === "discord-owner") changed.discord = { ...changed.discord, owner: "user" };
					expect(
						(yield* Effect.result(Effect.scoped(openMeetingPublicationGoogleSetupForTest(changed, options))))
							._tag,
					).toBe("Failure");
					expect(yield* Effect.promise(() => preservedSetup(input))).toEqual(before);
					expect(readFileSync(join(input.credentialDirectory, "auth.json"))).toEqual(credentials);
					const owner = yield* Effect.promise(() => acquireDataDirOwnership(input.directory));
					yield* Effect.promise(() => owner.release());
				}),
			),
		);
	});

	it("rejects a competing owner, wrong account and any subsequent setup after a connection was minted", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { input, options, wire, oauth } = yield* prepareFixture;
					yield* preparePartial(input, options);
					const before = yield* Effect.promise(() => preservedSetup(input));
					yield* Effect.scoped(
						Effect.gen(function* () {
							const handle = yield* openMeetingPublicationGoogleSetupForTest(continuationConfig(input), options);
							expect(
								(yield* Effect.result(
									Effect.scoped(openMeetingPublicationGoogleSetupForTest(continuationConfig(input), options)),
								))._tag,
							).toBe("Failure");
							wire.ownerEmail = "wrong@example.test";
							const consent = yield* handle.startGoogleConsent({ redirectUri: clientInput.redirectUri });
							const callback = yield* oauth.completeAuthorizationCodeFlow({
								authorizationUrl: consent.authorizationUrl,
							});
							expect((yield* Effect.result(consent.complete(callback.code)))._tag).toBe("Failure");
						}),
					);
					expect(
						(yield* Effect.result(
							Effect.scoped(openMeetingPublicationGoogleSetupForTest(continuationConfig(input), options)),
						))._tag,
					).toBe("Failure");
					expect(yield* Effect.promise(() => preservedSetup(input))).toEqual(before);
				}),
			),
		);
	});

	it("explicitly cancels a new consent without replacing existing credentials or client", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { input, options } = yield* prepareFixture;
					yield* preparePartial(input, options);
					const before = yield* Effect.promise(() => preservedSetup(input));
					const credentials = readFileSync(join(input.credentialDirectory, "auth.json"));
					yield* Effect.scoped(
						Effect.gen(function* () {
							const handle = yield* openMeetingPublicationGoogleSetupForTest(continuationConfig(input), options);
							const consent = yield* handle.startGoogleConsent({ redirectUri: clientInput.redirectUri });
							yield* consent.cancel();
							expect((yield* Effect.result(consent.complete("obsolete-code")))._tag).toBe("Failure");
						}),
					);
					expect(yield* Effect.promise(() => preservedSetup(input))).toEqual(before);
					expect(readFileSync(join(input.credentialDirectory, "auth.json"))).toEqual(credentials);
				}),
			),
		);
	});
});

describe("fresh native meeting setup", () => {
	it("runs actual schema/migrations, native OAuth PKCE and Discord setup, then reopens existing-only", async () => {
		const input = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { input, wire, oauth, handle } = yield* fixture;
					expect(Object.keys(handle).sort()).toEqual(["connectDiscord", "startGoogleConsent"]);
					const consent = yield* handle.startGoogleConsent(clientInput);
					const authorization = new URL(consent.authorizationUrl);
					expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: consent.authorizationUrl,
					});
					expect(callback.state).toBe(consent.state);
					yield* consent.complete(callback.code);
					yield* handle.connectDiscord("synthetic-discord-token");
					expect(wire.requests.map((r) => r.method)).toEqual(["GET", "GET", "GET"]);
					expect(wire.documents.size).toBe(0);
					expect(wire.messagesByNonce.size).toBe(0);
					expect((yield* Effect.result(consent.complete(callback.code)))._tag).toBe("Failure");
					expect((yield* Effect.result(handle.connectDiscord("replacement-token")))._tag).toBe("Failure");
					expect((yield* Effect.result(handle.startGoogleConsent(clientInput)))._tag).toBe("Failure");
					return input;
				}),
			),
		);
		const sqlite = createClient({ url: pathToFileURL(join(input.directory, "data.db")).href });
		try {
			expect((await sqlite.execute("SELECT name FROM data_migration")).rows.map((r) => r.name).sort()).toEqual(
				[...CURRENT_EXECUTOR_DATA_MIGRATIONS].sort(),
			);
			expect((await sqlite.execute("PRAGMA integrity_check")).rows[0]?.integrity_check).toBe("ok");
			expect((await sqlite.execute("SELECT name FROM connection")).rows).toHaveLength(2);
		} finally {
			sqlite.close();
		}
		for (const path of [input.directory, input.credentialDirectory]) expect(lstatSync(path).mode & 0o777).toBe(0o700);
		expect(lstatSync(join(input.directory, "data.db")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(input.directory, "data.db")).includes(Buffer.from("synthetic-discord-token"))).toBe(
			false,
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const engine = yield* makeHarnessyEngine({
						tenant: input.tenant,
						subject: input.subject,
						credentialDirectory: input.credentialDirectory,
						existingStatePath: join(input.directory, "data.db"),
						onElicitation: () => Effect.succeed({ action: "decline" }),
					});
					expect(yield* engine.connections.list()).toHaveLength(2);
				}),
			),
		);
		await expect(Effect.runPromise(Effect.scoped(openMeetingPublicationSetup(input)))).rejects.toThrow(
			"unsafe_directory",
		);
	});

	it.each(["existing", "unsafe-parent", "symlink-parent", "same", "relative"])(
		"rejects %s directories without touching existing data",
		async (kind) => {
			const input = config();
			let changed = input;
			if (kind === "existing") mkdirSync(input.directory, { mode: 0o700 });
			if (kind === "unsafe-parent") chmodSync(join(input.directory, ".."), 0o755);
			if (kind === "symlink-parent") {
				const alias = join(join(input.directory, ".."), "alias");
				symlinkSync(join(input.directory, ".."), alias);
				changed = { ...input, directory: join(alias, "executor"), credentialDirectory: join(alias, "credentials") };
			}
			if (kind === "same") changed = { ...input, credentialDirectory: input.directory };
			if (kind === "relative") changed = { ...input, directory: "relative/executor" };
			await expect(Effect.runPromise(Effect.scoped(openMeetingPublicationSetup(changed)))).rejects.toThrow(
				"unsafe_directory",
			);
			expect(existsSync(join(input.directory, "data.db"))).toBe(false);
		},
	);

	it("rejects invalid binding identity before creating directories", async () => {
		const input = config();
		await expect(
			Effect.runPromise(Effect.scoped(openMeetingPublicationSetup({ ...input, tenant: "" }))),
		).rejects.toThrow("invalid_input");
		expect(existsSync(input.directory)).toBe(false);
	});

	it("rejects a second setup and existing runtime while the first owns the store", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { input } = yield* fixture;
					expect((yield* Effect.result(openMeetingPublicationSetup(input)))._tag).toBe("Failure");
					expect(
						(yield* Effect.result(
							makeHarnessyEngine({
								tenant: input.tenant,
								subject: input.subject,
								credentialDirectory: input.credentialDirectory,
								existingStatePath: join(input.directory, "data.db"),
								onElicitation: "accept-all",
							}),
						))._tag,
					).toBe("Failure");
				}),
			),
		);
	});

	it("cancels consent without minting a connection and rejects replay", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, oauth, wire } = yield* fixture;
					const consent = yield* handle.startGoogleConsent(clientInput);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: consent.authorizationUrl,
					});
					yield* consent.cancel();
					expect((yield* Effect.result(consent.complete(callback.code)))._tag).toBe("Failure");
					expect((yield* Effect.result(consent.cancel()))._tag).toBe("Success");
					expect(wire.requests).toHaveLength(0);
				}),
			),
		);
	});

	it("rejects stale handles after owner scope closes", async () => {
		let handle: MeetingPublicationSetupHandle | undefined;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					handle = (yield* fixture).handle;
				}),
			),
		);
		expect(handle).toBeDefined();
		await expect(Effect.runPromise(handle!.connectDiscord("synthetic-token"))).rejects.toThrow("closed");
	});

	it("fails identity verification and keeps partial setup for inspection instead of retrying", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, oauth, wire, input } = yield* fixture;
					wire.ownerEmail = "wrong@example.test";
					const consent = yield* handle.startGoogleConsent(clientInput);
					const callback = yield* oauth.completeAuthorizationCodeFlow({
						authorizationUrl: consent.authorizationUrl,
					});
					const result = yield* Effect.result(consent.complete(callback.code));
					expect(result._tag).toBe("Failure");
					expect(JSON.stringify(result)).not.toContain("test-secret");
					expect((yield* Effect.result(handle.startGoogleConsent(clientInput)))._tag).toBe("Failure");
					expect(existsSync(join(input.directory, "data.db"))).toBe(true);
					expect(wire.requests.every((r) => r.method === "GET")).toBe(true);
				}),
			),
		);
	});

	it("rejects invalid code and redirects before provider calls, and redacts token errors", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, oauth, wire } = yield* fixture;
					expect(
						(yield* Effect.result(
							handle.startGoogleConsent({ ...clientInput, redirectUri: "https://evil.example/callback" }),
						))._tag,
					).toBe("Failure");
					const consent = yield* handle.startGoogleConsent(clientInput);
					expect((yield* Effect.result(consent.complete("")))._tag).toBe("Failure");
					const result = yield* Effect.result(consent.complete("wrong-code"));
					expect(result._tag).toBe("Failure");
					expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN_RESPONSE");
					expect((yield* oauth.requests).some((r) => r.path === "/token")).toBe(true);
					expect(wire.requests).toHaveLength(0);
				}),
			),
		);
	});

	it("rejects Discord channel mismatch without sending a message", async () => {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const { handle, wire } = yield* fixture;
					wire.channelResponseId = "999";
					expect((yield* Effect.result(handle.connectDiscord("synthetic-token")))._tag).toBe("Failure");
					expect(wire.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
				}),
			),
		);
	});

	it.each(["fresh", "continuation"] as const)(
		"retains %s ownership until a cancelled token exchange settles and never commits credentials",
		async (mode) => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const input = config();
						const wire = makeWireState();
						const provider = yield* Effect.acquireRelease(
							Effect.promise(() => startWireServer(wire)),
							(server) => Effect.promise(() => server.close()),
						);
						const oauth = yield* meetingOAuthWire;
						const options = {
							transport: {
								kind: "test-loopback" as const,
								googleDriveBaseUrl: provider.origin,
								googleDocsBaseUrl: provider.origin,
								discordBaseUrl: provider.origin,
							},
							authorizationUrl: oauth.authorizationEndpoint,
							tokenUrl: oauth.tokenEndpoint,
						};
						let before: Buffer | undefined;
						if (mode === "continuation") yield* preparePartial(input, options);
						wire.requests.length = 0;
						let tokenReached = () => {};
						let releaseToken = () => {};
						const reached = new Promise<void>((resolve) => {
							tokenReached = resolve;
						});
						const release = new Promise<void>((resolve) => {
							releaseToken = resolve;
						});
						oauth.controls.beforeTokenResponse = async () => {
							tokenReached();
							await release;
						};
						const controller = new AbortController();
						let settled = false;
						const completing = Effect.runPromise(
							Effect.scoped(
								Effect.gen(function* () {
									const handle =
										mode === "fresh"
											? yield* openMeetingPublicationSetupForTest(input, options)
											: yield* openMeetingPublicationGoogleSetupForTest(continuationConfig(input), options);
									const consent = yield* handle.startGoogleConsent(clientInput);
									const callback = yield* oauth.completeAuthorizationCodeFlow({
										authorizationUrl: consent.authorizationUrl,
									});
									before = readFileSync(join(input.credentialDirectory, "auth.json"));
									wire.requests.length = 0;
									yield* consent.complete(callback.code, controller.signal);
								}),
							),
							{
								signal: controller.signal,
							},
						).then(
							() => {
								settled = true;
								return "success";
							},
							() => {
								settled = true;
								return "rejected";
							},
						);
						yield* Effect.promise(() => reached);
						controller.abort();
						try {
							yield* Effect.promise(async () => {
								await new Promise<void>((resolve) => setImmediate(resolve));
								expect(settled).toBe(false);
								await expect(acquireDataDirOwnership(input.directory)).rejects.toThrow();
							});
						} finally {
							releaseToken();
						}
						expect(yield* Effect.promise(() => completing)).toBe("rejected");
						const subsequentOwner = yield* Effect.promise(() => acquireDataDirOwnership(input.directory));
						yield* Effect.promise(() => subsequentOwner.release());
						expect(readFileSync(join(input.credentialDirectory, "auth.json"))).toEqual(before);
						expect(wire.requests).toHaveLength(0);
						const db = createClient({ url: pathToFileURL(join(input.directory, "data.db")).href });
						try {
							expect(
								(yield* Effect.promise(() =>
									db.execute("SELECT name FROM connection WHERE integration = 'google-meeting-publication'"),
								)).rows,
							).toHaveLength(0);
						} finally {
							db.close();
						}
					}),
				),
			);
		},
	);

	it.each(["google", "discord"] as const)(
		"settles %s local mutations before closing an interrupted setup scope",
		async (provider) => {
			const input = config();
			const controller = new AbortController();
			let reached = () => {};
			let release = () => {};
			const ready = new Promise<void>((resolve) => {
				reached = resolve;
			});
			const start = new Promise<void>((resolve) => {
				release = resolve;
			});
			let settled = false;
			const operation = Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* openMeetingPublicationSetup(input);
						reached();
						yield* Effect.promise(() => start);
						if (provider === "google") yield* handle.startGoogleConsent(clientInput, controller.signal);
						else yield* handle.connectDiscord("synthetic-token", controller.signal);
					}),
				),
				{ signal: controller.signal },
			).then(
				() => {
					settled = true;
					return "success";
				},
				() => {
					settled = true;
					return "rejected";
				},
			);
			await ready;
			release();
			// Let the admitted operation enter its genuine async SQLite sequence.
			await Promise.resolve();
			queueMicrotask(() => controller.abort());
			const whileRunning = acquireDataDirOwnership(input.directory);
			expect(settled).toBe(false);
			await expect(whileRunning).rejects.toThrow();
			expect(await operation).toBe("rejected");
			const owner = await acquireDataDirOwnership(input.directory);
			await owner.release();
			const db = createClient({ url: pathToFileURL(join(input.directory, "data.db")).href });
			try {
				const rows = (await db.execute(`SELECT * FROM ${provider === "google" ? "oauth_client" : "connection"}`))
					.rows;
				expect(rows).toHaveLength(1);
			} finally {
				db.close();
			}
		},
	);
});
