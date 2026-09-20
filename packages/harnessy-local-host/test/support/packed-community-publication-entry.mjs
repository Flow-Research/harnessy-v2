import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommunityBriefingGrantHost, communityBriefingGrantPayload } from "@packed/core-community";
import { CommunityOperationSystemReference } from "@packed/core-community-operational-runtime";
import { MeetingPublicationSmokeRuntimeSystemReference } from "@packed/core-operational-runtime";
import { runCommunityPublicationCommand } from "@packed/local-host-community-command";
import { Effect } from "effect";
import { makeCommunityRuntimeFixture } from "../../../harnessy-sdk/test/support/community-runtime-fixture.ts";

// Source imports only seed synthetic stores/providers. Publication and authority
// verification below run exclusively through extracted, installed package code.
const installationRoot = realpathSync(process.argv[2]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const canonicalValue = (value) => {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalValue);
	return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonicalValue(entry)]));
};
const canonical = (value) => `${JSON.stringify(canonicalValue(value))}\n`;
const boundFile = (path) => {
	const stat = lstatSync(path, { bigint: true });
	return { path: realpathSync(path), device: String(stat.dev), inode: String(stat.ino), sha256: digest(readFileSync(path)) };
};
const paths = {
	core: join(installationRoot, "node_modules/@harnessy/core/dist/jarvis/community-briefing/operational-runtime.js"),
	host: join(installationRoot, "node_modules/@harnessy/local-host/dist/community-publication-command.js"),
	sdk: join(installationRoot, "node_modules/@harnessy/sdk/dist/node.js"),
	dependencies: join(installationRoot, "node_modules/effect/dist/index.js"),
};
const inventory = [];
const visit = (directory) => {
	for (const name of readdirSync(directory).sort()) {
		const path = join(directory, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) visit(path);
		else if (stat.isFile()) inventory.push(path);
		else throw new Error("Packed community artifact contains a link or special file.");
	}
};
visit(installationRoot);
const manifest = {
	kind: "harnessy.runtime-artifact-manifest", schemaVersion: 1, root: installationRoot,
	anchors: Object.entries(paths).map(([role, path]) => ({ role, path })),
	files: inventory.sort().map(boundFile),
};
let totalRequests = 0;
for (const scenario of ["success", "partial-revocation", "interruption"]) {
	const f = await makeCommunityRuntimeFixture();
	try {
		const snapshot = new DatabaseSync(f.engineStatePath);
		try { snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { snapshot.close(); }
		const keys = generateKeyPairSync("ed25519");
		const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
		const seed = new CommunityBriefingGrantHost(f.statePath, new Map([["fixture", pem]]), f.queuePath, f.statePath, f.providerScope);
		seed.close();
		const privateFile = (name, value) => {
			const path = join(f.root, `${name}.json`);
			writeFileSync(path, canonical(value), { mode: 0o600 });
			return boundFile(path);
		};
		const trust = privateFile("trust", { kind: "harnessy.community.briefing.trust.v1", keys: [{ issuer: "fixture", keyId: "fixture-key", publicKeyPem: pem, publicKeySha256: digest(keys.publicKey.export({ type: "spki", format: "der" })) }] });
		const ledgerPath = join(f.statePath, "community-grants.sqlite3");
		const ledger = boundFile(ledgerPath);
		const now = Date.now();
		const observation = { now, monotonic: 1000n, platform: "darwin", architecture: process.arch, hostname: "packed-fixture", uid: BigInt(process.geteuid?.() ?? 0), bootId: "packed-fixture-boot", executablePath: realpathSync(process.execPath) };
		const queue = boundFile(f.queuePath), engine = boundFile(f.engineStatePath);
		const payload = {
			issuer: "fixture", grantId: "a".repeat(64), queuePath: f.queuePath, statePath: f.statePath, briefingId: f.briefingId, sourceHash: f.sourceHash, expiresAt: new Date(now + 600_000).toISOString(), providerScope: f.providerScope,
			operational: {
				kind: "harnessy.community.briefing.operation.v1", keyId: "fixture-key", issuedAt: new Date(now).toISOString(), notBefore: new Date(now).toISOString(),
				runtime: { platform: observation.platform, architecture: observation.architecture, hostname: observation.hostname, uid: String(observation.uid), bootId: observation.bootId, executablePath: observation.executablePath, executableSha256: boundFile(observation.executablePath).sha256 },
				ledger: { path: ledger.path, device: ledger.device, inode: ledger.inode },
				queue: { device: queue.device, inode: queue.inode, sha256: queue.sha256 }, engine: { device: engine.device, inode: engine.inode, sha256: engine.sha256 },
				config: privateFile("config", { providerScope: f.providerScope }), artifactManifest: privateFile("manifest", manifest), cutoverEvidence: privateFile("cutover", { fixtureOnly: true }), rollbackPlan: privateFile("rollback", { fixtureOnly: true }),
			},
		};
		const authorization = privateFile("authorization", { ...payload, signature: sign(null, Buffer.from(communityBriefingGrantPayload(payload)), keys.privateKey).toString("base64") });
		const args = ["--authorization", authorization.path, "--trusted-keyring", trust.path, "--trusted-keyring-device", trust.device, "--trusted-keyring-inode", trust.inode, "--trusted-keyring-sha256", trust.sha256];
		const run = () => runCommunityPublicationCommand(args).pipe(
			Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, { observe: () => observation, proveNoKnownV1Writers: () => { throw new Error("Wrong workflow observer"); } }),
			Effect.provideService(CommunityOperationSystemReference, { coreAnchor: paths.core, proveCompatibilityAbsent: () => {} }),
		);
		const controller = new AbortController();
		let injected = false;
		f.wire.onRequest = (request) => {
			if (scenario === "interruption" && !injected) { injected = true; controller.abort(); }
			if (scenario === "partial-revocation" && request.method === "POST" && request.path.endsWith("/permissions")) {
				injected = true;
				const db = new DatabaseSync(ledgerPath);
				try { db.prepare("UPDATE community_briefing_grants SET revoked=1").run(); } finally { db.close(); }
			}
		};
		const result = await Effect.runPromiseExit(run(), { signal: controller.signal });
		const db = new DatabaseSync(ledgerPath, { readOnly: true });
		let consumed, leases;
		try { consumed = db.prepare("SELECT COUNT(*) n FROM community_briefing_grants").get().n; leases = db.prepare("SELECT COUNT(*) n FROM community_briefing_lease").get().n; } finally { db.close(); }
		const queueDb = new DatabaseSync(f.queuePath, { readOnly: true });
		let row;
		try { row = queueDb.prepare("SELECT * FROM community_briefings").get(); } finally { queueDb.close(); }
		assert.equal(consumed, 1);
		assert.equal(row.approved_hash, f.sourceHash);
		assert.ok(f.wire.requests.length > 0);
		if (scenario === "success") {
			assert.equal(result._tag, "Success");
			assert.equal(result.value.exitCode, 0);
			assert.equal(row.status, "published");
			assert.ok(row.google_doc_id && row.discord_message_id);
			assert.equal(leases, 0);
		} else {
			assert.equal(injected, true);
			assert.equal(leases, 1);
			assert.equal(row.discord_message_id, null);
			if (scenario === "interruption") assert.equal(result._tag, "Failure");
			else { assert.equal(result._tag, "Success"); assert.equal(result.value.exitCode, 1); assert.ok(row.google_doc_id); }
		}
		const count = f.wire.requests.length;
		const replay = await Effect.runPromise(run());
		assert.equal(replay.exitCode, 1);
		assert.equal(f.wire.requests.length, count);
		totalRequests += count;
	} finally { await f.cleanup(); }
}
process.stdout.write(`${JSON.stringify({ published: true, installedCommand: true, replayRejected: true, receiptsPreserved: true, interruptionPreserved: true, providerRequests: totalRequests })}\n`);
