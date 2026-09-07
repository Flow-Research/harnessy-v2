import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createMeetingPublicationReviewAuthorizationFixture } from "../../../harnessy-core/test/support/meeting-review-runtime-fixture.ts";

const installationRoot = process.argv[2];
const root = process.argv[3];
const assert = (value, message) => { if (!value) throw new Error(message); };
const snapshot = path => {
	const stat = lstatSync(path, {bigint: true});
	return [stat.dev.toString(), stat.ino.toString(), stat.mode.toString(), stat.size.toString(),
		stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.isDirectory()
			? readdirSync(path).sort().map(name => [name, snapshot(join(path, name))])
			: createHash("sha256").update(readFileSync(path)).digest("hex")];
};
assert(!existsSync(join(installationRoot, "node_modules/@harnessy/sdk")), "Review fixture must run without SDK installed");
for (const name of ["notes", "state", "control"]) {
	mkdirSync(join(root, name), {mode: 0o700});
	chmodSync(join(root, name), 0o700);
}
const sourcePath = join(root, "notes");
const statePath = join(root, "state");
const v1StatePath = statePath;
writeFileSync(join(sourcePath, "meeting.md"),
	"# Weekly Sync\n\n## Metadata\n- Project: alpha\n- Date: 2026-09-04\n- Fingerprint: review-fixture\n\n## Executive Summary\nPrepare without publishing.\n\n## Meeting Purpose\nReview migration readiness.\n", {mode: 0o600});
