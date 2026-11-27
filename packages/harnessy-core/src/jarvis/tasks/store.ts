/**
 * Local, versioned portal task store (`tasks.json` version 1).
 *
 * The store is the source of truth for outcomes, priority, order and native
 * tasks. Briefs, reminders, the action register and project status files stay
 * provenance: this module never writes those Markdown files, and it never
 * writes notes.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Result from "effect/Result";

import { normaliseTaskText } from "../../read-model/followups.ts";

export const TASKS_STORE_VERSION = 1;
export const TASKS_MAX = 500;
export const TASK_TITLE_MAX = 300;
export const TASK_OWNER_MAX = 64;
export const TASK_PROJECT_MAX = 64;
export const TASK_PRIORITY_MAX = 10_000;
export const TASKS_FILE_MAX_BYTES = 1024 * 1024;
/** How long a mutation waits for another writer (portal, CLI, brief ingest) before refusing `tasks_busy`. */
export const TASKS_LOCK_WAIT_MS = 5_000;
export const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const TASK_FINGERPRINT = /^[a-f0-9]{64}$/u;
export const TASK_DAY = /^\d{4}-\d{2}-\d{2}$/u;

export type TaskStatus = "todo" | "doing" | "waiting" | "done" | "dropped";
export type TaskOutcome = "done" | "carried" | "dropped" | "delegated";
export type StoredTaskSourceKind = "brief" | "reminders" | "register" | "status-md" | "native";

export interface StoredTaskSource {
	readonly kind: StoredTaskSourceKind;
	readonly path: string | null;
	readonly line: number | null;
	readonly displayRef: string;
	readonly briefDate: string | null;
}

export interface StoredTask {
	readonly id: string;
	readonly title: string;
	readonly status: TaskStatus;
	readonly owner: string | null;
	readonly due: string | null;
	readonly project: string | null;
	readonly priority: number;
	readonly outcome: TaskOutcome | null;
	readonly carriedFrom: string | null;
	readonly fingerprint: string | null;
	readonly source: StoredTaskSource;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface TasksStore {
	readonly version: typeof TASKS_STORE_VERSION;
	readonly items: readonly StoredTask[];
}

export interface CloseoutEntry {
	readonly id: string;
	readonly outcome: TaskOutcome;
	readonly owner?: string;
}

export interface IngestCandidate {
	readonly title: string;
	readonly status: TaskStatus;
	readonly owner: string | null;
	readonly due: string | null;
	readonly line: number;
	readonly fingerprint: string;
	readonly displayRef: string;
}

export interface TaskSidecarItem {
	readonly id: string;
	readonly fingerprint: string;
	readonly line: number;
	readonly title: string;
}

export interface TaskSidecar {
	readonly version: 1;
	readonly date: string;
	readonly items: readonly TaskSidecarItem[];
}

/** Calendar date in Africa/Lagos (YYYY-MM-DD). */
export const lagosCalendarDate = (date: Date): string =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: "Africa/Lagos",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);

/** Default store path: `<home>/.harnessy/portal/tasks.json`. */
export const defaultTasksFile = (homeRoot: string): string => join(homeRoot, ".harnessy", "portal", "tasks.json");

/**
 * A stable fingerprint for matching a restated brief item across days: kind and
 * normalised title, plus the occurrence for a repeated title. The source path is
 * left out so a new day's brief can keep the same id.
 */
export const taskFingerprint = (
	kind: StoredTaskSourceKind,
	text: string,
	occurrence = 0,
	scope: string | null = null,
): string => {
	const scoped = scope === null || scope === "" ? "" : `\0${normaliseTaskText(scope)}`;
	return createHash("sha256")
		.update(`${kind}\0${normaliseTaskText(text)}${occurrence === 0 ? "" : `\0${occurrence}`}${scoped}`)
		.digest("hex");
};

export class TaskRefused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "TaskRefused";
		this.code = code;
	}
}

