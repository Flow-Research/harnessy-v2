import * as Effect from "effect/Effect";

import type { MeetingPublicationWriteBinding, MeetingPublicationWriteOperation } from "./authority.ts";

const writeGrantBrand: unique symbol = Symbol("MeetingPublicationWriteGrant");
const issuedWriteGrants = new WeakMap<object, MeetingPublicationWriteGrantValidator>();

/** @internal Live validation remains package-private even when the grant type crosses into the SDK. */
export interface MeetingPublicationWriteGrantValidator {
	readonly validate: (
		operation: MeetingPublicationWriteOperation,
		binding: MeetingPublicationWriteBinding,
	) => Effect.Effect<boolean>;
}

/** Publicly consumable type whose construction remains package-internal. */
export interface MeetingPublicationWriteGrant {
	readonly operation: MeetingPublicationWriteOperation;
	readonly binding: MeetingPublicationWriteBinding;
	readonly [writeGrantBrand]: true;
}

/** @internal Used only by the source-level test fixture, never a package export. */
export const issueMeetingPublicationWriteGrant = (
	operation: MeetingPublicationWriteOperation,
	binding: MeetingPublicationWriteBinding,
	validator: MeetingPublicationWriteGrantValidator,
): MeetingPublicationWriteGrant => {
	const snapshot = Object.freeze({
		sourcePath: binding.sourcePath,
		statePath: binding.statePath,
		item: binding.item === undefined ? undefined : Object.freeze({ ...binding.item }),
	});
	const grant = Object.freeze({
		operation,
		binding: snapshot,
		[writeGrantBrand]: true,
	}) as MeetingPublicationWriteGrant;
	issuedWriteGrants.set(grant, validator);
	return grant;
};

/** @internal Used only by the source-level test fixture, never a package export. */
export const issueMeetingPublicationWriteGrantForTest = (
	operation: MeetingPublicationWriteOperation,
	binding: MeetingPublicationWriteBinding,
	validator: MeetingPublicationWriteGrantValidator = { validate: () => Effect.succeed(true) },
): MeetingPublicationWriteGrant => issueMeetingPublicationWriteGrant(operation, binding, validator);

/** @internal Runtime provenance check shared with exported validation. */
export const isMeetingPublicationWriteGrant = (
	grant: unknown,
	expectedOperation: MeetingPublicationWriteOperation,
): grant is MeetingPublicationWriteGrant =>
	typeof grant === "object" &&
	grant !== null &&
	issuedWriteGrants.has(grant) &&
	(grant as Partial<MeetingPublicationWriteGrant>).operation === expectedOperation;

/** @internal Revalidate the live session associated with an authentic grant. */
export const revalidateMeetingPublicationWriteGrant = (
	grant: MeetingPublicationWriteGrant,
	expectedOperation: MeetingPublicationWriteOperation,
) => issuedWriteGrants.get(grant)?.validate(expectedOperation, grant.binding);