const v1ReviewToken = "v1-review-token-remains-private-1234567890A";
const v1Sentinels = new Map([
	[join(v1StatePath, "queue.sqlite3"), Buffer.from("V1 meeting queue remains unchanged.\n")],
	[join(v1StatePath, "weekly-briefings.sqlite3"), Buffer.from("V1 weekly briefing state remains unchanged.\n")],
	[join(v1StatePath, "review.token"), Buffer.from(`${v1ReviewToken}\n`)],
	[join(v1StatePath, "review.log"), Buffer.from("V1 review log remains unchanged.\n")],
]);
for (const [path, bytes] of v1Sentinels) {
	writeFileSync(path, bytes, {mode: 0o600});
	chmodSync(path, 0o600);
}
const sentinelState = path => ({
	bytes: createHash("sha256").update(readFileSync(path)).digest("hex"),
	mode: Number(lstatSync(path, {bigint: true}).mode & 0o7777n),
});
const v1SentinelsBefore = [...v1Sentinels.keys()].map(sentinelState);
const config = {
	enabled: false, project: "alpha", sourcePath, statePath, backfillDays: 365, cutoverDate: "2026-01-01",
	maxFileBytes: 32_000, maxFiles: 100, leaseSeconds: 60, reminderSeconds: 3600,
	reviewHost: "127.0.0.1", reviewPort: 0, reviewSessionSeconds: 900, reviewMaxSessions: 64,
	reviewMaxBodyBytes: 4096, googleOwnerEmail: null, googleDriveFolder: null, discordChannelId: null,
};
const fixture = createMeetingPublicationReviewAuthorizationFixture({
	privateRoot: join(root, "control"), config, v1StatePath, installationRoot,
	artifactAnchors: {
		core: join(installationRoot, "node_modules/@harnessy/core/dist/jarvis/meeting-publication/operational-input.js"),
		host: join(installationRoot, "node_modules/@harnessy/local-host/dist/meeting-review-runtime.js"),
		dependencies: fileURLToPath(import.meta.resolve("effect")),
	},
});
const sourceBefore = JSON.stringify(snapshot(sourcePath));
// Sign read-only machine identity for the actual CLI; never inject its runtime.
let bootId;
if (process.platform === "darwin") {
	const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {encoding: "utf8", timeout: 2000, maxBuffer: 4096});
	assert(result.status === 0, "Could not read fixture boot identity");
	bootId = result.stdout.trim();
	assert(/^\{ sec = \d+, usec = \d+ \} .+$/u.test(bootId), "Invalid Darwin boot identity");
} else {
	assert(process.platform === "linux", "Unsupported review fixture platform");
	bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	assert(/^[a-f0-9-]{36}$/u.test(bootId), "Invalid Linux boot identity");
}
fixture.resign(payload => { payload.runtime.bootId = bootId; });
const bounded = async (promise, milliseconds, message) => {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), milliseconds);
	})]); } finally { clearTimeout(timer); }
};
const call = async (origin, path, init = {}) => {
	const started = Date.now();
	try {
		const response = await fetch(`${origin}${path}`, {...init, signal: AbortSignal.timeout(15_000), redirect: "manual", headers: {Connection: "close", ...init.headers}});
		return {status: response.status, headers: response.headers, body: await response.text()};
	} catch {
		throw new Error(`Fixture ${path.split(/[/?]/u)[1]} request failed after ${Date.now() - started}ms`);
	}
};
const pin = fixture.input.trustedKeyring;
const child = spawn(process.execPath, [
	join(installationRoot, "node_modules/@harnessy/local-host/dist/meeting-review-cli.js"),
	"--authorization", fixture.input.authorizationPath,
	"--trusted-keyring", pin.path, "--trusted-keyring-device", pin.device,
	"--trusted-keyring-inode", pin.inode, "--trusted-keyring-sha256", pin.sha256,
], {cwd: installationRoot, env: {...process.env, NODE_NO_WARNINGS: "1"}, stdio: ["ignore", "pipe", "pipe"]});
let stdout = "";
let stderr = "";
let outputError;
let closed = false;
let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
const completion = new Promise(resolve => {
	child.once("error", () => { rejectReady(new Error("Review CLI spawn failed")); });
	child.once("close", (code, signal) => {
		closed = true;
		rejectReady(new Error("Review CLI closed before readiness"));
		resolve({code, signal});
	});
});
const failOutput = () => {
	outputError = new Error(`Unexpected review CLI output: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
	rejectReady(outputError);
	child.kill("SIGTERM");
};
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => {
	if (stdout.length + chunk.length > 4096) return failOutput();
	stdout += chunk;
	if (!stdout.includes("\n")) return;
	try {
		const address = JSON.parse(stdout);
		assert(Object.keys(address).sort().join(",") === "kind,origin" &&
			address.kind === "harnessy.meeting-publication.review-ready" &&
			/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u.test(address.origin) &&
			Number(new URL(address.origin).port) <= 65535 &&
			stdout === `${JSON.stringify(address)}\n`, "Invalid readiness output");
		resolveReady(address);
	} catch { failOutput(); }
});
child.stderr.on("data", chunk => {
	if (stderr.length + chunk.length > 4096) return failOutput();
	stderr += chunk;
});
let reviewOrigin;
try {
		const address = await bounded(ready, 30_000, "Review CLI readiness timed out");
		reviewOrigin = address.origin;
		const database = new DatabaseSync(join(statePath, "meeting-publication.sqlite3"), {readOnly: true});
		let item;
		try { item = database.prepare("SELECT item_id,source_hash,status FROM publication_items").get(); }
		finally { database.close(); }
	assert(item?.status === "pending_review", "Scan did not prepare a pending item");
	const oldExchange = await call(address.origin, `/exchange?token=${encodeURIComponent(v1ReviewToken)}`);
	assert(oldExchange.status === 401, "V1 review token authenticated to the V2 review server");
	const token = readFileSync(join(statePath, "meeting-publication-v2-review.token"), "utf8").trim();
	const exchanged = await call(address.origin, `/exchange?token=${encodeURIComponent(token)}`);
		assert(exchanged.status === 303, "Token exchange failed");
		const cookie = exchanged.headers.get("set-cookie")?.split(";", 1)[0];
		assert(cookie, "Missing review cookie");
		const page = await call(address.origin, `/item/${item.item_id}`, {headers: {Cookie: cookie}});
		assert(page.status === 200 && !page.body.includes("update-note"), "Review did not hide source editing");
		const csrf = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(page.body)?.[1];
		assert(csrf, "Missing CSRF field");
		const body = new URLSearchParams({csrf, item_id: item.item_id, source_hash: item.source_hash, purpose: "Review migration readiness."}).toString();
		const request = {method: "POST", body, headers: {Cookie: cookie, Origin: address.origin, "Content-Type": "application/x-www-form-urlencoded"}};
		assert((await call(address.origin, `/update-note/${item.item_id}`, request)).status === 404, "Source update route is reachable");
		assert((await call(address.origin, `/approve/${item.item_id}`, request)).status === 303, "Approval failed");
		assert(child.kill("SIGTERM"), "Could not signal fixture review CLI");
		const result = await bounded(completion, 10_000, "Review CLI shutdown timed out");
		assert(!outputError && result.code === 143 && result.signal === null, "Review CLI did not exit cleanly after SIGTERM");
		assert(stderr === `${JSON.stringify({error: "meeting_review_failed", code: "interrupted"})}\n`, "Unexpected review CLI error output");
} finally {
	if (!closed) {
		child.kill("SIGTERM");
		try { await bounded(completion, 5000, "Fixture child cleanup timed out"); }
		catch {
			child.kill("SIGKILL");
			await bounded(completion, 5000, "Fixture child did not terminate");
		}
	}
}
assert(JSON.stringify(snapshot(sourcePath)) === sourceBefore, "Review changed source state");
assert(
	JSON.stringify([...v1Sentinels.keys()].map(sentinelState)) === JSON.stringify(v1SentinelsBefore),
	"Review changed V1 state bytes or modes",
);
const database = new DatabaseSync(join(statePath, "meeting-publication.sqlite3"), {readOnly: true});
try {
	const item = database.prepare("SELECT status,source_hash,approved_hash,google_doc_id,discord_message_id FROM publication_items").get();
	assert(item?.status === "approved" && item.approved_hash === item.source_hash, "Approval was not persisted");
	assert(item.google_doc_id === null && item.discord_message_id === null, "Review recorded provider publication");
} finally { database.close(); }
const replay = new DatabaseSync(fixture.replayPath, {readOnly: true});
try {
	assert(replay.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count === 1, "Authorization was not consumed");
	assert(replay.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count === 0, "Review lease survived interruption");
} finally { replay.close(); }
assert(await fetch(reviewOrigin, {signal: AbortSignal.timeout(2000), headers: {Connection: "close"}}).then(() => false, error => error.name !== "TimeoutError"), "Review server survived scope cleanup");
console.log(JSON.stringify({approved: true, sourceUnchanged: true, v1Unchanged: true, sdkInstalled: false, cliSignal: "SIGTERM", exitCode: 143}));
