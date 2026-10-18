/** Display formatting. Every time is shown in Africa/Lagos, where Julian works. */

const LAGOS = "Africa/Lagos";

const parse = (value: string | null | undefined): Date | undefined => {
	if (typeof value !== "string") return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
};

/** `4 s ago`, `12 min ago`, `3 h ago`, `2 d ago`; `in 5 min` for a future time. */
export const relativeTime = (value: string | null | undefined, now: number): string => {
	const date = parse(value);
	if (date === undefined) return "unknown";
	const seconds = Math.round((now - date.getTime()) / 1000);
	const magnitude = Math.abs(seconds);
	const text =
		magnitude < 60
			? `${magnitude} s`
			: magnitude < 3600
				? `${Math.round(magnitude / 60)} min`
				: magnitude < 86_400 * 2
					? `${Math.round(magnitude / 3600)} h`
					: `${Math.round(magnitude / 86_400)} d`;
	return seconds >= 0 ? `${text} ago` : `in ${text}`;
};

/** `Sun 18 Oct, 23:00` in Lagos time. */
export const dateTime = (value: string | null | undefined): string => {
	const date = parse(value);
	if (date === undefined) return "unknown";
	return new Intl.DateTimeFormat("en-GB", {
		timeZone: LAGOS,
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(date);
};

/** `23:41` in Lagos time. */
export const clockTime = (value: number): string =>
	new Intl.DateTimeFormat("en-GB", { timeZone: LAGOS, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
		new Date(value),
	);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `Sun 18 Oct` for a `YYYY-MM-DD` day, independent of the browser's locale data. */
export const dayLabel = (day: string): string => {
	const date = /^\d{4}-\d{2}-\d{2}$/u.test(day) ? parse(`${day}T12:00:00Z`) : undefined;
	return date === undefined ? day : `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};

/** Good morning, afternoon or evening, by the hour in Lagos. */
export const greeting = (now: number): string => {
	const hour = Number(
		new Intl.DateTimeFormat("en-GB", { timeZone: LAGOS, hour: "2-digit", hourCycle: "h23" }).format(new Date(now)),
	);
	return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
};

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/**
 * Invisible format controls: bidi embeddings, overrides and isolates, zero-width
 * characters, the Arabic letter mark and the byte-order mark. In a command or a
 * title they can make what is shown differ from the bytes that are there
 * (Trojan Source), so they are shown as a visible escape instead.
 */
const FORMAT_CONTROLS = /[؜​-‏‪-‮⁠-⁩﻿]/gu;

/** `text` with every invisible format control shown as `⟨U+202E⟩`. */
export const visibleText = (text: string): string =>
	text.replace(
		FORMAT_CONTROLS,
		(control) => `⟨U+${control.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`,
	);

/** Whether `text` holds an invisible format control. */
export const hasFormatControls = (text: string): boolean => text.search(FORMAT_CONTROLS) !== -1;
