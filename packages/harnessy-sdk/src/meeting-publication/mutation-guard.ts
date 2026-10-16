import { AsyncLocalStorage } from "node:async_hooks";

import { Context, Effect } from "effect";

type MutationGuard = Effect.Effect<void, unknown>;

const CurrentMeetingPublicationMutationGuard = Context.Reference<MutationGuard>(
	"@harnessy/sdk/CurrentMeetingPublicationMutationGuard",
	{ defaultValue: () => Effect.void },
);

const mutationGuardStorage = new AsyncLocalStorage<
	| {
			readonly guard: MutationGuard;
			readonly isActive: () => boolean;
	  }
	| undefined
>();

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
		// A provider's signed-grant guard must not replace its owning worker's
		// queue/lease guard. Revalidate both at the actual mutation boundary.
		const parent = mutationGuardStorage.getStore();
		let active = true;
		const isActive = () => active && !signal.aborted && (parent?.isActive() ?? true);
		const checkActive = Effect.suspend(() =>
			isActive() ? Effect.void : Effect.fail(new Error("Publication invocation ended.")),
		);
		// Host verification may yield; check the owning claim again afterwards.
		const authorization =
			parent === undefined ? guard : Effect.andThen(parent.guard, Effect.andThen(guard, parent.guard));
		const combined = Effect.andThen(checkActive, Effect.andThen(authorization, checkActive));
		mutationGuardStorage.run({ guard: combined, isActive }, () => {
			Effect.runCallback(effect.pipe(Effect.provideService(CurrentMeetingPublicationMutationGuard, combined)), {
				signal,
				onExit: (exit) => {
					active = false;
					mutationGuardStorage.run(parent, () => resume(exit));
				},
			});
		});
	});

/** @internal Native-Fetch adapter used only for Executor-owned OAuth writes. */
export const guardedMeetingPublicationFetch: typeof globalThis.fetch = async (input, init) => {
	const method = init?.method ?? (input instanceof Request ? input.method : undefined);
	const invocation = mutationGuardStorage.getStore();
	if (invocation !== undefined && mutatesRemoteState(method)) {
		try {
			await Effect.runPromise(invocation.guard);
			if (!invocation.isActive()) throw new Error("Publication invocation ended.");
		} catch {
			throw new Error("Meeting publication authorization was rejected.");
		}
	}
	return globalThis.fetch(input, init);
};
