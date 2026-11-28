/**
 * Local follow-up extraction from one Fathom meeting payload.
 *
 * Three sources, in order of trust:
 * 1. `action_items`: Fathom's own list. Confidence 1.
 * 2. The `## Next Steps` bullets of `default_summary.markdown_formatted`, such as
 *    `[**Ada:** Send the plan.](https://fathom.video/...&timestamp=120.0)`. Confidence 0.8.
 * 3. First-person commitments in the transcript ("I'll send the deck") and
 *    "Name owns …" sentences. Confidence 0.5. By default the transcript is read
 *    only when the meeting has no items from 1 or 2, because the summary is
 *    Fathom's own digest of the transcript.
 *
 * Everything runs on this machine: no meeting text is sent anywhere. A later
 * item that is the same as, or similar to, an earlier one is dropped, so an
 * action item always wins over the summary line that restates it.
 */
import { createHash } from "node:crypto";

import { plainText } from "../../read-model/followups.ts";
import { dueFromText, ownerByVerb, ownerLead, personOwner } from "../../read-model/owner-due.ts";

export type MeetingItemSource = "action_items" | "summary" | "transcript";

export const MEETING_ITEM_CONFIDENCE: Readonly<Record<MeetingItemSource, number>> = {
	action_items: 1,
	summary: 0.8,
	transcript: 0.5,
};

/** Transcript items for one meeting, at most. */
export const TRANSCRIPT_ITEMS_MAX = 8;
/** Items for one meeting, at most (the follow-up batch limit). */
export const MEETING_ITEMS_MAX = 50;
const TEXT_MAX = 300;
const QUOTE_MAX = 200;

export interface ExtractedMeetingItem {
	readonly text: string;
	readonly owner: string | null;
	readonly due: string | null;
	readonly completed: boolean;
	readonly source: MeetingItemSource;
	readonly confidence: number;
	/** The source words, at most 200 characters. */
	readonly quote: string;
	/** Position in the recording as `HH:MM:SS`, when Fathom gives one. */
	readonly timestamp: string | null;
	/** A Fathom link to the moment, when the source has one. */
	readonly link: string | null;
	/**
	 * The text the follow-up fingerprint hashes. Action items use their text, as
	 * before this extractor existed, so their ids do not change.
	 */
	readonly key: string;
}

/** A score from 0 to 1. Two titles at or above `threshold` are the same commitment. */
export type TitleSimilarity = (a: string, b: string) => number;

export interface MeetingExtractOptions {
	/** The meeting date (YYYY-MM-DD), for relative due dates. */
	readonly meetingDate: string | null;
	/** `fallback` (default) reads the transcript only when sources 1 and 2 give nothing. */
	readonly transcript?: "fallback" | "always" | "off";
	readonly similarity?: TitleSimilarity;
	readonly threshold?: number;
}

const STOPWORDS = new Set(
	"a an and are as at be by for from i in is it its me my of on or our so that the their them then this to we will with you your".split(
		" ",
	),
);

const contentWords = (value: string): ReadonlySet<string> =>
	new Set(
		plainText(value)
			.toLowerCase()
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.split(/[^\p{L}\p{N}]+/u)
			.filter((word) => word.length > 1 && !STOPWORDS.has(word))
			.map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)),
	);

/**
 * The default similarity: the Dice coefficient of the content words. PR #219's
 * `titleSimilarity` (stricter: numbers, names and negation must agree) can
 * replace it through `MeetingExtractOptions.similarity`.
 */