const STATUSES: ReadonlySet<string> = new Set(["todo", "doing", "waiting", "done", "dropped"]);
const OUTCOMES: ReadonlySet<string> = new Set(["done", "carried", "dropped", "delegated"]);
const KINDS: ReadonlySet<string> = new Set(["brief", "reminders", "register", "status-md", "native"]);
const SOURCE_KEYS = "briefDate,displayRef,kind,line,path";
const ITEM_KEYS =
	"carriedFrom,createdAt,due,fingerprint,id,outcome,owner,priority,project,source,status,title,updatedAt";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && TASK_ID.test(value);
const isDay = (value: unknown): value is string => typeof value === "string" && TASK_DAY.test(value);
const isInstant = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isText = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

const emptyControl = (value: string): boolean => /[\p{Cc}\p{Cf}]/u.test(value);

const boundedText = (value: string, max: number): string | undefined => {
	const text = value.trim();
	return text.length === 0 || text.length > max || emptyControl(text) ? undefined : text;
};

const optionalText = (value: string | null | undefined, max: number, code: string): string | null => {
	if (value === null || value === undefined || value.trim() === "") return null;
	const text = boundedText(value, max);
	if (text === undefined) throw new TaskRefused(code);
	return text;
};

const optionalDay = (value: string | null | undefined, code: string): string | null => {
	if (value === null || value === undefined || value.trim() === "") return null;
	if (!isDay(value)) throw new TaskRefused(code);
	return value;
};

const isSource = (value: unknown): value is StoredTaskSource => {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== SOURCE_KEYS) return false;
	if (typeof value.kind !== "string" || !KINDS.has(value.kind)) return false;
	if (value.path !== null && (typeof value.path !== "string" || value.path.length === 0 || value.path.length > 512))
		return false;
	if (value.line !== null && (!Number.isInteger(value.line) || (value.line as number) < 1)) return false;
	if (typeof value.displayRef !== "string" || value.displayRef.length === 0 || value.displayRef.length > 96)
		return false;
	if (value.briefDate !== null && !isDay(value.briefDate)) return false;
	return true;
};

const isStoredTask = (value: unknown): value is StoredTask => {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== ITEM_KEYS) return false;
	if (!isId(value.id) || !isText(value.title, TASK_TITLE_MAX)) return false;
	if (typeof value.status !== "string" || !STATUSES.has(value.status)) return false;
	if (value.owner !== null && !isText(value.owner, TASK_OWNER_MAX)) return false;
	if (value.due !== null && !isDay(value.due)) return false;
	if (value.project !== null && !isText(value.project, TASK_PROJECT_MAX)) return false;
	if (
		!Number.isInteger(value.priority) ||
		(value.priority as number) < 0 ||
		(value.priority as number) > TASK_PRIORITY_MAX
	)
		return false;
	if (value.outcome !== null && (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome))) return false;
	if (value.carriedFrom !== null && !isDay(value.carriedFrom)) return false;
	if (
		value.fingerprint !== null &&
		(typeof value.fingerprint !== "string" || !TASK_FINGERPRINT.test(value.fingerprint))
	)
		return false;
	if (!isSource(value.source) || !isInstant(value.createdAt) || !isInstant(value.updatedAt)) return false;
	return true;
};

const parseStore = (value: unknown): TasksStore | undefined => {
	if (
		!isRecord(value) ||
		Object.keys(value).sort().join(",") !== "items,version" ||
		value.version !== TASKS_STORE_VERSION ||
		!Array.isArray(value.items) ||
		value.items.length > TASKS_MAX ||
		!value.items.every(isStoredTask)
	)
		return undefined;
	const ids = new Set(value.items.map((item) => item.id));
	if (ids.size !== value.items.length) return undefined;
	return { version: TASKS_STORE_VERSION, items: value.items };
};

const EMPTY: TasksStore = { version: TASKS_STORE_VERSION, items: [] };

