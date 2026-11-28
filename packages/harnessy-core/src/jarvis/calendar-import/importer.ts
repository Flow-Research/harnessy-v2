import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { classifyEvent, isJarvisBlock, parseMarkers } from "./classify.ts";
import type { ConsentRecord } from "./consent.ts";
import { type CalendarRead, CalendarReadError } from "./gws-reader.ts";
import { accountLabel, actionKey, identityKey, keyed } from "./keys.ts";
import {
	type ActionDescriptor,
	heuristicCandidates,
	isEligible,
	type KeyedDecision,
	keyDecisions,
	type LinkSubject,
	resolveLink,
	subjectOf,
	type TasksOfAction,
	tasksFromDescriptors,
} from "./match.ts";
import type { AccountReason, LinkDecision, ObservationStore, StoredAccount, StoredEvent } from "./observations.ts";

const hour = 3_600_000;
/** The engine scores events up to 168 h ahead. One day back keeps a stable window across a day boundary. */
export const IMPORT_WINDOW = { backHours: 24, aheadHours: 192 } as const;
const PAGE_SIZE = 250;
const MAX_PAGES = 8;

// Only these fields are requested. Location, attendee addresses, organizer
// address, conference data and attachments are never asked for.
const EVENT_FIELDS =
	"nextPageToken,items(id,iCalUID,status,summary,description,start,end,recurringEventId,originalStartTime,organizer/self,attendees(self,responseStatus),eventType)";

/** One account to read. `slug` is the gws folder name and stays in memory only. */
export interface ImportAccount {
	readonly key: string;
	readonly slug: string;
}

export interface ImportOptions {
	readonly accounts: readonly ImportAccount[];
	/** Consent keyed by account key. Only an account with an approved identity is read. */
	readonly consent: ReadonlyMap<string, ConsentRecord>;
	/** Build the read-only reader for one folder name. It is called only for consented, bound accounts. */
	readonly readerFor: (slug: string) => CalendarRead;
	readonly salt: Buffer;
	readonly decisions?: readonly LinkDecision[];
	readonly descriptors?: readonly ActionDescriptor[];
	readonly previousFingerprint?: string;
	readonly now: Date;
}

export interface AccountSummary {
	/** First 12 hex characters of the opaque account key. */
	readonly account: string;
	readonly state: "read" | "unavailable";
	readonly reason?: AccountReason;
	readonly events: number;
	readonly status: Record<StoredEvent["status"], number>;
	readonly response: Record<StoredEvent["response"], number>;
	readonly relation: Record<StoredEvent["relation"], number>;
	readonly flags: {
		readonly eligible: number;
		readonly past: number;
		readonly allDay: number;
		readonly recurring: number;
		readonly organizerSelf: number;
		readonly jarvisBlocks: number;
		readonly copies: number;
		readonly actionMarkers: number;
		readonly taskMarkers: number;
	};
	readonly links: Record<"verified" | "candidate" | "conflict" | "checked_no_match", number>;
}

export interface ImportResult {
	readonly store: ObservationStore;
	readonly changed: boolean;
	readonly accounts: readonly AccountSummary[];
}

interface GoogleTime {
	readonly dateTime?: unknown;
	readonly date?: unknown;
}
const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** A Google start or end as an ISO instant. An all-day date starts at midnight in Lagos (UTC+01:00). */
function instantOf(value: unknown): { iso: string; allDay: boolean } | undefined {
	const time = record(value) as GoogleTime;
	if (typeof time.dateTime === "string") {
		const parsed = Date.parse(time.dateTime);
		return Number.isFinite(parsed) ? { iso: new Date(parsed).toISOString(), allDay: false } : undefined;
	}
	if (typeof time.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(time.date)) {
		const parsed = Date.parse(`${time.date}T00:00:00+01:00`);
		return Number.isFinite(parsed) ? { iso: new Date(parsed).toISOString(), allDay: true } : undefined;
	}
	return undefined;
}

const responses = new Set(["accepted", "tentative", "declined", "needsAction"]);
function responseOf(item: Record<string, unknown>, organizerSelf: boolean): StoredEvent["response"] {
	const attendees = Array.isArray(item.attendees) ? item.attendees.map(record) : [];
	const self = attendees.find((attendee) => attendee.self === true);
	if (self)
		return responses.has(text(self.responseStatus))
			? (text(self.responseStatus) as StoredEvent["response"])
			: "unknown";
	return organizerSelf ? "accepted" : "unknown";
}

