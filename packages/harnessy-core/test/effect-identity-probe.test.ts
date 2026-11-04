import { describe, expect, it } from "@effect/vitest";
import { Effect as SdkEffect } from "@executor-js/sdk/core";
import { Effect as RootEffect } from "effect";

describe("effect module identity across the vendor boundary", () => {
	it("vendored sdk re-exports the same effect instance harnessy-core uses", () => {
		expect(SdkEffect).toBe(RootEffect);
		expect(SdkEffect.gen).toBe(RootEffect.gen);
	});
});
