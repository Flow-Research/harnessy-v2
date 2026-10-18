import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	constants as fsConstants,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
	meetingPublicationReviewExchangePrefix,
	meetingPublicationReviewIdentityDomain,
	meetingPublicationReviewRendezvousFileName,
} from "@harnessy/core/meeting-publication";

// Shared by harnessy-meeting-review-open and harnessy-community-review-open.
// Both open an authenticated loopback review without a `jarvis …` argv (the
// one-writer guards treat those as writers) and without the long-lived review
// token in any argv, output or log. The launcher first proves that the listener
// named by the owner-only rendezvous holds the token, then hands the platform
// opener only the path of an owner-only redirect page that carries a
// single-use, 60-second code.

/** What differs between the review servers this launcher can open. */
export interface ReviewOpenProfile {
	/** The content-free error code printed on any refusal. */
	readonly failure: string;
	readonly rendezvousFileName: string;
	readonly rendezvousKind: string;
	readonly tokenFileName: string;
	/** Accepted `URL.hostname` values for the rendezvous origin. */
	readonly hostnames: ReadonlyArray<string>;
	/** HMAC message domain the server uses for `GET /identity`. */
	readonly identityDomain: string;
	/** Exchange files are `<exchangePrefix><sha256(code) hex>`; the server deletes one when it redeems it. */
	readonly exchangePrefix: string;
	/** Redirect pages are `<pagePrefix><32 hex>.html`. */
	readonly pagePrefix: string;
	/** Path and query prefix the code is appended to, such as `/exchange?code=`. */
	readonly codeRoute: string;
	readonly title: string;
}

export const meetingReviewOpenProfile: ReviewOpenProfile = {
	failure: "meeting_review_open_failed",
	rendezvousFileName: meetingPublicationReviewRendezvousFileName,
	rendezvousKind: "harnessy.meeting-publication.review-rendezvous.v1",
	tokenFileName: "meeting-publication-v2-review.token",
	hostnames: ["127.0.0.1", "[::1]"],
	identityDomain: meetingPublicationReviewIdentityDomain,
	exchangePrefix: meetingPublicationReviewExchangePrefix,
	pagePrefix: "meeting-review-open-",
	codeRoute: "/exchange?code=",
	title: "Opening meeting review",
};

/** Matches the V1 review.py `_redeem_exchange_code` and `_write_identity` used by the native briefing review. */
export const communityReviewOpenProfile: ReviewOpenProfile = {
	failure: "community_review_open_failed",
	rendezvousFileName: "community-review.rendezvous.json",
	rendezvousKind: "harnessy.community.review-rendezvous.v1",
	tokenFileName: "review.token",
	hostnames: ["127.0.0.1"],
	identityDomain: "harnessy-community-review-identity",
	exchangePrefix: "review-exchange-",
	pagePrefix: "review-open-",
	codeRoute: "/?code=",
	title: "Opening weekly briefing review",
};

/** The servers accept a code for 60 s; leftovers older than this are removed. */
const staleMs = 120_000;
const defaultRedeemWaitMs = 30_000;

/** Trusted absolute locations for the Linux opener. PATH is never consulted. */
export const linuxOpenerCandidates: ReadonlyArray<string> = [
	"/usr/bin/xdg-open",
	"/usr/local/bin/xdg-open",
	"/bin/xdg-open",
];

export type ResolvedOpener =
	| { readonly path: string }
	| { readonly reason: "unsupported_platform" | "opener_unavailable" };

/**
 * The platform opener as an absolute path: `/usr/bin/open` on macOS, and on Linux
 * the first candidate whose real path and every ancestor directory are owned by
 * `trustedUid` and not group- or world-writable. Other platforms are unsupported.
 */
