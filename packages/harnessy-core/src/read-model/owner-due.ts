/**
 * Owner and due-date parsing shared by the daily brief and meeting follow-ups.
 *
 * The brief writes "Name — action" or "Name owes …". Fathom summaries and
 * transcripts use the same forms, so one parser serves both. Nothing here reads
 * files or the clock: a relative date is resolved from the date the caller gives.
 */

/** "Name — action" or "Name – action": the name is the owner. */
export const OWNER_LEAD = /^([A-Z][\p{L}.,'&+ ]{0,48}?)\s+[—–]\s+(.+)$/u;
/**
 * "Name owes …", "Name owed …", "Name owns …" or "Names own …". The owner is at
 * most three words, so a verb later in a sentence does not make the sentence's
 * start an owner. The title keeps the whole sentence, because the verb is part
 * of the commitment. A possessive before "own" ("Their own plan") is the
 * adjective, not the verb, and gives no owner.
 */
export const OWNER_VERB =
	/^(?!(?:My|Our|Your|His|Her|Their|Its|The|This|That|Each|Every|We|They|You)\s+own\b)([A-Z][\p{L}.'&+-]*(?:\s+[\p{L}.'&+-]+){0,2})\s+(?:owes|owed|owns|own)\s+\S/u;

/** The owner of an "owes/owed/owns/own" sentence, or null. */
export const ownerByVerb = (text: string): string | null => OWNER_VERB.exec(text)?.[1] ?? null;

/** "Name — action" as owner and title, or null. */
export const ownerLead = (text: string): { readonly owner: string; readonly title: string } | null => {
	const match = OWNER_LEAD.exec(text);
	return match === null ? null : { owner: match[1]!.trim(), title: match[2]!.trim() };
};

/** Owner names that mean the whole group, so the item has no single owner. */
const GROUP_OWNERS = /^(?:all|everyone|everybody|team|the team|both|all contributors|all participants|group)$/iu;

/** A trimmed owner, or null for a group name such as "All". */
export const personOwner = (value: string | null | undefined): string | null => {
	const owner = (value ?? "").replace(/\s+/gu, " ").trim();
	return owner.length === 0 || GROUP_OWNERS.test(owner) ? null : owner;
};

const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/u;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH =
	"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_MONTH = new RegExp(
	`\\b(?:by|on|before|due)\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`,
	"iu",
);
const MONTH_DAY = new RegExp(`\\b(?:by|on|before|due)\\s+${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "iu");
const WEEKDAY =
	/\b(?:by|on|before|due|this|next)\s+(?:this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/iu;

const day = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const validDate = (year: number, month: number, date: number): Date | null => {
	const value = new Date(Date.UTC(year, month, date));
	return value.getUTCMonth() === month && value.getUTCDate() === date ? value : null;
};

/** The first ISO date (YYYY-MM-DD) in the text, or null. The brief parser uses only this form. */
export const isoDue = (text: string): string | null => {
	const match = ISO_DATE.exec(text);
	if (match === null) return null;
	return validDate(Number(match[1]), Number(match[2]) - 1, Number(match[3])) === null ? null : match[0];
};

/**
 * A due date from the text, resolved from `anchor` (YYYY-MM-DD, the meeting
 * date). It understands an ISO date, "today", "tomorrow", "end of (the) week",
 * "next week", a weekday ("by Friday", "next Monday") and a day with a month
 * ("by 5 December", "on Dec 5"). A day and month before the anchor is next year.
 * Anything else gives null: no due date is better than a wrong one.
 */
export const dueFromText = (text: string, anchor: string | null): string | null => {
	const iso = isoDue(text);
	if (iso !== null) return iso;
	if (anchor === null || !/^\d{4}-\d{2}-\d{2}$/u.test(anchor)) return null;
	const base = new Date(`${anchor}T00:00:00.000Z`);
	if (Number.isNaN(base.getTime())) return null;
	const lower = text.toLowerCase();
	if (/\b(?:by|before)\s+(?:the\s+)?end\s+of\s+(?:the\s+)?day\b|\b(?:by\s+)?today\b|\beod\b/u.test(lower))
		return day(base);
	if (/\btomorrow\b/u.test(lower)) return day(addDays(base, 1));
	if (/\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?week\b|\beow\b/u.test(lower))
		return day(addDays(base, (5 - base.getUTCDay() + 7) % 7));
	if (/\b(?:by|before)\s+next\s+week\b/u.test(lower)) return day(addDays(base, (1 - base.getUTCDay() + 7) % 7 || 7));
	const dayMonth = DAY_MONTH.exec(text);
	const monthDay = dayMonth === null ? MONTH_DAY.exec(text) : null;
	const dateText = dayMonth?.[1] ?? monthDay?.[2];
	const monthText = dayMonth?.[2] ?? monthDay?.[1];
	if (dateText !== undefined && monthText !== undefined) {
		const date = Number(dateText);
		const month = MONTHS.indexOf(monthText.slice(0, 3).toLowerCase());
		const year = base.getUTCFullYear();
		const candidate = validDate(year, month, date);
		if (candidate === null) return null;
		return candidate.getTime() < base.getTime()
			? (validDate(year + 1, month, date) ?? candidate).toISOString().slice(0, 10)
			: day(candidate);
	}
	const weekday = WEEKDAY.exec(text);
	if (weekday !== null) {
		const target = WEEKDAYS.indexOf(weekday[1]!.toLowerCase());
		// "Friday" and "next Friday" both mean the first Friday after the meeting.
		const offset = (target - base.getUTCDay() + 7) % 7 || 7;
		return day(addDays(base, offset));
	}
	return null;
};