export const wordOverlapSimilarity: TitleSimilarity = (a, b) => {
	const left = contentWords(a);
	const right = contentWords(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared += 1;
	return (2 * shared) / (left.size + right.size);
};

/** Default threshold for `wordOverlapSimilarity`. */
export const MEETING_DUPLICATE_THRESHOLD = 0.6;

/** Two owners can be one person when either is unknown or they share a word ("Ada" and "Ada Obi"). */
const ownersCompatible = (a: string | null, b: string | null): boolean => {
	if (a === null || b === null) return true;
	const left = new Set(
		a
			.toLowerCase()
			.split(/[^\p{L}]+/u)
			.filter(Boolean),
	);
	return b
		.toLowerCase()
		.split(/[^\p{L}]+/u)
		.some((word) => word.length > 0 && left.has(word));
};

/** True when `item` restates `other`: same normalised text, or similar text with compatible owners. */
export const sameCommitment = (
	item: { readonly text: string; readonly owner: string | null },
	other: { readonly text: string; readonly owner: string | null },
	similarity: TitleSimilarity = wordOverlapSimilarity,
	threshold = MEETING_DUPLICATE_THRESHOLD,
): boolean => {
	if (plainText(item.text).toLowerCase() === plainText(other.text).toLowerCase()) return true;
	return ownersCompatible(item.owner, other.owner) && similarity(item.text, other.text) >= threshold;
};

const oneLine = (value: string, max: number): string =>
	value
		.replace(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, max);

const clock = (seconds: number): string | null => {
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	const whole = Math.floor(seconds);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`;
};

const timestampOf = (value: unknown): string | null => {
	if (typeof value === "number") return clock(value);
	if (typeof value !== "string") return null;
	if (/^\d{1,2}:\d{2}:\d{2}$/u.test(value)) return value.padStart(8, "0");
	return /^\d+(?:\.\d+)?$/u.test(value) ? clock(Number(value)) : null;
};

const httpsLink = (value: unknown): string | null => {
	if (typeof value !== "string" || value.length > 2048 || !URL.canParse(value)) return null;
	return new URL(value).protocol === "https:" ? value : null;
};

const sentenceCase = (value: string): string => (value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1));
const withoutFinalStop = (value: string): string => value.replace(/[.;,\s]+$/u, "");

/** Fathom `action_items`: at most 50 items of 300 characters. */
const actionItemsOf = (payload: Record<string, unknown>, meetingDate: string | null): ExtractedMeetingItem[] => {
	if (!Array.isArray(payload.action_items)) return [];
	const items: ExtractedMeetingItem[] = [];
	for (const raw of payload.action_items) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, unknown>;
		const text = oneLine(String(item.description ?? ""), TEXT_MAX);
		if (text.length === 0) continue;
		const assignee =
			item.assignee && typeof item.assignee === "object" ? (item.assignee as Record<string, unknown>) : {};
		const owner = typeof assignee.name === "string" ? oneLine(assignee.name, 64) : "";
		items.push({
			text,
			owner: owner.length > 0 ? owner : null,
			due: dueFromText(text, meetingDate),
			completed: item.completed === true,
			source: "action_items",
			confidence: MEETING_ITEM_CONFIDENCE.action_items,
			quote: text.slice(0, QUOTE_MAX),
			timestamp: timestampOf(item.recording_timestamp),
			link: httpsLink(item.recording_playback_url),
			key: text,
		});
		if (items.length >= MEETING_ITEMS_MAX) break;
	}
	return items;
};

const NEXT_STEPS = /^(#{1,6})\s+next\s+steps\s*$/iu;
const HEADING = /^(#{1,6})\s+/u;
const BULLET = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/u;
const WHOLE_LINK = /^\[(.*)\]\((https:\/\/[^\s)]+)\)\s*$/u;
const BOLD_OWNER = /^\*\*([^*]{1,80}?)(?::\*\*|\*\*\s*:)\s*(.*)$/u;

/** The text of a summary's (or a note's) `Next Steps` section, with 0-based line numbers. */
export const nextStepsLines = (markdown: string): ReadonlyArray<{ readonly index: number; readonly text: string }> => {
	const lines = markdown.split(/\r?\n/u);
	const start = lines.findIndex((line) => NEXT_STEPS.test(line.trim()));
	if (start < 0) return [];
	const level = NEXT_STEPS.exec(lines[start]!.trim())![1]!.length;
	const result: Array<{ index: number; text: string }> = [];
	for (let index = start + 1; index < lines.length; index += 1) {
		const heading = HEADING.exec(lines[index]!);
		if (heading !== null && heading[1]!.length <= level) break;
		result.push({ index, text: lines[index]! });
	}
	return result;
};

/** `## Next Steps` bullets of the Fathom summary. A bold `**Owner:**` with no text owns its child bullets. */
const summaryItemsOf = (payload: Record<string, unknown>, meetingDate: string | null): ExtractedMeetingItem[] => {
	const summary =
		payload.default_summary && typeof payload.default_summary === "object"
			? String((payload.default_summary as Record<string, unknown>).markdown_formatted ?? "")
			: "";
	const items: ExtractedMeetingItem[] = [];
	let parent: { readonly indent: number; readonly owner: string | null } | null = null;
	for (const line of nextStepsLines(summary)) {
		const bullet = BULLET.exec(line.text);
		if (bullet === null) continue;
		const indent = bullet[1]!.replace(/\t/gu, "    ").length;
		const whole = WHOLE_LINK.exec(bullet[2]!.trim());
		const inner = whole?.[1] ?? bullet[2]!;
		const link = whole?.[2] ?? null;
		const seconds = link === null ? null : /[?&]timestamp=(\d+(?:\.\d+)?)/u.exec(link)?.[1];
		const bold = BOLD_OWNER.exec(inner.trim());
		if (parent !== null && indent <= parent.indent) parent = null;
		let owner: string | null;
		let body: string;
		if (bold !== null) {
			owner = personOwner(plainText(bold[1]!));
			body = plainText(bold[2]!);
			if (body.length === 0) {
				parent = { indent, owner };
				continue;
			}
		} else if (parent !== null) {
			owner = parent.owner;
			body = plainText(inner);
		} else {
			const plain = plainText(inner);
			const lead = ownerLead(plain);
			owner = personOwner(lead?.owner ?? ownerByVerb(plain));
			body = lead?.title ?? plain;
		}
		const text = oneLine(withoutFinalStop(body), TEXT_MAX);
		if (text.length < 4) continue;
		items.push({
			text,
			owner: owner === null ? null : owner.slice(0, 64),
			due: dueFromText(body, meetingDate),
			completed: false,
			source: "summary",
			confidence: MEETING_ITEM_CONFIDENCE.summary,
			quote: oneLine(plainText(inner), QUOTE_MAX),
			timestamp: seconds == null ? null : clock(Number(seconds)),
			link: httpsLink(link),
			key: `summary\0${text}`,
		});
		if (items.length >= MEETING_ITEMS_MAX) break;
	}
	return items;
};

const COMMIT_VERBS =
	"send|share|follow up|check|review|schedule|set up|write|draft|prepare|update|create|look into|reach out|email|call|ping|put together|get back|fix|test|book|organi[sz]e|circulate|forward|sync|connect|introduce|submit|finali[sz]e|confirm|invite|upload|publish|deploy|merge|document|send over|arrange|handle|take care of";
const FIRST_PERSON = new RegExp(
	`\\b(?:I'll|I will|I'm going to|I am going to|I'm gonna|I can)\\s+(?:also\\s+|just\\s+|quickly\\s+|then\\s+|definitely\\s+)?((?:${COMMIT_VERBS})\\b.*)$`,
	"iu",
);
/** Phrases that look like a commitment but are about the call itself. */
const CALL_TALK = /\b(?:my screen|the screen|screen share|you know|in a second|in a minute|right now|real quick)\b/iu;

const sentences = (value: string): string[] =>
	value
		.split(/(?<=[.!?])\s+/u)
		.map((sentence) => sentence.trim())
		.filter(Boolean);

/** First-person commitments and "Name owns …" sentences in the transcript. */
const transcriptItemsOf = (payload: Record<string, unknown>, meetingDate: string | null): ExtractedMeetingItem[] => {
	if (!Array.isArray(payload.transcript)) return [];
	const items: ExtractedMeetingItem[] = [];
	for (const raw of payload.transcript) {
		if (!raw || typeof raw !== "object") continue;
		const segment = raw as Record<string, unknown>;
		const speaker =
			segment.speaker && typeof segment.speaker === "object"
				? oneLine(String((segment.speaker as Record<string, unknown>).display_name ?? ""), 64)
				: "";
		for (const sentence of sentences(String(segment.text ?? ""))) {
			if (sentence.endsWith("?") || CALL_TALK.test(sentence)) continue;
			const first = FIRST_PERSON.exec(sentence);
			const named = first === null ? ownerByVerb(sentence) : null;
			if (first === null && named === null) continue;
			const owner = first !== null ? personOwner(speaker) : personOwner(named);
			const text = oneLine(sentenceCase(withoutFinalStop(first?.[1] ?? sentence)), TEXT_MAX);
			if (text.length < 12 || text.split(/\s+/u).length < 3) continue;
			const timestamp = timestampOf(segment.timestamp);
			items.push({
				text,
				owner,
				due: dueFromText(sentence, meetingDate),
				completed: false,
				source: "transcript",
				confidence: MEETING_ITEM_CONFIDENCE.transcript,
				quote: oneLine(`${speaker.length > 0 ? `${speaker}: ` : ""}${sentence}`, QUOTE_MAX),
				timestamp,
				link: null,
				key: `transcript\0${timestamp ?? ""}\0${text}`,
			});
		}
	}
	return items;
};

/**
 * Every follow-up candidate of one meeting, in source order, with duplicates
 * dropped. Completed action items are kept (marked `completed`) so a summary
 * line that restates a finished action does not come back as an open one.
 */
export const extractMeetingItems = (
	payload: Record<string, unknown>,
	options: MeetingExtractOptions,
): ReadonlyArray<ExtractedMeetingItem> => {
	const similarity = options.similarity ?? wordOverlapSimilarity;
	const threshold = options.threshold ?? MEETING_DUPLICATE_THRESHOLD;
	const kept: ExtractedMeetingItem[] = [];
	const add = (items: ReadonlyArray<ExtractedMeetingItem>, max: number): void => {
		let added = 0;
		for (const item of items) {
			if (kept.length >= MEETING_ITEMS_MAX || added >= max) return;
			// Same text from the same source is a repeat, not a duplicate: the batch counts its occurrence.
			const duplicate = kept.some(
				(other) =>
					(other.source !== item.source || item.source === "transcript") &&
					sameCommitment(item, other, similarity, threshold),
			);
			if (duplicate) continue;
			kept.push(item);
			added += 1;
		}
	};
	add(actionItemsOf(payload, options.meetingDate), MEETING_ITEMS_MAX);
	add(summaryItemsOf(payload, options.meetingDate), MEETING_ITEMS_MAX);
	const mode = options.transcript ?? "fallback";
	if (mode === "always" || (mode === "fallback" && kept.length === 0))
		add(transcriptItemsOf(payload, options.meetingDate), TRANSCRIPT_ITEMS_MAX);
	return kept;
};

/**
 * A hash of the follow-up sources of one payload: `action_items`, the summary
 * and the transcript. A change means the note may have new follow-ups.
 */
export const meetingSourceHash = (payload: Record<string, unknown>): string =>
	createHash("sha256")
		.update(
			JSON.stringify([
				payload.action_items ?? null,
				payload.default_summary && typeof payload.default_summary === "object"
					? ((payload.default_summary as Record<string, unknown>).markdown_formatted ?? null)
					: null,
				payload.transcript ?? null,
			]),
		)
		.digest("hex");
