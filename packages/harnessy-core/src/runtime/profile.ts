import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { causeMessage, HarnessError } from "../errors.ts";

/** Default profile output modes for commands that support multiple renderers. */
export const ProfileOutputMode = Schema.Literals(["text", "json"]);

/** Default profile output modes for commands that support multiple renderers. */
export type ProfileOutputMode = typeof ProfileOutputMode.Type;

/** Runtime profile controlling context files, scoped memory, and default capability selection. */
export class HarnessProfile extends Schema.Class<HarnessProfile>("HarnessProfile")({
	/** Human-readable profile name. */
	name: Schema.String,
	/** Optional description of when this profile should be used. */
	description: Schema.optional(Schema.String),
	/** Project-root-relative or absolute context file paths loaded for agents. */
	context: Schema.Array(Schema.String),
	/** Project-root-relative or absolute scoped memory files loaded with this profile. */
	memory: Schema.optional(Schema.Array(Schema.String)),
	/** Capability ids enabled by default for this profile. */
	capabilities: Schema.Array(Schema.String),
	/** Preferred output mode when a command supports profile-driven rendering. */
	defaultOutputMode: Schema.optional(ProfileOutputMode),
	/** Machine-readable labels for inventory, policy grouping, and Garden boundary metadata. */
	labels: Schema.optional(Schema.Array(Schema.String)),
}) {}

/** Decode profile text with Effect Schema. */
const HarnessProfileJson = Schema.fromJsonString(HarnessProfile);

/** Parse and validate profile JSON as an Effect. */
export const parseProfile = Effect.fn("HarnessProfile.parse")(function* (raw: string, sourcePath: string) {
	return yield* Schema.decodeUnknownEffect(HarnessProfileJson)(raw).pipe(
		Effect.mapError(
			(cause) =>
				new HarnessError({
					message: `Invalid Harnessy profile ${sourcePath}: ${causeMessage(cause)}`,
					cause,
				}),
		),
	);
});
