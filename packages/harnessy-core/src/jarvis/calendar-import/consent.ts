import { z } from "zod";
import { readOwnerFile, writeOwnerFile } from "./owner-file.ts";

/** A gws account slug: the `<slug>` in `~/.config/gws-<slug>/`. A leading dash is refused. */
export const ACCOUNT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u;

const consentRecord = z.strictObject({
	slug: z.string().regex(ACCOUNT_SLUG),
	scope: z.literal("calendar.read"),
	consentedAt: z.iso.datetime({ offset: true }),
	consentedBy: z.string().trim().min(1).max(64),
	method: z.enum(["voice", "written"]),
});
export type ConsentRecord = z.infer<typeof consentRecord>;
const consentFile = z.strictObject({ version: z.literal(1), accounts: z.array(consentRecord) });

/** Read per-account consent. A missing file means no account has consent. */
export function readConsent(path: string): ReadonlyMap<string, ConsentRecord> {
	const text = readOwnerFile(path);
	if (text === undefined) return new Map();
	const parsed = consentFile.parse(JSON.parse(text));
	return new Map(parsed.accounts.map((record) => [record.slug, record]));
}

/** Add or replace consent records. Only a human decision is recorded here; the importer never calls this. */
export function recordConsent(path: string, records: readonly ConsentRecord[]): ReadonlyMap<string, ConsentRecord> {
	const merged = new Map(readConsent(path));
	for (const record of records) merged.set(record.slug, consentRecord.parse(record));
	const accounts = [...merged.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	writeOwnerFile(path, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`);
	return merged;
}
