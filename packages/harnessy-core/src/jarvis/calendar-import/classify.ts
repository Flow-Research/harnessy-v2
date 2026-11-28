/**
 * Local, deterministic event classification. The input text stays in memory.
 * Only the derived relation and keyed hashes of marker values leave this module.
 * No outside model or network classifier is used.
 */
import { actionKey, taskKey } from "./keys.ts";

export type EventRelation = "preparation" | "agenda" | "none";

/** An explicit link written into the event. The value is stored only as a keyed hash. */
export interface LinkMarker {
	readonly kind: "action" | "task";
	readonly key: string;
	/** Set only when the marker label names the relation (`Jarvis-Prep`, `Jarvis-Agenda`). */
	readonly relation?: "preparation" | "agenda";
}

/**
 * At most this many distinct markers, and this many candidates, are stored per
 * event. An event with more is stored as incomplete and never verifies a link:
 * dropping the rest could hide a contradicting marker.
 */
export const MAX_LINKS_PER_EVENT = 64;

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// A complete marker token: a label at a word start, a colon, and one value token
// that ends at whitespace, punctuation or the end of the text.
const MARKER_SOURCE =
	"(?:^|(?<=[\\s>(\\[]))(jarvis-prep|jarvis-agenda|jarvis-action|action id|jarvis-task|task id)\\s*:\\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?=$|[\\s,;)\\]<\"'])";
const marker = () => new RegExp(MARKER_SOURCE, "giu");

/** Google stores some descriptions as HTML. Reduce them to plain text before matching. */
export function plainText(value: string): string {
	return value
		.replace(/<\s*(br|\/p|\/div|\/li)\s*\/?>/giu, "\n")
		.replace(/<[^>]*>/gu, " ")
		.replace(/&nbsp;/gu, " ")
		.replace(/&lt;/gu, "<")
		.replace(/&gt;/gu, ">")
		.replace(/&quot;/gu, '"')
		.replace(/&#39;/gu, "'")
		.replace(/&amp;/gu, "&");
}

/** Parse every distinct explicit link marker and return keyed hashes of their values. */
export function parseMarkers(text: string, salt: Buffer): LinkMarker[] {
	const markers: LinkMarker[] = [];
	const seen = new Set<string>();
	for (const match of plainText(text).matchAll(marker())) {
		const label = (match[1] ?? "").toLowerCase();
		const id = (match[2] ?? "").replace(/[.:]+$/u, "");
		const kind = label === "jarvis-task" || label === "task id" ? "task" : "action";
		if (kind === "task" ? !TASK_ID.test(id) : !ACTION_ID.test(id)) continue;
		const relation = label === "jarvis-prep" ? "preparation" : label === "jarvis-agenda" ? "agenda" : undefined;
		const value: LinkMarker = {
			kind,
			key: kind === "task" ? taskKey(salt, id) : actionKey(salt, id),
			...(relation ? { relation } : {}),
		};
		const dedupe = `${value.kind}|${value.key}|${value.relation ?? ""}`;
		if (seen.has(dedupe)) continue;
		seen.add(dedupe);
		markers.push(value);
	}
	return markers;
}

/** Remove marker spans, so an ID such as `board-report` cannot act as a preparation word. */
export function withoutMarkers(text: string): string {
	return plainText(text).replace(marker(), " ");
}

const PREPARATION =
	/\b(prep|prepare|preparation|present|presentation|presenting|demo|pitch|review|deliver|delivery|deliverable|deadline|due|submit|submission|interview|workshop|board|investor|launch|report|proposal|deck|walkthrough|sign-?off)\b/iu;
const AGENDA =
	/\b(agenda|discuss|discussion|sync|stand-?up|check-?in|catch-?up|1:1|one-on-one|weekly|retro|update)\b/iu;

/** Preparation-needed, agenda mention, or neither, from natural-language text only. */
export function classifyEvent(title: string, description: string): EventRelation {
	const text = withoutMarkers(`${title}\n${description}`);
	if (PREPARATION.test(text)) return "preparation";
	return AGENDA.test(text) ? "agenda" : "none";
}

/** Jarvis's own scheduled work blocks (`calendar/gws-provider.ts`). They are excluded as self-made copies of tasks. */
export function isJarvisBlock(title: string, description: string): boolean {
	return title.startsWith("Jarvis: ") && /^Task ID: [0-9a-f-]{36}\nReason: /iu.test(description);
}
