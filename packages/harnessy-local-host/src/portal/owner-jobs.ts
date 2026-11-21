/**
 * Owner jobs: launchd jobs that the owner made outside Harnessy and wants on
 * the Jobs list.
 *
 * The owner lists them in `jobs.json` in the portal state directory. Harnessy
 * reads the file and reports each job's launchd state. It never installs,
 * starts, stops or edits a job from this file.
 *
 * A file that cannot be used gives no jobs and one problem code. The Jobs list
 * shows the problem as a failing row, so a bad file is never silent.
 */
import {
	type JobSchedule,
	PORTAL_SERVICE_LABELS,
	ReadModelStateError,
	readBoundedFile,
} from "@harnessy/core/read-model";

export const OWNER_JOBS_FILE = "jobs.json";
/** The Jobs list holds at most 16 rows; nine are fixed. */
export const OWNER_JOBS_MAX = 6;
const MAX_FILE_BYTES = 64 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/u;
/** Control and invisible format characters; the same set the copied commands refuse. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const NAME_MAX = 64;
const NOTE_MAX = 200;
const NOTES_MAX = 4;
const COMMAND_MAX = 400;

export interface OwnerJob {
	readonly id: string;
	readonly name: string;
	readonly label: string;
	readonly schedule: JobSchedule | null;
	readonly notes: ReadonlyArray<string>;
	/** A command the owner can copy to run the job now; `null` when none is given. */
	readonly run: string | null;
}

export type OwnerJobsProblem = "file_unsafe" | "file_too_large" | "json_invalid" | "schema_invalid";

export interface OwnerJobsRead {
	readonly jobs: ReadonlyArray<OwnerJob>;
	/** `null` when the file is missing (no owner jobs) or valid. */
	readonly problem: OwnerJobsProblem | null;
}

export const NO_OWNER_JOBS: OwnerJobsRead = { jobs: [], problem: null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const onlyKeys = (record: Record<string, unknown>, keys: ReadonlyArray<string>): boolean =>
	Object.keys(record).every((key) => keys.includes(key));

const text = (value: unknown, max: number): string | null =>
	typeof value === "string" && value.trim().length > 0 && value.length <= max && !HIDDEN.test(value)
		? value.trim()
		: null;

const integer = (value: unknown, minimum: number, maximum: number): number | null =>
	typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;

/** `{ "hour", "minute", "weekday"? }` for a calendar time in Africa/Lagos, or `{ "everySeconds" }`. */
const parseSchedule = (value: unknown): JobSchedule | null | "invalid" => {
	if (value === undefined || value === null) return null;
	if (!isRecord(value)) return "invalid";
	if ("everySeconds" in value) {
		const seconds = integer(value.everySeconds, 1, 7 * 86_400);
		return seconds === null || !onlyKeys(value, ["everySeconds"]) ? "invalid" : { kind: "interval", seconds };
	}
	const hour = integer(value.hour, 0, 23);
	const minute = integer(value.minute, 0, 59);
	const weekday = value.weekday === undefined || value.weekday === null ? null : integer(value.weekday, 0, 6);
	if (hour === null || minute === null || !onlyKeys(value, ["hour", "minute", "weekday"])) return "invalid";
	if (value.weekday !== undefined && value.weekday !== null && weekday === null) return "invalid";
	return { kind: "calendar", hour, minute, weekday };
};

const parseJob = (value: unknown, reservedIds: ReadonlySet<string>, seen: Set<string>): OwnerJob | null => {
	if (!isRecord(value) || !onlyKeys(value, ["id", "name", "label", "schedule", "notes", "run"])) return null;
	const id = typeof value.id === "string" && ID.test(value.id) ? value.id : null;
	const name = text(value.name, NAME_MAX);
	const label = typeof value.label === "string" && LABEL.test(value.label) ? value.label : null;
	const schedule = parseSchedule(value.schedule);
	const rawNotes = value.notes === undefined ? [] : value.notes;
	const run = value.run === undefined || value.run === null ? null : text(value.run, COMMAND_MAX);
	if (id === null || name === null || label === null || schedule === "invalid") return null;
	if (value.run !== undefined && value.run !== null && run === null) return null;
	if (!Array.isArray(rawNotes) || rawNotes.length > NOTES_MAX) return null;
	const notes = rawNotes.map((note) => text(note, NOTE_MAX));
	if (notes.includes(null)) return null;
	// A fixed job, the community review service among them, is never redefined.
	if (reservedIds.has(id) || (PORTAL_SERVICE_LABELS as ReadonlyArray<string>).includes(label)) return null;
	if (seen.has(id) || seen.has(`label:${label}`)) return null;
	seen.add(id);
	seen.add(`label:${label}`);
	return { id, name, label, schedule, notes: notes as ReadonlyArray<string>, run };
};

/**
 * Read the owner's job list. One entry that breaks a rule refuses the whole
 * file: a list that is partly shown would hide a job the owner expects to see.
 */
export const readOwnerJobs = (path: string, reservedIds: ReadonlySet<string>): OwnerJobsRead => {
	let bytes: Buffer;
	try {
		const file = readBoundedFile(path, MAX_FILE_BYTES);
		if (file.truncated) return { jobs: [], problem: "file_too_large" };
		bytes = file.bytes;
	} catch (error) {
		if (error instanceof ReadModelStateError && error.state === "missing") return NO_OWNER_JOBS;
		return { jobs: [], problem: "file_unsafe" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		return { jobs: [], problem: "json_invalid" };
	}
	if (!isRecord(parsed) || parsed.version !== 1 || !onlyKeys(parsed, ["version", "jobs"]))
		return { jobs: [], problem: "schema_invalid" };
	if (!Array.isArray(parsed.jobs) || parsed.jobs.length > OWNER_JOBS_MAX)
		return { jobs: [], problem: "schema_invalid" };
	const seen = new Set<string>();
	const jobs = parsed.jobs.map((entry) => parseJob(entry, reservedIds, seen));
	if (jobs.includes(null)) return { jobs: [], problem: "schema_invalid" };
	return { jobs: jobs as ReadonlyArray<OwnerJob>, problem: null };
};
