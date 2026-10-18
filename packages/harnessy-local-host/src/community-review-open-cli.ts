#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	constants as fsConstants,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Written by the V2 native briefing review (community-draft-adapter.py) after it binds. */
const rendezvousFileName = "community-review.rendezvous.json";
/** Read and deleted by the review server's GET /?code= (review.py `_redeem_exchange_code`). */
const exchangePrefix = "review-exchange-";
const pagePattern = /^review-open-[0-9a-f]{32}\.html$/u;
const exchangePattern = /^review-exchange-[0-9a-f]{64}$/u;
/** The server accepts a code for 60 s; leftovers older than this are removed. */
const staleMs = 120_000;
const redeemWaitMs = 30_000;

// Opens the authenticated briefing review without `jarvis community briefing …`
// argv (the one-writer guards treat that as a community writer) and without the
// long-lived token in any argv, output or log. The opener receives only the path
// of an owner-only redirect page that carries a single-use, 60-second code.
const fail = (): never => {
	process.stderr.write('{"error":"community_review_open_failed"}\n');
	process.exit(1);
};
const statePath = process.argv[2] === "--state-path" ? process.argv[3] : undefined;
if (
	statePath === undefined ||
	!isAbsolute(statePath) ||
	resolve(statePath) !== statePath ||
	parse(statePath).root === statePath ||
	process.argv.length !== 4
)
	fail();
const uid = process.geteuid?.();
if (uid === undefined) fail();
const stateRoot = statePath as string;
const ownerUid = BigInt(uid as number);
const stateStat = lstatSync(stateRoot, { bigint: true, throwIfNoEntry: false });
if (
	stateStat === undefined ||
	!stateStat.isDirectory() ||
	stateStat.uid !== ownerUid ||
	(stateStat.mode & 0o077n) !== 0n
)
	fail();
const readOwnerFile = (path: string) => {
	const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	if (
		stat === undefined ||
		!stat.isFile() ||
		stat.uid !== ownerUid ||
		(stat.mode & 0o7777n) !== 0o600n ||
		stat.nlink !== 1n
	)
		fail();
	return readFileSync(path, "utf8");
};
let rendezvous: { kind?: unknown; origin?: unknown; port?: unknown; tokenPath?: unknown } = {};
try {
	rendezvous = JSON.parse(readOwnerFile(join(stateRoot, rendezvousFileName)));
} catch {
	fail();
}
if (rendezvous.kind !== "harnessy.community.review-rendezvous.v1") fail();
const originValue = rendezvous.origin;
const portValue = rendezvous.port;
if (typeof originValue !== "string" || typeof portValue !== "number" || !Number.isInteger(portValue)) fail();
const checkedOrigin = originValue as string;
const checkedPort = portValue as number;
if (checkedPort < 1 || checkedPort > 65_535 || !URL.canParse(checkedOrigin)) fail();
const origin = new URL(checkedOrigin);
if (
	origin.protocol !== "http:" ||
	origin.hostname !== "127.0.0.1" ||
	origin.port !== String(checkedPort) ||
	origin.pathname !== "/" ||
	origin.origin !== checkedOrigin
)
	fail();
if (rendezvous.tokenPath !== join(stateRoot, "review.token")) fail();
const token = readOwnerFile(rendezvous.tokenPath as string).trim();
if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) fail();

// A stale rendezvous can name a port now held by another listener. Only the
// review that holds the token can answer this port-bound challenge; refuse
// before any code exists if the listener cannot.
const nonce = randomBytes(32).toString("hex");
const expected = createHmac("sha256", token)
	.update(`harnessy-community-review-identity:${checkedPort}:${nonce}`)
	.digest("hex");
let proof = "";
try {
	const response = await fetch(`${checkedOrigin}/identity?nonce=${nonce}`, {
		redirect: "error",
		signal: AbortSignal.timeout(3_000),
	});
	proof = response.ok ? (await response.text()).slice(0, 128) : "";
} catch {
	fail();
}
if (proof.length !== expected.length || !timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) fail();

const now = Date.now();
for (const name of readdirSync(stateRoot)) {
	if (!pagePattern.test(name) && !exchangePattern.test(name)) continue;
	const stat = lstatSync(join(stateRoot, name));
	if (stat.isFile() && now - stat.mtimeMs > staleMs) unlinkSync(join(stateRoot, name));
}
const createPrivate = (path: string, body: string) => {
	const fd = openSync(
		path,
		fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
		0o600,
	);
	try {
		fchmodSync(fd, 0o600);
		writeSync(fd, body);
	} finally {
		closeSync(fd);
	}
};
const code = randomBytes(32).toString("base64url");
const exchangePath = join(stateRoot, `${exchangePrefix}${createHash("sha256").update(code).digest("hex")}`);
const pagePath = join(stateRoot, `review-open-${randomBytes(16).toString("hex")}.html`);
const target = `${checkedOrigin}/?code=${code}`;
const removeQuietly = () => {
	for (const path of [pagePath, exchangePath])
		try {
			unlinkSync(path);
		} catch {}
};
try {
	createPrivate(exchangePath, "");
	createPrivate(
		pagePath,
		[
			"<!doctype html>",
			'<meta charset="utf-8">',
			'<meta name="referrer" content="no-referrer">',
			`<meta http-equiv="refresh" content="0;url=${target}">`,
			"<title>Opening weekly briefing review</title>",
			"",
		].join("\n"),
	);
} catch {
	removeQuietly();
	fail();
}
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
const result = spawnSync(opener, [pagePath], { shell: false, stdio: "ignore", windowsHide: true });
if (result.error !== undefined || result.status !== 0) {
	removeQuietly();
	fail();
}
// The server deletes the exchange file when the browser redeems the code. Remove
// the page then, or after a bounded wait; an unredeemed code is revoked with it.
const deadline = Date.now() + redeemWaitMs;
while (Date.now() < deadline && lstatSync(exchangePath, { throwIfNoEntry: false }) !== undefined) await sleep(200);
removeQuietly();
