import { BigDecimal, Option } from "effect";

/**
 * Round `value` to `digits` decimal places using banker's rounding (round-half-to-even),
 * matching Python 3 `round(value, digits)` for the decimal values these metrics produce.
 *
 * Built on Effect's {@link BigDecimal}: the number is taken at its canonical decimal
 * representation and rounded with the `half-even` mode, so a true half-way value rounds
 * to its even neighbour (e.g. `0.0625 -> 0.062`, `0.125 -> 0.12`). This is exact decimal
 * rounding rather than the old `toFixed` shortcut, which rounded half-away-from-zero for
 * most values and only applied half-even on a fragile "scaled product is an odd integer"
 * heuristic (which mis-rounded non-dyadic values such as `1/160`).
 */
export const roundTo = (value: number, digits: number): number => {
	if (!Number.isFinite(value)) return value;
	return Option.match(BigDecimal.fromNumber(value), {
		onNone: () => value,
		onSome: (decimal) => Number(BigDecimal.format(BigDecimal.round(decimal, { scale: digits, mode: "half-even" }))),
	});
};
