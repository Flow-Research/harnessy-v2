#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

/** Written by the V2 native briefing review (community-draft-adapter.py) after it binds. */
const rendezvousFileName = "community-review.rendezvous.json";

// Opens the authenticated briefing review without printing the bearer link and
// without `jarvis community briefing …` argv, which the one-writer guards treat as
// a community writer.
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
if (stateStat === undefined || !stateStat.isDirectory() || stateStat.uid !== ownerUid) fail();
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
const url = `${checkedOrigin}/?token=${encodeURIComponent(token)}`;
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
const result = spawnSync(opener, [url], { shell: false, stdio: "ignore", windowsHide: true });
if (result.error !== undefined || result.status !== 0) fail();
