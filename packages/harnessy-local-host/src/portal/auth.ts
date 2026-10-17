/**
 * Portal sessions: one install token on disk, short-lived one-time codes and
 * in-memory page tokens. Page tokens grant read access only. Nothing here is
 * persisted, so a restart signs every page out.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { newPortalSecret } from "./token-store.ts";

export const PORTAL_CODE_TTL_MS = 60_000;
export const PORTAL_PAGE_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_CODES = 16;
const MAX_PAGE_TOKENS = 64;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

/** The secret of an `Authorization: Bearer <secret>` header, when it has the expected shape. */
export const bearerSecret = (header: string | undefined): string | undefined => {
	const match = header === undefined ? null : /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(header);
	return match === null ? undefined : match[1];
};

export interface PortalGrant {
	readonly secret: string;
	readonly expiresAt: Date;
}

export class PortalSessions {
	readonly #installDigest: Buffer;
	readonly #clock: () => number;
	/** Keyed by the SHA-256 of the secret, so a lookup never compares the secret itself. */
	readonly #codes = new Map<string, number>();
	readonly #pageTokens = new Map<string, number>();

	constructor(installToken: string, clock: () => number = Date.now) {
		if (!SECRET.test(installToken)) throw new Error("invalid_install_token");
		this.#installDigest = digest(installToken);
		this.#clock = clock;
	}

	/** Compare in constant time against the install token. */
	isInstallToken(candidate: string | undefined): boolean {
		return candidate !== undefined && timingSafeEqual(digest(candidate), this.#installDigest);
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
