import { z } from "zod";
import { readOwnerJson, writeOwnerFile } from "./owner-file.ts";

/** A gws account slug: the `<slug>` in `~/.config/gws-<slug>/`. A leading dash is refused. */
export const ACCOUNT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u;
const key = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * Per-account consent. The account is an opaque key, never the folder name.
 * `identity` is the keyed hash of the approved primary calendar ID. An account
 * without an approved identity is unbound: it is never read.
 */
const consentRecord = z.strictObject({
	account: key,
	identity: key.nullable(),
	scope: z.literal("calendar.read"),
	consentedAt: z.iso.datetime({ offset: true }),
	consentedBy: z.string().trim().min(1).max(64),
	method: z.enum(["voice", "written"]),
});
export type ConsentRecord = z.infer<typeof consentRecord>;
const consentFile = z.strictObject({ version: z.literal(2), accounts: z.array(consentRecord) });

/** Read per-account consent, keyed by account key. A missing file means no account has consent. */
export function readConsent(path: string): ReadonlyMap<string, ConsentRecord> {
	const parsed = readOwnerJson(path, "consent file", (value) => consentFile.parse(value));
	return new Map((parsed?.accounts ?? []).map((record) => [record.account, record]));
}

/** Add or replace consent records. Only a human decision is recorded here; the importer never calls this. */
export function recordConsent(path: string, records: readonly ConsentRecord[]): ReadonlyMap<string, ConsentRecord> {
	const merged = new Map(readConsent(path));
	for (const record of records) merged.set(record.account, consentRecord.parse(record));
	const accounts = [...merged.values()].sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
	writeOwnerFile(path, `${JSON.stringify({ version: 2, accounts }, null, 2)}\n`, "consent file");
	return merged;
}
