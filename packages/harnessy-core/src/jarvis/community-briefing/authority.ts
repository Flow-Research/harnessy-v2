import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { MeetingPublicationSmokeProviderBinding } from "../meeting-publication/operational-input.ts";

const grantBrand: unique symbol = Symbol("CommunityBriefingWriteGrant");
const validators = new WeakMap<object, CommunityBriefingWriteGrantValidator>();

/** One finite grant covers the ordered Google-then-Discord publication unit. */
export type CommunityBriefingWriteOperation = "publish";

/** Existing host-owned Executor configuration, not a new provider identity registry. */
export type CommunityBriefingProviderScope = Pick<
	MeetingPublicationSmokeProviderBinding,
	"tenantId" | "subjectId" | "credentialDirectory" | "engineStatePath" | "google" | "discord" | "transport"
>;

const ScopeText = Schema.String.pipe(Schema.check(Schema.isPattern(/\S/u)));
const ProviderScope = Schema.Struct({
	tenantId: ScopeText,
	subjectId: ScopeText,
	credentialDirectory: ScopeText,
	engineStatePath: ScopeText,
	google: Schema.Struct({
		owner: Schema.Literals(["org", "user"]),
		connection: ScopeText,
		authTemplate: Schema.Literals(["google-drive-file", "google-drive-file-test-token"]),
		ownerEmail: ScopeText,
		folderPath: ScopeText,
	}),
	discord: Schema.Struct({
		owner: Schema.Literals(["org", "user"]),
		connection: ScopeText,
		authTemplate: Schema.Literal("discord-bot"),
		channelId: ScopeText,
	}),
	transport: Schema.Union([
		Schema.Struct({ mode: Schema.Literal("production") }),
		Schema.Struct({
			mode: Schema.Literal("loopback"),
			googleDriveBaseUrl: ScopeText,
			googleDocsBaseUrl: ScopeText,
			discordBaseUrl: ScopeText,
		}),
	]),
});

/** @internal Decode all required fields and detach every nested caller-owned object. */
export const snapshotCommunityBriefingProviderScope = (
	input: CommunityBriefingProviderScope,
): CommunityBriefingProviderScope => {
	const scope = Schema.decodeUnknownSync(ProviderScope)(input);
	return Object.freeze({
		...scope,
		google: Object.freeze({ ...scope.google }),
		discord: Object.freeze({ ...scope.discord }),
		transport: Object.freeze({ ...scope.transport }),
	});
};

/** Stable signing and comparison bytes independent of object property order. */
export const communityBriefingProviderScopePayload = (input: CommunityBriefingProviderScope): string => {
	const scope = snapshotCommunityBriefingProviderScope(input);
	return JSON.stringify([
		scope.tenantId,
		scope.subjectId,
		scope.credentialDirectory,
		scope.engineStatePath,
		[
			scope.google.owner,
			scope.google.connection,
			scope.google.authTemplate,
			scope.google.ownerEmail,
			scope.google.folderPath,
		],
		[scope.discord.owner, scope.discord.connection, scope.discord.authTemplate, scope.discord.channelId],
		scope.transport.mode === "production"
			? ["production"]
			: [
					"loopback",
					scope.transport.googleDriveBaseUrl,
					scope.transport.googleDocsBaseUrl,
					scope.transport.discordBaseUrl,
				],
	]);
};

export interface CommunityBriefingWriteBinding {
	readonly queuePath: string;
	readonly statePath: string;
	readonly providerScope: CommunityBriefingProviderScope;
	readonly item: { readonly briefingId: string; readonly sourceHash: string };
}

export interface CommunityBriefingWriteGrantValidator {
	readonly validate: (
		operation: CommunityBriefingWriteOperation,
		binding: CommunityBriefingWriteBinding,
	) => Effect.Effect<boolean>;
}

/** A community grant is intentionally distinct from meeting publication authority. */
export interface CommunityBriefingWriteGrant {
	readonly operation: CommunityBriefingWriteOperation;
	readonly binding: CommunityBriefingWriteBinding;
	readonly [grantBrand]: true;
}

/** Internal issuance hook for the owning community runtime and isolated fixtures. */
export const issueCommunityBriefingWriteGrant = (
	operation: CommunityBriefingWriteOperation,
	binding: CommunityBriefingWriteBinding,
	validator: CommunityBriefingWriteGrantValidator,
): CommunityBriefingWriteGrant => {
	const grant = Object.freeze({
		operation,
		binding: Object.freeze({
			...binding,
			item: Object.freeze({ ...binding.item }),
			providerScope: snapshotCommunityBriefingProviderScope(binding.providerScope),
		}),
		[grantBrand]: true,
	}) as CommunityBriefingWriteGrant;
	validators.set(grant, validator);
	return grant;
};

/** Internal fixture hook; production authority remains deny-by-default until hosted. */
export const issueCommunityBriefingWriteGrantForTest = (
	operation: CommunityBriefingWriteOperation,
	binding: CommunityBriefingWriteBinding,
	validator: CommunityBriefingWriteGrantValidator = { validate: () => Effect.succeed(true) },
): CommunityBriefingWriteGrant => issueCommunityBriefingWriteGrant(operation, binding, validator);

export const validateCommunityBriefingWriteGrant = (
	grant: unknown,
	operation: CommunityBriefingWriteOperation,
	item: { readonly briefingId: string; readonly sourceHash: string },
): Effect.Effect<CommunityBriefingWriteGrant, Error> =>
	Effect.gen(function* () {
		if (
			typeof grant !== "object" ||
			grant === null ||
			!validators.has(grant) ||
			(grant as Partial<CommunityBriefingWriteGrant>).operation !== operation ||
			(grant as Partial<CommunityBriefingWriteGrant>).binding?.item.briefingId !== item.briefingId ||
			(grant as Partial<CommunityBriefingWriteGrant>).binding?.item.sourceHash !== item.sourceHash
		) {
			return yield* Effect.fail(new Error("invalid community briefing grant"));
		}
		const typed = grant as CommunityBriefingWriteGrant;
		const validator = validators.get(typed);
		if (validator === undefined || !(yield* validator.validate(operation, typed.binding))) {
			return yield* Effect.fail(new Error("revoked community briefing grant"));
		}
		return typed;
	});
