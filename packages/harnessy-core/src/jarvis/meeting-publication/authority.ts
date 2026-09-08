import { resolve } from "node:path";

import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { JarvisMeetingPublicationConfig } from "../config-model.ts";
import {
	isMeetingPublicationWriteGrant,
	type MeetingPublicationWriteGrant,
	revalidateMeetingPublicationWriteGrant,
} from "./authority-grant-registry.ts";

export type { MeetingPublicationWriteGrant } from "./authority-grant-registry.ts";

export const MeetingPublicationWriteOperation = Schema.Literals([
	"source_update",
	"store_open",
	"store_migrate",
	"store_upsert",
	"store_approve",
	"store_reject",
	"store_archive",
	"store_restore",
	"store_claim",
	"store_checkpoint",
	"store_failure",
	"store_publish",
	"store_notification",
	"service_worker",
	"review_serve",
	"provider_google",
	"provider_discord",
	"provider_notification",
]);
export type MeetingPublicationWriteOperation = typeof MeetingPublicationWriteOperation.Type;

export class MeetingPublicationWriteBinding extends Schema.Class<MeetingPublicationWriteBinding>(
	"MeetingPublicationWriteBinding",
)({
	sourcePath: Schema.String,
	statePath: Schema.String,
	item: Schema.optional(Schema.Struct({ itemId: Schema.String, sourceHash: Schema.String })),
}) {}

export const MeetingPublicationWriteAuthorityCode = Schema.Literals([
	"authorized",
	"v1_owned",
	"missing_binding",
	"binding_mismatch",
	"revoked",
	"invalid_grant",
]);
export type MeetingPublicationWriteAuthorityCode = typeof MeetingPublicationWriteAuthorityCode.Type;

export class MeetingPublicationWriteAuthorityError extends Schema.TaggedErrorClass<MeetingPublicationWriteAuthorityError>()(
	"MeetingPublicationWriteAuthorityError",
	{
		operation: MeetingPublicationWriteOperation,
		code: MeetingPublicationWriteAuthorityCode,
	},
) {}

export class MeetingPublicationWriteAuthorityState extends Schema.Class<MeetingPublicationWriteAuthorityState>(
	"MeetingPublicationWriteAuthorityState",
)({
	owner: Schema.Literals(["v1", "v2_test", "v2_smoke", "v2_review", "v2_worker", "v2_full_review"]),
	authorized: Schema.Boolean,
	code: MeetingPublicationWriteAuthorityCode,
}) {}

const bindingFor = (config: JarvisMeetingPublicationConfig): MeetingPublicationWriteBinding | null => {
	if (
		config.sourcePath === null ||
		config.sourcePath.trim().length === 0 ||
		config.statePath === null ||
		config.statePath.trim().length === 0
	) {
		return null;
	}
	return Object.freeze(
		new MeetingPublicationWriteBinding({
			sourcePath: resolve(config.sourcePath),
			statePath: resolve(config.statePath),
		}),
	);
};

export const resolveMeetingPublicationWriteBinding = Effect.fn("MeetingPublicationWriteAuthority.resolveBinding")(
	function* (config: JarvisMeetingPublicationConfig, operation: MeetingPublicationWriteOperation) {
		const binding = bindingFor(config);
		if (binding === null) {
			return yield* new MeetingPublicationWriteAuthorityError({ operation, code: "missing_binding" });
		}
		return binding;
	},
);

/**
 * Deny-by-default Core authority. The approved runtime composition must validate
 * operational authorization internally before providing a permitting service.
 */
export class MeetingPublicationWriteAuthority extends Context.Service<
	MeetingPublicationWriteAuthority,
	{
		readonly authorize: (
			operation: MeetingPublicationWriteOperation,
			binding: MeetingPublicationWriteBinding,
		) => Effect.Effect<MeetingPublicationWriteGrant, MeetingPublicationWriteAuthorityError>;
		readonly state: (
			binding: MeetingPublicationWriteBinding | null,
		) => Effect.Effect<MeetingPublicationWriteAuthorityState>;
	}
>()("@harnessy/core/MeetingPublicationWriteAuthority") {
	static readonly defaultLayer = Layer.succeed(
		MeetingPublicationWriteAuthority,
		MeetingPublicationWriteAuthority.of({
			authorize: (operation) =>
				Effect.fail(new MeetingPublicationWriteAuthorityError({ operation, code: "v1_owned" })),
			state: (binding) =>
				Effect.succeed(
					new MeetingPublicationWriteAuthorityState({
						owner: "v1",
						authorized: false,
						code: binding === null ? "missing_binding" : "v1_owned",
					}),
				),
		}),
	);
	static readonly v1OwnedLayer = MeetingPublicationWriteAuthority.defaultLayer;
}

/**
 * Validate grant provenance, operation, and an exact item revision when requested.
 * A grant from a duplicate Core installation intentionally fails this check.
 */
export const validateMeetingPublicationWriteGrant = Effect.fn("MeetingPublicationWriteAuthority.validateGrant")(
	function* (
		grant: unknown,
		expectedOperation: MeetingPublicationWriteOperation,
		expectedItem?: NonNullable<MeetingPublicationWriteBinding["item"]>,
	) {
		if (
			!isMeetingPublicationWriteGrant(grant, expectedOperation) ||
			(expectedItem !== undefined &&
				(grant.binding.item?.itemId !== expectedItem.itemId ||
					grant.binding.item?.sourceHash !== expectedItem.sourceHash))
		) {
			return yield* new MeetingPublicationWriteAuthorityError({
				operation: expectedOperation,
				code: "invalid_grant",
			});
		}
		const registered = grant as MeetingPublicationWriteGrant;
		const revalidation = revalidateMeetingPublicationWriteGrant(registered, expectedOperation);
		if (revalidation === undefined || !(yield* revalidation)) {
			return yield* new MeetingPublicationWriteAuthorityError({
				operation: expectedOperation,
				code: "revoked",
			});
		}
		return registered;
	},
);
