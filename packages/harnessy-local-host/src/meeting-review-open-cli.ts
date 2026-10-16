#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";

import { meetingPublicationReviewRendezvousFileName } from "@harnessy/core/meeting-publication";

const fail = (): never => {
	process.stderr.write('{"error":"meeting_review_open_failed"}\n');
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
const readOwnerFile = (path: string) => {
	const stat = lstatSync(path, { bigint: true });
	if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n) fail();
	return readFileSync(path, "utf8");
};
const rendezvous = JSON.parse(readOwnerFile(join(stateRoot, meetingPublicationReviewRendezvousFileName))) as {
	kind?: unknown;
	origin?: unknown;
	port?: unknown;
	tokenPath?: unknown;
};
if (rendezvous.kind !== "harnessy.meeting-publication.review-rendezvous.v1") fail();
const originValue = rendezvous.origin;
const portValue = rendezvous.port;
if (typeof originValue !== "string" || typeof portValue !== "number" || !Number.isInteger(portValue)) fail();
const checkedOrigin = originValue as string;
const checkedPort = portValue as number;
if (checkedPort < 1 || checkedPort > 65_535 || !URL.canParse(checkedOrigin)) fail();
const origin = new URL(checkedOrigin);
if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/") fail();
if (rendezvous.tokenPath !== join(stateRoot, "meeting-publication-v2-review.token")) fail();
const token = readOwnerFile(rendezvous.tokenPath as string).trim();
if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) fail();
const url = `${checkedOrigin}/exchange?token=${encodeURIComponent(token)}`;
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
const result = spawnSync(opener, [url], { shell: false, stdio: "ignore", windowsHide: true });
if (result.error !== undefined || result.status !== 0) fail();
