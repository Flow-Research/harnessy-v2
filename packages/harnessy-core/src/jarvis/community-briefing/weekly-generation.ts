import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Result, Schema } from "effect";

/**
 * Weekly community draft generation, owned by the native review service.
 *
 * The review service (`com.flow-harness.community-review-v2`) is the only
 * process the community one-writer guard exempts as a draft writer. Running the
 * weekly trigger inside it adds no process, argv or launchd label for the guard
 * to see. This module decides when a week is due and records each attempt; the
 * review process supplies the single adapter request. It never approves or
 * publishes: it has no access to grants, leases or provider destinations.
 */

export const COMMUNITY_GENERATION_STATUS_FILE = "community-weekly-generation.json";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export interface CommunityGenerationSchedule {
	readonly enabled: boolean;
	/** 0 = Sunday … 6 = Saturday, in `timezone`. */
	readonly weekday: number;
	readonly hour: number;
	readonly minute: number;
	readonly timezone: string;
}

/** The schedule V1 used: Sunday 23:00 WAT closes the Monday–Sunday week. */
export const DEFAULT_COMMUNITY_GENERATION_SCHEDULE: CommunityGenerationSchedule = {
	enabled: true,
	weekday: 0,
	hour: 23,
	minute: 0,
	timezone: "Africa/Lagos",
};

const ScheduleSettings = Schema.Struct({
	enabled: Schema.optional(Schema.Boolean),
	weekday: Schema.optional(Schema.Literals(WEEKDAYS)),
	time: Schema.optional(Schema.String),
});

/**
 * Read `community_briefing.generation_schedule`. Generation runs only when the
 * community workflow itself is enabled (`community_briefing.enabled: true`).
 */
export const parseCommunityGenerationSchedule = (
	workflowEnabled: unknown,
	value: unknown,
	timezone: string = DEFAULT_COMMUNITY_GENERATION_SCHEDULE.timezone,
): CommunityGenerationSchedule => {
	const settings = Schema.decodeUnknownSync(ScheduleSettings, { onExcessProperty: "error" })(value ?? {});
	const time = settings.time ?? "23:00";
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time);
	if (!match) throw new Error("community_briefing.generation_schedule.time must be HH:MM (24-hour).");
	// Reject an unknown zone now rather than at the first weekly tick.
	new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	return {
		enabled: workflowEnabled === true && settings.enabled !== false,
		weekday: WEEKDAYS.indexOf(settings.weekday ?? "sunday"),
		hour: Number(match[1]),
		minute: Number(match[2]),
		timezone,
	};
};

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The Monday of the week to generate at `now`: the latest Monday–Sunday week
 * that has ended by the most recent scheduled occurrence. A Sunday 23:00
 * schedule generates the week ending that Sunday; a Monday 08:00 schedule
 * generates the week that ended the day before. A missed occurrence (machine
 * off) is caught up at the next tick, as V1's RunAtLoad catch-up did.
 */
export const dueCommunityGenerationWeek = (now: Date, schedule: CommunityGenerationSchedule): string => {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: schedule.timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "long",
			hourCycle: "h23",
		})
			.formatToParts(now)
			.map((part) => [part.type, part.value]),
	);
	const localDay = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
	const weekday = WEEKDAYS.indexOf(String(parts.weekday).toLowerCase() as (typeof WEEKDAYS)[number]);
	let daysSince = (weekday - schedule.weekday + 7) % 7;
	if (daysSince === 0 && Number(parts.hour) * 60 + Number(parts.minute) < schedule.hour * 60 + schedule.minute)
		daysSince = 7;
	const day = 86_400_000;
	const occurrence = localDay - daysSince * day;
	const sunday = occurrence - schedule.weekday * day;
	return isoDate(new Date(sunday - 6 * day));
};

/** The adapter's answer to one scheduled week. `publication` is always false. */
export interface CommunityWeekGenerationResult {
	readonly status: "created" | "existing" | "busy" | "failed";
	readonly briefingId?: string;
	readonly code?: string;
	/** True when the adapter ran a native AI run, whose failure the review already reports. */
	readonly ran?: boolean;
}

const WeekRecord = Schema.Struct({
	status: Schema.Literals(["created", "existing", "failed"]),
	attempts: Schema.Int,
	lastAttemptAt: Schema.String,
	briefingId: Schema.optional(Schema.String),
	code: Schema.optional(Schema.String),
	gaveUp: Schema.optional(Schema.Boolean),
});
type WeekRecord = typeof WeekRecord.Type;

const StatusRecord = Schema.Struct({
	kind: Schema.Literal("harnessy.community.briefing.weekly-generation.v1"),
	publication: Schema.Literal(false),
	updatedAt: Schema.String,
	schedule: Schema.Struct({
		weekday: Schema.Int,
		hour: Schema.Int,
		minute: Schema.Int,
		timezone: Schema.String,
	}),
	lastFailure: Schema.NullOr(
		Schema.Struct({ weekStart: Schema.String, at: Schema.String, code: Schema.String, attempts: Schema.Int }),
	),
	weeks: Schema.Record(Schema.String, WeekRecord),
});
export type CommunityGenerationStatus = typeof StatusRecord.Type;

