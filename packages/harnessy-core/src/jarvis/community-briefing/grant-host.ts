import { createHash, createPublicKey, type KeyObject, randomUUID, verify } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import { canonicalMeetingPublicationSmokeJson } from "../meeting-publication/operational-input.ts";
import {
	type CommunityBriefingProviderScope,
	type CommunityBriefingWriteBinding,
	type CommunityBriefingWriteGrant,
	communityBriefingProviderScopePayload,
	issueCommunityBriefingWriteGrant,
	snapshotCommunityBriefingProviderScope,
} from "./authority.ts";
import type { CommunityOperationalBinding } from "./operational-input.ts";

export interface SignedCommunityBriefingGrant {
	readonly issuer: string;
	readonly grantId: string;
	readonly queuePath: string;
	readonly statePath: string;
	readonly briefingId: string | null;
	readonly sourceHash: string | null;
	readonly expiresAt: string | null;
	readonly providerScope: CommunityBriefingProviderScope;
	readonly signature: string;
	readonly operational?: CommunityOperationalBinding;
}

export const communityBriefingGrantPayload = (grant: Omit<SignedCommunityBriefingGrant, "signature">): string =>
	JSON.stringify([
		grant.operational?.kind === "harnessy.community.briefing.service.v1"
			? "harnessy.community.briefing.service.v1"
			: "harnessy.community.briefing.publish.v1",
		grant.issuer,
		grant.grantId,
		resolve(grant.queuePath),
		resolve(grant.statePath),
		grant.briefingId,
		grant.sourceHash,
		grant.expiresAt,
		communityBriefingProviderScopePayload(grant.providerScope),
		...(grant.operational === undefined ? [] : [canonicalMeetingPublicationSmokeJson(grant.operational)]),
	]);

const ownerOnly = (path: string, label: string): string => {
	const resolved = resolve(path);
	const uid = process.getuid?.();
	if (process.platform === "win32" || uid === undefined) throw new Error(`${label} requires POSIX ownership checks.`);
	if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true, mode: 0o700 });
	const stat = lstatSync(resolved);
	const canonical = realpathSync(resolved);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
		throw new Error(`${label} must be a canonical owner-only directory.`);
	return canonical;
};

export const COMMUNITY_BRIEFING_GRANT_SCHEMA_SQL = `PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS community_briefing_grants (
 grant_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, consumed_at TEXT, revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1))
);`;

/** Verifies one-shot grants or explicitly enrolled service authority in the same ledger. */
export class CommunityBriefingGrantHost {
	readonly #database: DatabaseSync;
	readonly #keys: ReadonlyMap<string, KeyObject>;
	readonly #now: () => number;
	readonly #queuePath: string;
	readonly #statePath: string;
	readonly #providerScope: CommunityBriefingProviderScope;
	readonly #providerScopePayload: string;

	constructor(
		stateDirectory: string,
		trustedPublicKeys: ReadonlyMap<string, string>,
		queuePath: string,
		statePath: string,
		expectedProviderScope: CommunityBriefingProviderScope,
		now: () => number = Date.now,
	) {
		this.#providerScope = snapshotCommunityBriefingProviderScope(expectedProviderScope);
		for (const path of [this.#providerScope.credentialDirectory, this.#providerScope.engineStatePath]) {
			if (!isAbsolute(path) || resolve(path) !== path)
				throw new Error("Community provider paths must be absolute and normalized.");
		}
		this.#providerScopePayload = communityBriefingProviderScopePayload(this.#providerScope);
		const root = ownerOnly(stateDirectory, "Community grant state");
		this.#queuePath = resolve(queuePath);
		this.#statePath = resolve(statePath);
		const keys = new Map<string, KeyObject>();
		for (const [issuer, pem] of trustedPublicKeys) {
			const key = createPublicKey(pem);
			if (!issuer.trim() || key.asymmetricKeyType !== "ed25519")
				throw new Error("Community grants require Ed25519 issuers.");
			keys.set(issuer, key);
		}
		if (keys.size === 0) throw new Error("Community grants require a trusted issuer.");
		const databasePath = join(root, "community-grants.sqlite3");
		if (!existsSync(databasePath)) {
			const fd = openSync(
				databasePath,
				constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
				0o600,
			);
			closeSync(fd);
		}
		const stat = lstatSync(databasePath);
		const uid = process.getuid?.();
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			uid === undefined ||
			stat.uid !== uid ||
			(stat.mode & 0o077) !== 0
		)
			throw new Error("Community grant database must be an owner-only regular file.");
		const database = new DatabaseSync(databasePath, { timeout: 10_000 });
		database.exec(COMMUNITY_BRIEFING_GRANT_SCHEMA_SQL);
		this.#database = database;
		this.#keys = keys;
		this.#now = now;
	}

	close(): void {
		this.#database.close();
	}

