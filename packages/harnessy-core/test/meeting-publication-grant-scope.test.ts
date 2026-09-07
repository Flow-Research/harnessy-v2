import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
	MeetingPublicationWriteBinding,
	validateMeetingPublicationWriteGrant,
} from "../src/jarvis/meeting-publication/authority.ts";
import { authorizeMeetingPublicationWrite } from "../src/jarvis/meeting-publication/authority-check.ts";
import { issueMeetingPublicationWriteGrantForTest } from "../src/jarvis/meeting-publication/authority-grant-registry.ts";

const item = { itemId: "a".repeat(24), sourceHash: "b".repeat(64) };
const paths = { sourcePath: "/fixture/notes", statePath: "/fixture/state" };

describe("meeting publication grant item scope", () => {
	it.effect("accepts the authentic grant only for its exact item revision", () =>
		Effect.gen(function* () {
			const binding = new MeetingPublicationWriteBinding({ ...paths, item });
			const grant = issueMeetingPublicationWriteGrantForTest("provider_google", binding);
			expect(yield* validateMeetingPublicationWriteGrant(grant, "provider_google", item)).toBe(grant);
			expect(
				yield* authorizeMeetingPublicationWrite(
					{ authorize: () => Effect.succeed(grant) },
					"provider_google",
					binding,
				),
			).toBe(grant);
		}),
	);

	it.effect("rechecks the private live validator on every use of an authentic grant", () =>
		Effect.gen(function* () {
			let active = true;
			const binding = new MeetingPublicationWriteBinding({ ...paths, item });
			const grant = issueMeetingPublicationWriteGrantForTest("provider_google", binding, {
				validate: () => Effect.sync(() => active),
			});
			expect(yield* validateMeetingPublicationWriteGrant(grant, "provider_google", item)).toBe(grant);
			active = false;
			const revoked = yield* validateMeetingPublicationWriteGrant(grant, "provider_google", item).pipe(
				Effect.result,
			);
			expect(revoked._tag).toBe("Failure");
			if (revoked._tag === "Failure") expect(revoked.failure.code).toBe("revoked");
		}),
	);

	it.each([
		["missing item scope", undefined],
		["different item", { ...item, itemId: "c".repeat(24) }],
		["different revision", { ...item, sourceHash: "d".repeat(64) }],
	] as const)("rejects %s without confusing valid provenance with permission", async (_name, grantedItem) => {
		const grant = issueMeetingPublicationWriteGrantForTest(
			"provider_google",
			new MeetingPublicationWriteBinding({ ...paths, item: grantedItem }),
		);
		const result = await Effect.runPromise(
			validateMeetingPublicationWriteGrant(grant, "provider_google", item).pipe(Effect.result),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") expect(result.failure.code).toBe("invalid_grant");
	});

	it.effect("does not let a custom authority substitute or widen a scoped grant", () =>
		Effect.gen(function* () {
			const grant = issueMeetingPublicationWriteGrantForTest(
				"store_claim",
				new MeetingPublicationWriteBinding({ ...paths, item }),
			);
			for (const requestedItem of [undefined, { ...item, sourceHash: "e".repeat(64) }]) {
				const result = yield* authorizeMeetingPublicationWrite(
					{ authorize: () => Effect.succeed(grant) },
					"store_claim",
					new MeetingPublicationWriteBinding({ ...paths, item: requestedItem }),
				).pipe(Effect.result);
				expect(result._tag).toBe("Failure");
				if (result._tag === "Failure") expect(result.failure.code).toBe("binding_mismatch");
			}
		}),
	);

	it("snapshots and freezes the grant binding so caller mutation cannot retarget it", () => {
		const mutableItem = { ...item };
		const supplied = { ...paths, item: mutableItem };
		const grant = issueMeetingPublicationWriteGrantForTest("provider_google", supplied);
		supplied.statePath = "/fixture/other-state";
		mutableItem.itemId = "f".repeat(24);
		mutableItem.sourceHash = "0".repeat(64);
		expect(grant.binding).toEqual({ ...paths, item });
		expect(grant.binding).not.toBe(supplied);
		expect(Object.isFrozen(grant)).toBe(true);
		expect(Object.isFrozen(grant.binding)).toBe(true);
		expect(Object.isFrozen(grant.binding.item)).toBe(true);
	});
});