const emptySummary = (account: string, state: AccountSummary["state"], reason?: AccountReason): AccountSummary => ({
	account: accountLabel(account),
	state,
	...(reason ? { reason } : {}),
	events: 0,
	status: { confirmed: 0, tentative: 0, cancelled: 0 },
	response: { accepted: 0, tentative: 0, declined: 0, needsAction: 0, unknown: 0 },
	relation: { preparation: 0, agenda: 0, none: 0 },
	flags: {
		eligible: 0,
		past: 0,
		allDay: 0,
		recurring: 0,
		organizerSelf: 0,
		jarvisBlocks: 0,
		copies: 0,
		actionMarkers: 0,
		taskMarkers: 0,
	},
	links: { verified: 0, candidate: 0, conflict: 0, checked_no_match: 0 },
});

class TooManyEvents extends Error {}

async function readEvents(read: CalendarRead, from: string, to: string): Promise<Record<string, unknown>[]> {
	const items: Record<string, unknown>[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = await read([
			"calendar",
			"events",
			"list",
			"--params",
			JSON.stringify({
				calendarId: "primary",
				singleEvents: true,
				orderBy: "startTime",
				showDeleted: false,
				timeMin: from,
				timeMax: to,
				maxResults: PAGE_SIZE,
				fields: EVENT_FIELDS,
				...(pageToken ? { pageToken } : {}),
			}),
		]);
		if (Array.isArray(result.items)) items.push(...result.items.map(record));
		pageToken = typeof result.nextPageToken === "string" && result.nextPageToken ? result.nextPageToken : undefined;
		if (!pageToken) return items;
	}
	throw new TooManyEvents();
}

/**
 * Read each consented, bound account once. Keep only opaque keys, flags and
 * timestamps; every title and description is dropped when the function returns.
 * The primary calendar must match the approved identity before events are listed.
 */
export async function importCalendars(options: ImportOptions): Promise<ImportResult> {
	const { salt, now } = options;
	const from = new Date(now.getTime() - IMPORT_WINDOW.backHours * hour).toISOString();
	const to = new Date(now.getTime() + IMPORT_WINDOW.aheadHours * hour).toISOString();
	const identities = new Set<string>();
	const groups = new Set<string>();
	const accounts: StoredAccount[] = [];
	const events: StoredEvent[] = [];
	const summaries: AccountSummary[] = [];
	const decisions = keyDecisions(salt, options.decisions ?? []);
	const descriptors = options.descriptors ?? [];
	const tasksOfAction = tasksFromDescriptors(descriptors);
	for (const { key: account, slug } of options.accounts) {
		const refuse = (reason: AccountReason) => {
			accounts.push({ account, state: "unavailable", reason });
			summaries.push(emptySummary(account, "unavailable", reason));
		};
		const consent = options.consent.get(account);
		if (!consent) {
			refuse("no-consent");
			continue;
		}
		if (consent.identity === null) {
			refuse("unbound");
			continue;
		}
		const outcome = await Effect.runPromise(
			Effect.tryPromise({
				try: async (): Promise<AccountReason | Record<string, unknown>[]> => {
					const read = options.readerFor(slug);
					const primary = await read([
						"calendar",
						"calendars",
						"get",
						"--params",
						JSON.stringify({ calendarId: "primary", fields: "id" }),
					]);
					if (!text(primary.id)) throw new CalendarReadError("failed");
					const identity = identityKey(salt, text(primary.id));
					// The approved identity is checked before any event is listed.
					if (identity !== consent.identity) return "identity-changed";
					if (identities.has(identity)) return "duplicate-account";
					identities.add(identity);
					return await readEvents(read, from, to);
				},
				catch: (cause): AccountReason =>
					cause instanceof TooManyEvents
						? "too-many-events"
						: cause instanceof CalendarReadError
							? cause.reason
							: "failed",
			}).pipe(Effect.result),
		);
		if (Result.isFailure(outcome)) {
			refuse(outcome.failure);
			continue;
		}
		if (typeof outcome.success === "string") {
			refuse(outcome.success);
			continue;
		}
		const items = outcome.success;
		const accountEvents: StoredEvent[] = [];
		let copies = 0;
		for (const item of items) {
			const id = text(item.id);
			const start = instantOf(item.start);
			const end = instantOf(item.end);
			const status = text(item.status);
			if (!id || !start || !end || (status !== "confirmed" && status !== "tentative" && status !== "cancelled"))
				continue;
			// Text stays in these two locals and is gone when the loop turns.
			const title = text(item.summary);
			const description = text(item.description);
			const organizerSelf = record(item.organizer).self === true;
			const recurring = text(item.recurringEventId);
			const original = recurring ? instantOf(item.originalStartTime) : undefined;
			const copyGroup = keyed(salt, "ical", text(item.iCalUID) || `${account}:${id}`, original?.iso ?? start.iso);
			if (groups.has(copyGroup)) copies++;
			groups.add(copyGroup);
			accountEvents.push({
				key: keyed(salt, "event", account, id),
				account,
				copyGroup,
				series: recurring ? keyed(salt, "series", account, recurring) : null,
				occurrence: original?.iso ?? null,
				start: start.iso,
				end: end.iso,
				allDay: start.allDay,
				status,
				response: responseOf(item, organizerSelf),
				organizerSelf,
				jarvisBlock: organizerSelf && isJarvisBlock(title, description),
				relation: classifyEvent(title, description),
				markers: parseMarkers(`${title}\n${description}`, salt),
				candidates: heuristicCandidates(title, description, descriptors).map((actionId) =>
					actionKey(salt, actionId),
				),
			});
		}
		accounts.push({ account, state: "read" });
		events.push(...accountEvents);
		summaries.push(summarise(account, accountEvents, copies, { salt, decisions, descriptors, tasksOfAction }, now));
	}
	const body = { accounts, events };
	const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	return {
		store: { version: 2, importedAt: now.toISOString(), window: { from, to }, fingerprint, ...body },
		changed: fingerprint !== options.previousFingerprint,
		accounts: summaries,
	};
}

