/**
 * Portal sessions: one install token on disk, short-lived one-time codes and
 * in-memory page tokens. Page tokens grant read access only. Nothing here is
 * persisted, so a restart signs every page out.
 *
 * The install token never crosses the wire. A CLI first asks for a one-time
 * challenge with its own nonce; the server answers with an HMAC that proves it
 * holds the token, bound to its origin. The CLI checks that proof, then sends an
 * HMAC over the challenge, origin, method and path. Another process listening
 * on the port learns nothing reusable, and a relayed proof fails the origin check.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { newPortalSecret } from "./token-store.ts";

export const PORTAL_CODE_TTL_MS = 60_000;
export const PORTAL_PAGE_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
export const PORTAL_CHALLENGE_TTL_MS = 60_000;
const MAX_CODES = 16;
const MAX_CHALLENGES = 16;
const MAX_PAGE_TOKENS = 64;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** The secret of an `Authorization: Bearer <secret>` header, when it has the expected shape. */
export const bearerSecret = (header: string | undefined): string | undefined => {
	const match = header === undefined ? null : /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header);
	return match === null ? undefined : match[1];
};

const SERVER_PROOF = "harnessy.portal.server-proof.v1";
const CLIENT_PROOF = "harnessy.portal.client-proof.v1";
const PROOF_HEADER = /^HarnessyProof ([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/u;

const hmac = (secret: string, ...parts: ReadonlyArray<string>): string =>
	createHmac("sha256", secret).update(parts.join("\n")).digest("base64url");

const sameSecret = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right));

/** The server's proof that it holds the install token, for the client's nonce and this origin. */
export const portalServerProof = (installToken: string, nonce: string, challenge: string, origin: string): string =>
	hmac(installToken, SERVER_PROOF, nonce, challenge, origin);

/** The client's single-use proof for one request: `Authorization: HarnessyProof <challenge>.<proof>`. */
export const portalClientProofHeader = (
	installToken: string,
	challenge: string,
	origin: string,
	method: string,
	path: string,
): string => `HarnessyProof ${challenge}.${hmac(installToken, CLIENT_PROOF, challenge, origin, method, path)}`;

/** Check a server proof in constant time. */
export const isPortalServerProof = (
	installToken: string,
	nonce: string,
	challenge: string,
	origin: string,
	proof: string,
): boolean => sameSecret(portalServerProof(installToken, nonce, challenge, origin), proof);

export interface PortalChallenge {
	readonly challenge: string;
	readonly proof: string;
	readonly expiresAt: Date;
}

export interface PortalGrant {
	readonly secret: string;
	readonly expiresAt: Date;
}

export class PortalSessions {
	readonly #installToken: string;
	readonly #clock: () => number;
	/** Keyed by the SHA-256 of the secret, so a lookup never compares the secret itself. */
	readonly #codes = new Map<string, number>();
	readonly #pageTokens = new Map<string, number>();
	readonly #challenges = new Map<string, number>();

	constructor(installToken: string, clock: () => number = Date.now) {
		if (!SECRET.test(installToken)) throw new Error("invalid_install_token");
		this.#installToken = installToken;
		this.#clock = clock;
	}

	/** A single-use challenge (60 s) and the server's proof for the client's nonce. */
	issueChallenge(nonce: string, origin: string): PortalChallenge | undefined {
		if (!SECRET.test(nonce)) return undefined;
		const grant = this.#issue(this.#challenges, PORTAL_CHALLENGE_TTL_MS, MAX_CHALLENGES);
		return {
			challenge: grant.secret,
			proof: portalServerProof(this.#installToken, nonce, grant.secret, origin),
			expiresAt: grant.expiresAt,
		};
	}

	/** Spend a challenge once on a client proof for exactly this origin, method and path. */
	isInstallProof(header: string | undefined, origin: string, method: string, path: string): boolean {
		const match = header === undefined ? null : PROOF_HEADER.exec(header);
		if (match === null) return false;
		const key = digest(match[1]!).toString("hex");
		const expiresAt = this.#challenges.get(key);
		this.#challenges.delete(key);
		if (expiresAt === undefined || expiresAt <= this.#clock()) return false;
		return sameSecret(portalClientProofHeader(this.#installToken, match[1]!, origin, method, path), header!);
	}

	#issue(store: Map<string, number>, ttlMs: number, limit: number): PortalGrant {
		const now = this.#clock();
		for (const [key, expiresAt] of store) if (expiresAt <= now) store.delete(key);
		// Maps keep insertion order: past the limit, the oldest grant is dropped first.
		while (store.size >= limit) store.delete(store.keys().next().value as string);
		const secret = newPortalSecret();
		const expiresAt = now + ttlMs;
		store.set(digest(secret).toString("hex"), expiresAt);
		return { secret, expiresAt: new Date(expiresAt) };
	}

	/** A one-time code for `POST /v1/session/exchange`. */
	mintCode(): PortalGrant {
		return this.#issue(this.#codes, PORTAL_CODE_TTL_MS, MAX_CODES);
	}

	/** Spend a code once. An unknown, used or expired code gives `undefined`. */
	exchange(code: string): PortalGrant | undefined {
		if (!SECRET.test(code)) return undefined;
		const key = digest(code).toString("hex");
		const expiresAt = this.#codes.get(key);
		this.#codes.delete(key);
		if (expiresAt === undefined || expiresAt <= this.#clock()) return undefined;
		return this.#issue(this.#pageTokens, PORTAL_PAGE_TOKEN_TTL_MS, MAX_PAGE_TOKENS);
	}

	/** A live page token (read scope). */
	isPageToken(candidate: string | undefined): boolean {
		if (candidate === undefined) return false;
		const key = digest(candidate).toString("hex");
		const expiresAt = this.#pageTokens.get(key);
		if (expiresAt === undefined) return false;
		if (expiresAt > this.#clock()) return true;
		this.#pageTokens.delete(key);
		return false;
	}
}
