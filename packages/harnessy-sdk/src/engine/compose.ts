import { type Effect, Schema } from "effect";

export const EngineOwner = Schema.Literals(["org", "user"]);
export type EngineOwner = typeof EngineOwner.Type;

export class EngineConnection extends Schema.Class<EngineConnection>("EngineConnection")({
	owner: EngineOwner,
	integration: Schema.String,
	name: Schema.String,
}) {}

export class EngineTool extends Schema.Class<EngineTool>("EngineTool")({
	address: Schema.String,
	owner: EngineOwner,
	integration: Schema.String,
	connection: Schema.String,
	name: Schema.String,
	description: Schema.String,
}) {}

export class EngineIntegration extends Schema.Class<EngineIntegration>("EngineIntegration")({
	slug: Schema.String,
	name: Schema.String,
	description: Schema.String,
	kind: Schema.String,
}) {}

export class EngineHealth extends Schema.Class<EngineHealth>("EngineHealth")({
	status: Schema.Literals(["healthy", "expired", "degraded", "unknown"]),
	httpStatus: Schema.optional(Schema.Number),
	identity: Schema.optional(Schema.String),
	checkedAt: Schema.Number,
	detail: Schema.optional(Schema.String),
}) {}

export class EnginePolicyDecision extends Schema.Class<EnginePolicyDecision>("EnginePolicyDecision")({
	action: Schema.Literals(["approve", "require_approval", "block"]),
	source: Schema.Literals(["user", "plugin-default"]),
	pattern: Schema.optional(Schema.String),
	policyId: Schema.optional(Schema.String),
}) {}

export interface EngineConnectionRef {
	readonly owner: EngineOwner;
	readonly integration: string;
	readonly name: string;
}

/**
 * Host-supplied connection material for the narrow SDK boundary. The adapter
 * persists these values only through the credential directory selected by the
 * host; provider handles and Executor credential types remain internal.
 */
export interface EngineConnectionCreateInput extends EngineConnectionRef {
	readonly template: string;
	readonly values: Readonly<Record<string, string>>;
	readonly identityLabel?: string | null;
	readonly description?: string | null;
}

/** Harnessy-owned structural boundary. No vendored engine type crosses this interface. */
export interface HarnessyEngineHandle {
	readonly execute: (address: string, args: unknown) => Effect.Effect<unknown, unknown>;
	/** Per-call, in-memory approval for one Core-approved meeting mutation. */
	readonly executeApprovedMeetingMutation: (
		address: string,
		args: unknown,
		approval: { readonly itemId: string; readonly sourceHash: string },
	) => Effect.Effect<unknown, unknown>;
	readonly connections: {
		readonly create: (input: EngineConnectionCreateInput) => Effect.Effect<EngineConnection, unknown>;
		readonly list: (filter?: {
			readonly integration?: string;
			readonly owner?: EngineOwner;
		}) => Effect.Effect<ReadonlyArray<EngineConnection>, unknown>;
		readonly checkHealth: (ref: EngineConnectionRef) => Effect.Effect<EngineHealth, unknown>;
	};
	readonly tools: {
		readonly list: (filter?: {
			readonly integration?: string;
			readonly owner?: EngineOwner;
			readonly connection?: string;
		}) => Effect.Effect<ReadonlyArray<EngineTool>, unknown>;
	};
	readonly integrations: {
		readonly list: () => Effect.Effect<ReadonlyArray<EngineIntegration>, unknown>;
	};
	readonly policies: {
		readonly resolve: (address: string) => Effect.Effect<EnginePolicyDecision, unknown>;
	};
}

export const engineToolAddress = (input: {
	readonly integration: string;
	readonly owner: EngineOwner;
	readonly connection: string;
	readonly tool: string;
}): string => `tools.${input.integration}.${input.owner}.${input.connection}.${input.tool}`;
