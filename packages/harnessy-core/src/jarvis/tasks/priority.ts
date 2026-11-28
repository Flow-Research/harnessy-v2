import { type DueDateDeriver, deriveV3DueDates } from "./due-date-deriver.ts";
import type { Availability, CalendarSignal, EmailSignal, PriorityAction } from "./priority-evidence.ts";
import { priorityPolicy } from "./priority-policy.ts";
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
	if (Date.parse(message.receivedAt) > now) throw new Error("Future email timestamp");
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
	deriveDueDates: DueDateDeriver = deriveV3DueDates,
	createdAt?: string,
) {
	const now = at.getTime();
	const today = Date.parse(lagosCalendarDate(at));
	const points = { deadline: 0, calendar: 0, email: 0, dependency: 0, effort: 0, ownership: 0, context: 0, age: 0 };
	const actionable = action.state === "open" && action.owner === "self";
	let urgent = false;
	let due: string | null = null;
	let strongestDate: string | null = null;
	const invalidEmail = email !== "unavailable" && email.some((message) => Date.parse(message.receivedAt) > now);
	const dateEvidence = deriveDueDates.derive({ action, at, calendar });
	if (actionable) {
		const verified =
			action.verifiedOverdueAt && Date.parse(action.verifiedOverdueAt) <= now
				? (today - Date.parse(lagosCalendarDate(new Date(action.verifiedOverdueAt)))) / day
				: Infinity;
		for (const dayValue of dateEvidence.days) {
			const days = (Date.parse(dayValue) - today) / day;
			const value = deadlinePoints(days);
			if (value > points.deadline || (value === points.deadline && value > 0 && dayValue < (strongestDate ?? "~"))) {
				points.deadline = value;
				strongestDate = dayValue;
			}
			if (days <= 3 && (days >= -14 || verified < 3)) urgent = true;
			if (due === null || dayValue < due) due = dayValue;
		}
		for (const event of calendar === "unavailable" ? [] : calendar)
			points.calendar = Math.max(points.calendar, calendarPoints(event, now));
		for (const message of email === "unavailable" || invalidEmail ? [] : email)
			points.email = Math.max(points.email, emailPoints(message, now));

		if (action.estimate) points.effort = action.estimate.minutes <= 15 ? 150 : action.estimate.minutes <= 60 ? 75 : 0;
		points.ownership = action.kind === "chase" ? 100 : 250;
		if (
			action.context === "accepted" &&
			(action.contextAuthority === "human" || action.contextAuthority === "direct-speaker")
		)
			points.context = 300;
		else if (action.context === "request" || action.context === "accepted") points.context = 180;
		else if (action.context === "plan") points.context = 80;
		const progress = action.progress;
		const scopeTimes = (action.scopeHistory ?? []).map((change) => Date.parse(change.at));
		if (progress?.kind === "accepted-material-scope-change" && progress.basis)
			scopeTimes.push(Date.parse(progress.at));
		let scopeReset = -Infinity;
		for (const time of scopeTimes.sort((a, b) => a - b)) {
			if (time <= now && time - scopeReset >= priorityPolicy.scopeResetDays * day) scopeReset = time;
		}
		const progressTime = progress && progress.kind !== "accepted-material-scope-change" ? Date.parse(progress.at) : 0;
		const evidenceAnchor = Math.max(
			Date.parse(action.observedAt ?? "") || 0,
			scopeReset,
			progressTime <= now ? progressTime : 0,
		);
		const anchor = evidenceAnchor || Date.parse(createdAt ?? "");
		if (anchor > 0) points.age = Math.max(0, Math.min(100, 10 * Math.floor((now - anchor) / (7 * day))));
		urgent ||= points.calendar >= 300;
	}
	const important = action.importance !== undefined && action.state !== "pending_reverification";
	const quadrant: keyof typeof bands = urgent ? (important ? "Q1" : "Q3") : important ? "Q2" : "Q4";
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
		invalid: invalidEmail ? ["email"] : [],
		unavailable: [calendar === "unavailable" ? "calendar" : "", email === "unavailable" ? "email" : ""].filter(
			Boolean,
		),
		empty: [
			!dateEvidence.hasEvidence ? "deadline" : "",
			calendar !== "unavailable" && !calendar.length ? "calendar" : "",
			email !== "unavailable" && !email.length ? "email" : "",
			!action.dependency ? "dependency" : "",
			!action.estimate ? "effort" : "",
			action.owner === "unknown" ? "ownership" : "",
			!action.context ? "context" : "",
			!action.progress && !action.observedAt && !createdAt && !action.scopeHistory?.length ? "age" : "",
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
/** The target must be its independent first-pass score, before any edge is applied. */
export function scoreDependency(base: ActionScore, target: ActionScore | undefined): ActionScore {
	if (base.disposition !== "actionable" || target?.state !== "open") return base;
	const dependency = target.quadrant === "Q1" ? 350 : 175;
	const quadrant = dependency === 350 ? (base.importanceRule ? "Q1" : "Q3") : base.quadrant;
	const points = { ...base.points, dependency };
	return {
		...base,
		points,
		quadrant,
		computed: priorityInBand(
			quadrant,
			Object.values(points).reduce((a, b) => a + b, 0),
		),
	};
}
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
	(priorityPolicy.reopenedLastOnTie
		? Number(a.winner.state === "pending_reverification") - Number(b.winner.state === "pending_reverification")
		: 0) ||
	Number(b.pinned) - Number(a.pinned) ||
	(a.pinned && b.pinned ? (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) : 0) ||
	ascii(a.winner.due ?? "~", b.winner.due ?? "~") ||
	Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
	ascii(a.id.toLowerCase(), b.id.toLowerCase());
