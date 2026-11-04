import { describe, expect, it } from "@effect/vitest";

import { roundTo } from "../src/round.ts";

describe("roundTo", () => {
	it("rounds half-way decimals to even (banker's rounding)", () => {
		expect(roundTo(0.0625, 3)).toBe(0.062); // 2 is even
		expect(roundTo(0.0635, 3)).toBe(0.064); // 4 is even
		expect(roundTo(0.125, 2)).toBe(0.12);
		expect(roundTo(0.135, 2)).toBe(0.14);
		expect(roundTo(2.5, 0)).toBe(2);
		expect(roundTo(3.5, 0)).toBe(4);
	});

	it("rounds non-half values to nearest", () => {
		expect(roundTo(0.3333333333, 4)).toBe(0.3333);
		expect(roundTo(0.6666666666, 4)).toBe(0.6667);
		expect(roundTo(1.2345, 3)).toBe(1.234);
		expect(roundTo(1.2346, 3)).toBe(1.235);
	});

	it("uses exact decimal half-even semantics on canonical decimals", () => {
		// BigDecimal rounds the canonical decimal value (0.00625), not the raw binary float,
		// so the half-way case rounds to the even neighbour.
		expect(roundTo(1 / 160, 4)).toBe(0.0062);
		expect(roundTo(0.00005, 4)).toBe(0);
	});

	it("handles negatives and passes through non-finite values", () => {
		expect(roundTo(-0.125, 2)).toBe(-0.12);
		expect(roundTo(-2.5, 0)).toBe(-2);
		expect(roundTo(Number.NaN, 2)).toBeNaN();
		expect(roundTo(Number.POSITIVE_INFINITY, 2)).toBe(Number.POSITIVE_INFINITY);
		expect(roundTo(0, 4)).toBe(0);
	});
});