interface SummaryLookups {
	readonly salt: Buffer;
	readonly decisions: readonly KeyedDecision[];
	readonly descriptors: readonly ActionDescriptor[];
	readonly tasksOfAction: TasksOfAction;
}

/**
 * Count link states with the same lookups as the provider: known actions resolve
 * their task markers, and every other subject is an action key seen in the data.
 */
function summarise(
	account: string,
	events: readonly StoredEvent[],
	copies: number,
	lookups: SummaryLookups,
	now: Date,
): AccountSummary {
	const base = emptySummary(account, "read");
	const status = { ...base.status };
	const response = { ...base.response };
	const relation = { ...base.relation };
	const flags = { ...base.flags, copies };
	const links = { ...base.links };
	const known = new Map<string, LinkSubject>();
	for (const descriptor of lookups.descriptors) {
		const subject = subjectOf(lookups.salt, descriptor.actionId, lookups.tasksOfAction);
		known.set(subject.action, subject);
	}
	for (const event of events) {
		status[event.status]++;
		response[event.response]++;
		relation[event.relation]++;
		if (isEligible(event, now)) flags.eligible++;
		if (Date.parse(event.start) < now.getTime()) flags.past++;
		if (event.allDay) flags.allDay++;
		if (event.series) flags.recurring++;
		if (event.organizerSelf) flags.organizerSelf++;
		if (event.jarvisBlock) flags.jarvisBlocks++;
		flags.actionMarkers += event.markers.filter((marker) => marker.kind === "action").length;
		flags.taskMarkers += event.markers.filter((marker) => marker.kind === "task").length;
		const subjects = new Map(known);
		for (const key of [
			...event.markers.filter((marker) => marker.kind === "action").map((marker) => marker.key),
			...event.candidates,
			...lookups.decisions.map((decision) => decision.action),
		])
			if (!subjects.has(key)) subjects.set(key, { action: key, tasks: [] });
		const linked = [...subjects.values()]
			.map((subject) => resolveLink(event, subject, lookups.decisions).state)
			.filter((state) => state !== "checked_no_match");
		if (linked.length === 0) links.checked_no_match++;
		for (const state of linked) links[state]++;
	}
	return { ...base, events: events.length, status, response, relation, flags, links };
}
