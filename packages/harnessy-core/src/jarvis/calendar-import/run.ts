import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import * as Result from "effect/Result";
import { z } from "zod";
import { ACCOUNT_SLUG, type ConsentRecord, readConsent, recordConsent } from "./consent.ts";
import { type CalendarRead, childProcessDebugEnabled, gwsCalendarReader } from "./gws-reader.ts";
import { type AccountSummary, type ImportAccount, importCalendars } from "./importer.ts";
import { accountKey, accountLabel, CalendarImportError, identityKey } from "./keys.ts";
import type { ActionDescriptor } from "./match.ts";
import { observationStore, readDecisions, readObservations } from "./observations.ts";
import { readOrCreateSalt, readOwnerJson, readSalt, writeOwnerFile } from "./owner-file.ts";

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

/**
 * The read-permission check for one folder: one metadata call for the primary
 * calendar ID, nothing else. It returns the full keyed identity digest, never the
 * ID. A person reviews the result and passes the digest to `recordAccountConsent`.
 */
export async function checkPrimaryIdentity(
	home: string,
	slug: string,
	read: CalendarRead,
): Promise<{ readonly account: string; readonly identity: string }> {
	if (!ACCOUNT_SLUG.test(slug)) throw new CalendarImportError("Account folder name is not valid");
	refuseWhenSpawnIsLogged();
	const salt = readOrCreateSalt(calendarImportPaths(home).salt);
	const primary = await read([
		"calendar",
		"calendars",
		"get",
		"--params",
		JSON.stringify({ calendarId: "primary", fields: "id" }),
	]);
	const id = typeof primary.id === "string" ? primary.id : "";
	if (!id) throw new CalendarImportError("The primary calendar has no ID; nothing was checked");
	return { account: accountLabel(accountKey(salt, slug)), identity: identityKey(salt, id) };
}

/** Refuse before any file or account is touched when Node would log spawn arguments and environment. */
function refuseWhenSpawnIsLogged(): void {
	if (childProcessDebugEnabled())
		throw new CalendarImportError("Refused: Node child-process debugging is enabled; gws was not started");
}

const FULL_DIGEST = /^[a-f0-9]{64}$/u;

/**
 * Record consent for one folder. `approvedIdentity` is the full keyed digest from
 * the read-permission check that a person approved. It is stored as given and the
 * importer compares it exactly on every read. Nothing is read here, and a short or
 * malformed value is refused. Without it the account stays unbound and is never read.
 */
export function recordAccountConsent(
	home: string,
	slug: string,
	input: ConsentInput,
	approvedIdentity?: string,
): { readonly account: string; readonly bound: boolean } {
	if (!ACCOUNT_SLUG.test(slug)) throw new CalendarImportError("Account folder name is not valid");
	if (approvedIdentity !== undefined && !FULL_DIGEST.test(approvedIdentity))
		throw new CalendarImportError(
			"The approved identity must be the full 64-character keyed digest; nothing was recorded",
		);
	const paths = calendarImportPaths(home);
	const salt = readOrCreateSalt(paths.salt);
	const account = accountKey(salt, slug);
	recordConsent(paths.consent, [{ account, identity: approvedIdentity ?? null, scope: "calendar.read", ...input }]);
	return { account: accountLabel(account), bound: approvedIdentity !== undefined };
}
