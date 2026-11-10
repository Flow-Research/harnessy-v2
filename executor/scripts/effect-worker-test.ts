import { Effect, Layer, Scope } from "effect";
import { TestClock, TestConsole } from "effect/testing";

const testEnvironment = Layer.mergeAll(TestClock.layer(), TestConsole.layer);

interface WorkerTestContext {
  readonly signal: AbortSignal;
  readonly onTestFinished: (cleanup: () => Promise<void>) => void;
}

/**
 * Run current Effect tests in Cloudflare's supported Vitest 4 pool. Effect's
 * published Vitest 5 adapter cannot run there. Keep the test clock and console,
 * abort the fiber with the runner, and await scoped finalizers after timeout.
 * The abort cleanup follows @effect/vitest 4.1.3's settleOnAbort contract.
 */
export const effectWorkerTest =
  <A, E>(
    body: () => Effect.Effect<A, E, TestClock.TestClock | TestConsole.TestConsole | Scope.Scope>,
  ) =>
  (context: WorkerTestContext): Promise<A> => {
    const promise = Effect.runPromise(
      Effect.scoped(Effect.suspend(body)).pipe(Effect.provide(testEnvironment)),
      { signal: context.signal },
    );
    const onAbort = () =>
      context.onTestFinished(() =>
        promise.then(
          () => {},
          () => {},
        ),
      );
    context.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => context.signal.removeEventListener("abort", onAbort);
    promise.then(cleanup, cleanup);
    if (context.signal.aborted) onAbort();
    return promise;
  };
