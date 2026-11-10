import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { effectWorkerTest } from "./effect-worker-test";

describe("Effect bridge for the Cloudflare test pool", () => {
  it("closes scoped resources before completing", async () => {
    let closed = false;
    const result = await effectWorkerTest(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        return 42;
      }),
    )({ signal: new AbortController().signal, onTestFinished: () => {} });
    expect(result).toBe(42);
    expect(closed).toBe(true);
  });

  it("preserves failures", async () => {
    await expect(
      effectWorkerTest(() => Effect.fail("bridge failure"))({
        signal: new AbortController().signal,
        onTestFinished: () => {},
      }),
    ).rejects.toThrow("bridge failure");
  });

  it("interrupts on runner cancellation and registers awaited cleanup", async () => {
    const controller = new AbortController();
    const started = Deferred.makeUnsafe<void>();
    const cleanups: Array<() => Promise<void>> = [];
    let closed = false;
    const result = effectWorkerTest(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        yield* Deferred.succeed(started, undefined);
        yield* Effect.never;
      }),
    )({
      signal: controller.signal,
      onTestFinished: (cleanup) => {
        cleanups.push(cleanup);
      },
    });
    const failure = expect(result).rejects.toThrow();
    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    await failure;
    await Promise.all(cleanups.map((cleanup) => cleanup()));
    expect(cleanups).toHaveLength(1);
    expect(closed).toBe(true);
  });

  it("provides the deterministic Effect test clock", async () => {
    const result = await effectWorkerTest(() =>
      Effect.gen(function* () {
        const sleeper = yield* Effect.sleep("1 hour").pipe(Effect.as(42), Effect.forkChild);
        yield* TestClock.adjust("1 hour");
        return yield* Fiber.join(sleeper);
      }),
    )({ signal: new AbortController().signal, onTestFinished: () => {} });
    expect(result).toBe(42);
  });
});
