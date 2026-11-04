/**
 * The fixed schedules of the Harnessy launchd jobs, mirrored from each
 * `schedule.ts` so the portal can show the next run without reading a plist.
 *
 * Every time is wall-clock time in Africa/Lagos. Lagos keeps UTC+01:00 all
 * year (no daylight saving), so the next run is plain offset arithmetic. A test
 * checks that this table matches the plists the real planners render.
 */
import { FATHOM_LAUNCH_AGENT_LABEL, FATHOM_POLL_INTERVAL_SECONDS } from "../jarvis/fathom/schedule.ts";
import { LIFE_LAUNCH_AGENT_LABELS } from "../jarvis/life-orchestrator/schedule.ts";

export const JOB_SCHEDULE_TIMEZONE = "Africa/Lagos";
/** Africa/Lagos is UTC+01:00 with no daylight saving. */
export const LAGOS_UTC_OFFSET_MINUTES = 60;

export type JobSchedule =
	| { readonly kind: "calendar"; readonly hour: number; readonly minute: number; readonly weekday: number | null }
	| { readonly kind: "interval"; readonly seconds: number };

/** The schedule of each timed launchd job, keyed by label. */
export const JOB_SCHEDULES: Readonly<Record<string, JobSchedule>> = {
	[LIFE_LAUNCH_AGENT_LABELS[0]]: { kind: "calendar", hour: 4, minute: 15, weekday: null },
	[LIFE_LAUNCH_AGENT_LABELS[1]]: { kind: "calendar", hour: 5, minute: 30, weekday: null },
	[LIFE_LAUNCH_AGENT_LABELS[2]]: { kind: "calendar", hour: 18, minute: 0, weekday: 0 },
	[FATHOM_LAUNCH_AGENT_LABEL]: { kind: "interval", seconds: FATHOM_POLL_INTERVAL_SECONDS },
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_MS = 86_400_000;
const pad = (value: number) => String(value).padStart(2, "0");

/** A short description, for example `05:30 daily`, `Sun 18:00` or `every 5 min`. */
export const describeJobSchedule = (schedule: JobSchedule): string => {
	if (schedule.kind === "interval")
		return schedule.seconds % 60 === 0 ? `every ${schedule.seconds / 60} min` : `every ${schedule.seconds} s`;
	const time = `${pad(schedule.hour)}:${pad(schedule.minute)}`;
	return schedule.weekday === null ? `${time} daily` : `${WEEKDAY_NAMES[schedule.weekday]} ${time}`;
};

/**
 * The first calendar occurrence strictly after `now`, in Lagos wall-clock time.
 * `weekday` is 0 (Sunday) to 6, as in launchd's `StartCalendarInterval`.
 */
export const nextCalendarRun = (now: Date, hour: number, minute: number, weekday: number | null): Date => {
	const offset = LAGOS_UTC_OFFSET_MINUTES * 60_000;
	const local = now.getTime() + offset;
	const midnight = Math.floor(local / DAY_MS) * DAY_MS;
	const today = new Date(midnight).getUTCDay();
	const daysAhead = weekday === null ? 0 : (weekday - today + 7) % 7;
	let candidate = midnight + daysAhead * DAY_MS + (hour * 60 + minute) * 60_000;
	if (candidate <= local) candidate += (weekday === null ? 1 : 7) * DAY_MS;
	return new Date(candidate - offset);
};

/**
 * The next run of a timed job. An interval job's next run is known only from its
 * last activity; without one, or when that run is overdue, it is `null`.
 */
export const nextJobRun = (schedule: JobSchedule, now: Date, lastActivity: Date | null = null): Date | null => {
	if (schedule.kind === "calendar") return nextCalendarRun(now, schedule.hour, schedule.minute, schedule.weekday);
	if (lastActivity === null) return null;
	const next = lastActivity.getTime() + schedule.seconds * 1000;
	return next > now.getTime() ? new Date(next) : null;
};
