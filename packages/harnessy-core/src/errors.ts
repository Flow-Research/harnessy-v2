import { Schema } from "effect";

/** Structured failure for Harnessy CLI/core operations. */
export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
	/** User-facing error message. */
	message: Schema.String,
	/** Optional original failure retained for debugging and Effect causes. */
	cause: Schema.optional(Schema.Unknown),
}) {}

/** Convert unknown causes into a readable message without throwing. */
export const causeMessage = (cause: unknown): string => {
	if (cause instanceof Error) return cause.message;
	if (typeof cause === "string") return cause;
	return String(cause);
};