const MAX_STATUS_BYTES = 256 * 1024;
/** Retained week records; older weeks cannot become due again. */
const RETAINED_WEEKS = 12;

/** Read the owner-only status record; `undefined` when none exists yet. */
export const readCommunityGenerationStatus = (path: string): CommunityGenerationStatus | undefined => {
	const opened = Result.try({
		try: () => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
		catch: () => new Error("status_record_unreadable"),
	});
	if (Result.isFailure(opened)) {
		if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
		throw opened.failure;
	}
	const fd = opened.success;
	try {
		const stat = fstatSync(fd);
		const uid = process.geteuid?.();
		if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0)
			throw new Error("status_record_unsafe");
		if (stat.size > MAX_STATUS_BYTES) throw new Error("status_record_invalid");
		const bytes = Buffer.alloc(stat.size);
		if (readSync(fd, bytes, 0, stat.size, 0) !== stat.size) throw new Error("status_record_invalid");
		const decoded = Result.try({
			try: () => Schema.decodeUnknownSync(StatusRecord)(JSON.parse(bytes.toString("utf8"))),
			catch: () => new Error("status_record_invalid"),
		});
		if (Result.isFailure(decoded)) throw decoded.failure;
		return decoded.success;
	} finally {
		closeSync(fd);
	}
};

/** Atomic owner-only replacement; a crash leaves the previous record intact. */
const writeStatus = (path: string, status: CommunityGenerationStatus) => {
	const temporary = join(dirname(path), `.${COMMUNITY_GENERATION_STATUS_FILE}.${randomBytes(6).toString("hex")}.tmp`);
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	const written = Result.try({
		try: () => {
			writeSync(fd, `${JSON.stringify(status, null, 2)}\n`);
			fsyncSync(fd);
		},
		catch: (cause) => cause,
	});
	closeSync(fd);
	if (Result.isFailure(written)) {
		rmSync(temporary, { force: true });
		throw written.failure;
	}
	renameSync(temporary, path);
	const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
};

/** One allow-listed, content-free event per decision, for the service log. */
export interface CommunityGenerationEvent {
	readonly event: "weekly-generation";
	readonly weekStart: string;
	readonly status: "created" | "existing" | "busy" | "failed" | "skipped";
	readonly attempt?: number;
	readonly code?: string;
	readonly briefingId?: string;
	readonly gaveUp?: boolean;
	readonly publication: false;
}

export interface WeeklyCommunityGenerationOptions {
	readonly schedule: CommunityGenerationSchedule;
	/** The owner-only status record path, beside the community queue. */
	readonly statusPath: string;
	readonly now: () => Date;
	/** One adapter request for exactly one Monday. Must never publish. */
	readonly generateWeek: (weekStart: string) => Promise<CommunityWeekGenerationResult>;
	readonly report: (event: CommunityGenerationEvent) => void;
	/** Desktop notification; returns whether it was delivered. */
	readonly notify?: (kind: "pending" | "error", count: number) => Promise<boolean>;
	/** Automatic attempts per week, including the first. Default 3. */
	readonly maxAttempts?: number;
	/** Minimum time between attempts for one week. Default one hour. */
	readonly retryAfterMs?: number;
	/** Per-process memory: notified record faults, and week records even when the file cannot be written. */
	readonly memory?: CommunityGenerationMemory;
}

export interface CommunityGenerationMemory {
	readonly notified: Set<string>;
	readonly weeks: Map<string, WeekRecord>;
}

const CODE = /^[a-z][a-z_]{0,63}$/u;
const safeCode = (code: unknown) => (typeof code === "string" && CODE.test(code) ? code : "generation_failed");

/**
 * Evaluate the schedule once. Returns the decision taken. Never throws:
 * every failure becomes a recorded, reported and notified status.
 */
