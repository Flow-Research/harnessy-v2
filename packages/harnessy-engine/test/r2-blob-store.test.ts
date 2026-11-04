import { makeR2BlobStore } from "@executor-js/cloudflare/blob-store";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

type HarnessyEngineTestR2Bucket = Parameters<typeof makeR2BlobStore>[0];

const makeBucket = () => {
	const values = new Map<string, string>();
	const bucket = {
		get: async (key: string) => {
			const value = values.get(key);
			return value === undefined ? null : { text: async () => value };
		},
		put: async (key: string, value: string) => {
			values.set(key, value);
			return null;
		},
		delete: async (key: string) => {
			values.delete(key);
		},
		head: async (key: string) => (values.has(key) ? {} : null),
	} as unknown as HarnessyEngineTestR2Bucket;
	return { bucket, values };
};

describe("makeR2BlobStore", () => {
	it("namespaces reads, writes, multi-reads, existence, and deletion", async () => {
		const { bucket, values } = makeBucket();
		const store = makeR2BlobStore(bucket);

		await Effect.runPromise(store.put("tenant/plugin", "key", "value"));
		expect(values.get("tenant/plugin/key")).toBe("value");
		expect(await Effect.runPromise(store.get("tenant/plugin", "key"))).toBe("value");
		expect(await Effect.runPromise(store.has("tenant/plugin", "key"))).toBe(true);

		values.set("other/plugin/key", "other");
		expect([...(await Effect.runPromise(store.getMany(["tenant/plugin", "other/plugin"], "key"))).entries()]).toEqual(
			[
				["tenant/plugin", "value"],
				["other/plugin", "other"],
			],
		);

		await Effect.runPromise(store.delete("tenant/plugin", "key"));
		expect(await Effect.runPromise(store.get("tenant/plugin", "key"))).toBeNull();
	});

	it("maps R2 failures to StorageError", async () => {
		const bucket = {
			get: async () => {
				throw new Error("R2 unavailable");
			},
		} as unknown as HarnessyEngineTestR2Bucket;
		const exit = await Effect.runPromiseExit(makeR2BlobStore(bucket).get("tenant/plugin", "key"));
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause)).toContain("R2 blob get failed");
		}
	});
});
