import * as Effect from "effect/Effect";

import {
	MeetingPublicationWriteAuthorityError,
	type MeetingPublicationWriteBinding,
	type MeetingPublicationWriteGrant,
	type MeetingPublicationWriteOperation,
	validateMeetingPublicationWriteGrant,
} from "./authority.ts";

interface WriteAuthorityService {
	readonly authorize: (
		operation: MeetingPublicationWriteOperation,
		binding: MeetingPublicationWriteBinding,
	) => Effect.Effect<MeetingPublicationWriteGrant, MeetingPublicationWriteAuthorityError>;
}

/** @internal Every Core mutation boundary must authorize and validate provenance through this helper. */
export const authorizeMeetingPublicationWrite = Effect.fn("MeetingPublicationWriteAuthority.authorizeAndValidate")(
	function* (
		authority: WriteAuthorityService,
		operation: MeetingPublicationWriteOperation,
		binding: MeetingPublicationWriteBinding,
	) {
		const grant = yield* authority.authorize(operation, binding);
		const validated = yield* validateMeetingPublicationWriteGrant(grant, operation);
		if (
			validated.binding.sourcePath !== binding.sourcePath ||
			validated.binding.statePath !== binding.statePath ||
			validated.binding.item?.itemId !== binding.item?.itemId ||
			validated.binding.item?.sourceHash !== binding.item?.sourceHash
		) {
			return yield* new MeetingPublicationWriteAuthorityError({ operation, code: "binding_mismatch" });
		}
		return validated;
	},
);
