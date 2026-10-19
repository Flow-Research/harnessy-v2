import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Result, Schema } from "effect";
import { CODEX_TRANSIENT_FAILURE_CODES } from "../../ai/codex-failure.ts";

/**
 * Weekly community draft generation, owned by the native review service.
 *
 * The review service (`com.flow-harness.community-review-v2`) is the only
 * process the community one-writer guard exempts as a draft writer. The weekly
 * trigger runs in that process and starts each scheduled week as its own
 * one-shot adapter child, so the guard sees no new parent argv or launchd
 * label, and a stuck generation is stopped without touching the review. This
 * module decides when a week is due and records each attempt. It never approves
 * or publishes: it has no access to grants, leases or provider destinations.
 */

export const COMMUNITY_GENERATION_STATUS_FILE = "community-weekly-generation.json";
/** Held by the one scheduler that owns a state directory, for its whole life. */
export const COMMUNITY_GENERATION_LOCK_FILE = "community-weekly-generation.lock";
/** Held briefly around each record write and around a repair's read-and-move-aside. */
export const COMMUNITY_GENERATION_RECORD_LOCK_FILE = "community-weekly-generation.record.lock";
export const COMMUNITY_QUEUE_FILE = "weekly-briefings.sqlite3";
/**
 * An owner's request to retry one week, written by `harnessy jarvis community
 * generation-retry` and consumed by the running scheduler. The CLI never generates:
 * only the exempt review process that holds the scheduler lock acts on it.
 */
export const COMMUNITY_GENERATION_RETRY_REQUEST_FILE = "community-weekly-generation.retry-request.json";

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

export interface CommunityGenerationScheduleSettings {
	readonly schedule: CommunityGenerationSchedule;
	/** Why generation is disabled despite the workflow being on; empty when the settings are valid. */
	readonly issues: ReadonlyArray<string>;
}

/**
 * Read `community_briefing.generation_schedule`. Generation runs only when the
 * community workflow itself is enabled (`community_briefing.enabled: true`).
 * Never throws: an invalid setting disables only generation and is reported,
 * so a typo cannot stop the review service.
 */
export const parseCommunityGenerationSchedule = (
	workflowEnabled: unknown,
	value: unknown,
	timezone: unknown = DEFAULT_COMMUNITY_GENERATION_SCHEDULE.timezone,
): CommunityGenerationScheduleSettings => {
	const issues: string[] = [];
	if (workflowEnabled !== undefined && typeof workflowEnabled !== "boolean")
		issues.push("community_briefing.enabled must be true or false");
	const decoded = Result.try({
		// Only an absent setting selects the default; an explicit null is invalid.
		try: () =>
			Schema.decodeUnknownSync(ScheduleSettings, { onExcessProperty: "error" })(value === undefined ? {} : value),
		catch: () => undefined,
	});
	if (Result.isFailure(decoded))
		issues.push(
			"community_briefing.generation_schedule accepts only enabled (true or false), weekday (sunday … saturday) and time (HH:MM)",
		);
	const settings = Result.isSuccess(decoded) ? decoded.success : {};
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(settings.time ?? "23:00");
	if (!match) issues.push("community_briefing.generation_schedule.time must be HH:MM (24-hour)");
	const zone =
		typeof timezone === "string" &&
		Result.isSuccess(Result.try(() => new Intl.DateTimeFormat("en-US", { timeZone: timezone })))
			? timezone
			: undefined;
	if (zone === undefined) issues.push("community_briefing.timezone is not a known time zone");
	return {
		schedule: {
			enabled: issues.length === 0 && workflowEnabled === true && settings.enabled !== false,
			weekday: WEEKDAYS.indexOf(settings.weekday ?? "sunday"),
			hour: match ? Number(match[1]) : DEFAULT_COMMUNITY_GENERATION_SCHEDULE.hour,
			minute: match ? Number(match[2]) : DEFAULT_COMMUNITY_GENERATION_SCHEDULE.minute,
			timezone: zone ?? DEFAULT_COMMUNITY_GENERATION_SCHEDULE.timezone,
		},
		issues,
	};
};

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The Monday of the week to generate at `now`: the latest Monday–Sunday week
 * that has ended by the most recent scheduled occurrence. A Sunday 23:00
 * schedule generates the week ending that Sunday; a Monday 08:00 schedule
 * generates the week that ended the day before. A missed occurrence (machine
 * off) is caught up at the next tick, as V1's RunAtLoad catch-up did. The
 * comparison uses local wall-clock time. Across a daylight-saving change the
 * scheduled minute can be skipped (it then fires at the next tick) or repeated;
 * during a repeated hour the previous week is briefly due again. That week is
 * already recorded, so no week is generated twice.
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
	/** `cancelled`: the review service stopped mid-generation. Not an attempt. */
	readonly status: "created" | "existing" | "busy" | "cancelled" | "failed";
	readonly briefingId?: string;
	readonly code?: string;
	/** Allow-listed network sub-code of a provider failure, such as `ENOTFOUND`. */
	readonly subCode?: string;
	/** True when the generation already delivered its own "pending review" notice. */
	readonly notified?: boolean;
}

