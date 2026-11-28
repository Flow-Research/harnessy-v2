import { plainText } from "./classify.ts";
import { actionKey, taskKey } from "./keys.ts";
import type { LinkDecision, StoredEvent } from "./observations.ts";

/** Evidence states from the signed-off v3 spec. */
export type EvidenceState = "unavailable" | "checked_no_match" | "candidate" | "conflict" | "verified";

/**
 * In-memory words that describe one action, used only to propose candidates at
 * import time. A candidate needs a deliverable word AND an actor or project word.
 * `taskIds` lets a `Task ID` marker resolve to this action.
 */
export interface ActionDescriptor {
	readonly actionId: string;
	readonly taskIds?: readonly string[];
	readonly deliverable: readonly string[];
	readonly actorOrProject: readonly string[];
}

/** One task-to-action lookup, shared by the import summary and the provider. */
export type TasksOfAction = (actionId: string) => readonly string[];
export const tasksFromDescriptors =
	(descriptors: readonly ActionDescriptor[]): TasksOfAction =>
	(actionId) =>
		descriptors
			.filter((descriptor) => descriptor.actionId.toLowerCase() === actionId.toLowerCase())
			.flatMap((descriptor) => descriptor.taskIds ?? []);

const MIN_TERM = 4;
const MAX_CANDIDATES = 8;
const wordsOf = (text: string) =>
	plainText(text)
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
const hasTerm = (bag: ReadonlySet<string>, term: string) => {
	const parts = wordsOf(term);
	// Exact whole words only. Similar spelling is never a match.
	return parts.length > 0 && parts.join("").length >= MIN_TERM && parts.every((part) => bag.has(part));
};

/**
 * Heuristic proposals, returned as action IDs in memory. They are scored 0 until
 * a person accepts them. A busy interval, a shared attendee or similar spelling is
 * never enough: attendees are not read, and terms must match exact whole words on
 * both axes.
 */
export function heuristicCandidates(
	title: string,
	description: string,
	descriptors: readonly ActionDescriptor[],
): string[] {
	const bag = new Set(wordsOf(`${title}\n${description}`));
	return descriptors
		.filter(
			(descriptor) =>
				descriptor.deliverable.some((term) => hasTerm(bag, term)) &&
				descriptor.actorOrProject.some((term) => hasTerm(bag, term)),
		)
		.map((descriptor) => descriptor.actionId)
		.slice(0, MAX_CANDIDATES);
}

/** An action as the stored data sees it: keyed hashes only. */
export interface LinkSubject {
	readonly action: string;
	readonly tasks: readonly string[];
}
export const subjectOf = (salt: Buffer, actionId: string, tasksOfAction: TasksOfAction): LinkSubject => ({
	action: actionKey(salt, actionId),
	tasks: tasksOfAction(actionId).map((taskId) => taskKey(salt, taskId)),
});

/** A human decision with its action ID replaced by the keyed hash. */
export interface KeyedDecision extends Omit<LinkDecision, "actionId"> {
	readonly action: string;
}
export const keyDecisions = (salt: Buffer, decisions: readonly LinkDecision[]): KeyedDecision[] =>
	decisions.map(({ actionId, ...rest }) => ({ ...rest, action: actionKey(salt, actionId) }));

export interface LinkResolution {
	readonly state: Exclude<EvidenceState, "unavailable">;
	readonly relation?: "preparation" | "agenda";
}

/** Decide the link between one stored event and one action, from opaque data only. */
export function resolveLink(
	event: StoredEvent,
	subject: LinkSubject,
	decisions: readonly KeyedDecision[],
): LinkResolution {
	const marked = event.markers.filter((marker) =>
		marker.kind === "action" ? marker.key === subject.action : subject.tasks.includes(marker.key),
	);
	// Anyone who invites Julian can write a marker into the invite. A marker is an
	// explicit link only on an event Julian organised; otherwise it is a candidate.
	const explicit = event.organizerSelf ? marked : [];
	const relevant = decisions.filter(
		(decision) =>
			decision.action === subject.action &&
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
	return marked.length > 0 || event.candidates.includes(subject.action)
		? { state: "candidate" }
		: { state: "checked_no_match" };
}

/** An event can feed the engine only when it is confirmed, accepted by Julian, not a Jarvis block, and not past. */
export function isEligible(event: StoredEvent, at: Date): boolean {
	return (
		event.status === "confirmed" &&
		event.response === "accepted" &&
		!event.jarvisBlock &&
		Date.parse(event.start) >= at.getTime()
	);
}
