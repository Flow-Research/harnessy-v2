import { createHash, createPublicKey, type KeyObject, verify } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Schema } from "effect";
import * as Result from "effect/Result";

import { LifeDraftAuthority } from "./draft-provider.ts";

export interface SignedLifeDraftGrant {
	readonly issuer: string;
	readonly authority: LifeDraftAuthority;
	readonly signature: string;
}

/** Stable signing bytes, domain-separated from meeting and publication grants. */
export const lifeDraftGrantPayload = (issuer: string, input: LifeDraftAuthority): string => {
	const value = Schema.decodeUnknownSync(LifeDraftAuthority)(input);
	return JSON.stringify([
		"harnessy.life.draft.v1",
		issuer,
		value.grantId,
		value.operation,
		value.runId,
		value.kind,
		value.provider,
		value.model,
		value.promptHash,
		value.expiresAt,
		value.maximumOutputBytes,
	]);
};

/** POSIX, cooperative same-owner local host. Not a defence against a malicious same-UID process.
 * Owns only consumption/revocation evidence; never stores private keys or mints authority.
 * Keep this store when reconciling a crash: replacing it from stale backup permits replay.
 */
export class LifeDraftGrantHost {
	readonly #database: DatabaseSync;
	readonly #keys: ReadonlyMap<string, KeyObject>;
	readonly #now: () => number;

	constructor(stateDirectory: string, trustedPublicKeys: ReadonlyMap<string, string>, now: () => number = Date.now) {
		if (process.platform === "win32" || !process.getuid)
			throw new Error("Life grant host requires POSIX ownership checks.");
		const keys = new Map<string, KeyObject>();
		for (const [issuer, pem] of trustedPublicKeys) {
			const key = createPublicKey(pem);
			if (!issuer.trim() || key.asymmetricKeyType !== "ed25519")
				throw new Error("Life grants require named Ed25519 issuers.");
			keys.set(issuer, key);
		}
		if (keys.size === 0) throw new Error("Life grant host requires an owner-selected trusted issuer.");
		const root = resolve(stateDirectory);
		mkdirSync(root, { recursive: true, mode: 0o700 });
		const rootStat = lstatSync(root);
		if (
			!rootStat.isDirectory() ||
			rootStat.isSymbolicLink() ||
			realpathSync(root) !== root ||
			rootStat.uid !== process.getuid() ||
			(rootStat.mode & 0o077) !== 0
		)
			throw new Error("Life grant state directory must be canonical and owner-only.");
		const path = join(root, "draft-grants.sqlite3");
		if (!existsSync(path)) {
			const fd = openSync(
				path,
				constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
				0o600,
			);
			closeSync(fd);
		}
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid() ||
			(stat.mode & 0o077) !== 0
		)
			throw new Error("Life grant database must be an owner-only regular file.");
		for (const suffix of ["-journal", "-wal", "-shm"]) {
			if (!existsSync(`${path}${suffix}`)) continue;
			const sidecar = lstatSync(`${path}${suffix}`);
			if (
				!sidecar.isFile() ||
				sidecar.isSymbolicLink() ||
				sidecar.nlink !== 1 ||
				sidecar.uid !== process.getuid() ||
				(sidecar.mode & 0o077) !== 0
			)
				throw new Error("Life grant database sidecar must be owner-only.");
		}
		const database = new DatabaseSync(path, { timeout: 10_000 });
		const initialized = Result.try(() => {
			database.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS life_draft_grants (
 grant_id TEXT PRIMARY KEY, payload_hash TEXT, consumed_at TEXT,
 revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1))
);`);
		});
		if (Result.isFailure(initialized)) {
			database.close();
			throw initialized.failure;
		}
		this.#database = database;
		this.#keys = keys;
		this.#now = now;
	}

	close(): void {
		this.#database.close();
	}

	/** Operator-side revocation is permanent, including before a grant's first use. */
	revoke(grantId: string): void {
		if (!grantId.trim()) throw new Error("A Life grant ID is required.");
		this.#database
			.prepare(`INSERT INTO life_draft_grants(grant_id,revoked) VALUES (?,1)
ON CONFLICT(grant_id) DO UPDATE SET revoked=1`)
			.run(grantId);
	}

	/** Bind these callbacks to generateLifeDraft; signature checking is never optional. */
	bind(signed: SignedLifeDraftGrant): {
		readonly authorize: (authority: LifeDraftAuthority) => Promise<void>;
		readonly revalidate: (authority: LifeDraftAuthority) => Promise<void>;
	} {
		const envelope = {
			issuer: signed.issuer,
			signature: signed.signature,
			authority: Object.freeze(Schema.decodeUnknownSync(LifeDraftAuthority)(signed.authority)),
		};
		const validate = (authority: LifeDraftAuthority): string => {
			const payload = lifeDraftGrantPayload(envelope.issuer, envelope.authority);
			if (payload !== lifeDraftGrantPayload(envelope.issuer, authority))
				throw new Error("Life grant request changed.");
			const key = this.#keys.get(envelope.issuer);
			const signature = Buffer.from(envelope.signature, "base64");
			if (
				!key ||
				signature.length !== 64 ||
				signature.toString("base64") !== envelope.signature ||
				!verify(null, Buffer.from(payload), key, signature)
			)
				throw new Error("Life grant signature is not trusted.");
			const now = this.#now();
			const expires = Date.parse(authority.expiresAt);
			if (
				!Number.isFinite(now) ||
				!Number.isFinite(expires) ||
				expires <= now ||
				!authority.grantId.trim() ||
				!authority.runId.trim() ||
				!authority.model.trim() ||
				!Number.isSafeInteger(authority.maximumOutputBytes) ||
				authority.maximumOutputBytes < 1 ||
				!/^[a-f0-9]{64}$/.test(authority.promptHash)
			)
				throw new Error("Life grant is invalid or expired.");
			return createHash("sha256").update(payload).digest("hex");
		};
		return {
			authorize: async (authority) => {
				const digest = validate(authority);
				// One atomic, fully synchronous commit precedes every provider invocation.
				const result = this.#database
					.prepare(`INSERT INTO life_draft_grants(grant_id,payload_hash,consumed_at)
VALUES (?,?,?) ON CONFLICT(grant_id) DO NOTHING`)
					.run(authority.grantId, digest, new Date(this.#now()).toISOString());
				if (result.changes !== 1) throw new Error("Life grant was consumed or revoked; reconcile before retrying.");
			},
			revalidate: async (authority) => {
				const digest = validate(authority);
				const row = this.#database
					.prepare("SELECT payload_hash,consumed_at,revoked FROM life_draft_grants WHERE grant_id=?")
					.get(authority.grantId);
				if (!row || row.revoked !== 0 || row.payload_hash !== digest || typeof row.consumed_at !== "string")
					throw new Error("Life grant is absent, changed or revoked.");
			},
		};
	}
}
