import { it as effectIt } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
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

effectIt.effect(
	"starts again after a cool-down for a retryable failure, at most the bounded number of times in a row",
	() =>
		Effect.gen(function* () {
			let calls = 0,
				alerts = 0;
			const recoveries: Array<number> = [];
			const outcomes = ["loop", "loop", "ok", "loop", "loop", "loop", "loop"];
			yield* Effect.scoped(
				Effect.gen(function* () {
					const reported = yield* Deferred.make<void>();
					const stop = yield* startCommunityBackground(
						Effect.suspend(() => (outcomes[calls++] === "ok" ? Effect.void : Effect.fail(new Error("loop")))),
						Effect.sync(() => {
							alerts++;
						}).pipe(Effect.andThen(Deferred.succeed(reported, undefined))),
						{
							retryable: (cause) => cause instanceof Error && cause.message === "loop",
							coolDownMs: 30 * 60_000,
							maxConsecutive: 3,
							onRecovering: (attempt) => Effect.sync(() => recoveries.push(attempt)),
						},
					);
					// Each cool-down (and the five-minute wait after the success) passes on the test clock.
					for (let step = 0; step < 12 && !Deferred.isDoneUnsafe(reported); step++)
						yield* TestClock.adjust("30 minutes");
					yield* Deferred.await(reported);
					yield* stop;
				}),
			);
			// Two recoveries, a success that resets the count, then three recoveries and the final stop.
			expect(recoveries).toEqual([1, 2, 1, 2, 3]);
			expect(calls).toBe(7);
			expect(alerts).toBe(1);
		}),
);

it("never retries a failure the recovery does not mark retryable", async () => {
	let calls = 0,
		alerts = 0;
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const reported = yield* Deferred.make<void>();
				const stop = yield* startCommunityBackground(
					Effect.suspend(() => {
						calls++;
						return Effect.fail(new Error("publication_uncertain"));
					}),
					Effect.sync(() => {
						alerts++;
					}).pipe(Effect.andThen(Deferred.succeed(reported, undefined))),
					{ retryable: () => false, coolDownMs: 1, maxConsecutive: 3, onRecovering: () => Effect.void },
				);
				yield* Deferred.await(reported);
				yield* stop;
			}),
		),
	);
	expect(calls).toBe(1);
	expect(alerts).toBe(1);
});
