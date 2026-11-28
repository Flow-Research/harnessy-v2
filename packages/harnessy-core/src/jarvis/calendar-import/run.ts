import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import * as Result from "effect/Result";
import { z } from "zod";
import { ACCOUNT_SLUG, type ConsentRecord, readConsent, recordConsent } from "./consent.ts";
import { type CalendarRead, gwsCalendarReader } from "./gws-reader.ts";
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
	if (options.accounts !== undefined && options.accounts.length > 0 && !options.dryRun)
		throw new CalendarImportError("A partial calendar import is allowed only with --dry-run");
	const paths = calendarImportPaths(options.home);
	const existingSalt = readSalt(paths.salt);
	const salt = options.dryRun && existingSalt === undefined ? randomBytes(32) : readOrCreateSalt(paths.salt);
	const consent = readConsent(paths.consent);
	const descriptors = options.descriptorsPath === undefined ? [] : readDescriptors(options.descriptorsPath);
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
 * Record consent for one folder. With `approvedIdentityPrefix`, the primary
 * calendar ID is read once (metadata only) and bound only if its SHA-256 starts
 * with the prefix that a person approved from the read-permission check. The
 * stored identity is a keyed hash. Without a prefix the account stays unbound.
 */
export async function recordAccountConsent(
	home: string,
	slug: string,
	input: ConsentInput,
	approval?: { readonly read: CalendarRead; readonly approvedIdentityPrefix: string },
): Promise<{ readonly account: string; readonly bound: boolean }> {
	if (!ACCOUNT_SLUG.test(slug)) throw new CalendarImportError("Account folder name is not valid");
	const paths = calendarImportPaths(home);
	const salt = readOrCreateSalt(paths.salt);
	let identity: string | null = null;
	if (approval) {
		if (!/^[a-f0-9]{8,64}$/u.test(approval.approvedIdentityPrefix))
			throw new CalendarImportError("The approved identity prefix must be 8 to 64 lowercase hex characters");
		const primary = await approval.read([
			"calendar",
			"calendars",
			"get",
			"--params",
			JSON.stringify({ calendarId: "primary", fields: "id" }),
		]);
		const id = typeof primary.id === "string" ? primary.id : "";
		if (
			!id ||
			!createHash("sha256").update(id.toLowerCase()).digest("hex").startsWith(approval.approvedIdentityPrefix)
		)
			throw new CalendarImportError(
				"The primary calendar does not match the approved identity; nothing was recorded",
			);
		identity = identityKey(salt, id);
	}
	const account = accountKey(salt, slug);
	recordConsent(paths.consent, [{ account, identity, scope: "calendar.read", ...input }]);
	return { account: accountLabel(account), bound: identity !== null };
}