export const resolvePlatformOpener = (
	platform: NodeJS.Platform = process.platform,
	candidates: ReadonlyArray<string> = linuxOpenerCandidates,
	trustedUid = 0,
): ResolvedOpener => {
	if (platform === "darwin") return { path: "/usr/bin/open" };
	if (platform !== "linux") return { reason: "unsupported_platform" };
	const trusted = (path: string) => {
		const stat = statSync(path);
		return stat.uid === trustedUid && (stat.mode & 0o022) === 0;
	};
	for (const candidate of candidates) {
		if (!isAbsolute(candidate)) continue;
		try {
			const real = realpathSync(candidate);
			const stat = statSync(real);
			if (!stat.isFile() || (stat.mode & 0o111) === 0 || !trusted(real)) continue;
			let directory = dirname(real);
			while (trusted(directory) && dirname(directory) !== directory) directory = dirname(directory);
			if (dirname(directory) === directory && trusted(directory)) return { path: real };
		} catch {}
	}
	return { reason: "opener_unavailable" };
};

/** Constant-time for equal byte lengths; never throws on non-ASCII input. */
export const identityProofMatches = (proof: string, expected: string) => {
	const supplied = Buffer.from(proof, "utf8");
	const wanted = Buffer.from(expected, "utf8");
	return supplied.byteLength === wanted.byteLength && timingSafeEqual(supplied, wanted);
};

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/**
 * Remove stale launcher pages and exchange files. Another launcher or the
 * server may delete an entry between the listing and the lstat; that is not an error.
 */
