import "../../harnessy-local-host/test/support/fixture-network-guard.mjs";
import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommunityBriefingGrantHost, communityBriefingGrantPayload } from "@harnessy/core";
import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import { startCommunityBackground } from "../../harnessy-local-host/src/community-background.ts";
import { runNativeCommunityBriefing } from "../src/community-briefing/runtime.ts";
import { makeHarnessyEngine } from "../src/engine.ts";
import { makeCommunityRuntimeFixture } from "./support/community-runtime-fixture.ts";

it.each([false, true])(
	"preserves the shared owner and partial receipt when stop notification fails=%s",
	async (notificationFails) => {
		const f = await makeCommunityRuntimeFixture();
		const keys = generateKeyPairSync("ed25519");
		const now = Date.now();
		const host = new CommunityBriefingGrantHost(
			join(f.root, "authority"),
			new Map([["fixture", keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
			f.queuePath,
			f.statePath,
			f.providerScope,
			() => now,
		);
		const payload = {
			issuer: "fixture",
			grantId: "background-revocation",
			queuePath: f.queuePath,
			statePath: f.statePath,
			briefingId: f.briefingId,
			sourceHash: f.sourceHash,
			expiresAt: new Date(now + 600_000).toISOString(),
			providerScope: f.providerScope,
		};
		let runs = 0,
			alerts = 0;
		try {
			const grant = await Effect.runPromise(
				host
					.bind({
						...payload,
						signature: sign(null, Buffer.from(communityBriefingGrantPayload(payload)), keys.privateKey).toString(
							"base64",
						),
					})
					.authorize(),
			);
			f.wire.onRequest = (request) => {
				if (request.method === "POST" && request.path.endsWith("/permissions")) host.revoke(payload.grantId);
			};
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const transport = f.providerScope.transport;
						if (transport.mode !== "loopback") throw new Error("Expected loopback providers");
						const config = {
							tenant: f.providerScope.tenantId,
							subject: f.providerScope.subjectId,
							credentialDirectory: f.credentialDirectory,
							existingStatePath: f.engineStatePath,
							meetingProviderTransport: { ...transport, kind: "test-loopback" as const },
							onElicitation: () => Effect.succeed({ action: "decline" as const }),
						};
						const owner = yield* makeHarnessyEngine(config);
						const reported = yield* Deferred.make<void>();
						const stop = yield* startCommunityBackground(
							Effect.suspend(() => {
								runs++;
								return runNativeCommunityBriefing(grant, () => now, owner);
							}),
							Effect.sync(() => {
								alerts++;
							}).pipe(
								Effect.andThen(Deferred.succeed(reported, undefined)),
								Effect.andThen(
									notificationFails ? Effect.die(new Error("synthetic notification failure")) : Effect.void,
								),
							),
						);
						yield* Deferred.await(reported).pipe(Effect.timeout("10 seconds"));
						yield* stop;
						yield* stop;
						expect(runs).toBe(1);
						expect(alerts).toBe(1);
						expect(yield* owner.connections.list({ owner: "user" })).toHaveLength(2);
						expect(yield* makeHarnessyEngine(config).pipe(Effect.flip)).toMatchObject({
							cause: { code: "ownership_held" },
						});
						const db = new DatabaseSync(f.queuePath, { readOnly: true });
						try {
							expect(
								db
									.prepare(
										"SELECT google_doc_id,discord_message_id,approved_hash,attempts FROM community_briefings",
									)
									.get(),
							).toMatchObject({
								google_doc_id: expect.any(String),
								discord_message_id: null,
								approved_hash: f.sourceHash,
								attempts: 1,
							});
						} finally {
							db.close();
						}
						expect(f.wire.messagesByNonce.size).toBe(0);
					}),
				),
			);
		} finally {
			host.close();
			await f.cleanup();
		}
	},
);
