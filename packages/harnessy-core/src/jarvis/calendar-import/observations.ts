import { z } from "zod";
import { readOwnerFile } from "./owner-file.ts";

/**
 * The stored calendar observations. Only opaque keys, derived flags, Jarvis IDs
 * and timestamps are allowed here. Titles, descriptions, locations, attendees and
 * addresses never enter this shape, so they cannot reach storage, logs or sync.
 */
const key = z.string().regex(/^[a-f0-9]{64}$/u);
const instant = z.iso.datetime({ offset: true });
const marker = z.strictObject({
	kind: z.enum(["action", "task"]),
	id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
	relation: z.enum(["preparation", "agenda"]).optional(),
});
export const storedEvent = z.strictObject({
	key,
	account: key,
	series: key.nullable(),
	occurrence: instant.nullable(),
	start: instant,
	end: instant,
	allDay: z.boolean(),
	status: z.enum(["confirmed", "tentative", "cancelled"]),
	response: z.enum(["accepted", "tentative", "declined", "needsAction", "unknown"]),
	organizerSelf: z.boolean(),
	jarvisBlock: z.boolean(),
	duplicateOf: key.nullable(),
	relation: z.enum(["preparation", "agenda", "none"]),
	markers: z.array(marker),
	candidates: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)),
});
export type StoredEvent = z.infer<typeof storedEvent>;

export const accountReasons = [
	"no-consent",
	"auth",
	"scope",
	"failed",
	"identity-changed",
	"duplicate-account",
	"too-many-events",
] as const;
export type AccountReason = (typeof accountReasons)[number];
export const storedAccount = z.strictObject({
	account: key,
	state: z.enum(["read", "unavailable"]),
	reason: z.enum(accountReasons).optional(),
});
export type StoredAccount = z.infer<typeof storedAccount>;

export const observationStore = z.strictObject({
	version: z.literal(1),
	importedAt: instant,
	window: z.strictObject({ from: instant, to: instant }),
	fingerprint: key,
	accounts: z.array(storedAccount),
	events: z.array(storedEvent),
});
export type ObservationStore = z.infer<typeof observationStore>;

export function readObservations(path: string): ObservationStore | undefined {
	const text = readOwnerFile(path);
	return text === undefined ? undefined : observationStore.parse(JSON.parse(text));
}

/**
 * Human decisions about links. The importer and agents never write this file:
 * a heuristic match stays a candidate until a person accepts it here.
 * A series target covers every occurrence; `closedOccurrences` lists original
 * occurrence starts that are done, so later occurrences stay open.
 */
export const linkDecision = z.strictObject({
	actionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
	target: z.strictObject({ kind: z.enum(["event", "series"]), key }),
	decision: z.enum(["accept", "reject"]),
	relation: z.enum(["preparation", "agenda"]).optional(),
	decidedBy: z.string().trim().min(1).max(64),
	decidedAt: instant,
	closedOccurrences: z.array(instant).default([]),
});
export type LinkDecision = z.output<typeof linkDecision>;
const decisionsFile = z.strictObject({ version: z.literal(1), decisions: z.array(linkDecision) });

export function readDecisions(path: string): readonly LinkDecision[] {
	const text = readOwnerFile(path);
	return text === undefined ? [] : decisionsFile.parse(JSON.parse(text)).decisions;
}
