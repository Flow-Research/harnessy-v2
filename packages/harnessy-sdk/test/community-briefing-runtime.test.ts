import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	CommunityBriefingGrantHost,
	type CommunityBriefingProviderScope,
	communityBriefingGrantPayload,
} from "@harnessy/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CommunityBriefingQueue } from "../src/community-briefing/queue.ts";
import { runNativeCommunityBriefing } from "../src/community-briefing/runtime.ts";
import { makeCommunityRuntimeFixture } from "./support/community-runtime-fixture.ts";

const now = Date.parse("2026-09-19T01:00:00.000Z");
type Fixture = Awaited<ReturnType<typeof makeCommunityRuntimeFixture>>;
const signedRuntime = async (
	fixture: Fixture,
	scope: CommunityBriefingProviderScope = fixture.providerScope,
	sourceHash = fixture.sourceHash,
	clock: () => number = () => now,
	lifetimeMs = 600_000,
) => {
	const keys = generateKeyPairSync("ed25519");
	const host = new CommunityBriefingGrantHost(
		join(fixture.root, "authority"),
		new Map([["test-owner", keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
		fixture.queuePath,
		fixture.statePath,
		scope,
		clock,
	);
	const unsigned = {
		issuer: "test-owner",
		grantId: "one-publication",
		queuePath: fixture.queuePath,
		statePath: fixture.statePath,
		briefingId: fixture.briefingId,
		sourceHash,
		expiresAt: new Date(now + lifetimeMs).toISOString(),
		providerScope: scope,
	};
	const signature = sign(null, Buffer.from(communityBriefingGrantPayload(unsigned)), keys.privateKey).toString(
		"base64",
	);
	try {
		return { host, grant: await Effect.runPromise(host.bind({ ...unsigned, signature }).authorize()) };
	} catch (error) {
		host.close();
		throw error;
	}
};
const row = (fixture: Fixture) => {
	const database = new DatabaseSync(fixture.queuePath, { readOnly: true });
	try {
		return database
			.prepare("SELECT status,attempts,google_doc_id,discord_message_id,error_message FROM community_briefings")
			.get();
	} finally {
		database.close();
	}
};

describe("signed native community runtime", () => {
	it.each(["symlink", "dangling-symlink", "invalid-utf8", "oversized"])(
		"rejects an unsafe %s revision marker",
		async (kind) => {
			const fixture = await makeCommunityRuntimeFixture();
			const { host, grant } = await signedRuntime(fixture);
			try {
				const marker = join(fixture.root, "revision-status.json");
				if (kind === "symlink" || kind === "dangling-symlink") {
					const target = join(fixture.root, "marker-target");
					if (kind === "symlink")
						writeFileSync(target, JSON.stringify({ nonce: "job", state: "completed", phase: "finished" }), {
							mode: 0o600,
						});
					symlinkSync(target, marker);
				} else
					writeFileSync(
						marker,
						kind === "invalid-utf8" ? Buffer.from([0xff]) : Buffer.alloc(1024 * 1024 + 1, 65),
						{ mode: 0o600 },
					);
				const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
				expect(failure).toMatchObject({ code: "artifact_reconciliation_required" });
				expect(fixture.wire.requests).toEqual([]);
				expect(row(fixture)).toMatchObject({ status: "blocked", google_doc_id: null, discord_message_id: null });
			} finally {
				host.close();
				await fixture.cleanup();
			}
		},
	);
	it.each([
		"{",
		"null",
		JSON.stringify({ nonce: "job", state: "running", phase: "generating" }),
		JSON.stringify({ nonce: "job", state: "running", phase: "committing" }),
		JSON.stringify({ nonce: "job", state: "failed", phase: "committing" }),
		JSON.stringify({ state: "completed", phase: "finished" }),
		JSON.stringify({ nonce: "job", state: "unknown", phase: "finished" }),
		JSON.stringify({ nonce: "job", state: ["completed"], phase: "finished" }),
		JSON.stringify({ nonce: "job", state: { completed: true }, phase: "finished" }),
	])("requires reconciliation for a nonterminal or invalid revision marker: %s", async (marker) => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			writeFileSync(join(fixture.root, "revision-status.json"), marker, { mode: 0o600 });
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ code: "artifact_reconciliation_required" });
			expect(fixture.wire.requests).toEqual([]);
			expect(row(fixture)).toMatchObject({ status: "blocked", error_message: "artifact_reconciliation_required" });
			expect(readFileSync(join(fixture.root, "revision-status.json"), "utf8")).toBe(marker);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it.each(["completed", "failed", "superseded"])(
		"preserves a terminal %s marker with an unchanged valid approval",
		async (state) => {
			const fixture = await makeCommunityRuntimeFixture();
			const { host, grant } = await signedRuntime(fixture);
			try {
				const marker = JSON.stringify({ nonce: "job", state, phase: "finished" });
				writeFileSync(join(fixture.root, "revision-status.json"), marker, { mode: 0o600 });
				await Effect.runPromise(runNativeCommunityBriefing(grant, () => now));
				expect(row(fixture)).toMatchObject({ status: "published" });
				expect(fixture.wire.messagesByNonce.size).toBe(1);
				expect(readFileSync(join(fixture.root, "revision-status.json"), "utf8")).toBe(marker);
			} finally {
				host.close();
				await fixture.cleanup();
			}
		},
	);
	it("rechecks the revision barrier after provider reads before writes", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			fixture.wire.onRequest = () =>
				writeFileSync(
					join(fixture.root, "revision-status.json"),
					JSON.stringify({ nonce: "job", state: "running", phase: "committing" }),
					{ mode: 0o600 },
				);
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			// Executor deliberately sanitizes a nested mutation-guard rejection.
			expect(failure).toMatchObject({ code: "invalid_grant" });
			expect(fixture.wire.requests.length).toBeGreaterThan(0);
			expect(fixture.wire.requests.every((request) => request.method === "GET")).toBe(true);
			expect(row(fixture)).toMatchObject({ status: "blocked", google_doc_id: null, discord_message_id: null });
			expect(JSON.parse(readFileSync(join(fixture.root, "revision-status.json"), "utf8"))).toEqual({
				nonce: "job",
				state: "running",
				phase: "committing",
			});
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it.each(["google", "discord"] as const)(
		"stops without replay when the %s receipt cannot be stored",
		async (stage) => {
			const fixture = await makeCommunityRuntimeFixture();
			const { host, grant } = await signedRuntime(fixture);
			let injected = false;
			try {
				fixture.wire.onRequest = (request) => {
					const checkpointResponse =
						stage === "google" ? request.path.endsWith(":batchUpdate") : request.path.endsWith("/messages");
					if (injected || request.method !== "POST" || !checkpointResponse) return;
					const database = new DatabaseSync(fixture.queuePath);
					try {
						database.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF ${stage === "google" ? "google_doc_id" : "discord_message_id"}
					ON community_briefings BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END;`);
						injected = true;
					} finally {
						database.close();
					}
				};
				const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
				expect(injected).toBe(true);
				expect(failure).toMatchObject({ stage, code: "checkpoint_write_failed" });
				expect(row(fixture)).toMatchObject({
					status: "blocked",
					attempts: 1,
					google_doc_id: stage === "google" ? null : expect.any(String),
					discord_message_id: null,
					error_message: "checkpoint_write_failed",
				});
				expect([...fixture.wire.files.values()].filter((file) => file.mimeType.endsWith("document"))).toHaveLength(
					1,
				);
				expect(fixture.wire.messagesByNonce.size).toBe(stage === "google" ? 0 : 1);
				const reopened = new CommunityBriefingQueue(fixture.queuePath);
				try {
					expect(reopened.claim(new Date(now + 3_600_000).toISOString())).toBeNull();
				} finally {
					reopened.close();
				}
			} finally {
				host.close();
				await fixture.cleanup();
			}
		},
	);
	it.each(["-wal", "-shm", "-journal"])("rejects a redirected queue %s before opening SQLite", async (suffix) => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			const target = join(fixture.root, "sidecar-sentinel");
			writeFileSync(target, "UNCHANGED_SENTINEL", { mode: 0o600 });
			symlinkSync(target, `${fixture.queuePath}${suffix}`);
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ cause: { message: "community_unsafe_sidecar" } });
			expect(readFileSync(target, "utf8")).toBe("UNCHANGED_SENTINEL");
			// Inspect only after removing the unsafe sidecar: opening SQLite itself
			// could otherwise follow it, even in a supposedly read-only assertion.
			renameSync(`${fixture.queuePath}${suffix}`, join(fixture.root, "preserved-sidecar-link"));
			expect(row(fixture)).toMatchObject({ status: "approved", attempts: 0 });
			expect(fixture.wire.requests).toEqual([]);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it("rejects queue triggers before a claim can alter approval or receipts", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			const database = new DatabaseSync(fixture.queuePath);
			try {
				database.exec(`CREATE TRIGGER redirect_claim AFTER UPDATE OF status ON community_briefings
				BEGIN UPDATE community_briefings SET approved_hash='altered'; END;`);
			} finally {
				database.close();
			}
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ cause: { message: "community_queue_trigger_rejected" } });
			expect(row(fixture)).toMatchObject({ status: "approved", attempts: 0 });
			expect(fixture.wire.requests).toEqual([]);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it("stops when signed runtime directories are replaced after provider reads", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		let replaced = false;
		try {
			fixture.wire.onRequest = () => {
				if (replaced) return;
				replaced = true;
				renameSync(fixture.credentialDirectory, `${fixture.credentialDirectory}.preserved`);
				mkdirSync(fixture.credentialDirectory, { mode: 0o700 });
				writeFileSync(
					join(fixture.credentialDirectory, "auth.json"),
					readFileSync(join(`${fixture.credentialDirectory}.preserved`, "auth.json")),
					{ mode: 0o600 },
				);
			};
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(replaced).toBe(true);
			expect(failure).toMatchObject({ code: "invalid_grant" });
			expect(row(fixture)).toMatchObject({ status: "blocked", google_doc_id: null, discord_message_id: null });
			expect(fixture.wire.requests.every((request) => request.method === "GET")).toBe(true);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it("keeps Google's receipt but stops Discord when authority expires during its preflight", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		let time = now;
		const { host, grant } = await signedRuntime(
			fixture,
			fixture.providerScope,
			fixture.sourceHash,
			() => time,
			60_000,
		);
		try {
			fixture.wire.onRequest = (request) => {
				if (request.path === "/users/@me") time = now + 60_000;
			};
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => time).pipe(Effect.flip));
			expect(time).toBe(now + 60_000);
			expect(failure).toMatchObject({ code: "invalid_grant" });
			expect(row(fixture)).toMatchObject({
				status: "blocked",
				google_doc_id: expect.any(String),
				discord_message_id: null,
			});
			expect(fixture.wire.messagesByNonce.size).toBe(0);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it.each(["auth.json", "auth.json.tmp"])("rejects a redirected %s before credential access", async (name) => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			const target = join(fixture.root, "outside-credentials");
			writeFileSync(target, "UNCHANGED_SENTINEL", { mode: 0o600 });
			const path = join(fixture.credentialDirectory, name);
			if (name === "auth.json") renameSync(path, `${path}.preserved`);
			symlinkSync(target, path);
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ cause: { message: "community_unsafe_credentials" } });
			expect(readFileSync(target, "utf8")).toBe("UNCHANGED_SENTINEL");
			expect(row(fixture)).toMatchObject({ status: "approved", attempts: 0 });
			expect(fixture.wire.requests).toEqual([]);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it.each(["symlink", "oversized", "invalid-utf8", "missing"])(
		"rejects %s approved artifacts before provider access",
		async (kind) => {
			const fixture = await makeCommunityRuntimeFixture();
			const { host, grant } = await signedRuntime(fixture);
			try {
				if (kind === "symlink") {
					renameSync(fixture.markdownPath, `${fixture.markdownPath}.preserved`);
					symlinkSync(`${fixture.markdownPath}.preserved`, fixture.markdownPath);
				} else if (kind === "missing") {
					renameSync(fixture.markdownPath, `${fixture.markdownPath}.preserved`);
				} else
					writeFileSync(
						fixture.markdownPath,
						kind === "oversized" ? Buffer.alloc(1024 * 1024 + 1, 65) : Buffer.from([0xff]),
					);
				const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
				expect(failure).toMatchObject({ stage: "google", code: "missing_approved_artifact" });
				expect(row(fixture)).toMatchObject({ status: "blocked", google_doc_id: null, discord_message_id: null });
				expect(fixture.wire.requests).toEqual([]);
			} finally {
				host.close();
				await fixture.cleanup();
			}
		},
	);
	it("does not publish edited bytes under an unchanged database approval", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			writeFileSync(fixture.discordPath, "This change was never approved.");
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ code: "approved_revision_mismatch" });
			expect(row(fixture)).toMatchObject({ status: "blocked", google_doc_id: null, discord_message_id: null });
			expect(fixture.wire.requests).toEqual([]);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
	it("reopens the existing Executor, publishes only approved bytes and saves both receipts", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			const result = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now));
			expect(result).toMatchObject({
				briefingId: fixture.briefingId,
				googleDocId: expect.any(String),
				discordMessageId: expect.any(String),
			});
			expect(row(fixture)).toMatchObject({
				status: "published",
				attempts: 1,
				google_doc_id: result.googleDocId,
				discord_message_id: result.discordMessageId,
				error_message: null,
			});
			expect(fixture.wire.messagesByNonce.size).toBe(1);
			expect([...fixture.wire.messagesByNonce.values()][0]?.content).toBe(
				`${readFileSync(fixture.discordPath, "utf8").trim()}\n\n[Read the weekly briefing](https://docs.google.com/document/d/${result.googleDocId}/view)`,
			);
			expect(fixture.wire.files.get(result.googleDocId)?.appProperties).toEqual({
				harnessyCommunityBriefingId: fixture.briefingId,
				harnessyCommunitySourceHash: fixture.sourceHash,
			});
			const batch = fixture.wire.requests.find(
				(request) => request.method === "POST" && request.path.endsWith(":batchUpdate"),
			);
			expect(batch?.body).toMatchObject({
				requests: expect.arrayContaining([
					{ insertText: { location: { index: 1 }, text: "Weekly Research Briefing\n\nDetails.\n" } },
				]),
			});
			const requests = fixture.wire.requests.length;
			const replay = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(replay).toMatchObject({ cause: { message: "community_grant_already_started" } });
			expect(fixture.wire.requests).toHaveLength(requests);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});

	it("does not claim another approved revision when the signed revision is absent", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture, fixture.providerScope, "f".repeat(64));
		try {
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(String(failure)).toContain("community_approved_item_unavailable");
			expect(row(fixture)).toMatchObject({ status: "approved", attempts: 0 });
			expect(fixture.wire.requests).toEqual([]);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});

	it("rejects a mismatched connection template before claiming or accessing providers", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture, {
			...fixture.providerScope,
			google: { ...fixture.providerScope.google, authTemplate: "google-drive-file" },
		});
		try {
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(String(failure)).toContain("community_connection_mismatch");
			expect(row(fixture)).toMatchObject({ status: "approved", attempts: 0 });
			expect(fixture.wire.requests).toEqual([]);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});

	it("fails before state acquisition for an unsafe queue binding", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			chmodSync(fixture.queuePath, 0o644);
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ cause: { message: "community_unsafe_path" } });
			expect(row(fixture)).toMatchObject({ status: "approved", attempts: 0 });
			expect(fixture.wire.requests).toEqual([]);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});

	it("rechecks revocation after provider reads before the first remote write", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			fixture.wire.onRequest = () => host.revoke("one-publication");
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ code: "invalid_grant" });
			expect(row(fixture)).toMatchObject({ status: "blocked", google_doc_id: null, discord_message_id: null });
			expect(fixture.wire.requests.length).toBeGreaterThan(0);
			expect(fixture.wire.requests.every((request) => request.method === "GET")).toBe(true);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});

	it("retains Google evidence and blocks retry after an uncertain Discord delivery", async () => {
		const fixture = await makeCommunityRuntimeFixture();
		const { host, grant } = await signedRuntime(fixture);
		try {
			fixture.wire.lostDiscordMessageCreateResponses = 1;
			const failure = await Effect.runPromise(runNativeCommunityBriefing(grant, () => now).pipe(Effect.flip));
			expect(failure).toMatchObject({ code: "delivery_uncertain" });
			expect(row(fixture)).toMatchObject({
				status: "blocked",
				attempts: 1,
				google_doc_id: expect.any(String),
				discord_message_id: null,
				error_message: "delivery_uncertain",
			});
			expect(fixture.wire.messagesByNonce.size).toBe(1);
			expect(
				fixture.wire.requests.filter((request) => request.method === "POST" && request.path.includes("/messages")),
			).toHaveLength(1);
		} finally {
			host.close();
			await fixture.cleanup();
		}
	});
});
