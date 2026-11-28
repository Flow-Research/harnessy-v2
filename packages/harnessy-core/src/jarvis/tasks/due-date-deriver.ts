import type { Availability, CalendarSignal, PriorityAction } from "./priority-evidence.ts";

/** A policy returns eligible WAT calendar days (YYYY-MM-DD). An empty list is undated.
 * Evidence can exist without an eligible day, for example a disputed promise.
 * Implementations must be deterministic for the supplied action, clock and observations.
 */
export type DueDateDeriver = (input: {
	readonly action: PriorityAction;
	readonly at: Date;
	readonly calendar: Availability<CalendarSignal>;
}) => { readonly days: readonly string[]; readonly hasEvidence: boolean };

export const deriveV3DueDates: DueDateDeriver = ({ action }) => {
	const valid = action.dates.filter((d) => {
		if (d.confidence !== "high") return false;
		if (d.kind === "promise") return d.authority === "direct-speaker" || d.authority === "human";
		if (d.kind === "manual") return d.authority === "human";
		if (d.kind === "chase" && action.kind !== "chase") return false;
		return d.authority === "human" || d.authority === "approved-plan";
	});
	const manual = valid.filter((d) => d.kind === "manual");
	// Inputs describe current facts. Different active dates for the same role
	// require reconciliation, unless a manual date overrides the role.
	const candidates = manual.length ? manual : valid;
	const dates = candidates.filter(
		(d) =>
			!action.dates.some((other) => other.kind === d.kind && other.confidence === "conflict") &&
			!candidates.some((other) => other.kind === d.kind && other.day !== d.day),
	);
	return { days: dates.map((date) => date.day), hasEvidence: action.dates.length > 0 };
};
