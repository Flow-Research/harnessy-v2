import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { communityBriefingGrantPayload } from "@packed/core-community";
import { CommunityOperationSystemReference } from "@packed/core-community-operational-runtime";
import { MeetingPublicationSmokeRuntimeSystemReference } from "@packed/core-operational-runtime";
import { runCommunityPublicationCommand } from "@packed/local-host-community-command";
import { Effect } from "effect";
import { makeCommunityRuntimeFixture } from "../../../harnessy-sdk/test/support/community-runtime-fixture.ts";
import { preparePackedCombinedMeeting } from "./packed-combined-publication.mjs";

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
for (const scenario of ["success", "partial-revocation", "interruption", "service", "combined", "combined-revocation", "combined-drain"]) {
	const completed = ["success", "service", "combined", "combined-drain"].includes(scenario);
	const reusable = ["service", "combined", "combined-drain"].includes(scenario);
	const f = await makeCommunityRuntimeFixture();
	const ownerRoot = mkdtempSync(join(realpathSync(tmpdir()), "packed-community-owner-"));
	try {
		const snapshot = new DatabaseSync(f.engineStatePath);
		try { snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } finally { snapshot.close(); }
		const keys = generateKeyPairSync("ed25519");
		const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
		const privateFile = (name, value) => {
			const path = join(f.root, `${name}.json`);
			writeFileSync(path, canonical(value), { mode: 0o600 });
			return boundFile(path);
		};
		const controlDirectory = join(ownerRoot, "control");
		mkdirSync(controlDirectory, { mode: 0o700 });
		const publicKeyPath = join(ownerRoot, "owner-public.pem");
		writeFileSync(publicKeyPath, pem, { mode: 0o600 });
		const setupInput = privateFile("setup", {
			kind: "harnessy.community.briefing.service-setup.v1",
			stateDirectory: f.statePath, controlDirectory, publicKeyPath,
			publicKeySha256: digest(keys.publicKey.export({ type: "spki", format: "der" })),
			issuer: "fixture", keyId: "fixture-key",
		});
		const beforeSetup = [f.queuePath, f.engineStatePath].map(path => readFileSync(path));
		const setup = await Effect.runPromise(runCommunityPublicationCommand(["--setup-service", "--input", setupInput.path]));
		assert.equal(setup.exitCode, 0);
		assert.equal(setup.value.activated, false);
		assert.deepEqual([f.queuePath, f.engineStatePath].map(path => readFileSync(path)), beforeSetup);
		assert.equal(f.wire.requests.length, 0);
		const trust = boundFile(join(controlDirectory, "community-trust.json"));
		assert.deepEqual(setup.value.trustedKeyring, trust);
		const ledgerPath = join(f.statePath, "community-grants.sqlite3");
		const ledger = boundFile(ledgerPath);
		const now = Date.now();
		const combined = scenario.startsWith("combined") ? await preparePackedCombinedMeeting(f, installationRoot, scenario === "combined-revocation", scenario === "combined-drain") : undefined;
		const observation = combined?.observation ?? { now, monotonic: 1000n, platform: "darwin", architecture: process.arch, hostname: "packed-fixture", uid: BigInt(process.geteuid?.() ?? 0), bootId: "packed-fixture-boot", executablePath: realpathSync(process.execPath) };
		const queue = boundFile(f.queuePath), engine = boundFile(f.engineStatePath);
		const sourcePath = join(f.root, "sources"), draftPath = join(f.root, "drafts");
		mkdirSync(sourcePath, {mode:0o700});
		mkdirSync(draftPath, {mode:0o700});
		const payload = {
			issuer: "fixture", grantId: "a".repeat(64), queuePath: f.queuePath, statePath: f.statePath, briefingId: f.briefingId, sourceHash: f.sourceHash, expiresAt: new Date(now + 600_000).toISOString(), providerScope: f.providerScope,
			operational: {
				kind: "harnessy.community.briefing.operation.v1", keyId: "fixture-key", issuedAt: new Date(now).toISOString(), notBefore: new Date(now).toISOString(),
				runtime: { platform: observation.platform, architecture: observation.architecture, hostname: observation.hostname, uid: String(observation.uid), bootId: observation.bootId, executablePath: observation.executablePath, executableSha256: boundFile(observation.executablePath).sha256 },
				ledger: { path: ledger.path, device: ledger.device, inode: ledger.inode },
				queue: { device: queue.device, inode: queue.inode, sha256: queue.sha256 }, engine: { device: engine.device, inode: engine.inode, sha256: engine.sha256 },
				config: privateFile("config", { providerScope: f.providerScope, sourcePath, draftPath }), artifactManifest: privateFile("manifest", manifest), cutoverEvidence: privateFile("cutover", { fixtureOnly: true }), rollbackPlan: privateFile("rollback", { fixtureOnly: true }),
			},
		};
		const authorization = privateFile("authorization", { ...payload, signature: sign(null, Buffer.from(communityBriefingGrantPayload(payload)), keys.privateKey).toString("base64") });
		let args = ["--authorization", authorization.path, "--trusted-keyring", trust.path, "--trusted-keyring-device", trust.device, "--trusted-keyring-inode", trust.inode, "--trusted-keyring-sha256", trust.sha256];
		const command = (argv) => runCommunityPublicationCommand(argv).pipe(
			Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, { observe: () => observation, proveNoKnownV1Writers: () => { throw new Error("Wrong workflow observer"); } }),
			Effect.provideService(CommunityOperationSystemReference, { coreAnchor: paths.core, proveCompatibilityAbsent: () => {} }),
		);
		if (scenario === "service" || combined !== undefined) {
			const output = join(ownerRoot, "enrollment");
			mkdirSync(output, {mode:0o700});
			const input = privateFile("preparation", {
				issuer:"fixture", keyId:"fixture-key", queuePath:f.queuePath, statePath:f.statePath,
				configPath:payload.operational.config.path, installationRoot,
				cutoverEvidencePath:payload.operational.cutoverEvidence.path, rollbackPlanPath:payload.operational.rollbackPlan.path,
				trustedKeyring:trust,
			});
			const before = [f.queuePath, ledgerPath, f.engineStatePath].map(path => readFileSync(path));
			const prepared = await Effect.runPromise(command(["--prepare-service", "--input", input.path, "--output-directory", output]));
			assert.equal(prepared.exitCode, 0);
			assert.equal(prepared.value.activated, false);
			const requestPath = join(output, "request.json");
			assert.equal(prepared.value.requestSha256, digest(readFileSync(requestPath)));
			const keyPath = join(ownerRoot, "owner.pem");
			writeFileSync(keyPath, keys.privateKey.export({type:"pkcs8",format:"pem"}), {mode:0o600});
			const signed = await Effect.runPromise(command(["--enroll-service", "--request", requestPath,
				"--request-sha256", prepared.value.requestSha256, "--owner-key", keyPath,
				"--public-key-sha256", digest(keys.publicKey.export({type:"spki",format:"der"})),
				"--output", join(output, "enrollment.json")]));
			assert.equal(signed.exitCode, 0);
			assert.equal(signed.value.activated, false);
			assert.deepEqual([f.queuePath, ledgerPath, f.engineStatePath].map(path => readFileSync(path)), before);
			assert.equal(f.wire.requests.length, 0);
			args = ["--service-config", join(output, "service.json")];
		}
		const run = () => command(args);
		const controller = new AbortController();
		let injected = false;
		f.wire.onRequest = (request) => {
			if (scenario === "interruption" && !injected) { injected = true; controller.abort(); }
			if (["partial-revocation", "combined-revocation"].includes(scenario) && request.method === "POST" && request.path.endsWith("/permissions")) {
				injected = true;
				const db = new DatabaseSync(ledgerPath);
				try { db.prepare("UPDATE community_briefing_grants SET revoked=1").run(); } finally { db.close(); }
			}
		};
		const result = await Effect.runPromiseExit(combined === undefined ? run() : combined.run(args[1]).pipe(
			Effect.provideService(CommunityOperationSystemReference, { coreAnchor: paths.core, proveCompatibilityAbsent: () => {} }),
			Effect.as({ exitCode: 0 }),
		), { signal: controller.signal });
		if (scenario !== "interruption") {
			assert.equal(result._tag, "Success", `Community ${scenario} exited before receipt inspection: ${JSON.stringify(result, (_key, value) => value instanceof Error ? { ...value, message: value.message } : value)}`);
			assert.equal(result.value.exitCode, scenario === "partial-revocation" ? 1 : 0,
				`Community ${scenario} failed before receipt inspection: ${JSON.stringify(result.value)}`);
		}
		const db = new DatabaseSync(ledgerPath, { readOnly: true });
		let consumed, leases;
		try { consumed = db.prepare("SELECT COUNT(*) n FROM community_briefing_grants").get().n; leases = db.prepare("SELECT COUNT(*) n FROM community_briefing_lease").get().n; } finally { db.close(); }
		const queueDb = new DatabaseSync(f.queuePath, { readOnly: true });
		let row;
		try { row = queueDb.prepare("SELECT * FROM community_briefings").get(); } finally { queueDb.close(); }
		assert.equal(consumed, 1);
		assert.equal(row.approved_hash, f.sourceHash);
		assert.ok(f.wire.requests.length > 0);
		if (completed) {
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
			else {
				assert.equal(result._tag, "Success");
				assert.equal(result.value.exitCode, scenario === "combined-revocation" ? 0 : 1);
				if (row.google_doc_id === null) {
					// A one-shot authority monitor can win after the remote permission
					// mutation but before its response becomes a durable checkpoint. That
					// is an uncertain delivery: retain the singleton lease and never replay.
					assert.equal(scenario, "partial-revocation");
					assert.ok(f.wire.permissions.size > 0);
					assert.ok(["publishing", "blocked"].includes(row.status));
				} else assert.equal(typeof row.google_doc_id, "string");
			}
		}
		const count = f.wire.requests.length;
		const replay = await Effect.runPromise(run());
		assert.equal(replay.exitCode, reusable ? 0 : 1);
		if (reusable) {
			assert.equal(replay.value.status, "idle");
			const status = await Effect.runPromise(command(["--service-status", ...args]));
			assert.equal(status.value.enrollment, "enrolled");
			assert.equal(status.value.ownership, "none");
			assert.equal((await Effect.runPromise(command(["--revoke-service", ...args]))).value.revoked, true);
			assert.equal((await Effect.runPromise(run())).exitCode, 1);
		}
		assert.equal(f.wire.requests.length, count);
		totalRequests += count;
	} finally { await f.cleanup(); rmSync(ownerRoot, {recursive:true, force:true}); }
}
process.stdout.write(`${JSON.stringify({ published: true, installedCommand: true, combinedMeetingOwner: true, combinedRevocation: true, combinedDrain: true, servicePreparation: true, serviceEnrollment: true, serviceRevocation: true, replayRejected: true, receiptsPreserved: true, interruptionPreserved: true, providerRequests: totalRequests })}\n`);