	revoke(grantId: string): void {
		if (!grantId.trim()) throw new Error("A community grant ID is required.");
		this.#database
			.prepare(`INSERT INTO community_briefing_grants(grant_id,payload_hash,revoked) VALUES (?, '', 1)
ON CONFLICT(grant_id) DO UPDATE SET revoked=1`)
			.run(grantId);
	}

	#validateSignature(signed: SignedCommunityBriefingGrant): string {
		if (resolve(signed.queuePath) !== this.#queuePath || resolve(signed.statePath) !== this.#statePath)
			throw new Error("Community grant path binding changed.");
		if (communityBriefingProviderScopePayload(signed.providerScope) !== this.#providerScopePayload)
			throw new Error("Community grant provider scope differs from the owning host.");
		const key = this.#keys.get(signed.issuer);
		const signature = Buffer.from(signed.signature, "base64");
		const payload = communityBriefingGrantPayload(signed);
		if (
			!key ||
			signature.length !== 64 ||
			signature.toString("base64") !== signed.signature ||
			!verify(null, Buffer.from(payload), key, signature)
		)
			throw new Error("Community grant signature is not trusted.");
		return createHash("sha256").update(payload).digest("hex");
	}

	#recordGrant(signed: SignedCommunityBriefingGrant, digest: string, reusable: boolean): void {
		const result = this.#database
			.prepare(`INSERT INTO community_briefing_grants(grant_id,payload_hash,consumed_at)
VALUES (?,?,?) ON CONFLICT(grant_id) DO NOTHING`)
			.run(signed.grantId, digest, new Date(this.#now()).toISOString());
		if (result.changes === 1) return;
		const enrolled = this.#database
			.prepare("SELECT payload_hash,consumed_at,revoked FROM community_briefing_grants WHERE grant_id=?")
			.get(signed.grantId);
		if (
			!reusable ||
			enrolled?.payload_hash !== digest ||
			enrolled.revoked !== 0 ||
			typeof enrolled.consumed_at !== "string"
		)
			throw new Error("Community grant was consumed or revoked; reconcile before retrying.");
	}

	/** Record a verified service adoption even when there is no approved item yet.
	 * The operational caller verifies artifact and database identities before this call.
	 * This issues no publication grant and never clears retained ownership.
	 */
	enrollService(signed: SignedCommunityBriefingGrant): void {
		const digest = this.#validateSignature(signed);
		const operation = signed.operational;
		const now = this.#now();
		if (
			operation?.kind !== "harnessy.community.briefing.service.v1" ||
			operation.runtime.bootId !== null ||
			signed.briefingId !== null ||
			signed.sourceHash !== null ||
			signed.expiresAt !== null ||
			!signed.grantId.trim() ||
			!Number.isFinite(now) ||
			!Number.isFinite(Date.parse(operation.notBefore)) ||
			Date.parse(operation.notBefore) > now
		)
			throw new Error("Invalid community service enrollment.");
		this.#database.exec("BEGIN IMMEDIATE");
		let committed = false;
		try {
			if (this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get())
				throw new Error("Community ledger trigger rejected.");
			if (
				this.#database
					.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_briefing_lease'")
					.get() &&
				this.#database.prepare("SELECT 1 FROM community_briefing_lease").get()
			)
				throw new Error("Community lease requires reconciliation.");
			this.#recordGrant(signed, digest, true);
			this.#database.exec("COMMIT");
			committed = true;
		} finally {
			if (!committed) this.#database.exec("ROLLBACK");
		}
	}

	bind(
		envelope: SignedCommunityBriefingGrant,
		operation?: {
			readonly check: () => Effect.Effect<void, Error>;
			readonly assertLedger: () => void;
			readonly serviceItem?: { readonly briefingId: string; readonly sourceHash: string };
			readonly bootId?: string;
			readonly deadline?: string;
		},
	): {
		readonly authorize: () => Effect.Effect<CommunityBriefingWriteGrant, Error>;
		readonly revalidate: (grant: CommunityBriefingWriteGrant) => Effect.Effect<void, Error>;
		readonly complete: () => void;
	} {
		const leaseId = randomUUID();
		const signed = Object.freeze({
			...envelope,
			providerScope: snapshotCommunityBriefingProviderScope(envelope.providerScope),
			...(envelope.operational === undefined
				? {}
				: {
						operational: JSON.parse(
							canonicalMeetingPublicationSmokeJson(envelope.operational),
						) as CommunityOperationalBinding,
					}),
		});
		const service = signed.operational?.kind === "harnessy.community.briefing.service.v1";
		const item = service ? operation?.serviceItem : { briefingId: signed.briefingId, sourceHash: signed.sourceHash };
		if (!item || typeof item.briefingId !== "string" || typeof item.sourceHash !== "string")
			throw new Error("Community publication requires an exact item binding.");
		const selected = Object.freeze({ briefingId: item.briefingId, sourceHash: item.sourceHash });
		const bootId = service ? operation?.bootId : signed.operational?.runtime.bootId;
		const deadline = service ? operation?.deadline : signed.expiresAt;
		let issued: CommunityBriefingWriteGrant | undefined;
		const assertLease = () => {
			if (operation === undefined) return;
			operation.assertLedger();
			if (this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get())
				throw new Error("Community ledger trigger rejected.");
			const row = this.#database
				.prepare("SELECT lease_id,grant_id,pid,boot_id,expires_at FROM community_briefing_lease WHERE singleton=1")
				.get();
			if (
				row?.lease_id !== leaseId ||
				row.grant_id !== signed.grantId ||
				row.pid !== process.pid ||
				row.boot_id !== bootId ||
				row.expires_at !== deadline
			)
				throw new Error("Community lease lost.");
		};
		const binding: CommunityBriefingWriteBinding = {
			queuePath: this.#queuePath,
			statePath: this.#statePath,
			providerScope: this.#providerScope,
			item: selected,
		};
		const validate = (): string => {
			const digest = this.#validateSignature(signed);
			if (
				service &&
				(signed.briefingId !== null ||
					signed.sourceHash !== null ||
					signed.expiresAt !== null ||
					!bootId ||
					!operation)
			)
				throw new Error("Invalid community service enrollment.");
			const expires = typeof deadline === "string" ? Date.parse(deadline) : Number.NaN;
			const now = this.#now();
			if (
				!Number.isFinite(now) ||
				!Number.isFinite(expires) ||
				expires <= now ||
				!signed.grantId.trim() ||
				!/^[a-f0-9]{64}$/.test(selected.sourceHash) ||
				!selected.briefingId.trim()
			)
				throw new Error("Community grant is invalid or expired.");
			return digest;
		};
		return {
			authorize: () =>
				Effect.andThen(
					operation?.check() ?? Effect.void,
					Effect.try({
						try: () => {
							const digest = validate();
							if (operation !== undefined) {
								operation.assertLedger();
								if (signed.operational === undefined) throw new Error("Operational binding required.");
								if (this.#database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get())
									throw new Error("Community ledger trigger rejected.");
								this.#database.exec(
									"CREATE TABLE IF NOT EXISTS community_briefing_lease (singleton INTEGER PRIMARY KEY CHECK(singleton=1), lease_id TEXT NOT NULL, grant_id TEXT NOT NULL, pid INTEGER NOT NULL, boot_id TEXT NOT NULL, expires_at TEXT NOT NULL); BEGIN IMMEDIATE;",
								);
							}
							let committed = false;
							try {
								if (
									operation !== undefined &&
									this.#database.prepare("SELECT 1 FROM community_briefing_lease").get()
								)
									throw new Error("Community lease requires reconciliation.");
								this.#recordGrant(signed, digest, service);
								if (operation !== undefined) {
									this.#database
										.prepare("INSERT INTO community_briefing_lease VALUES (1,?,?,?,?,?)")
										.run(leaseId, signed.grantId, process.pid, bootId!, deadline!);
									this.#database.exec("COMMIT;");
									committed = true;
								}
							} finally {
								if (operation !== undefined && !committed) this.#database.exec("ROLLBACK;");
							}
							issued = issueCommunityBriefingWriteGrant("publish", binding, {
								validate: (requested, current) =>
									Effect.andThen(
										operation?.check() ?? Effect.void,
										Effect.try({
											try: () => {
												assertLease();
												const row = this.#database
													.prepare(
														"SELECT payload_hash,consumed_at,revoked FROM community_briefing_grants WHERE grant_id=?",
													)
													.get(signed.grantId) as
													| { payload_hash?: unknown; consumed_at?: unknown; revoked?: unknown }
													| undefined;
												if (
													requested !== "publish" ||
													current.item.briefingId !== selected.briefingId ||
													current.item.sourceHash !== selected.sourceHash ||
													!row ||
													row.revoked !== 0 ||
													typeof row.consumed_at !== "string" ||
													row.payload_hash !== validate()
												)
													return false;
												return true;
											},
											catch: () => false,
										}),
									).pipe(Effect.catch(() => Effect.succeed(false))),
							});
							return issued;
						},
						catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
					}),
				),
			revalidate: (grant) =>
				Effect.try({
					try: () => {
						assertLease();
						if (issued === undefined || grant !== issued)
							throw new Error("Community grant does not belong to this binding.");
						const row = this.#database
							.prepare("SELECT payload_hash,consumed_at,revoked FROM community_briefing_grants WHERE grant_id=?")
							.get(signed.grantId) as
							| { payload_hash?: unknown; consumed_at?: unknown; revoked?: unknown }
							| undefined;
						if (
							!row ||
							row.revoked !== 0 ||
							typeof row.consumed_at !== "string" ||
							row.payload_hash !== validate()
						)
							throw new Error("Community grant is absent, changed or revoked.");
						return undefined;
					},
					catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
				}),
			complete: () => {
				if (operation === undefined || issued === undefined) return;
				assertLease();
				this.#database
					.prepare("DELETE FROM community_briefing_lease WHERE singleton=1 AND lease_id=?")
					.run(leaseId);
			},
		};
	}
}