const applyOutcomeFields = (
	item: StoredTask,
	outcome: TaskOutcome,
	owner: string | null,
	date: string,
	updatedAt: string,
): StoredTask => {
	switch (outcome) {
		case "done":
			return { ...item, status: "done", outcome: "done", carriedFrom: null, updatedAt };
		case "dropped":
			return { ...item, status: "dropped", outcome: "dropped", carriedFrom: null, updatedAt };
		case "carried":
			return { ...item, status: "todo", outcome: "carried", carriedFrom: date, updatedAt };
		case "delegated": {
			if (owner === null) throw new TaskRefused("owner_required");
			return { ...item, status: "waiting", owner, outcome: "delegated", carriedFrom: null, updatedAt };
		}
	}
};

const outcomeUnchanged = (item: StoredTask, next: StoredTask): boolean =>
	item.status === next.status &&
	item.outcome === next.outcome &&
	item.owner === next.owner &&
	item.carriedFrom === next.carriedFrom;

const placeItem = (items: readonly StoredTask[], item: StoredTask, index: number | undefined): StoredTask[] => {
	const rest = items.filter((other) => other.id !== item.id);
	if (index === undefined || index >= rest.length) return [...rest, item];
	const at = Math.max(0, index);
	return [...rest.slice(0, at), item, ...rest.slice(at)];
};

export class TasksState {
	readonly file: string;
	readonly #clock: () => Date;
	readonly #lockWaitMs: number;

	constructor(file: string, clock: () => Date = () => new Date(), lockWaitMs: number = TASKS_LOCK_WAIT_MS) {
		this.file = file;
		this.#clock = clock;
		this.#lockWaitMs = Math.max(0, Math.trunc(lockWaitMs));
	}

	/** The store, or an empty version-1 document when the file is absent. */
	read(): TasksStore {
		const opened = Result.try(() => openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW));
		if (Result.isFailure(opened)) {
			if ((opened.failure as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
			throw new TaskRefused("unreadable");
		}
		const fd = opened.success;
		const loaded = Result.try(() => {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > TASKS_FILE_MAX_BYTES) throw new TaskRefused("unreadable");
			const store = parseStore(JSON.parse(readFileSync(fd, "utf8")));
			if (store === undefined) throw new TaskRefused("unreadable");
			return store;
		});
		closeSync(fd);
		if (Result.isFailure(loaded)) {
			if (loaded.failure instanceof TaskRefused) throw loaded.failure;
			throw new TaskRefused("unreadable");
		}
		return loaded.success;
	}