export const sweepStaleReviewFiles = (
	root: string,
	profile: ReviewOpenProfile,
	now: number,
	list: (path: string) => ReadonlyArray<string> = readdirSync,
) => {
	const page = new RegExp(`^${profile.pagePrefix}[0-9a-f]{32}\\.html$`, "u");
	const exchange = new RegExp(`^${profile.exchangePrefix}[0-9a-f]{64}$`, "u");
	for (const name of list(root)) {
		if (!page.test(name) && !exchange.test(name)) continue;
		const path = join(root, name);
		try {
			const stat = lstatSync(path);
			if (stat.isFile() && now - stat.mtimeMs > staleMs) unlinkSync(path);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
};

export interface ReviewOpenOptions {
	/** Absolute opener path. Defaults to `resolvePlatformOpener()`; tests pass a recording stub. */
	readonly opener?: string;
	readonly redeemWaitMs?: number;
}

const cleanupSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export const runReviewOpen = async (
	profile: ReviewOpenProfile,
	argv: ReadonlyArray<string>,
	options: ReviewOpenOptions = {},
): Promise<void> => {
	const fail = (reason?: string): never => {
		process.stderr.write(
			`${JSON.stringify(reason === undefined ? { error: profile.failure } : { error: profile.failure, reason })}\n`,
		);
		process.exit(1);
	};
	const statePath = argv[0] === "--state-path" ? argv[1] : undefined;
	if (
		statePath === undefined ||
		argv.length !== 2 ||
		!isAbsolute(statePath) ||
		resolve(statePath) !== statePath ||
		parse(statePath).root === statePath
	)
		return fail();
	let opener = options.opener;
	if (opener === undefined) {
		const resolved = resolvePlatformOpener();
		if ("reason" in resolved) return fail(resolved.reason);
		opener = resolved.path;
	}
	const uid = process.geteuid?.();
	if (!isAbsolute(opener) || uid === undefined) return fail();
	const ownerUid = BigInt(uid);

	const readOwnerFile = (path: string) => {
		const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
		if (
			stat === undefined ||
			!stat.isFile() ||
			stat.uid !== ownerUid ||
			(stat.mode & 0o7777n) !== 0o600n ||
			stat.nlink !== 1n
		)
			return fail();
		return readFileSync(path, "utf8");
	};
	let origin = "";
	let port = 0;
	let token = "";
	try {
		const stateStat = lstatSync(statePath, { bigint: true, throwIfNoEntry: false });
		if (
			stateStat === undefined ||
			!stateStat.isDirectory() ||
			stateStat.uid !== ownerUid ||
			(stateStat.mode & 0o077n) !== 0n
		)
			return fail();
		const rendezvous = JSON.parse(readOwnerFile(join(statePath, profile.rendezvousFileName))) as {
			kind?: unknown;
			origin?: unknown;
			port?: unknown;
			tokenPath?: unknown;
		};
		if (
			rendezvous.kind !== profile.rendezvousKind ||
			typeof rendezvous.origin !== "string" ||
			typeof rendezvous.port !== "number" ||
			!Number.isInteger(rendezvous.port) ||
			rendezvous.port < 1 ||
			rendezvous.port > 65_535 ||
			!URL.canParse(rendezvous.origin) ||
			rendezvous.tokenPath !== join(statePath, profile.tokenFileName)
		)
			return fail();
		const parsed = new URL(rendezvous.origin);
		if (
			parsed.protocol !== "http:" ||
			!profile.hostnames.includes(parsed.hostname) ||
			parsed.port !== String(rendezvous.port) ||
			parsed.pathname !== "/" ||
			parsed.origin !== rendezvous.origin
		)
			return fail();
		origin = rendezvous.origin;
		port = rendezvous.port;
		token = readOwnerFile(rendezvous.tokenPath).trim();
	} catch {
		return fail();
	}
	if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return fail();

	// A stale rendezvous can name a port now held by another listener. Only the
	// review that holds the token can answer this port-bound challenge; refuse
	// before any code exists if the listener cannot.
	const nonce = randomBytes(32).toString("hex");
	const expected = createHmac("sha256", token).update(`${profile.identityDomain}:${port}:${nonce}`).digest("hex");
	let proof = "";
	try {
		const response = await fetch(`${origin}/identity?nonce=${nonce}`, {
			redirect: "error",
			signal: AbortSignal.timeout(3_000),
		});
		proof = response.ok ? (await response.text()).slice(0, 128) : "";
	} catch {
		return fail();
	}
	if (!identityProofMatches(proof, expected)) return fail();

	// Every file this run creates is removed on exit, on a refusal, and on
	// SIGINT, SIGTERM or SIGHUP; an unredeemed code is revoked with it.
	const created: Array<string> = [];
	const removeCreated = () => {
		for (const path of created.splice(0))
			try {
				unlinkSync(path);
			} catch {}
	};
	process.on("exit", removeCreated);
	for (const signal of cleanupSignals)
		process.once(signal, () => {
			removeCreated();
			process.exit(128 + osConstants.signals[signal]);
		});
	const createPrivate = (path: string, body: string) => {
		const fd = openSync(
			path,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
			0o600,
		);
		created.push(path);
		try {
			fchmodSync(fd, 0o600);
			if (body.length > 0) writeSync(fd, body);
		} finally {
			closeSync(fd);
		}
	};
	const code = randomBytes(32).toString("base64url");
	const exchangePath = join(statePath, `${profile.exchangePrefix}${createHash("sha256").update(code).digest("hex")}`);
	const pagePath = join(statePath, `${profile.pagePrefix}${randomBytes(16).toString("hex")}.html`);
	try {
		sweepStaleReviewFiles(statePath, profile, Date.now());
		createPrivate(exchangePath, "");
		createPrivate(
			pagePath,
			[
				"<!doctype html>",
				'<meta charset="utf-8">',
				'<meta name="referrer" content="no-referrer">',
				`<meta http-equiv="refresh" content="0;url=${origin}${profile.codeRoute}${code}">`,
				`<title>${profile.title}</title>`,
				"",
			].join("\n"),
		);
	} catch {
		return fail();
	}
	// Spawned asynchronously so the signal handlers above can run while it is open.
	const status = await new Promise<number | null>((done) => {
		const child = spawn(opener, [pagePath], { shell: false, stdio: "ignore", windowsHide: true });
		child.once("error", () => done(null));
		child.once("exit", (exitCode) => done(exitCode));
	});
	if (status !== 0) return fail();
	// The server deletes the exchange file when the browser redeems the code. Remove
	// the page then, or after a bounded wait.
	const deadline = Date.now() + (options.redeemWaitMs ?? defaultRedeemWaitMs);
	while (Date.now() < deadline && lstatSync(exchangePath, { throwIfNoEntry: false }) !== undefined) await sleep(200);
	removeCreated();
};
