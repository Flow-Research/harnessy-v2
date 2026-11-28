import { createHash, createHmac } from "node:crypto";
import { classifyEvent, isJarvisBlock, parseMarkers } from "./classify.ts";
import type { ConsentRecord } from "./consent.ts";
import { type CalendarRead, CalendarReadError } from "./gws-reader.ts";
import { type ActionDescriptor, heuristicCandidates, resolveLink } from "./match.ts";
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

export interface ImportOptions {
	/** Slugs to read, in order. A slug without consent is refused before any call. */
	readonly accounts: readonly string[];
	readonly consent: ReadonlyMap<string, ConsentRecord>;
	/** Build the read-only reader for one slug. It is called only for consented slugs. */
	readonly readerFor: (slug: string) => CalendarRead;
	readonly salt: Buffer;
	/** Keyed identity per slug from earlier runs. A changed primary calendar is refused. */
	readonly bindings: Readonly<Record<string, string>>;
	readonly decisions?: readonly LinkDecision[];
	readonly descriptors?: readonly ActionDescriptor[];
	readonly previousFingerprint?: string;
	readonly now: Date;
}

export interface AccountSummary {
	readonly slug: string;
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
		readonly duplicates: number;
		readonly actionMarkers: number;
		readonly taskMarkers: number;
	};
	readonly links: Record<"verified" | "candidate" | "conflict" | "checked_no_match", number>;
}

export interface ImportResult {
	readonly store: ObservationStore;
	readonly bindings: Record<string, string>;
	readonly changed: boolean;
	readonly accounts: readonly AccountSummary[];
}

const keyed = (salt: Buffer, ...parts: string[]) =>
	createHmac("sha256", salt).update(parts.join("\u0000")).digest("hex");

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

const emptySummary = (slug: string, state: AccountSummary["state"], reason?: AccountReason): AccountSummary => ({
	slug,
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
		duplicates: 0,
		actionMarkers: 0,
		taskMarkers: 0,
	},
	links: { verified: 0, candidate: 0, conflict: 0, checked_no_match: 0 },
});

/** An event can feed the engine only when it is confirmed, accepted by Julian, not a copy, and not past. */
export function isEligible(event: StoredEvent, at: Date): boolean {
	return (
		event.status === "confirmed" &&
		event.response === "accepted" &&
		!event.jarvisBlock &&
		event.duplicateOf === null &&
		Date.parse(event.start) >= at.getTime()
	);
}

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
class TooManyEvents extends Error {}

/**
 * Read each consented account once, keep only opaque keys, flags, Jarvis IDs and
 * timestamps, and drop every title and description when the function returns.
 */
export async function importCalendars(options: ImportOptions): Promise<ImportResult> {
	const { salt, now } = options;
	const from = new Date(now.getTime() - IMPORT_WINDOW.backHours * hour).toISOString();
	const to = new Date(now.getTime() + IMPORT_WINDOW.aheadHours * hour).toISOString();
	const bindings: Record<string, string> = { ...options.bindings };
	const identities = new Set<string>();
	const seen = new Map<string, string>();
	const accounts: StoredAccount[] = [];
	const events: StoredEvent[] = [];
	const summaries: AccountSummary[] = [];
	const decisions = options.decisions ?? [];
	for (const slug of options.accounts) {
		const account = keyed(salt, "account", slug);
		const refuse = (reason: AccountReason) => {
			accounts.push({ account, state: "unavailable", reason });
			summaries.push(emptySummary(slug, "unavailable", reason));
		};
		if (!options.consent.has(slug)) {
			refuse("no-consent");
			continue;
		}
		let items: Record<string, unknown>[];
		try {
			const read = options.readerFor(slug);
			const primary = await read([
				"calendar",
				"calendars",
				"get",
				"--params",
				JSON.stringify({ calendarId: "primary", fields: "id" }),
			]);
			if (!text(primary.id)) throw new CalendarReadError("failed");
			const identity = keyed(salt, "identity", text(primary.id).toLowerCase());
			const bound = bindings[slug];
			if (bound !== undefined && bound !== identity) {
				refuse("identity-changed");
				continue;
			}
			if (identities.has(identity)) {
				refuse("duplicate-account");
				continue;
			}
			identities.add(identity);
			bindings[slug] = identity;
			items = await readEvents(read, from, to);
		} catch (cause) {
			refuse(
				cause instanceof TooManyEvents
					? "too-many-events"
					: cause instanceof CalendarReadError
						? cause.reason
						: "failed",
			);
			continue;
		}
		const summary = emptySummary(slug, "read");
		const accountEvents: StoredEvent[] = [];
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
			const key = keyed(salt, "event", account, id);
			const dedupe = keyed(salt, "ical", text(item.iCalUID) || id, original?.iso ?? start.iso);
			const first = status === "cancelled" ? undefined : seen.get(dedupe);
			if (status !== "cancelled" && first === undefined) seen.set(dedupe, key);
			accountEvents.push({
				key,
				account,
				series: recurring ? keyed(salt, "series", account, recurring) : null,
				occurrence: original?.iso ?? null,
				start: start.iso,
				end: end.iso,
				allDay: start.allDay,
				status,
				response: responseOf(item, organizerSelf),
				organizerSelf,
				jarvisBlock: isJarvisBlock(title, description),
				duplicateOf: first ?? null,
				relation: classifyEvent(title, description),
				markers: parseMarkers(`${title}\n${description}`),
				candidates: heuristicCandidates(title, description, options.descriptors ?? []),
			});
		}
		accounts.push({ account, state: "read" });
		events.push(...accountEvents);
		summaries.push(summarise(summary, accountEvents, decisions, now));
	}
	const body = { accounts, events };
	const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
	return {
		store: { version: 1, importedAt: now.toISOString(), window: { from, to }, fingerprint, ...body },
		bindings,
		changed: fingerprint !== options.previousFingerprint,
		accounts: summaries,
	};
}

function summarise(
	base: AccountSummary,
	events: readonly StoredEvent[],
	decisions: readonly LinkDecision[],
	now: Date,
): AccountSummary {
	const status = { ...base.status };
	const response = { ...base.response };
	const relation = { ...base.relation };
	const flags = { ...base.flags };
	const links = { ...base.links };
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
		if (event.duplicateOf) flags.duplicates++;
		flags.actionMarkers += event.markers.filter((marker) => marker.kind === "action").length;
		flags.taskMarkers += event.markers.filter((marker) => marker.kind === "task").length;
		const actions = new Set(
			[
				...event.markers.filter((marker) => marker.kind === "action").map((marker) => marker.id),
				...event.candidates,
				...decisions.map((decision) => decision.actionId),
			].map((id) => id.toLowerCase()),
		);
		const states = [...actions].map((actionId) => resolveLink(event, actionId, decisions).state);
		const linked = states.filter((state) => state !== "checked_no_match");
		if (linked.length === 0) links.checked_no_match++;
		for (const state of linked) links[state]++;
	}
	return { ...base, events: events.length, status, response, relation, flags, links };
}
