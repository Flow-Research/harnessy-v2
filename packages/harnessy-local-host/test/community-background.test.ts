import { Deferred, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { startCommunityBackground } from "../src/community-background.ts";

it("drains the in-flight operation without starting another or reporting failure", async () => {
	let calls = 0,
		alerts = 0,
		finished = false;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				const release = yield* Deferred.make<void>();
				const stop = yield* startCommunityBackground(
					Effect.gen(function* () {
						calls++;
						yield* Deferred.succeed(entered, undefined);
						yield* Deferred.await(release);
						finished = true;
					}),
					Effect.sync(() => {
						alerts++;
					}),
				);
				yield* Deferred.await(entered);
				const draining = yield* stop.pipe(Effect.forkScoped({ startImmediately: true }));
				expect(finished).toBe(false);
				yield* Deferred.succeed(release, undefined);
				yield* Fiber.join(draining);
				expect(finished).toBe(true);
			}),
		),
	);
	expect(calls).toBe(1);
	expect(alerts).toBe(0);
});

it("reports a failed operation once and never retries it", async () => {
	let calls = 0,
		alerts = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const reported = yield* Deferred.make<void>();
				const stop = yield* startCommunityBackground(
					Effect.gen(function* () {
						calls++;
						return yield* Effect.fail(new Error("synthetic uncertain delivery"));
					}),
					Effect.sync(() => {
						alerts++;
					}).pipe(Effect.andThen(Deferred.succeed(reported, undefined))),
				);
				yield* Deferred.await(reported);
				yield* stop;
			}),
		),
	);
	expect(calls).toBe(1);
	expect(alerts).toBe(1);
});

it("awaits publication cleanup and reports interruption when the owning scope closes", async () => {
	let cleaned = false,
		alerts = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const entered = yield* Deferred.make<void>();
				yield* startCommunityBackground(
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(
							Effect.sync(() => {
								cleaned = true;
							}),
						),
					),
					Effect.sync(() => {
						expect(cleaned).toBe(true);
						alerts++;
					}),
				);
				yield* Deferred.await(entered);
			}),
		),
	);
	expect(cleaned).toBe(true);
	expect(alerts).toBe(1);
});
