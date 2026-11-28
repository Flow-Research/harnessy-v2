import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { readConsent } from "./consent.ts";
import { gwsCalendarReader } from "./gws-reader.ts";
import { type AccountSummary, importCalendars } from "./importer.ts";
import type { ActionDescriptor } from "./match.ts";
import { observationStore, readDecisions, readObservations } from "./observations.ts";
import { readOrCreateSalt, readOwnerFile, writeOwnerFile } from "./owner-file.ts";

/** Every importer file lives under `<home>/.harnessy/calendar-import/` (0700 folder, 0600 files). */
export function calendarImportPaths(home: string) {
	const root = join(home, ".harnessy", "calendar-import");
	return {
		root,
		salt: join(root, "salt"),
		consent: join(root, "consent.json"),
		bindings: join(root, "bindings.json"),
		observations: join(root, "observations.json"),
		decisions: join(root, "decisions.json"),
	};
}

const bindingsFile = z.strictObject({
	version: z.literal(1),
	accounts: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u)),
});
const descriptorsFile = z.array(
	z.strictObject({
		actionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
		deliverable: z.array(z.string().min(1).max(80)).max(20),
		actorOrProject: z.array(z.string().min(1).max(80)).max(20),
	}),
);

export interface CalendarImportRunOptions {
	readonly home: string;
	readonly googleExecutable: string;
	/** Slugs to read. Default: every slug in the consent file. */
	readonly accounts?: readonly string[];
	/** Read and count only. Nothing is written; a missing salt is replaced by a throwaway one. */
	readonly dryRun: boolean;
	readonly descriptorsPath?: string;
	readonly now?: Date;
}

export interface CalendarImportReport {
	readonly dryRun: boolean;
	readonly importedAt: string;
	readonly changed: boolean;
	readonly accounts: readonly AccountSummary[];
	readonly totals: {
		readonly accountsRead: number;
		readonly accountsUnavailable: number;
		readonly events: number;
		readonly eligible: number;
		readonly links: AccountSummary["links"];
	};
}

/** One import pass against the real files. The report holds counts and flags only. */
export async function runCalendarImport(options: CalendarImportRunOptions): Promise<CalendarImportReport> {
	const paths = calendarImportPaths(options.home);
	const consent = readConsent(paths.consent);
	const existingSalt = readOwnerFile(paths.salt);
	const salt = options.dryRun && existingSalt === undefined ? randomBytes(32) : readOrCreateSalt(paths.salt);
	const bindingsText = readOwnerFile(paths.bindings);
	const bindings = bindingsText === undefined ? {} : bindingsFile.parse(JSON.parse(bindingsText)).accounts;
	const descriptors: ActionDescriptor[] =
		options.descriptorsPath === undefined
			? []
			: descriptorsFile.parse(JSON.parse(readOwnerFile(options.descriptorsPath) ?? "[]"));
	const previous = readObservations(paths.observations);
	const result = await importCalendars({
		accounts: options.accounts ?? [...consent.keys()].sort(),
		consent,
		readerFor: (slug) => gwsCalendarReader(options.googleExecutable, join(options.home, ".config", `gws-${slug}`)),
		salt,
		bindings,
		decisions: readDecisions(paths.decisions),
		descriptors,
		...(previous ? { previousFingerprint: previous.fingerprint } : {}),
		now: options.now ?? new Date(),
	});
	if (!options.dryRun) {
		observationStore.parse(result.store);
		writeOwnerFile(paths.bindings, `${JSON.stringify({ version: 1, accounts: result.bindings }, null, 2)}\n`);
		writeOwnerFile(paths.observations, `${JSON.stringify(result.store)}\n`);
	}
	const links = { verified: 0, candidate: 0, conflict: 0, checked_no_match: 0 };
	for (const account of result.accounts)
		for (const state of Object.keys(links) as (keyof typeof links)[]) links[state] += account.links[state];
	return {
		dryRun: options.dryRun,
		importedAt: result.store.importedAt,
		changed: result.changed,
		accounts: result.accounts,
		totals: {
			accountsRead: result.accounts.filter((account) => account.state === "read").length,
			accountsUnavailable: result.accounts.filter((account) => account.state === "unavailable").length,
			events: result.accounts.reduce((sum, account) => sum + account.events, 0),
			eligible: result.accounts.reduce((sum, account) => sum + account.flags.eligible, 0),
			links,
		},
	};
}
