import { type EvidenceState, isEligible, keyDecisions, resolveLink, subjectOf, type TasksOfAction } from "./match.ts";
import type { LinkDecision, ObservationStore } from "./observations.ts";

// Structurally identical to `CalendarSignal`, `Availability` and the calendar half
// of `PriorityProviders` in `tasks/priority-evidence.ts` (PR #221). They are local
// until #221 merges; then this file imports them instead.
export interface CalendarSignal {
	readonly start: string;
	readonly relation: "preparation" | "agenda";
}
export type Availability<T> = readonly T[] | "unavailable";
export interface CalendarPriorityProvider {
	calendar(actionId: string, at: Date): Promise<Availability<CalendarSignal>>;
}

/** Stored observations older than this cannot prove absence and give `unavailable`. */
export const OBSERVATIONS_MAX_AGE_MS = 2 * 3_600_000;

export interface CalendarProviderOptions {
	/** The importer salt. Action and task IDs are compared as keyed hashes. */
	readonly salt: Buffer;
	/** Read the latest stored observations. Called once per query, so a new import is seen. */
	readonly observations: () => ObservationStore | undefined;
	readonly decisions: () => readonly LinkDecision[];
	readonly tasksOfAction?: TasksOfAction;
	readonly maxAgeMs?: number;
}

export interface CalendarEvidence {
	readonly state: EvidenceState;
	readonly signals: readonly CalendarSignal[];
}

/**
 * Evidence for one action at one instant. Only verified, eligible events become
 * signals. Copies of one meeting seen through several accounts give at most one
 * signal, chosen after matching, so a declined copy cannot hide an accepted one.
 */
export function calendarEvidence(options: CalendarProviderOptions, actionId: string, at: Date): CalendarEvidence {
	const store = options.observations();
	const age = store ? at.getTime() - Date.parse(store.importedAt) : Number.NaN;
	if (!store || !(age >= 0 && age <= (options.maxAgeMs ?? OBSERVATIONS_MAX_AGE_MS)))
		return { state: "unavailable", signals: [] };
	// No account read means nothing was checked, even when no account failed.
	if (!store.accounts.some((account) => account.state === "read")) return { state: "unavailable", signals: [] };
	const subject = subjectOf(options.salt, actionId, options.tasksOfAction ?? (() => []));
	const decisions = keyDecisions(options.salt, options.decisions());
	const byGroup = new Map<string, CalendarSignal>();
	let candidate = false;
	let conflict = false;
	for (const event of store.events) {
		const link = resolveLink(event, subject, decisions);
		if (link.state === "candidate") candidate = true;
		if (link.state === "conflict") conflict = true;
		if (link.state !== "verified" || !isEligible(event, at) || !link.relation) continue;
		const signal = { start: event.start, relation: link.relation };
		const held = byGroup.get(event.copyGroup);
		if (!held || (held.relation === "agenda" && signal.relation === "preparation"))
			byGroup.set(event.copyGroup, signal);
	}
	const signals = [...byGroup.values()].sort(
		(a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.relation < b.relation ? -1 : 1),
	);
	if (signals.length > 0) return { state: "verified", signals };
	// Absence is proven only when every approved account was read. A duplicate folder
	// is an identity that another folder read. A folder without consent is outside the
	// approved set; at least one account was read (checked above), so it does not block proof.
	if (
		store.accounts.some(
			(account) =>
				account.state !== "read" && account.reason !== "duplicate-account" && account.reason !== "no-consent",
		)
	)
		return { state: "unavailable", signals: [] };
	return { state: conflict ? "conflict" : candidate ? "candidate" : "checked_no_match", signals: [] };
}

/** The calendar half of the priority engine's provider interface. */
export function calendarImportProvider(options: CalendarProviderOptions): CalendarPriorityProvider {
	return {
		calendar: async (actionId, at) => {
			const evidence = calendarEvidence(options, actionId, at);
			return evidence.state === "unavailable" ? "unavailable" : evidence.signals;
		},
	};
}