const WeekRecord = Schema.Struct({
	status: Schema.Literals(["created", "existing", "failed"]),
	attempts: Schema.Int,
	lastAttemptAt: Schema.String,
	briefingId: Schema.optional(Schema.String),
	code: Schema.optional(Schema.String),
	/** Allow-listed network sub-code of the last provider failure. */
	subCode: Schema.optional(Schema.String),
	/** Transient failures (network, provider unavailable). They do not count toward `attempts`. */
	transientAttempts: Schema.optional(Schema.Int),
	gaveUp: Schema.optional(Schema.Boolean),
	/** A failed attempt whose draft was found in the queue later (for example after a deadline). */
	recovered: Schema.optional(Schema.Boolean),
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
		Schema.Struct({
			weekStart: Schema.String,
			at: Schema.String,
			code: Schema.String,
			subCode: Schema.optional(Schema.String),
			attempts: Schema.Int,
		}),
	),
	/** A failure that repeats every tick until it clears, such as an unreadable queue. */
	standingFault: Schema.optional(Schema.NullOr(Schema.Struct({ code: Schema.String, since: Schema.String }))),
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

/**
 * Move a damaged or unsafe record aside, never deleting it. The scheduler
 * rebuilds the record from the queue at its next tick. Returns the new path,
 * or `undefined` when there was no record.
 */
export const quarantineCommunityGenerationStatus = (path: string, now: Date = new Date()): string | undefined => {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
	const target = `${path}.quarantined-${now.toISOString().replace(/[:.]/gu, "-")}-${randomBytes(3).toString("hex")}`;
	// Renames a link itself, not its target.
	renameSync(path, target);
	return target;
};

/**
 * Run `action` holding the record lock, waiting at most `waitMs`. Returns
 * `undefined` when the lock stays busy. Serializes the scheduler's writes with
 * `--repair`, so a repair can never move aside a record written after it read.
 */
export const withCommunityGenerationRecordLock = <A>(
	statePath: string,
	waitMs: number,
	action: () => A,
): { readonly value: A } | undefined => {
	const path = join(statePath, COMMUNITY_GENERATION_RECORD_LOCK_FILE);
	closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
	const database = new DatabaseSync(path, { allowExtension: false });
	try {
		const locked = Result.try(() => {
			database.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(waitMs))}`);
			database.exec("BEGIN EXCLUSIVE");
		});
		if (Result.isFailure(locked)) return undefined;
		try {
			return { value: action() };
		} finally {
			database.exec("ROLLBACK");
		}
	} finally {
		database.close();
	}
};

export type CommunityGenerationRepair =
	| { readonly outcome: "busy" }
	| { readonly outcome: "missing" }
	| { readonly outcome: "valid" }
	| { readonly outcome: "quarantined"; readonly fault: string; readonly movedTo: string };

/**
 * `generation-status --repair`: move the record aside only when it cannot be
 * read safely. A valid record is never touched: it holds the attempt counts
 * and `gaveUp` flags that bound paid retries.
 */
export const repairCommunityGenerationStatus = (path: string, now: Date = new Date()): CommunityGenerationRepair =>
	withCommunityGenerationRecordLock(dirname(path), 5_000, () => repairUnlocked(path, now))?.value ?? {
		outcome: "busy",
	};

const repairUnlocked = (path: string, now: Date): CommunityGenerationRepair => {
	const read = Result.try({
		try: () => readCommunityGenerationStatus(path),
		catch: (cause) => (cause instanceof Error ? cause.message : "status_record_unreadable"),
	});
	if (Result.isSuccess(read)) return { outcome: read.success === undefined ? "missing" : "valid" };
	const movedTo = quarantineCommunityGenerationStatus(path, now);
	return movedTo === undefined ? { outcome: "missing" } : { outcome: "quarantined", fault: read.failure, movedTo };
};

/** Atomic owner-only replacement; a crash leaves the previous file intact. */
const writeOwnerOnlyJson = (path: string, value: unknown) => {
	const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	const written = Result.try({
		try: () => {
			writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
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

/** Read-only view of the drafts already in the community queue. */
export interface CommunityQueuedWeeks {
	/** The briefing ID queued for the week, or `undefined`. Throws when the queue cannot be read. */
	readonly find: (weekStart: string) => string | undefined;
	/** The most recent queued weeks, newest first. */
	readonly list: (limit: number) => ReadonlyArray<{ readonly weekStart: string; readonly briefingId: string }>;
}

/** Reads the queue database read-only; a queue that does not exist yet has no weeks. */
export const sqliteQueuedWeeks = (databasePath: string): CommunityQueuedWeeks => {
	const query = <A>(read: (database: DatabaseSync) => A, empty: A): A => {
		if (!existsSync(databasePath)) return empty;
		const database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
		try {
			database.exec("PRAGMA busy_timeout=2000");
			const table = database
				.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='community_briefings'")
				.get();
			return table === undefined ? empty : read(database);
		} finally {
			database.close();
		}
	};
	return {
		find: (weekStart) =>
			query((database) => {
				const row = database
					.prepare("SELECT briefing_id FROM community_briefings WHERE week_start=?")
					.get(weekStart);
				return row === undefined ? undefined : String(row.briefing_id);
			}, undefined),
		list: (limit) =>
			query(
				(database) =>
					database
						.prepare("SELECT week_start, briefing_id FROM community_briefings ORDER BY week_start DESC LIMIT ?")
						.all(limit)
						.map((row) => ({ weekStart: String(row.week_start), briefingId: String(row.briefing_id) })),
				[],
			),
	};
};

export interface CommunityGenerationLock {
	readonly release: () => void;
}

/**
 * Take the state directory's scheduler lock without waiting. Only its holder
 * runs the weekly trigger, so two review processes cannot both pay for a week
 * or lose each other's attempt counts. The record itself is replaced by rename
 * on every write, so the lock lives on a sibling file. The OS releases it when
 * the holder exits, however it exits. Returns `undefined` when another process
 * holds it.
 */
export const acquireCommunityGenerationLock = (statePath: string): CommunityGenerationLock | undefined => {
	const path = join(statePath, COMMUNITY_GENERATION_LOCK_FILE);
	closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
	const database = new DatabaseSync(path, { allowExtension: false });
	const locked = Result.try(() => {
		database.exec("PRAGMA busy_timeout=0");
		database.exec("BEGIN EXCLUSIVE");
	});
	if (Result.isFailure(locked)) {
		database.close();
		return undefined;
	}
	return {
		release: () => {
			database.exec("ROLLBACK");
			database.close();
		},
	};
};

/** True while a review process holds the state directory's scheduler lock. Takes and drops it otherwise. */
export const isCommunityGenerationSchedulerRunning = (statePath: string): boolean => {
	if (!existsSync(join(statePath, COMMUNITY_GENERATION_LOCK_FILE))) return false;
	const lock = acquireCommunityGenerationLock(statePath);
	lock?.release();
	return lock === undefined;
};

export interface CommunityGenerationSummary {
	readonly ok: boolean;
	readonly latestWeek: string | null;
	/**
	 * `generating`: an attempt is in flight in the running scheduler.
	 * `interrupted`: an attempt began but no scheduler is running to finish it.
	 */
	readonly state: "none" | "created" | "existing" | "failed" | "generating" | "interrupted";
	readonly attempts: number;
	readonly standingFault: string | null;
}

/** What `generation-status` reports. A reservation is in flight while the scheduler runs, not a failure. */
export const summarizeCommunityGenerationStatus = (
	record: CommunityGenerationStatus | null,
	schedulerRunning: boolean,
): CommunityGenerationSummary => {
	const [latestWeek, latest] = Object.entries(record?.weeks ?? {}).sort(([a], [b]) => b.localeCompare(a))[0] ?? [];
	const standingFault = record?.standingFault?.code ?? null;
	const state =
		latest === undefined
			? "none"
			: latest.status === "failed" && latest.code === "attempt_interrupted"
				? schedulerRunning
					? "generating"
					: "interrupted"
				: latest.status;
	return {
		ok: standingFault === null && state !== "failed" && state !== "interrupted",
		latestWeek: latestWeek ?? null,
		state,
		attempts: latest?.attempts ?? 0,
		standingFault,
	};
};

const RetryRequest = Schema.Struct({
	kind: Schema.Literal("harnessy.community.briefing.generation-retry.v1"),
	weekStart: Schema.String,
	requestedAt: Schema.String,
});

/**
 * `generation-retry`: ask the running review service to retry one week. Writes only an
 * owner-only request file in the state directory (atomically; a newer request replaces
 * an unconsumed one). It never opens the queue, runs the adapter or calls a provider.
 */
export const requestCommunityGenerationRetry = (
	statePath: string,
	weekStart: string,
	now: Date = new Date(),
): string => {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(weekStart) || new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 1)
		throw new Error("--week-start must be a Monday in YYYY-MM-DD format");
	const path = join(statePath, COMMUNITY_GENERATION_RETRY_REQUEST_FILE);
	const request: typeof RetryRequest.Type = {
		kind: "harnessy.community.briefing.generation-retry.v1",
		weekStart,
		requestedAt: now.toISOString(),
	};
	writeOwnerOnlyJson(path, request);
	return path;
};

/** A consumed request: the week to retry, or the allow-listed reason it was refused. */
export type CommunityGenerationRetryRequest =
	| { readonly weekStart: string }
	| { readonly invalid: "retry_request_invalid" | "retry_request_unsafe" };

/**
 * Take (read and remove) a pending retry request, if any. A request that is a link, not
 * owner-only, oversized or malformed is removed and reported, never acted on.
 */
export const takeCommunityGenerationRetryRequest = (statePath: string): CommunityGenerationRetryRequest | undefined => {
	const path = join(statePath, COMMUNITY_GENERATION_RETRY_REQUEST_FILE);
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
	const read = Result.try((): CommunityGenerationRetryRequest => {
		const opened = Result.try(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW));
		if (Result.isFailure(opened)) return { invalid: "retry_request_unsafe" };
		const fd = opened.success;
		try {
			const stat = fstatSync(fd);
			const uid = process.geteuid?.();
			if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0)
				return { invalid: "retry_request_unsafe" };
			if (stat.size > 4096) return { invalid: "retry_request_invalid" };
			const bytes = Buffer.alloc(stat.size);
			if (readSync(fd, bytes, 0, stat.size, 0) !== stat.size) return { invalid: "retry_request_invalid" };
			const decoded = Result.try(() => Schema.decodeUnknownSync(RetryRequest)(JSON.parse(bytes.toString("utf8"))));
			return Result.isSuccess(decoded)
				? { weekStart: decoded.success.weekStart }
				: { invalid: "retry_request_invalid" };
		} finally {
			closeSync(fd);
		}
	});
	// Removes a link itself, never its target. A request is acted on at most once.
	rmSync(path, { force: true });
	return Result.isSuccess(read) ? read.success : { invalid: "retry_request_invalid" };
};

/** One allow-listed, content-free event per decision, for the service log. */
export interface CommunityGenerationEvent {
	readonly event: "weekly-generation";
	readonly weekStart: string;
	readonly status: "created" | "existing" | "busy" | "failed" | "skipped" | "repaired";
	readonly attempt?: number;
	readonly code?: string;
	readonly subCode?: string;
	/** A transient failure: not counted toward the attempt limit; retried after `retryInMs`. */
	readonly transient?: boolean;
	readonly retryInMs?: number;
	/** This attempt was requested by the owner (`generation-retry`). */
	readonly requested?: boolean;
	readonly briefingId?: string;
	readonly gaveUp?: boolean;
	readonly recovered?: boolean;
	readonly issues?: ReadonlyArray<string>;
	readonly publication: false;
}

export interface WeeklyCommunityGenerationOptions {
	readonly schedule: CommunityGenerationSchedule;
	/** The owner-only status record path, beside the community queue. */
	readonly statusPath: string;
	/** Drafts already queued. Checked before every attempt, so no week is generated twice. */
	readonly queue: CommunityQueuedWeeks;
	readonly now: () => Date;
	/** One generation for exactly one Monday. Must never publish. */
	readonly generateWeek: (weekStart: string) => Promise<CommunityWeekGenerationResult>;
	readonly report: (event: CommunityGenerationEvent) => void;
	/** Desktop notification; returns whether it was delivered. */
	readonly notify?: (kind: "pending" | "error", count: number) => Promise<boolean>;
	/** Automatic attempts per week, including the first. Default 3. Transient failures do not count. */
	readonly maxAttempts?: number;
	/** Minimum time between attempts for one week. Default one hour. */
	readonly retryAfterMs?: number;
	/** Transient failures per week before giving up. Default COMMUNITY_GENERATION_MAX_TRANSIENT_ATTEMPTS. */
	readonly maxTransientAttempts?: number;
	/** Per-process memory: notified faults, and week records even when the file cannot be written. */
	readonly memory?: CommunityGenerationMemory;
}

export interface CommunityGenerationMemory {
	readonly notified: Set<string>;
	readonly weeks: Map<string, WeekRecord>;
}

const CODE = /^[a-z][a-z_]{0,63}$/u;
const safeCode = (code: unknown) => (typeof code === "string" && CODE.test(code) ? code : "generation_failed");
/** A network sub-code is an allow-listed identifier (codexNetworkSubCode); anything else is dropped. */
const SUB_CODE = /^(?:E[A-Z][A-Z_]{1,15}|(?:UND_ERR|ERR_TLS)_[A-Z0-9_]{1,48}|unexpected_redirect|timeout)$/u;
const safeSubCode = (value: unknown) => (typeof value === "string" && SUB_CODE.test(value) ? value : undefined);

/**
 * Transient failures per week before the trigger gives up: 12. With the backoff below
 * the retries span about ten hours (10 + 20 + 40 minutes, then hourly), which outlasts
 * an overnight network outage. Each retry can repeat at most the run's earlier paid
 * calls, so the bound also caps what an outage can cost. The owner can still retry a
 * given-up week with `harnessy jarvis community generation-retry`.
 */
export const COMMUNITY_GENERATION_MAX_TRANSIENT_ATTEMPTS = 12;
/** Backoff after the n-th transient failure: 10 minutes, doubling, at most one hour. */
export const communityGenerationTransientBackoffMs = (failures: number): number =>
	Math.min(60 * 60 * 1000, 10 * 60 * 1000 * 2 ** Math.max(0, failures - 1));
/** Codes that the same request cannot fix: retrying would only repeat the failure. */
const FINAL_CODES = new Set(["orphan_artifacts"]);
const isTransientCode = (code: string) => (CODEX_TRANSIENT_FAILURE_CODES as ReadonlySet<string>).has(code);

const DAY_MS = 86_400_000;
/** A Monday from the last RETAINED_WEEKS weeks, no later than the week due now. */
const isRetryableCommunityWeek = (weekStart: string, dueWeek: string) => {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(weekStart)) return false;
	const day = Date.parse(`${weekStart}T00:00:00Z`);
	if (!Number.isFinite(day) || isoDate(new Date(day)) !== weekStart || new Date(day).getUTCDay() !== 1) return false;
	const due = Date.parse(`${dueWeek}T00:00:00Z`);
	return day <= due && day > due - RETAINED_WEEKS * 7 * DAY_MS;
};

/** Faults that repeat every tick until someone acts; each is notified once per process. */
const isStandingFault = (code: string | undefined) =>
	code !== undefined && (code.startsWith("status_record_") || code === "queue_unreadable");

/**
 * Evaluate the schedule once. Returns the decision taken. Never throws:
 * every failure becomes a recorded, reported and notified status.
 */
export const runCommunityGenerationTick = async (
	options: WeeklyCommunityGenerationOptions,
	/** An owner's request to retry this week now (generation-retry), bypassing backoff and give-up once. */
	requestedWeek?: string,
): Promise<CommunityGenerationEvent | undefined> => {
	if (!options.schedule.enabled) return undefined;
	const maxAttempts = options.maxAttempts ?? 3;
	const retryAfterMs = options.retryAfterMs ?? 60 * 60 * 1000;
	const maxTransientAttempts = options.maxTransientAttempts ?? COMMUNITY_GENERATION_MAX_TRANSIENT_ATTEMPTS;
	const started = options.now();
	const dueWeek = dueCommunityGenerationWeek(started, options.schedule);
	const requested = requestedWeek !== undefined;
	if (requested && !isRetryableCommunityWeek(requestedWeek, dueWeek)) {
		options.report({
			event: "weekly-generation",
			weekStart: dueWeek,
			status: "skipped",
			code: "retry_rejected",
			requested,
			publication: false,
		});
		return undefined;
	}
	const weekStart = requestedWeek ?? dueWeek;
	const finish = async (event: CommunityGenerationEvent, notify: "pending" | "error" | undefined) => {
		options.report(event);
		const repeated = isStandingFault(event.code) && options.memory?.notified.has(event.code!) === true;
		if (isStandingFault(event.code)) options.memory?.notified.add(event.code!);
		if (options.notify && notify !== undefined && !repeated)
			await options.notify(notify, notify === "pending" ? 1 : 0).catch(() => false);
		return event;
	};
	/** A standing fault that has cleared is notified again if it recurs. */
	const cleared = (...codes: ReadonlyArray<string>) => {
		for (const code of codes) options.memory?.notified.delete(code);
	};
	const store = (record: CommunityGenerationStatus) => {
		const written = Result.try({
			try: () => {
				// A busy record lock (a repair in progress) counts as unwritable: nothing is generated.
				const done = withCommunityGenerationRecordLock(dirname(options.statusPath), 2_000, () =>
					writeOwnerOnlyJson(options.statusPath, record),
				);
				if (done === undefined) throw new Error("status_record_unwritable");
			},
			catch: () => "status_record_unwritable",
		});
		if (Result.isSuccess(written)) cleared("status_record_unwritable");
		return written;
	};
	let standing: CommunityGenerationStatus["standingFault"] = null;
	const statusFor = (
		weeks: Record<string, WeekRecord>,
		lastFailure: CommunityGenerationStatus["lastFailure"],
	): CommunityGenerationStatus => ({
		kind: "harnessy.community.briefing.weekly-generation.v1",
		publication: false,
		updatedAt: options.now().toISOString(),
		schedule: {
			weekday: options.schedule.weekday,
			hour: options.schedule.hour,
			minute: options.schedule.minute,
			timezone: options.schedule.timezone,
		},
		lastFailure,
		standingFault: standing,
		weeks: Object.fromEntries(
			Object.entries(weeks)
				.sort(([left], [right]) => right.localeCompare(left))
				.slice(0, RETAINED_WEEKS),
		),
	});
	/** A fresh record seeded from the drafts already queued: those weeks are done. */
	const rebuild = (): CommunityGenerationStatus => {
		const queued = Result.try(() => options.queue.list(RETAINED_WEEKS));
		const at = options.now().toISOString();
		return statusFor(
			Object.fromEntries(
				(Result.isSuccess(queued) ? queued.success : []).map(({ weekStart: week, briefingId }) => [
					week,
					{ status: "existing", attempts: 0, lastAttemptAt: at, briefingId },
				]),
			),
			null,
		);
	};

	const read = Result.try({
		try: () => readCommunityGenerationStatus(options.statusPath),
		catch: (cause) => (cause instanceof Error ? cause.message : "status_record_unreadable"),
	});
	let current: CommunityGenerationStatus;
	if (Result.isSuccess(read)) cleared("status_record_invalid", "status_record_unsafe", "status_record_unreadable");
	if (Result.isSuccess(read) && read.success !== undefined) current = read.success;
	else if (Result.isSuccess(read) || read.failure === "status_record_invalid") {
		// Missing or damaged (for example truncated): rebuild from the queue. Only
		// attempt counts of weeks without a draft are lost, and the queue check
		// before every attempt still prevents a second draft.
		const repaired = Result.isFailure(read);
		if (repaired)
			Result.try(() =>
				withCommunityGenerationRecordLock(dirname(options.statusPath), 2_000, () =>
					quarantineCommunityGenerationStatus(options.statusPath, options.now()),
				),
			);
		current = rebuild();
		const written = store(current);
		if (repaired)
			options.report({
				event: "weekly-generation",
				weekStart,
				status: "repaired",
				code: Result.isFailure(written) ? written.failure : "status_record_invalid",
				publication: false,
			});
	} else {
		// A record that is a link, not owner-only, or unreadable may be tampering.
		// Stop and ask the owner: `harnessy jarvis community generation-status --repair`.
		return finish(
			{ event: "weekly-generation", weekStart, status: "failed", code: safeCode(read.failure), publication: false },
			"error",
		);
	}

	standing = current.standingFault ?? null;
	const persisted = current.weeks[weekStart];
	const remembered = options.memory?.weeks.get(weekStart);
	// An unwritable record must not reset the attempt limit within this process.
	const previous = remembered && remembered.attempts > (persisted?.attempts ?? 0) ? remembered : persisted;
	if (previous && previous.status !== "failed") {
		if (requested)
			options.report({
				event: "weekly-generation",
				weekStart,
				status: "skipped",
				code: "retry_not_needed",
				requested,
				publication: false,
			});
		return undefined;
	}

	const record = async (
		week: WeekRecord,
		event: CommunityGenerationEvent,
		notify: "pending" | "error" | undefined,
	) => {
		options.memory?.weeks.set(weekStart, week);
		const failure =
			week.status === "failed"
				? {
						weekStart,
						at: week.lastAttemptAt,
						code: week.code ?? "generation_failed",
						...(week.subCode === undefined ? {} : { subCode: week.subCode }),
						attempts: week.attempts,
					}
				: current.lastFailure;
		const written = store(statusFor({ ...current.weeks, [weekStart]: week }, failure));
		if (Result.isFailure(written)) return finish({ ...event, status: "failed", code: written.failure }, "error");
		return finish(event, notify);
	};

	// Reconcile with the queue before anything else. A draft for the week means it
	// is done: made by this scheduler after its deadline, by a manual run, or
	// before a lost record. A previous failure that produced the draft is
	// recovered, and its "pending review" notice is sent now.
	const queued = Result.try(() => options.queue.find(weekStart));
	if (Result.isFailure(queued)) {
		// Recorded, so generation-status reports it; no attempt is counted.
		if (standing?.code !== "queue_unreadable") {
			standing = { code: "queue_unreadable", since: options.now().toISOString() };
			store(statusFor(current.weeks, current.lastFailure));
		}
		return finish(
			{ event: "weekly-generation", weekStart, status: "failed", code: "queue_unreadable", publication: false },
			"error",
		);
	}
	cleared("queue_unreadable");
	if (standing !== null) {
		standing = null;
		store(statusFor(current.weeks, current.lastFailure));
	}
	if (queued.success !== undefined) {
		const recovered = previous !== undefined;
		const week: WeekRecord = {
			status: recovered ? "created" : "existing",
			attempts: previous?.attempts ?? 0,
			lastAttemptAt: options.now().toISOString(),
			briefingId: queued.success,
			...(recovered ? { recovered } : {}),
		};
		return record(
			week,
			{
				event: "weekly-generation",
				weekStart,
				status: week.status,
				briefingId: queued.success,
				...(recovered ? { recovered } : {}),
				publication: false,
			},
			recovered ? "pending" : undefined,
		);
	}
	// A transient failure backs off from 10 minutes to an hour; any other waits retryAfterMs.
	const transientBefore = previous?.transientAttempts ?? 0;
	const lastWasTransient = previous?.code !== undefined && isTransientCode(previous.code);
	const gap = lastWasTransient ? communityGenerationTransientBackoffMs(transientBefore) : retryAfterMs;
	if (!requested && previous?.gaveUp) return undefined;
	if (!requested && previous && started.getTime() - Date.parse(previous.lastAttemptAt) < gap) return undefined;

	const attempt = (previous?.attempts ?? 0) + 1;
	// Persist the attempt before any paid call. If the process dies mid-run, or
	// KeepAlive restarts it, the attempt still counts. If the record cannot be
	// written, nothing is generated: attempts kept only in memory would reset
	// with every restart.
	const reservation: WeekRecord = {
		status: "failed",
		attempts: attempt,
		lastAttemptAt: options.now().toISOString(),
		code: "attempt_interrupted",
		...(attempt >= maxAttempts ? { gaveUp: true } : {}),
	};
	const reserved = store(statusFor({ ...current.weeks, [weekStart]: reservation }, current.lastFailure));
	if (Result.isFailure(reserved))
		return finish(
			{ event: "weekly-generation", weekStart, status: "failed", code: reserved.failure, publication: false },
			"error",
		);
	options.memory?.weeks.set(weekStart, reservation);
	const result = await Promise.resolve()
		.then(() => options.generateWeek(weekStart))
		.then(
			(value) => value,
			(): CommunityWeekGenerationResult => ({ status: "failed", code: "generation_failed" }),
		);
	if (result.status === "busy" || result.status === "cancelled") {
		// Neither counts as an attempt: put the week back as it was. If that write
		// fails, the reservation stays on disk and in memory alike, and is reported.
		const rolledBack = store(statusFor(current.weeks, current.lastFailure));
		if (Result.isFailure(rolledBack))
			return finish(
				{ event: "weekly-generation", weekStart, status: "failed", code: rolledBack.failure, publication: false },
				"error",
			);
		if (remembered === undefined) options.memory?.weeks.delete(weekStart);
		else options.memory?.weeks.set(weekStart, remembered);
	}
	if (result.status === "busy")
		// Another native draft holds the state directory. Not an attempt: try again next tick.
		return finish({ event: "weekly-generation", weekStart, status: "busy", publication: false }, undefined);
	if (result.status === "cancelled")
		// Shutdown is not a failure. A draft committed before the stop is reconciled at the next start.
		return finish(
			{ event: "weekly-generation", weekStart, status: "skipped", code: "cancelled", publication: false },
			undefined,
		);
	const failed = result.status === "failed";
	const code = failed ? safeCode(result.code) : undefined;
	const subCode = failed ? safeSubCode(result.subCode) : undefined;
	if (failed && isTransientCode(code!)) {
		// Not an attempt toward the limit: the reservation is replaced by the previous count.
		// An owner's request resets the transient count, so automatic backoff resumes.
		const transientAttempts = (requested ? 0 : transientBefore) + 1;
		const transientGaveUp = transientAttempts >= maxTransientAttempts;
		const retryInMs = transientGaveUp ? undefined : communityGenerationTransientBackoffMs(transientAttempts);
		const week: WeekRecord = {
			status: "failed",
			attempts: previous?.attempts ?? 0,
			transientAttempts,
			lastAttemptAt: options.now().toISOString(),
			code: code!,
			...(subCode === undefined ? {} : { subCode }),
			...(transientGaveUp ? { gaveUp: true } : {}),
		};
		return record(
			week,
			{
				event: "weekly-generation",
				weekStart,
				status: "failed",
				attempt: transientAttempts,
				code: code!,
				...(subCode === undefined ? {} : { subCode }),
				transient: true,
				...(retryInMs === undefined ? {} : { retryInMs }),
				...(transientGaveUp ? { gaveUp: true } : {}),
				...(requested ? { requested } : {}),
				publication: false,
			},
			// An outage retries on its own: notify only when the trigger gives up.
			transientGaveUp ? "error" : undefined,
		);
	}
	const gaveUp = failed && (attempt >= maxAttempts || FINAL_CODES.has(code!));
	const briefingId =
		!failed && typeof result.briefingId === "string" && /^[a-f0-9]{24}$/u.test(result.briefingId)
			? result.briefingId
			: undefined;
	const week: WeekRecord = {
		status: result.status === "existing" ? "existing" : failed ? "failed" : "created",
		attempts: attempt,
		lastAttemptAt: options.now().toISOString(),
		...(briefingId === undefined ? {} : { briefingId }),
		...(code === undefined ? {} : { code }),
		...(subCode === undefined ? {} : { subCode }),
		...(transientBefore > 0 && !requested ? { transientAttempts: transientBefore } : {}),
		...(gaveUp ? { gaveUp } : {}),
	};
	return record(
		week,
		{
			event: "weekly-generation",
			weekStart,
			status: week.status,
			attempt,
			...(code === undefined ? {} : { code }),
			...(subCode === undefined ? {} : { subCode }),
			...(briefingId === undefined ? {} : { briefingId }),
			...(gaveUp ? { gaveUp } : {}),
			...(requested ? { requested } : {}),
			publication: false,
		},
		failed ? "error" : week.status === "created" && result.notified !== true ? "pending" : undefined,
	);
};

/** Ten minutes: wake often enough to catch a scheduled minute after sleep. */
export const COMMUNITY_GENERATION_TICK_MS = 10 * 60 * 1000;

/**
 * Run the weekly trigger until `signal` aborts. Only the holder of the state
 * directory's scheduler lock runs ticks; another process keeps trying to take
 * the lock, so it takes over if the holder exits. One tick at a time; never throws.
 */
export const runWeeklyCommunityGeneration = async (
	options: WeeklyCommunityGenerationOptions & {
		readonly signal: AbortSignal;
		readonly acquireLock: () => CommunityGenerationLock | undefined;
		readonly tickMs?: number;
		readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
		/**
		 * Owner retry requests (`generation-retry`). While it holds the scheduler lock, the
		 * loop checks for one every `pollMs` (default 15 seconds) and runs it at once.
		 */
		readonly retryRequests?: {
			readonly pending: () => boolean;
			readonly take: () => CommunityGenerationRetryRequest | undefined;
			readonly pollMs?: number;
		};
	},
): Promise<void> => {
	const sleep =
		options.sleep ??
		((ms: number, signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				const aborted = () => {
					clearTimeout(timer);
					resolve();
				};
				// Remove the listener when the timer fires too, or every tick leaks one.
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", aborted);
					resolve();
				}, ms);
				signal.addEventListener("abort", aborted, { once: true });
			}));
	const memory = options.memory ?? { notified: new Set<string>(), weeks: new Map<string, WeekRecord>() };
	let lock: CommunityGenerationLock | undefined;
	let waiting = false;
	try {
		while (!options.signal.aborted) {
			if (lock === undefined) {
				const taken = Result.try(options.acquireLock);
				lock = Result.isSuccess(taken) ? taken.success : undefined;
				if (lock === undefined && !waiting)
					options.report({
						event: "weekly-generation",
						weekStart: dueCommunityGenerationWeek(options.now(), options.schedule),
						status: "skipped",
						code: Result.isSuccess(taken) ? "scheduler_locked" : "scheduler_lock_unavailable",
						publication: false,
					});
				waiting = lock === undefined;
			}
			// A request the loop could not remove must not wake it again at once.
			let stuckRequest = false;
			if (lock !== undefined) {
				const taken = Result.try(() => options.retryRequests?.take());
				const request = Result.isSuccess(taken) ? taken.success : { invalid: "retry_request_invalid" as const };
				if (request !== undefined && "invalid" in request)
					options.report({
						event: "weekly-generation",
						weekStart: dueCommunityGenerationWeek(options.now(), options.schedule),
						status: "skipped",
						code: request.invalid,
						requested: true,
						publication: false,
					});
				await runCommunityGenerationTick(
					{ ...options, memory },
					request !== undefined && "weekStart" in request ? request.weekStart : undefined,
				);
				if (request !== undefined) {
					const remaining = Result.try(() => options.retryRequests?.pending() === true);
					stuckRequest = Result.isFailure(remaining) || remaining.success;
				}
			}
			if (options.signal.aborted) return;
			const tickMs = options.tickMs ?? COMMUNITY_GENERATION_TICK_MS;
			const retryRequests = options.retryRequests;
			if (retryRequests === undefined || lock === undefined || stuckRequest) await sleep(tickMs, options.signal);
			else {
				// Wake early for an owner's retry request; otherwise wait the full tick.
				const pollMs = Math.max(1, retryRequests.pollMs ?? 15_000);
				for (let waited = 0; waited < tickMs && !options.signal.aborted; waited += pollMs) {
					const pending = Result.try(retryRequests.pending);
					if (Result.isSuccess(pending) && pending.success) break;
					await sleep(Math.min(pollMs, tickMs - waited), options.signal);
				}
			}
		}
	} finally {
		lock?.release();
	}
};
