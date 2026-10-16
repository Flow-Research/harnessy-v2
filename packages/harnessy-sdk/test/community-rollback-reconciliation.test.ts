import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CommunityBriefingGrantHost, communityBriefingGrantPayload } from "@harnessy/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CommunityBriefingQueue } from "../src/community-briefing/queue.ts";
import { runNativeCommunityBriefing } from "../src/community-briefing/runtime.ts";
import { makeCommunityRuntimeFixture } from "./support/community-runtime-fixture.ts";

const now = Date.parse("2026-09-19T01:00:00.000Z");
const expired = "2026-09-20T01:00:00.000Z";

// Explicit installed compatibility acceptance: ordinary SDK runs remain native-only.
// Once either binding is supplied, a missing peer or failed probe MUST fail the gate.
const compatibilityReopen = (database: string, state: string) => {
	const python = process.env.HARNESSY_TEST_COMMUNITY_PYTHON;
	const source = process.env.HARNESSY_TEST_COMMUNITY_SOURCE;
	if (python === undefined && source === undefined) return;
	if (!python || !source) throw new Error("Both installed community compatibility bindings are required.");
	const result = spawnSync(
		python,
		[
			"-I",
			"-B",
			fileURLToPath(new URL("./support/community-rollback-reader.py", import.meta.url)),
			source,
			database,
			state,
		],
		{ encoding: "utf8", timeout: 20_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
	);
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
	expect(JSON.parse(result.stdout)).toMatchObject({ rows: 1, claimable: false, unchanged: true });
	const restored = join(state, "weekly-briefings.sqlite3");
	const native = new CommunityBriefingQueue(restored);
	try {
		expect(native.claim(expired)).toBeNull();
	} finally {
		native.close();
	}
	expect(queueRows(restored)).toEqual(queueRows(database));
};

const queueRows = (path: string) => {
	const database = new DatabaseSync(path, { readOnly: true });
	try {
		expect(database.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
		return database.prepare("SELECT * FROM community_briefings ORDER BY briefing_id").all();
	} finally {
		database.close();
	}
};

/** SQLite's online-backup API, not a main-file copy of a live WAL database. */
const consistentBackup = async (source: string, destination: string) => {
	const database = new DatabaseSync(source, { readOnly: true });
	try {
		await backup(database, destination);
		chmodSync(destination, 0o600);
	} finally {
		database.close();
	}
};

describe(
	process.env.HARNESSY_TEST_COMMUNITY_PYTHON !== undefined || process.env.HARNESSY_TEST_COMMUNITY_SOURCE !== undefined
		? "installed compatibility/native dual-reader rollback acceptance"
		: "native-only community receipt-preserving backup and reopen",
	() => {
		it.each(["completed", "uncertain-discord"] as const)(
			"preserves %s evidence through consistent backup; stale queue cannot replay its consumed grant",
			async (outcome) => {
				const fixture = await makeCommunityRuntimeFixture();
				const keys = generateKeyPairSync("ed25519");
				const trusted = new Map([
					["fixture-owner", keys.publicKey.export({ type: "spki", format: "pem" }).toString()],
				]);
				const authority = join(fixture.root, "authority");
				let host: CommunityBriefingGrantHost | undefined;
				try {
					const snapshots = join(fixture.root, "snapshots");
					mkdirSync(snapshots, { mode: 0o700 });
					const stale = join(snapshots, "before.sqlite3");
					await consistentBackup(fixture.queuePath, stale);
					const artifacts = [fixture.markdownPath, fixture.discordPath, join(fixture.root, "proof.json")];
					const bytes = artifacts.map((path) => readFileSync(path));
					const unsigned = {
						issuer: "fixture-owner",
						grantId: "one-publication",
						queuePath: fixture.queuePath,
						statePath: fixture.statePath,
						briefingId: fixture.briefingId,
						sourceHash: fixture.sourceHash,
						expiresAt: new Date(now + 600_000).toISOString(),
						providerScope: fixture.providerScope,
					};
					const envelope = {
						...unsigned,
						signature: sign(null, Buffer.from(communityBriefingGrantPayload(unsigned)), keys.privateKey).toString(
							"base64",
						),
					};
					host = new CommunityBriefingGrantHost(
						authority,
						trusted,
						fixture.queuePath,
						fixture.statePath,
						fixture.providerScope,
						() => now,
					);
					const grant = await Effect.runPromise(host.bind(envelope).authorize());
					if (outcome === "uncertain-discord") fixture.wire.lostDiscordMessageCreateResponses = 1;
					const result = await Effect.runPromiseExit(runNativeCommunityBriefing(grant, () => now));
					expect(result._tag).toBe(outcome === "completed" ? "Success" : "Failure");
					host.close();
					host = undefined;
					const latestRows = queueRows(fixture.queuePath);
					expect(latestRows).toHaveLength(1);
					expect(latestRows[0]).toMatchObject({
						status: outcome === "completed" ? "published" : "blocked",
						approved_hash: fixture.sourceHash,
						draft_hash: fixture.sourceHash,
						attempts: 1,
						google_doc_id: expect.any(String),
						google_doc_url: expect.any(String),
						discord_message_id: outcome === "completed" ? expect.any(String) : null,
						error_message: outcome === "completed" ? null : "delivery_uncertain",
					});
					// The uncertain request really reached the simulated provider. Missing
					// local receipt is deliberately NOT treated as proof of non-delivery.
					expect(fixture.wire.messagesByNonce.size).toBe(1);
					const requestCount = fixture.wire.requests.length;
					const latest = join(snapshots, "latest.sqlite3");
					await consistentBackup(fixture.queuePath, latest);
					const authoritySnapshot = join(snapshots, "authority");
					mkdirSync(authoritySnapshot, { mode: 0o700 });
					await consistentBackup(
						join(authority, "community-grants.sqlite3"),
						join(authoritySnapshot, "community-grants.sqlite3"),
					);
					expect(queueRows(latest)).toEqual(latestRows);
					compatibilityReopen(latest, join(snapshots, "compatibility"));
					for (const [index, path] of artifacts.entries()) {
						const destination = join(snapshots, `artifact-${index}`);
						copyFileSync(path, destination);
						chmodSync(destination, 0o600);
						expect(readFileSync(destination)).toEqual(bytes[index]);
					}
					const reopened = new CommunityBriefingQueue(latest);
					try {
						expect(reopened.claim(expired)).toBeNull();
					} finally {
						reopened.close();
					}
					expect(queueRows(latest)).toEqual(latestRows);
					// Negative control: deliberately restore only the pre-delivery queue
					// in isolated fixture state. Retain the latest consumed-grant ledger.
					copyFileSync(stale, fixture.queuePath);
					expect(queueRows(fixture.queuePath)[0]).toMatchObject({
						status: "approved",
						attempts: 0,
						google_doc_id: null,
					});
					host = new CommunityBriefingGrantHost(
						authoritySnapshot,
						trusted,
						fixture.queuePath,
						fixture.statePath,
						fixture.providerScope,
						() => now,
					);
					await expect(Effect.runPromise(host.bind(envelope).authorize())).rejects.toThrow(/consumed or revoked/);
					host.close();
					host = undefined;
					// The manual procedure selects latest reconciled state, never stale.
					copyFileSync(latest, fixture.queuePath);
					expect(queueRows(fixture.queuePath)).toEqual(latestRows);
					expect(fixture.wire.requests).toHaveLength(requestCount);
				} finally {
					host?.close();
					await fixture.cleanup();
				}
			},
		);

		it("preserves an interrupted claim and its partial receipt without reclaiming its expired lease", async () => {
			const fixture = await makeCommunityRuntimeFixture();
			try {
				const queue = new CommunityBriefingQueue(fixture.queuePath);
				try {
					const claim = queue.claim(new Date(now).toISOString())!;
					// Exercise the production checkpoint API with a synthetic receipt;
					// this case tests persistence, not provider delivery acceptance.
					queue.recordGoogle(
						claim,
						"synthetic-doc",
						"https://docs.google.com/document/d/synthetic-doc/edit",
						new Date(now).toISOString(),
					);
				} finally {
					queue.close();
				}
				const before = queueRows(fixture.queuePath);
				expect(before[0]).toMatchObject({
					status: "publishing",
					attempts: 1,
					lease_until: expect.any(String),
					google_doc_id: "synthetic-doc",
				});
				const snapshot = join(fixture.root, "interrupted.sqlite3");
				await consistentBackup(fixture.queuePath, snapshot);
				compatibilityReopen(snapshot, join(fixture.root, "compatibility"));
				const reopened = new CommunityBriefingQueue(snapshot);
				try {
					expect(reopened.claim(expired)).toBeNull();
				} finally {
					reopened.close();
				}
				expect(queueRows(snapshot)).toEqual(before);
				expect(fixture.wire.requests).toEqual([]);
			} finally {
				await fixture.cleanup();
			}
		});
	},
);
