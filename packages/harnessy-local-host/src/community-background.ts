import { Deferred, Effect, Exit, Fiber } from "effect";

/** One serial worker in its owning Engine scope. Failure never schedules a retry.
 * A requested drain finishes the current operation; scope interruption instead
 * preserves the publication boundary's uncertain-delivery lease and reports it.
 */
export const startCommunityBackground = (runOnce: Effect.Effect<unknown, unknown>, onStopped: Effect.Effect<void>) =>
	Effect.gen(function* () {
		const stop = yield* Deferred.make<void>();
		const worker = yield* Effect.gen(function* () {
			while (!Deferred.isDoneUnsafe(stop)) {
				yield* runOnce;
				yield* Effect.sleep("5 minutes").pipe(Effect.raceFirst(Deferred.await(stop)));
			}
		}).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? onStopped : Effect.void)),
			Effect.catchCause(() => Effect.void),
			Effect.forkScoped,
		);
		return Deferred.succeed(stop, undefined).pipe(Effect.andThen(Fiber.join(worker)));
	});