	/**
	 * Add a native task. `index` inserts at that position (0 is first); omit it
	 * to append.
	 */
	add(fields: {
		readonly title: string;
		readonly owner?: string | null;
		readonly due?: string | null;
		readonly project?: string | null;
		readonly priority?: number;
		readonly index?: number;
		readonly status?: TaskStatus;
	}): StoredTask {
		const title = boundedText(fields.title, TASK_TITLE_MAX);
		if (title === undefined) throw new TaskRefused("invalid_title");
		const owner = optionalText(fields.owner, TASK_OWNER_MAX, "invalid_owner");
		const due = optionalDay(fields.due, "invalid_due");
		const project = optionalText(fields.project, TASK_PROJECT_MAX, "invalid_project");
		const priority = fields.priority ?? 100;
		if (!Number.isInteger(priority) || priority < 0 || priority > TASK_PRIORITY_MAX)
			throw new TaskRefused("invalid_priority");
		if (
			fields.index !== undefined &&
			(!Number.isInteger(fields.index) || fields.index < 0 || fields.index > TASKS_MAX)
		)
			throw new TaskRefused("invalid_index");
		return this.#locked(() => {
			const store = this.read();
			if (store.items.length >= TASKS_MAX) throw new TaskRefused("tasks_full");
			const now = this.#clock().toISOString();
			const item: StoredTask = {
				id: randomUUID(),
				title,
				status: fields.status ?? "todo",
				owner,
				due,
				project,
				priority,
				outcome: null,
				carriedFrom: null,
				fingerprint: null,
				source: { kind: "native", path: null, line: null, displayRef: "native", briefDate: null },
				createdAt: now,
				updatedAt: now,
			};
			this.#write({ version: TASKS_STORE_VERSION, items: placeItem(store.items, item, fields.index) });
			return item;
		});
	}

	setPriority(id: string, priority: number): StoredTask {
		if (!Number.isInteger(priority) || priority < 0 || priority > TASK_PRIORITY_MAX)
			throw new TaskRefused("invalid_priority");
		return this.#update(id, (item, updatedAt) => ({ ...item, priority, updatedAt }));
	}

	/** Put every item in `ids` order. `ids` must name each current item exactly once. */
	reorder(ids: readonly string[]): void {
		this.#locked(() => {
			const store = this.read();
			const byId = new Map(store.items.map((item) => [item.id, item]));
			if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id)))
				throw new TaskRefused("tasks_changed");
			const items = ids.map((id) => byId.get(id)!);
			this.#write({ version: TASKS_STORE_VERSION, items });
		});
	}

	applyOutcome(
		id: string,
		outcome: TaskOutcome,
		options: { readonly owner?: string | null; readonly date?: string } = {},
	): StoredTask {
		if (!OUTCOMES.has(outcome)) throw new TaskRefused("invalid_outcome");
		const date = options.date ?? lagosCalendarDate(this.#clock());
		if (!isDay(date)) throw new TaskRefused("invalid_due");
		const owner =
			outcome === "delegated"
				? optionalText(options.owner, TASK_OWNER_MAX, "invalid_owner")
				: options.owner === undefined
					? undefined
					: optionalText(options.owner, TASK_OWNER_MAX, "invalid_owner");
		if (outcome === "delegated" && (owner === null || owner === undefined)) throw new TaskRefused("owner_required");
		return this.#update(id, (item, updatedAt) => {
			const next = applyOutcomeFields(item, outcome, owner ?? item.owner, date, updatedAt);
			return outcomeUnchanged(item, next) ? item : next;
		});
	}

	/** Apply many outcomes in one write. The whole batch is refused if any entry is invalid. */
	closeout(
		entries: readonly CloseoutEntry[],
		date?: string,
	): { readonly updated: readonly StoredTask[]; readonly unchanged: number } {
		if (entries.length === 0) return { updated: [], unchanged: 0 };
		const ids = entries.map((entry) => entry.id);
		if (new Set(ids).size !== ids.length) throw new TaskRefused("duplicate_id");
		const day = date ?? lagosCalendarDate(this.#clock());
		if (!isDay(day)) throw new TaskRefused("invalid_due");
		return this.#locked(() => {
			const store = this.read();
			const byId = new Map(store.items.map((item) => [item.id, item]));
			const now = this.#clock().toISOString();
			const updated: StoredTask[] = [];
			let unchanged = 0;
			const nextById = new Map(byId);
			for (const entry of entries) {
				if (!OUTCOMES.has(entry.outcome)) throw new TaskRefused("invalid_outcome");
				const item = nextById.get(entry.id);
				if (item === undefined) throw new TaskRefused("task_missing");
				const owner =
					entry.outcome === "delegated"
						? optionalText(entry.owner, TASK_OWNER_MAX, "invalid_owner")
						: optionalText(entry.owner, TASK_OWNER_MAX, "invalid_owner");
				if (entry.outcome === "delegated" && owner === null) throw new TaskRefused("owner_required");
				const next = applyOutcomeFields(item, entry.outcome, owner ?? item.owner, day, now);
				if (outcomeUnchanged(item, next)) {
					unchanged += 1;
					continue;
				}
				nextById.set(item.id, next);
				updated.push(next);
			}
			if (updated.length > 0)
				this.#write({
					version: TASKS_STORE_VERSION,
					items: store.items.map((item) => nextById.get(item.id) ?? item),
				});
			return { updated, unchanged };
		});
	}

	/**
	 * Align derived source items with the store: reuse a UUID when a fingerprint or
	 * a single open title matches, otherwise mint one. Never writes source Markdown.
	 */
	ingest(
		candidates: readonly IngestCandidate[],
		source: {
			readonly kind: Exclude<StoredTaskSourceKind, "native">;
			readonly path: string;
			readonly displayRef: string;
			readonly briefDate: string | null;
		},
		sidecar?: { readonly date: string; readonly path: string },
	): {
		readonly items: readonly StoredTask[];
		readonly created: number;
		readonly matched: number;
		readonly sidecar?: TaskSidecar;
	} {
		if (source.path.length > 512) throw new TaskRefused("invalid_source");
		return this.#locked(() => {
			const store = this.read();
			let items = [...store.items];
			const used = new Set<string>();
			const openByFingerprint = new Map<string, StoredTask[]>();
			const closedByFingerprint = new Map<string, StoredTask[]>();
			for (const item of items) {
				if (item.fingerprint === null) continue;
				const target =
					item.status === "done" || item.status === "dropped" ? closedByFingerprint : openByFingerprint;
				const list = target.get(item.fingerprint) ?? [];
				list.push(item);
				target.set(item.fingerprint, list);
			}
			const titleIndex = new Map<string, StoredTask[]>();
			for (const item of items) {
				if (item.status === "done" || item.status === "dropped") continue;
				const key = `${item.source.kind}\0${normaliseTaskText(item.title)}`;
				const list = titleIndex.get(key) ?? [];
				list.push(item);
				titleIndex.set(key, list);
			}
			const now = this.#clock().toISOString();
			const sidecarItems: TaskSidecarItem[] = [];
			let created = 0;
			let matched = 0;
			const sameBrief = (item: StoredTask): boolean =>
				(source.briefDate !== null && item.source.briefDate === source.briefDate) ||
				item.source.path === source.path;
			const unused = (item: StoredTask): boolean => !used.has(item.id);
			for (const candidate of candidates) {
				const closedSame = (closedByFingerprint.get(candidate.fingerprint) ?? []).find(
					(item) => unused(item) && sameBrief(item),
				);
				if (closedSame !== undefined) {
					used.add(closedSame.id);
					matched += 1;
					sidecarItems.push({
						id: closedSame.id,
						fingerprint: candidate.fingerprint,
						line: candidate.line,
						title: closedSame.title,
					});
					continue;
				}
				const existing = (openByFingerprint.get(candidate.fingerprint) ?? []).find(unused);
				const titleKey = `${source.kind}\0${normaliseTaskText(candidate.title)}`;
				// Briefs restate titles across days; other sources (status-md, register,
				// reminders) only match a title within the same file.
				const titleMatches = (titleIndex.get(titleKey) ?? []).filter(
					(item) => unused(item) && (source.kind === "brief" || item.source.path === source.path),
				);
				const uniqueTitle = existing === undefined && titleMatches.length === 1 ? titleMatches[0] : undefined;
				const nativeMatches =
					existing === undefined && uniqueTitle === undefined && source.kind === "brief"
						? (titleIndex.get(`native\0${normaliseTaskText(candidate.title)}`) ?? []).filter(unused)
						: [];
				const uniqueNative = nativeMatches.length === 1 ? nativeMatches[0] : undefined;
				const current = existing ?? uniqueTitle ?? uniqueNative;
				if (current !== undefined) {
					used.add(current.id);
					matched += 1;
					const next: StoredTask = {
						...current,
						title: candidate.title.slice(0, TASK_TITLE_MAX),
						owner: current.owner ?? candidate.owner,
						due: current.due ?? candidate.due,
						fingerprint: candidate.fingerprint,
						source: {
							kind: source.kind,
							path: source.path,
							line: candidate.line,
							displayRef: candidate.displayRef.slice(0, 96),
							briefDate: source.briefDate,
						},
						updatedAt: now,
					};
					items = items.map((item) => (item.id === current.id ? next : item));
					sidecarItems.push({
						id: current.id,
						fingerprint: candidate.fingerprint,
						line: candidate.line,
						title: next.title,
					});
					const list = openByFingerprint.get(candidate.fingerprint);
					if (list)
						openByFingerprint.set(
							candidate.fingerprint,
							list.filter((item) => item.id !== current.id),
						);
					continue;
				}
				if (items.length >= TASKS_MAX) throw new TaskRefused("tasks_full");
				created += 1;
				const item: StoredTask = {
					id: randomUUID(),
					title: candidate.title.slice(0, TASK_TITLE_MAX),
					status: candidate.status,
					owner: candidate.owner,
					due: candidate.due,
					project: null,
					priority: 100 + sidecarItems.length,
					outcome: null,
					carriedFrom: null,
					fingerprint: candidate.fingerprint,
					source: {
						kind: source.kind,
						path: source.path,
						line: candidate.line,
						displayRef: candidate.displayRef.slice(0, 96),
						briefDate: source.briefDate,
					},
					createdAt: now,
					updatedAt: now,
				};
				items = [...items, item];
				sidecarItems.push({
					id: item.id,
					fingerprint: candidate.fingerprint,
					line: candidate.line,
					title: item.title,
				});
			}
			this.#write({ version: TASKS_STORE_VERSION, items });
			const sidecarDocument: TaskSidecar | undefined =
				sidecar === undefined ? undefined : { version: 1, date: sidecar.date, items: sidecarItems };
			if (sidecar !== undefined && sidecarDocument !== undefined) this.#writeSidecar(sidecar.path, sidecarDocument);
			return {
				items: sidecarItems.map((entry) => items.find((item) => item.id === entry.id)!),
				created,
				matched,
				sidecar: sidecarDocument,
			};
		});
	}

	#update(id: string, update: (item: StoredTask, updatedAt: string) => StoredTask): StoredTask {
		return this.#locked(() => {
			const store = this.read();
			const current = store.items.find((item) => item.id === id);
			if (current === undefined) throw new TaskRefused("task_missing");
			const next = update(current, this.#clock().toISOString());
			if (next === current) return current;
			this.#write({
				version: TASKS_STORE_VERSION,
				items: store.items.map((item) => (item.id === id ? next : item)),
			});
			return next;
		});
	}

	/**
	 * Run one read-modify-write holding the store's cross-process lock, so the
	 * portal, the CLI and brief ingest never lose each other's updates. Uses the
	 * same SQLite `BEGIN EXCLUSIVE` lock file pattern as the community generation
	 * record. Refuses `tasks_busy` when another writer holds it past the wait.
	 */
	#locked<A>(action: () => A): A {
		const lockPath = `${this.file}.lock`;
		const prepared = Result.try(() => {
			mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
			closeSync(openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600));
			return new DatabaseSync(lockPath, { allowExtension: false });
		});
		if (Result.isFailure(prepared)) throw new TaskRefused("unwritable");
		const database = prepared.success;
		try {
			const locked = Result.try(() => {
				database.exec(`PRAGMA busy_timeout=${this.#lockWaitMs}`);
				database.exec("BEGIN EXCLUSIVE");
			});
			if (Result.isFailure(locked)) throw new TaskRefused("tasks_busy");
			try {
				return action();
			} finally {
				database.exec("ROLLBACK");
			}
		} finally {
			database.close();
		}
	}

	#writeSidecar(path: string, sidecar: TaskSidecar): void {
		this.#atomicWrite(path, sidecar);
	}

	#write(store: TasksStore): void {
		const payload = { version: TASKS_STORE_VERSION, items: store.items };
		if (parseStore(JSON.parse(JSON.stringify(payload))) === undefined) throw new TaskRefused("unwritable");
		if (Buffer.byteLength(`${JSON.stringify(payload)}\n`, "utf8") > TASKS_FILE_MAX_BYTES)
			throw new TaskRefused("unwritable");
		this.#atomicWrite(this.file, payload);
	}

	#atomicWrite(file: string, value: unknown): void {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const temp = `${file}.${randomUUID()}.tmp`;
		const written = Result.try(() => {
			writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
			renameSync(temp, file);
		});
		Result.try(() => unlinkSync(temp));
		if (Result.isFailure(written)) throw new TaskRefused("unwritable");
	}
}
