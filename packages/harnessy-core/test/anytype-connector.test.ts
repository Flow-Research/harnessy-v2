import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { AnytypeConfig, AnytypeConnector } from "../src/anytype-connector.ts";
import { type FakeHttp, makeFakeHttp } from "./lib/fake-http.ts";

const withFake = <A, E>(fake: FakeHttp, effect: Effect.Effect<A, E, AnytypeConnector>) =>
	effect.pipe(
		Effect.provide(AnytypeConnector.layer),
		Effect.provide(AnytypeConfig.layer({ baseUrl: "http://anytype.test", apiKey: "secret-key" })),
		Effect.provide(fake.layer),
	);

describe("AnytypeConnector", () => {
	it.effect("lists spaces and sends auth + version headers", () => {
		const fake = makeFakeHttp(() => ({
			body: { data: [{ id: "space-1", name: "Flow", extra: "ignored" }] },
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				const anytype = yield* AnytypeConnector;
				const spaces = yield* anytype.listSpaces();
				expect(spaces).toHaveLength(1);
				expect(spaces[0]).toMatchObject({ id: "space-1", name: "Flow" });
				expect(fake.calls[0]?.url).toBe("http://anytype.test/v1/spaces");
				expect(fake.calls[0]?.headers.authorization).toBe("Bearer secret-key");
				expect(fake.calls[0]?.headers["anytype-version"]).toBeDefined();
			}),
		);
	});

	it.effect("searches a space and flattens the nested type name", () => {
		const fake = makeFakeHttp(() => ({
			body: { data: [{ id: "obj-1", name: "25 - Meeting", type: { name: "Page" } }] },
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				const anytype = yield* AnytypeConnector;
				const results = yield* anytype.search("space-1", "meeting");
				expect(results[0]).toMatchObject({ id: "obj-1", name: "25 - Meeting", type: "Page" });
				expect(fake.calls[0]?.method).toBe("POST");
				expect(fake.calls[0]?.url).toBe("http://anytype.test/v1/spaces/space-1/search");
				// The query is sent as a JSON body with the right content-type.
				expect(JSON.parse(fake.calls[0]?.body ?? "{}")).toEqual({ query: "meeting" });
				expect(fake.calls[0]?.headers["content-type"]).toContain("application/json");
			}),
		);
	});

	it.effect("url-encodes space and object ids in the path", () => {
		const fake = makeFakeHttp(() => ({ body: { object: { id: "x", name: "x" } } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const anytype = yield* AnytypeConnector;
				yield* anytype.getObject("space/with slash", "obj#frag");
				expect(fake.calls[0]?.url).toBe("http://anytype.test/v1/spaces/space%2Fwith%20slash/objects/obj%23frag");
			}),
		);
	});

	it.effect("fetches an object with its markdown body", () => {
		const fake = makeFakeHttp(() => ({
			body: { object: { id: "obj-1", name: "Meeting", snippet: "summary", markdown: "# Meeting\nbody" } },
		}));
		return withFake(
			fake,
			Effect.gen(function* () {
				const anytype = yield* AnytypeConnector;
				const object = yield* anytype.getObject("space-1", "obj-1");
				expect(object.markdown).toContain("# Meeting");
				expect(object.snippet).toBe("summary");
			}),
		);
	});

	it.effect("fails with a HarnessError on a non-2xx response", () => {
		const fake = makeFakeHttp(() => ({ status: 401, body: { error: "unauthorized" } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const anytype = yield* AnytypeConnector;
				const error = yield* Effect.flip(anytype.listSpaces());
				// Surfaced as a HarnessError whose message names the failing action.
				expect(error._tag).toBe("HarnessError");
				expect(error.message).toContain("AnyType list spaces");
			}),
		);
	});

	it.effect("tolerates missing/extra fields without breaking", () => {
		const fake = makeFakeHttp(() => ({ body: { data: [{ id: "only-id" }], unexpected: true } }));
		return withFake(
			fake,
			Effect.gen(function* () {
				const anytype = yield* AnytypeConnector;
				const spaces = yield* anytype.listSpaces();
				expect(spaces[0]).toMatchObject({ id: "only-id" });
				expect(spaces[0]?.name).toBeUndefined();
			}),
		);
	});
});
