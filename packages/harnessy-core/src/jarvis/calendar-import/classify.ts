/**
 * Local, deterministic event classification. The input text stays in memory.
 * Only the derived relation and the parsed Jarvis ID markers leave this module.
 * No outside model or network classifier is used.
 */

export type EventRelation = "preparation" | "agenda" | "none";

/** An explicit link that a person wrote into the event. IDs are Jarvis action or task IDs. */
export interface LinkMarker {
	readonly kind: "action" | "task";
	readonly id: string;
	/** Set only when the marker itself names the relation (`Jarvis-Prep`, `Jarvis-Agenda`). */
	readonly relation?: "preparation" | "agenda";
}

const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MARKER =
	/(?:^|[\s>([])(jarvis-prep|jarvis-agenda|jarvis-action|action id|jarvis-task|task id)\s*:\s*([A-Za-z0-9][A-Za-z0-9._:-]{0,127})/giu;

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

/** Parse explicit link markers. Text that does not form a valid Jarvis ID is ignored. */
export function parseMarkers(text: string): LinkMarker[] {
	const markers: LinkMarker[] = [];
	const seen = new Set<string>();
	for (const match of plainText(text).matchAll(MARKER)) {
		const label = (match[1] ?? "").toLowerCase();
		const id = (match[2] ?? "").replace(/[.:]+$/u, "");
		const kind = label === "jarvis-task" || label === "task id" ? "task" : "action";
		if (kind === "task" ? !TASK_ID.test(id) : !ACTION_ID.test(id)) continue;
		const relation = label === "jarvis-prep" ? "preparation" : label === "jarvis-agenda" ? "agenda" : undefined;
		const marker: LinkMarker = {
			kind,
			id: kind === "task" ? id.toLowerCase() : id,
			...(relation ? { relation } : {}),
		};
		const key = `${marker.kind}|${marker.id.toLowerCase()}|${marker.relation ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		markers.push(marker);
	}
	return markers;
}

const PREPARATION =
	/\b(prep|prepare|preparation|present|presentation|presenting|demo|pitch|review|deliver|delivery|deliverable|deadline|due|submit|submission|interview|workshop|board|investor|launch|report|proposal|deck|walkthrough|sign-?off)\b/iu;
const AGENDA =
	/\b(agenda|discuss|discussion|sync|stand-?up|check-?in|catch-?up|1:1|one-on-one|weekly|retro|update)\b/iu;

/** Preparation-needed, agenda mention, or neither. Preparation cues win over agenda cues. */
export function classifyEvent(title: string, description: string): EventRelation {
	const text = `${title}\n${plainText(description)}`;
	if (PREPARATION.test(text)) return "preparation";
	return AGENDA.test(text) ? "agenda" : "none";
}

/** Jarvis's own scheduled work blocks (`calendar/gws-provider.ts`). They are excluded as self-made copies of tasks. */
export function isJarvisBlock(title: string, description: string): boolean {
	return title.startsWith("Jarvis: ") && /^Task ID: [0-9a-f-]{36}\nReason: /iu.test(description);
}
