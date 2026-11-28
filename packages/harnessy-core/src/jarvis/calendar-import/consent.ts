import { z } from "zod";
import { readOwnerJson, writeOwnerFile } from "./owner-file.ts";

/** A gws account slug: the `<slug>` in `~/.config/gws-<slug>/`. A leading dash is refused. */
export const ACCOUNT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u;
const key = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * Per-account consent. The account is an opaque key, never the folder name.
 * `identity` is the keyed hash of the primary calendar ID. It is set only by
 * `enrollAccount`, which compares that ID with the intended ID the operator
 * supplied (`binding: "enrolled"`). An account without an enrolled identity is
 * unbound: it is never read.
 */
const consentRecord = z
	.strictObject({
		account: key,
		identity: key.nullable(),
		binding: z.enum(["none", "enrolled"]),
		scope: z.literal("calendar.read"),
		consentedAt: z.iso.datetime({ offset: true }),
		consentedBy: z.string().trim().min(1).max(64),
		method: z.enum(["voice", "written"]),
	})
	.refine((record) => (record.binding === "enrolled") === (record.identity !== null), {
		message: "An identity is allowed only on an enrolled binding",
	});
export type ConsentRecord = z.infer<typeof consentRecord>;

// Version 2 records were bound before the enrollment comparison existed. They are
// still read, so consent is kept, but each one is unbound until import-enroll runs.
const legacyRecord = z.strictObject({
	account: key,
	identity: key.nullable(),
	scope: z.literal("calendar.read"),
	consentedAt: z.iso.datetime({ offset: true }),
	consentedBy: z.string().trim().min(1).max(64),
	method: z.enum(["voice", "written"]),
});
const consentFile = z.union([
	z.strictObject({ version: z.literal(3), accounts: z.array(consentRecord) }),
	z.strictObject({ version: z.literal(2), accounts: z.array(legacyRecord) }).transform(({ accounts }) => ({
		version: 3 as const,
		accounts: accounts.map((record): ConsentRecord => ({ ...record, identity: null, binding: "none" })),
	})),
]);

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
	writeOwnerFile(path, `${JSON.stringify({ version: 3, accounts }, null, 2)}\n`, "consent file");
	return merged;
}
