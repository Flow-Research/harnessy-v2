import type { Effect } from "effect";

declare module "effect/Context" {
  interface Service<Identifier, Shape> {
    asEffect(): Effect.Effect<Shape, never, Identifier>;
  }
}

export {};
