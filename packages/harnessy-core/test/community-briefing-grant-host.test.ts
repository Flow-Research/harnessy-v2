import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	CommunityBriefingGrantHost,
	type CommunityBriefingProviderScope,
	communityBriefingGrantPayload,
	type SignedCommunityBriefingGrant,
	validateCommunityBriefingWriteGrant,
} from "../src/community-briefing.ts";

const providerScope = {
	tenantId: "community-tenant",
	subjectId: "reviewer",
	credentialDirectory: "/fixture/credentials",
	engineStatePath: "/fixture/engine/data.db",
	google: {
		owner: "org",
		connection: "briefingGoogle",
		authTemplate: "google-drive-file",
		ownerEmail: "owner@example.test",
		folderPath: "Community/Briefings",
	},
	discord: {
		owner: "org",
		connection: "briefingDiscord",
		authTemplate: "discord-bot",
		channelId: "555555555555555555",
	},
	transport: { mode: "production" },
} satisfies CommunityBriefingProviderScope;

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const fixture = (expectedProviderScope: CommunityBriefingProviderScope = providerScope) => {
	const root = mkdtempSync(join(tmpdir(), "community-grant-host-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const queuePath = join(root, "queue.sqlite3");
	const statePath = join(root, "state");
	const clock = { now: Date.parse("2026-09-19T12:00:00.000Z") };
	const expiresAt = new Date(clock.now + 60_000).toISOString();
	const expectedScope = structuredClone(expectedProviderScope);
	const envelope = (overrides: Partial<Omit<SignedCommunityBriefingGrant, "signature">> = {}) => {
		const unsigned = {
			issuer: "owner",
			grantId: "grant-1",
			queuePath,
			statePath,
			briefingId: "briefing-1",
			sourceHash: "a".repeat(64),
			expiresAt,
			providerScope: structuredClone(expectedScope),
			...overrides,
		};
		return {
			...unsigned,
			signature: sign(null, Buffer.from(communityBriefingGrantPayload(unsigned)), privateKey).toString("base64"),
		};
	};
	const open = () => {
		const host = new CommunityBriefingGrantHost(
			join(root, "grants"),
			new Map([["owner", publicKey.export({ type: "spki", format: "pem" }).toString()]]),
			queuePath,
			statePath,
			expectedScope,
			() => clock.now,
		);
		let closed = false;
		const close = () => {
			if (!closed) host.close();
			closed = true;
		};
		cleanups.push(close);
		return { host, close };
	};
	return { clock, envelope, open, expectedScope };
};

describe("community briefing signed grant host", () => {
	it.each([
		["tenant", { ...providerScope, tenantId: "another-tenant" }],
		["subject", { ...providerScope, subjectId: "another-reviewer" }],
		["credentials", { ...providerScope, credentialDirectory: "/fixture/other-credentials" }],
		["Engine state", { ...providerScope, engineStatePath: "/fixture/other-engine/data.db" }],
		["Google owner", { ...providerScope, google: { ...providerScope.google, owner: "user" } }],
		["Google connection", { ...providerScope, google: { ...providerScope.google, connection: "otherGoogle" } }],
		["Google account", { ...providerScope, google: { ...providerScope.google, ownerEmail: "other@example.test" } }],
		["Google folder", { ...providerScope, google: { ...providerScope.google, folderPath: "Other/Briefings" } }],
		[
			"Google template",
			{ ...providerScope, google: { ...providerScope.google, authTemplate: "google-drive-file-test-token" } },
		],
		["Discord owner", { ...providerScope, discord: { ...providerScope.discord, owner: "user" } }],
		["Discord connection", { ...providerScope, discord: { ...providerScope.discord, connection: "otherDiscord" } }],
		["Discord channel", { ...providerScope, discord: { ...providerScope.discord, channelId: "666666666666666666" } }],
		[
			"transport",
			{
				...providerScope,
				transport: {
					mode: "loopback",
					googleDriveBaseUrl: "http://127.0.0.1:1234",
					googleDocsBaseUrl: "http://127.0.0.1:1234",
					discordBaseUrl: "http://127.0.0.1:1234",
				},
			},
		],
	] as const)("requires independently selected and signed %s scope", async (_label, changed) => {
		const setup = fixture();
		const { host } = setup.open();
		await expect(
			Effect.runPromise(host.bind(setup.envelope({ providerScope: changed })).authorize()),
		).rejects.toThrow("provider scope differs");
		// Matching the owning host still requires a signature covering that scope.
		const other = fixture(changed);
		const original = other.envelope({ providerScope });
		const forged = { ...original, providerScope: changed };
		await expect(Effect.runPromise(other.open().host.bind(forged).authorize())).rejects.toThrow(
			"signature is not trusted",
		);
	});

	it.each(["googleDriveBaseUrl", "googleDocsBaseUrl", "discordBaseUrl"] as const)(
		"signs the individual loopback transport endpoint %s",
		async (endpoint) => {
			const scope: CommunityBriefingProviderScope = {
				...providerScope,
				transport: {
					mode: "loopback",
					googleDriveBaseUrl: "http://127.0.0.1:1234",
					googleDocsBaseUrl: "http://127.0.0.1:1234",
					discordBaseUrl: "http://127.0.0.1:1234",
				},
			};
			const setup = fixture(scope);
			const signed = setup.envelope();
			const changed = { ...scope, transport: { ...scope.transport, [endpoint]: "http://127.0.0.1:4321" } };
			expect(communityBriefingGrantPayload({ ...signed, providerScope: changed })).not.toBe(
				communityBriefingGrantPayload(signed),
			);
			await expect(
				Effect.runPromise(
					setup
						.open()
						.host.bind({ ...signed, providerScope: changed })
						.authorize(),
				),
			).rejects.toThrow("provider scope differs");
		},
	);

	it("freezes host-selected, signed and issued nested provider scopes", async () => {
		const setup = fixture();
		const { host } = setup.open();
		const signed = setup.envelope();
		const bound = host.bind(signed);
		Object.assign(setup.expectedScope.google, { connection: "changed-host-input" });
		Object.assign(signed.providerScope.discord, { channelId: "666666666666666666" });
		const grant = await Effect.runPromise(bound.authorize());
		expect(grant.binding.providerScope).toEqual(providerScope);
		expect(Object.isFrozen(grant.binding.providerScope)).toBe(true);
		for (const field of ["google", "discord", "transport"] as const)
			expect(Object.isFrozen(grant.binding.providerScope[field])).toBe(true);
		await expect(Effect.runPromise(bound.revalidate(grant))).resolves.toBeUndefined();
	});

	it("requires provider scope even for JavaScript callers", () => {
		const setup = fixture();
		const signed = setup.envelope();
		Reflect.deleteProperty(signed, "providerScope");
		expect(() => setup.open().host.bind(signed)).toThrow();
	});

	it("uses deterministic scope bytes independent of object key order", () => {
		const setup = fixture();
		const signed = setup.envelope();
		const reordered = {
			...signed,
			providerScope: Object.fromEntries(
				Object.entries(signed.providerScope).reverse(),
			) as CommunityBriefingProviderScope,
		};
		expect(communityBriefingGrantPayload(reordered)).toBe(communityBriefingGrantPayload(signed));
	});

	it("consumes one exact signed grant and preserves revocation", async () => {
		const root = mkdtempSync(join(tmpdir(), "community-grant-host-"));
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const queuePath = join(root, "queue.sqlite3");
		const statePath = join(root, "state");
		const unsigned = {
			issuer: "owner",
			grantId: "grant-1",
			queuePath,
			statePath,
			briefingId: "briefing-1",
			sourceHash: "a".repeat(64),
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			providerScope,
		} as const;
		const signed: SignedCommunityBriefingGrant = {
			...unsigned,
			signature: sign(null, Buffer.from(communityBriefingGrantPayload(unsigned)), privateKey).toString("base64"),
		};
		const host = new CommunityBriefingGrantHost(
			join(root, "grants"),
			new Map([["owner", publicKey.export({ type: "spki", format: "pem" }).toString()]]),
			queuePath,
			statePath,
			providerScope,
		);
		try {
			const bound = host.bind(signed);
			const grant = await Effect.runPromise(bound.authorize());
			await expect(Effect.runPromise(bound.authorize())).rejects.toThrow("consumed or revoked");
			await expect(Effect.runPromise(bound.revalidate(grant))).resolves.toBeUndefined();
			host.revoke("grant-1");
			await expect(Effect.runPromise(bound.revalidate(grant))).rejects.toThrow("absent, changed or revoked");
			await expect(
				Effect.runPromise(validateCommunityBriefingWriteGrant(grant, "publish", grant.binding.item)),
			).rejects.toThrow("revoked community briefing grant");
		} finally {
			host.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([60_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects provider use and host revalidation after clock changes to %s",
		async (delta) => {
			const setup = fixture();
			const { host } = setup.open();
			const bound = host.bind(setup.envelope());
			const grant = await Effect.runPromise(bound.authorize());
			await expect(
				Effect.runPromise(validateCommunityBriefingWriteGrant(grant, "publish", grant.binding.item)),
			).resolves.toBe(grant);
			setup.clock.now += delta;
			await expect(Effect.runPromise(bound.revalidate(grant))).rejects.toThrow("invalid or expired");
			await expect(
				Effect.runPromise(validateCommunityBriefingWriteGrant(grant, "publish", grant.binding.item)),
			).rejects.toThrow("revoked community briefing grant");
		},
	);

	it.each(["", "   "])("rejects empty grant IDs: %j", async (grantId) => {
		const setup = fixture();
		const { host } = setup.open();
		await expect(Effect.runPromise(host.bind(setup.envelope({ grantId })).authorize())).rejects.toThrow(
			"invalid or expired",
		);
	});

	it("preserves consumption and pre-revocation across reopen", async () => {
		const setup = fixture();
		const first = setup.open();
		await Effect.runPromise(first.host.bind(setup.envelope()).authorize());
		first.host.revoke("revoked-before-use");
		first.close();
		const { host } = setup.open();
		for (const grantId of ["grant-1", "revoked-before-use"]) {
			await expect(Effect.runPromise(host.bind(setup.envelope({ grantId })).authorize())).rejects.toThrow(
				"consumed or revoked",
			);
		}
	});

	it("allows only one consumer across separate hosts sharing the ledger", async () => {
		const setup = fixture();
		const first = setup.open();
		const second = setup.open();
		const results = await Promise.allSettled([
			Effect.runPromise(first.host.bind(setup.envelope()).authorize()),
			Effect.runPromise(second.host.bind(setup.envelope()).authorize()),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
	});

	it("rejects foreign objects and grants from another binding", async () => {
		const setup = fixture();
		const { host } = setup.open();
		const first = host.bind(setup.envelope());
		const second = host.bind(setup.envelope({ grantId: "grant-2" }));
		const grant = await Effect.runPromise(first.authorize());
		await expect(Effect.runPromise(second.revalidate(grant))).rejects.toThrow("does not belong");
		const foreign = await Effect.runPromise(second.authorize());
		await expect(Effect.runPromise(first.revalidate(foreign))).rejects.toThrow("does not belong");
		await expect(Effect.runPromise(first.revalidate({ ...grant }))).rejects.toThrow("does not belong");
	});

	it("snapshots the envelope before authorization and later revalidation", async () => {
		const setup = fixture();
		const { host } = setup.open();
		const signed = setup.envelope();
		const bound = host.bind(signed);
		Object.assign(signed, setup.envelope({ grantId: "replacement-before-authorization" }));
		const grant = await Effect.runPromise(bound.authorize());
		Object.assign(signed, setup.envelope({ grantId: "replacement-after-authorization" }));
		await expect(Effect.runPromise(bound.revalidate(grant))).resolves.toBeUndefined();
		host.revoke("grant-1");
		await expect(
			Effect.runPromise(validateCommunityBriefingWriteGrant(grant, "publish", grant.binding.item)),
		).rejects.toThrow("revoked community briefing grant");
	});
});
