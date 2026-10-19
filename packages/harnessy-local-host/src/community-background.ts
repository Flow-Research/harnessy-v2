import { Deferred, Effect, Exit, Fiber } from "effect";

/** A bounded restart after a failure that provably began no publication. */
export interface CommunityBackgroundRecovery {
	/** True only for a failure rejected before any lease (no publication began). */
	readonly retryable: (cause: unknown) => boolean;
	readonly coolDownMs: number;
	/** Recoveries allowed for the life of the worker; a success does not reset the count. */
	readonly maxRecoveries: number;
	readonly onRecovering: (attempt: number) => Effect.Effect<void>;
}

/** One serial worker in its owning Engine scope. A failure stops it, except a failure
 * `recovery` marks retryable, which starts again after a cool-down at most
 * `maxRecoveries` times for the life of the worker. A requested drain finishes the current operation;
 * scope interruption instead preserves the publication boundary's uncertain-delivery
 * lease and reports it.
 */
export const startCommunityBackground = (
	runOnce: Effect.Effect<unknown, unknown>,
	onStopped: Effect.Effect<void>,
	recovery?: CommunityBackgroundRecovery,
) =>
	Effect.gen(function* () {
		const stop = yield* Deferred.make<void>();
		const worker = yield* Effect.gen(function* () {
			let recoveries = 0;
			while (!Deferred.isDoneUnsafe(stop)) {
				const completed = yield* runOnce.pipe(
					Effect.as(true),
					Effect.catch((cause) =>
						recovery !== undefined && recoveries < recovery.maxRecoveries && recovery.retryable(cause)
							? Effect.succeed(false)
							: Effect.fail(cause),
					),
				);
				if (!completed && recovery !== undefined) {
					recoveries += 1;
					yield* recovery.onRecovering(recoveries);
					yield* Effect.sleep(recovery.coolDownMs).pipe(Effect.raceFirst(Deferred.await(stop)));
					continue;
				}
				yield* Effect.sleep("5 minutes").pipe(Effect.raceFirst(Deferred.await(stop)));
			}
		}).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? onStopped : Effect.void)),
			Effect.catchCause(() => Effect.void),
			Effect.forkScoped,
		);
		return Deferred.succeed(stop, undefined).pipe(Effect.andThen(Fiber.join(worker)));
	});
