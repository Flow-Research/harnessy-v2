import { AsyncLocalStorage } from "node:async_hooks";

import { Context, Effect } from "effect";

type MutationGuard = Effect.Effect<void, unknown>;

const CurrentMeetingPublicationMutationGuard = Context.Reference<MutationGuard>(
	"@harnessy/sdk/CurrentMeetingPublicationMutationGuard",
	{ defaultValue: () => Effect.void },
);

const mutationGuardStorage = new AsyncLocalStorage<MutationGuard>();

const mutatesRemoteState = (method: string | undefined) => {
	const normalized = (method ?? "GET").toUpperCase();
	return normalized === "POST" || normalized === "PUT" || normalized === "PATCH" || normalized === "DELETE";
};

/** @internal Revalidate the grant installed for this one provider invocation. */
export const revalidateMeetingPublicationMutation = Effect.flatMap(
	CurrentMeetingPublicationMutationGuard,
	(guard) => guard,
);

/**
 * @internal Run one exact approved Engine invocation with a private live guard.
 *
 * Context carries the guard to SDK plugins. AsyncLocalStorage carries the same
 * guard to oauth4webapi's native-Fetch seam, which cannot consume Effect's
 * HttpClient service. Neither mechanism is part of the public Engine contract.
 */
export const withMeetingPublicationMutationGuard = <A, E, G>(
	effect: Effect.Effect<A, E>,
	guard: Effect.Effect<void, G>,
): Effect.Effect<A, E> =>
	Effect.callback((resume, signal) => {
		mutationGuardStorage.run(guard, () => {
			Effect.runCallback(effect.pipe(Effect.provideService(CurrentMeetingPublicationMutationGuard, guard)), {
				signal,
				onExit: resume,
			});
		});
	});

/** @internal Native-Fetch adapter used only for Executor-owned OAuth writes. */
export const guardedMeetingPublicationFetch: typeof globalThis.fetch = async (input, init) => {
	const method = init?.method ?? (input instanceof Request ? input.method : undefined);
	const guard = mutationGuardStorage.getStore();
	if (guard !== undefined && mutatesRemoteState(method)) {
		try {
			await Effect.runPromise(guard);
		} catch {
			throw new Error("Meeting publication authorization was rejected.");
		}
	}
	return globalThis.fetch(input, init);
};
