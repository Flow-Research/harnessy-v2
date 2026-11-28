import { plainText } from "./classify.ts";
import type { LinkDecision, StoredEvent } from "./observations.ts";

/** Evidence states from the signed-off v3 spec. */
export type EvidenceState = "unavailable" | "checked_no_match" | "candidate" | "conflict" | "verified";

/**
 * In-memory words that describe one action, used only to propose candidates at
 * import time. A candidate needs a deliverable word AND an actor or project word.
 */
export interface ActionDescriptor {
	readonly actionId: string;
	readonly deliverable: readonly string[];
	readonly actorOrProject: readonly string[];
}

const MIN_TERM = 4;
const words = (text: string) =>
	new Set(
		plainText(text)
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter(Boolean),
	);
const hasTerm = (bag: ReadonlySet<string>, term: string) => {
	const parts = term
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
	// Exact whole words only. Similar spelling is never a match.
	return parts.length > 0 && parts.join("").length >= MIN_TERM && parts.every((part) => bag.has(part));
};

/**
 * Heuristic proposals. They are scored 0 until a person accepts them. A busy
 * interval, a shared attendee or similar spelling is never enough: attendees are
 * not read, and terms must match exact whole words on both axes.
 */
export function heuristicCandidates(
	title: string,
	description: string,
	descriptors: readonly ActionDescriptor[],
): string[] {
	const bag = words(`${title}\n${description}`);
	return descriptors
		.filter(
			(descriptor) =>
				descriptor.deliverable.some((term) => hasTerm(bag, term)) &&
				descriptor.actorOrProject.some((term) => hasTerm(bag, term)),
		)
		.map((descriptor) => descriptor.actionId);
}

export interface LinkResolution {
	readonly state: Exclude<EvidenceState, "unavailable">;
	readonly relation?: "preparation" | "agenda";
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Decide the link between one stored event and one action, from opaque data only.
 * `actionsOfTask` maps a Jarvis task ID marker to that task's action IDs.
 */
export function resolveLink(
	event: StoredEvent,
	actionId: string,
	decisions: readonly LinkDecision[],
	actionsOfTask: (taskId: string) => readonly string[] = () => [],
): LinkResolution {
	const marked = event.markers.filter((marker) =>
		marker.kind === "action"
			? same(marker.id, actionId)
			: actionsOfTask(marker.id).some((linked) => same(linked, actionId)),
	);
	// Anyone who invites Julian can write a marker into the invite. A marker is an
	// explicit link only on an event Julian organised; otherwise it is a candidate.
	const explicit = event.organizerSelf ? marked : [];
	const relevant = decisions.filter(
		(decision) =>
			same(decision.actionId, actionId) &&
			((decision.target.kind === "event" && decision.target.key === event.key) ||
				(decision.target.kind === "series" && event.series !== null && decision.target.key === event.series)),
	);
	// A closed occurrence of an accepted series is done. Later occurrences stay open.
	if (
		event.occurrence !== null &&
		relevant.some(
			(decision) =>
				decision.decision === "accept" &&
				decision.target.kind === "series" &&
				decision.closedOccurrences.some((closed) => Date.parse(closed) === Date.parse(event.occurrence ?? "")),
		)
	)
		return { state: "checked_no_match" };
	const accepted = relevant.filter((decision) => decision.decision === "accept");
	const rejected = relevant.some((decision) => decision.decision === "reject");
	if (rejected && (explicit.length > 0 || accepted.length > 0)) return { state: "conflict" };
	const named = new Set(
		[...explicit.map((marker) => marker.relation), ...accepted.map((decision) => decision.relation)].filter(
			(relation) => relation !== undefined,
		),
	);
	if (named.size > 1) return { state: "conflict" };
	if (explicit.length > 0 || accepted.length > 0) {
		const relation = [...named][0] ?? (event.relation === "preparation" ? "preparation" : "agenda");
		return { state: "verified", relation };
	}
	if (rejected) return { state: "checked_no_match" };
	return marked.length > 0 || event.candidates.some((candidate) => same(candidate, actionId))
		? { state: "candidate" }
		: { state: "checked_no_match" };
}