export const runCommunityGenerationTick = async (
	options: WeeklyCommunityGenerationOptions,
): Promise<CommunityGenerationEvent | undefined> => {
	if (!options.schedule.enabled) return undefined;
	const maxAttempts = options.maxAttempts ?? 3;
	const retryAfterMs = options.retryAfterMs ?? 60 * 60 * 1000;
	const started = options.now();
	const weekStart = dueCommunityGenerationWeek(started, options.schedule);
	const finish = async (event: CommunityGenerationEvent) => {
		options.report(event);
		// A persistent record fault repeats every tick; notify it once per process.
		const recordFault = event.code?.startsWith("status_record_") === true;
		const repeated = recordFault && options.memory?.notified.has(event.code!) === true;
		if (recordFault) options.memory?.notified.add(event.code!);
		if (options.notify && !repeated && (event.status === "created" || event.status === "failed"))
			await options
				.notify(event.status === "created" ? "pending" : "error", event.status === "created" ? 1 : 0)
				.catch(() => false);
		return event;
	};
	const read = Result.try({
		try: () => readCommunityGenerationStatus(options.statusPath),
		catch: (cause) => (cause instanceof Error ? cause.message : undefined),
	});
	// Fail closed and visibly: an unreadable record could hide spent attempts.
	if (Result.isFailure(read))
		return finish({
			event: "weekly-generation",
			weekStart,
			status: "failed",
			code: safeCode(read.failure),
			publication: false,
		});
	const current = read.success;
	const persisted = current?.weeks[weekStart];
	const remembered = options.memory?.weeks.get(weekStart);
	// An unwritable record must not reset the attempt limit within this process.
	const previous = remembered && remembered.attempts > (persisted?.attempts ?? 0) ? remembered : persisted;
	if (previous && previous.status !== "failed") return undefined;
	if (previous?.gaveUp) return undefined;
	if (previous && started.getTime() - Date.parse(previous.lastAttemptAt) < retryAfterMs) return undefined;
	const attempt = (previous?.attempts ?? 0) + 1;
	const result = await Promise.resolve()
		.then(() => options.generateWeek(weekStart))
		.then(
			(value) => value,
			(cause: unknown): CommunityWeekGenerationResult => ({
				status: "failed",
				code: cause instanceof Error ? safeCode(cause.message) : "generation_failed",
			}),
		);
	if (result.status === "busy")
		// Another native draft holds the adapter. Not an attempt: try again next tick.
		return finish({ event: "weekly-generation", weekStart, status: "busy", publication: false });
	const at = options.now().toISOString();
	const failed = result.status === "failed";
	const code = failed ? safeCode(result.code) : undefined;
	const gaveUp = failed && attempt >= maxAttempts;
	const briefingId =
		!failed && typeof result.briefingId === "string" && /^[a-f0-9]{24}$/u.test(result.briefingId)
			? result.briefingId
			: undefined;
	const record: WeekRecord = {
		status: result.status === "existing" ? "existing" : failed ? "failed" : "created",
		attempts: attempt,
		lastAttemptAt: at,
		...(briefingId === undefined ? {} : { briefingId }),
		...(code === undefined ? {} : { code }),
		...(gaveUp ? { gaveUp } : {}),
	};
	options.memory?.weeks.set(weekStart, record);
	const weeks = Object.fromEntries(
		[...Object.entries(current?.weeks ?? {}), [weekStart, record] as const]
			.sort(([left], [right]) => right.localeCompare(left))
			.slice(0, RETAINED_WEEKS),
	);
	const event: CommunityGenerationEvent = {
		event: "weekly-generation",
		weekStart,
		status: record.status,
		attempt,
		...(code === undefined ? {} : { code }),
		...(briefingId === undefined ? {} : { briefingId }),
		...(gaveUp ? { gaveUp } : {}),
		publication: false,
	};
	const stored = Result.try({
		try: () =>
			writeStatus(options.statusPath, {
				kind: "harnessy.community.briefing.weekly-generation.v1",
				publication: false,
				updatedAt: at,
				schedule: {
					weekday: options.schedule.weekday,
					hour: options.schedule.hour,
					minute: options.schedule.minute,
					timezone: options.schedule.timezone,
				},
				lastFailure: failed
					? { weekStart, at, code: code ?? "generation_failed", attempts: attempt }
					: (current?.lastFailure ?? null),
				weeks,
			}),
		catch: () => "status_record_unwritable",
	});
	if (Result.isFailure(stored)) return finish({ ...event, status: "failed", code: stored.failure });
	// A failed native AI run is already notified by the review's run-finished handler.
	if (failed && result.ran) {
		options.report(event);
		return event;
	}
	return finish(event);
};

/** Ten minutes: wake often enough to catch a scheduled minute after sleep. */
export const COMMUNITY_GENERATION_TICK_MS = 10 * 60 * 1000;

/** Run the weekly trigger until `signal` aborts. One tick at a time; never throws. */
export const runWeeklyCommunityGeneration = async (
	options: WeeklyCommunityGenerationOptions & {
		readonly signal: AbortSignal;
		readonly tickMs?: number;
		readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	},
): Promise<void> => {
	const sleep =
		options.sleep ??
		((ms: number, signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, ms);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			}));
	const memory = options.memory ?? { notified: new Set<string>(), weeks: new Map<string, WeekRecord>() };
	while (!options.signal.aborted) {
		await runCommunityGenerationTick({ ...options, memory });
		if (options.signal.aborted) return;
		await sleep(options.tickMs ?? COMMUNITY_GENERATION_TICK_MS, options.signal);
	}
};
