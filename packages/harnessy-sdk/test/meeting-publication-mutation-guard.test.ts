import { createServer } from "node:http";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	guardedMeetingPublicationFetch,
	revalidateMeetingPublicationMutation,
	withMeetingPublicationMutationGuard,
} from "../src/meeting-publication/mutation-guard.ts";

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("nested publication mutation guards", () => {
	it("restores the caller context between sequential provider invocations", async () => {
		const checked: string[] = [];
		await Effect.runPromise(
			Effect.gen(function* () {
				for (const name of ["google", "discord"]) {
					yield* withMeetingPublicationMutationGuard(
						revalidateMeetingPublicationMutation,
						Effect.sync(() => {
							checked.push(name);
						}),
					);
				}
			}),
		);
		expect(checked).toEqual(["google", "discord"]);
	});
	it("sends no OAuth request when cancelled during pending authorization", async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests++;
			response.end("unexpected");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("Missing loopback port");
		const entered = deferred<void>();
		const release = deferred<void>();
		const fetched = deferred<string>();
		const controller = new AbortController();
		try {
			const running = Effect.runPromiseExit(
				withMeetingPublicationMutationGuard(
					Effect.promise(async () => {
						const outcome = await guardedMeetingPublicationFetch(`http://127.0.0.1:${address.port}/oauth`, {
							method: "POST",
						}).then(
							() => "unexpected success",
							(error) => String(error),
						);
						fetched.resolve(outcome);
					}),
					Effect.promise(async () => {
						entered.resolve();
						await release.promise;
					}),
				),
				{ signal: controller.signal },
			);
			await entered.promise;
			controller.abort();
			await running;
			release.resolve();
			expect(await fetched.promise).toContain("authorization was rejected");
			expect(requests).toBe(0);
		} finally {
			release.resolve();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
	it("rechecks claim expiry after asynchronous host authorization", async () => {
		let expired = false;
		let wrote = false;
		const claim = Effect.suspend(() => (expired ? Effect.fail(new Error("claim_expired")) : Effect.void));
		const result = await Effect.runPromise(
			withMeetingPublicationMutationGuard(
				withMeetingPublicationMutationGuard(
					Effect.andThen(
						revalidateMeetingPublicationMutation,
						Effect.sync(() => {
							wrote = true;
						}),
					),
					Effect.promise(async () => {
						await Promise.resolve();
						expired = true;
					}),
				),
				claim,
			).pipe(Effect.match({ onFailure: (error) => String(error), onSuccess: () => "unexpected success" })),
		);
		expect(result).toContain("claim_expired");
		expect(wrote).toBe(false);
	});
	it("revalidates the worker and provider at each mutation", async () => {
		const calls: string[] = [];
		const mutation = Effect.andThen(
			revalidateMeetingPublicationMutation,
			Effect.sync(() => calls.push("write")),
		);
		await Effect.runPromise(
			withMeetingPublicationMutationGuard(
				withMeetingPublicationMutationGuard(
					Effect.andThen(mutation, mutation),
					Effect.sync(() => {
						calls.push("grant");
					}),
				),
				Effect.sync(() => {
					calls.push("claim");
				}),
			),
		);
		expect(calls).toEqual(["claim", "grant", "claim", "write", "claim", "grant", "claim", "write"]);
	});
	it("does not let a valid provider guard replace a revoked worker claim", async () => {
		const calls: string[] = [];
		const outcome = await Effect.runPromise(
			withMeetingPublicationMutationGuard(
				withMeetingPublicationMutationGuard(
					Effect.andThen(
						revalidateMeetingPublicationMutation,
						Effect.sync(() => calls.push("write")),
					),
					Effect.sync(() => {
						calls.push("grant");
					}),
				),
				Effect.fail(new Error("claim_expired")),
			).pipe(Effect.match({ onFailure: (error) => String(error), onSuccess: () => "unexpected success" })),
		);
		expect(outcome).toContain("claim_expired");
		expect(calls).toEqual([]);
	});
	it("does not leak an expired claim into a later independent invocation", async () => {
		await Effect.runPromiseExit(
			withMeetingPublicationMutationGuard(revalidateMeetingPublicationMutation, Effect.fail("expired")),
		);
		let checked = false;
		await Effect.runPromise(
			withMeetingPublicationMutationGuard(
				revalidateMeetingPublicationMutation,
				Effect.sync(() => {
					checked = true;
				}),
			),
		);
		expect(checked).toBe(true);
	});
});
