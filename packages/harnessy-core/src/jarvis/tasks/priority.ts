import type { Availability, CalendarSignal, EmailSignal, PriorityAction } from "./priority-evidence.ts";
import { lagosCalendarDate } from "./store.ts";

const hour = 3_600_000;
const day = 24 * hour;
const bands = { Q1: [0, 2499], Q2: [2500, 4999], Q3: [5000, 7499], Q4: [7500, 10000] } as const;
const decay = [100, 79, 63, 50, 40, 31, 25, 20, 16, 13, 10, 8, 6, 3];
export function priorityInBand(quadrant: keyof typeof bands, sum: number) {
	const [low, high] = bands[quadrant];
	return Math.max(low, high - sum);
}
export const deadlinePoints = (days: number) => {
	if (days < -14) return 200;
	if (days < -7) return 500;
	if (days <= 1) return 700;
	if (days <= 3) return 550;
	if (days <= 7) return 350;
	return days <= 14 ? 150 : 0;
};

export function calendarPoints(event: CalendarSignal, now: number) {
	const hours = (Date.parse(event.start) - now) / hour;
	if (!(hours >= 0 && hours <= 168)) return 0;
	if (event.relation === "agenda") return 50;
	if (hours <= 24) return 450;
	return hours <= 72 ? 300 : 150;
}

export function emailPoints(message: EmailSignal, now: number) {
	const bucket = Math.floor((now - Date.parse(message.receivedAt)) / day);
	return Math.floor(((message.relation === "direct" ? 200 : 100) * (decay[bucket] ?? 0)) / 100);
}

export function ascii(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function scoreAction(
	action: PriorityAction,
	at: Date,
	calendar: Availability<CalendarSignal> = "unavailable",
	email: Availability<EmailSignal> = "unavailable",
) {
	const now = at.getTime();
	const today = Date.parse(lagosCalendarDate(at));
	const points = { deadline: 0, calendar: 0, email: 0, dependency: 0, effort: 0, ownership: 0, context: 0, age: 0 };
	const actionable = action.state === "open" && action.owner === "self";
	let urgent = false;
	let due: string | null = null;
	let strongestDate: string | null = null;
	if (actionable) {
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
		const verified =
			action.verifiedOverdueAt && Date.parse(action.verifiedOverdueAt) <= now
				? (today - Date.parse(lagosCalendarDate(new Date(action.verifiedOverdueAt)))) / day
				: Infinity;
		for (const date of dates) {
			const days = (Date.parse(date.day) - today) / day;
			const value = deadlinePoints(days);
			if (value > points.deadline || (value === points.deadline && value > 0 && date.day < (strongestDate ?? "~"))) {
				points.deadline = value;
				strongestDate = date.day;
			}
			if (days <= 3 && (days >= -14 || verified < 3)) urgent = true;
			if (due === null || date.day < due) due = date.day;
		}
		for (const event of calendar === "unavailable" ? [] : calendar)
			points.calendar = Math.max(points.calendar, calendarPoints(event, now));
		for (const message of email === "unavailable" ? [] : email)
			points.email = Math.max(points.email, emailPoints(message, now));
		if (action.dependency) points.dependency = action.dependency.level === "independent-Q1" ? 350 : 175;
		if (action.estimate) points.effort = action.estimate.minutes <= 15 ? 150 : action.estimate.minutes <= 60 ? 75 : 0;
		points.ownership = action.kind === "chase" ? 100 : 250;
		if (
			action.context === "accepted" &&
			(action.contextAuthority === "human" || action.contextAuthority === "direct-speaker")
		)
			points.context = 300;
		else if (action.context === "request" || action.context === "accepted") points.context = 180;
		else if (action.context === "plan") points.context = 80;
		const anchor = Math.max(Date.parse(action.observedAt ?? "") || 0, Date.parse(action.progress?.at ?? "") || 0);
		if (anchor > 0) points.age = Math.max(0, Math.min(100, 10 * Math.floor((now - anchor) / (7 * day))));
		urgent ||= points.calendar >= 300 || points.dependency === 350;
	}
	const important = action.importance !== undefined && action.state !== "pending_reverification";
	const quadrant = urgent ? (important ? "Q1" : "Q3") : important ? "Q2" : "Q4";
	const computed = priorityInBand(
		quadrant,
		Object.values(points).reduce((sum, p) => sum + p, 0),
	);
	return {
		actionId: action.id,
		kind: action.kind,
		state: action.state,
		quadrant,
		computed,
		due,
		strongestDate,
		importanceRule: important ? action.importance?.rule : undefined,
		points,
		unavailable: [calendar === "unavailable" ? "calendar" : "", email === "unavailable" ? "email" : ""].filter(
			Boolean,
		),
		empty: [
			!action.dates.length ? "deadline" : "",
			calendar !== "unavailable" && !calendar.length ? "calendar" : "",
			email !== "unavailable" && !email.length ? "email" : "",
			!action.dependency ? "dependency" : "",
			!action.estimate ? "effort" : "",
			action.owner === "unknown" ? "ownership" : "",
			!action.context ? "context" : "",
			!action.progress && !action.observedAt ? "age" : "",
		].filter(Boolean),
		disposition: actionable
			? "actionable"
			: action.state !== "open"
				? action.state
				: action.owner === "other"
					? "watch-only"
					: "unknown-owner",
	};
}

export type ActionScore = ReturnType<typeof scoreAction>;
export const compareActions = (a: ActionScore, b: ActionScore) =>
	a.computed - b.computed ||
	ascii(a.due ?? "~", b.due ?? "~") ||
	ascii(a.actionId.toLowerCase(), b.actionId.toLowerCase());

export interface RankedTask {
	id: string;
	title: string;
	status: string;
	current: number;
	createdAt: string;
	effective: number;
	pinned: boolean;
	position?: number;
	winner: ActionScore;
}
export const compareTasks = (a: RankedTask, b: RankedTask) =>
	a.effective - b.effective ||
	Number(b.pinned) - Number(a.pinned) ||
	(a.pinned && b.pinned ? (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) : 0) ||
	ascii(a.winner.due ?? "~", b.winner.due ?? "~") ||
	Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
	ascii(a.id.toLowerCase(), b.id.toLowerCase());
