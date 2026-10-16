import { Data } from "effect";

export class KeychainError extends Data.TaggedError("KeychainError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
