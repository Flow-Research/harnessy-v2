import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as Result from "effect/Result";
import { z } from "zod";
import { ACCOUNT_SLUG, type ConsentRecord, readConsent, recordConsent } from "./consent.ts";
import { type CalendarRead, childProcessDebugEnabled, gwsCalendarReader } from "./gws-reader.ts";
import { type AccountSummary, type ImportAccount, importCalendars } from "./importer.ts";
import { accountKey, accountLabel, CalendarImportError, identityKey } from "./keys.ts";
import type { ActionDescriptor } from "./match.ts";
import { observationStore, readDecisions, readObservations } from "./observations.ts";
import { readOrCreateSalt, readOwnerFile, readOwnerJson, readSalt, writeOwnerFile } from "./owner-file.ts";

/** Every importer file lives under `<home>/.harnessy/calendar-import/` (0700 folder, 0600 files). */
export function calendarImportPaths(home: string) {
	const root = join(home, ".harnessy", "calendar-import");
	return {
		root,
		salt: join(root, "salt"),
		consent: join(root, "consent.json"),
		observations: join(root, "observations.json"),
		decisions: join(root, "decisions.json"),
		/** Action descriptors. The manual command and the scheduled job both read this file by default. */
		actions: join(root, "actions.json"),
	};
}

/** The gws account folders on this Mac, keyed in memory. Folder names never leave this function's result. */
export function gwsAccounts(home: string, salt: Buffer): ImportAccount[] {
	const listed = Result.try(() => readdirSync(join(home, ".config")));
	if (Result.isFailure(listed)) return [];
	return listed.success
		.filter((name) => name.startsWith("gws-") && ACCOUNT_SLUG.test(name.slice(4)))
		.map((name) => ({ key: accountKey(salt, name.slice(4)), slug: name.slice(4) }))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const descriptorsFile = z.array(
	z.strictObject({
		actionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
		taskIds: z.array(z.uuid()).max(20).optional(),
		deliverable: z.array(z.string().min(1).max(80)).max(20),
		actorOrProject: z.array(z.string().min(1).max(80)).max(20),
	}),
);
export const readDescriptors = (path: string): ActionDescriptor[] =>
	readOwnerJson(path, "action descriptors file", (value) => descriptorsFile.parse(value)) ?? [];

export interface CalendarImportRunOptions {
	readonly home: string;
	readonly googleExecutable: string;
	/** SHA-256 of the native gws binary that a person approved. */
	readonly googleExecutableSha256: string;
	/** Opaque account labels to read. Allowed only with `dryRun`, so a stored import always covers every account. */
	readonly accounts?: readonly string[];
	/** Read and count only. Nothing is written; a missing salt is replaced by a throwaway one. */
	readonly dryRun: boolean;
	readonly descriptorsPath?: string;
	readonly now?: Date;
	/** Tests only, passed to `gwsCalendarReader`. No command sets it. */
	readonly testPreload?: readonly string[];
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

/** One import pass against the real files. The report holds counts, flags and opaque labels only. */
export async function runCalendarImport(options: CalendarImportRunOptions): Promise<CalendarImportReport> {
	refuseWhenSpawnIsLogged();
	if (options.accounts !== undefined && options.accounts.length > 0 && !options.dryRun)
		throw new CalendarImportError("A partial calendar import is allowed only with --dry-run");
	const paths = calendarImportPaths(options.home);
	const existingSalt = readSalt(paths.salt);
	const salt = options.dryRun && existingSalt === undefined ? randomBytes(32) : readOrCreateSalt(paths.salt);
	const consent = readConsent(paths.consent);
	// The scheduled job passes no path, so it reads the same file as a manual run.
	// A refresh therefore keeps the candidates of a manual import.
	const descriptors = readDescriptors(options.descriptorsPath ?? paths.actions);
	// A damaged or oversized earlier store must not block the next run; it is replaced below.
	const previous = Result.try(() => readObservations(paths.observations)?.fingerprint);
	const previousFingerprint = Result.isSuccess(previous) ? previous.success : undefined;
	// Every consented account, plus folders without consent so they are reported as refused.
	const present = gwsAccounts(options.home, salt);
	const known = new Set(present.map((account) => account.key));
	const all: ImportAccount[] = [
		...present,
		...[...consent.keys()].filter((key) => !known.has(key)).map((key) => ({ key, slug: "" })),
	];
	const wanted = options.accounts?.length ? new Set(options.accounts) : undefined;
	const accounts = wanted ? all.filter((account) => wanted.has(accountLabel(account.key))) : all;
	const result = await importCalendars({
		accounts,
		consent,
		readerFor: (slug) => {
			if (!slug) throw new CalendarImportError("Consented account folder is missing");
			return gwsCalendarReader(
				options.googleExecutable,
				options.googleExecutableSha256,
				join(options.home, ".config", `gws-${slug}`),
				options.testPreload,
			);
		},
		salt,
		decisions: readDecisions(paths.decisions),
		descriptors,
		...(previousFingerprint ? { previousFingerprint } : {}),
		now: options.now ?? new Date(),
	});
	if (!options.dryRun)
		writeOwnerFile(
			paths.observations,
			`${JSON.stringify(observationStore.parse(result.store))}\n`,
			"observations file",
		);
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

export interface ConsentInput {
	readonly consentedAt: string;
	readonly consentedBy: string;
	readonly method: ConsentRecord["method"];
}

const EXPECTED_ID = /^[^\s]{3,254}$/u;
const EXPECTED_ID_MAX_BYTES = 1024;

/**
 * Read the intended primary calendar ID that the operator supplies. `-` reads
 * standard input; any other value is an owner-only (0600) file. The value is
 * never taken from argv, never printed and never stored: only the comparison
 * result leaves `enrollAccount`.
 */
export function readExpectedPrimaryId(source: string): string {
	const raw =
		source === "-"
			? Result.try(() => readFileSync(0, "utf8"))
			: Result.try(() => readOwnerFile(source, "expected identity file"));
	if (Result.isFailure(raw)) {
		if (raw.failure instanceof CalendarImportError) throw raw.failure;
		throw new CalendarImportError("The expected identity input could not be read");
	}
	const text = raw.success ?? "";
	if (Buffer.byteLength(text, "utf8") > EXPECTED_ID_MAX_BYTES)
		throw new CalendarImportError("The expected identity input is too large");
	const value = text.trim();
	if (!EXPECTED_ID.test(value))
		throw new CalendarImportError("The expected identity input must be one primary calendar ID on one line");
	return value;
}

/**
 * First enrollment for one folder. One metadata call reads the primary calendar
 * ID, which is compared in memory with the ID the operator intended. Consent is
 * bound to the keyed identity only on equality. On a mismatch nothing is written,
 * so a folder that already opens the wrong login cannot be enrolled.
 */
export async function enrollAccount(
	home: string,
	slug: string,
	input: ConsentInput,
	read: CalendarRead,
	expectedPrimaryId: string,
): Promise<{ readonly account: string; readonly matches: boolean; readonly bound: boolean }> {
	if (!ACCOUNT_SLUG.test(slug)) throw new CalendarImportError("Account folder name is not valid");
	refuseWhenSpawnIsLogged();
	const paths = calendarImportPaths(home);
	const salt = readOrCreateSalt(paths.salt);
	const account = accountKey(salt, slug);
	const primary = await read([
		"calendar",
		"calendars",
		"get",
		"--params",
		JSON.stringify({ calendarId: "primary", fields: "id" }),
	]);
	const id = typeof primary.id === "string" ? primary.id : "";
	const matches = id !== "" && id.toLowerCase() === expectedPrimaryId.trim().toLowerCase();
	if (!matches) return { account: accountLabel(account), matches: false, bound: false };
	recordConsent(paths.consent, [
		{ account, identity: identityKey(salt, id), binding: "enrolled", scope: "calendar.read", ...input },
	]);
	return { account: accountLabel(account), matches: true, bound: true };
}

/**
 * Record consent for one folder without an identity. The account stays unbound
 * and is never read until `enrollAccount` binds it.
 */
export function recordAccountConsent(
	home: string,
	slug: string,
	input: ConsentInput,
): { readonly account: string; readonly bound: boolean } {
	if (!ACCOUNT_SLUG.test(slug)) throw new CalendarImportError("Account folder name is not valid");
	const paths = calendarImportPaths(home);
	const salt = readOrCreateSalt(paths.salt);
	const account = accountKey(salt, slug);
	recordConsent(paths.consent, [{ account, identity: null, binding: "none", scope: "calendar.read", ...input }]);
	return { account: accountLabel(account), bound: false };
}

/** Refuse before any file or account is touched when Node would log spawn arguments and environment. */
function refuseWhenSpawnIsLogged(): void {
	if (childProcessDebugEnabled())
		throw new CalendarImportError("Refused: Node child-process debugging is enabled; gws was not started");
}
