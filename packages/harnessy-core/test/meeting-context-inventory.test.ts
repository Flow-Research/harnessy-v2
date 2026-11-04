import { chmodSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MeetingContextError, meetingSourceKey } from "../src/meeting-context.ts";
import {
	collectMeetingInventory,
	DEFAULT_INVENTORY_PAGE_SIZE,
	type InventoryEntry,
	type InventoryOptions,
	inventoryMeetingSources,
	legacyNoteCandidates,
	MAX_INVENTORY_PAGE_SIZE,
	validateAccountScopes,
} from "../src/meeting-context-inventory.ts";
import {
	createContextRoot,
	envelopeRef,
	fathomTranscript,
	INBOX,
	NOTES,
	ROOTS,
	removeContextRoots,
	SCOPES,
	segments,
	snapshotTree,
	writeEnvelope,
	writeFile,
	writeLegacyNote,
} from "./support/meeting-context-fixture.ts";

afterEach(removeContextRoots);

const options = (contextRoot: string, overrides: Partial<InventoryOptions> = {}): InventoryOptions => ({
	contextRoot,
	roots: ROOTS,
	accountScopes: SCOPES,
	...overrides,
});

const byRef = (entries: ReadonlyArray<InventoryEntry>, ref: string): InventoryEntry => {
	const entry = entries.find((candidate) => candidate.ref === ref);
	if (entry === undefined) throw new Error(`missing inventory entry ${ref}`);
	return entry;
};

const expectCode = (action: () => unknown, code: MeetingContextError["code"]): void => {
	let failure: unknown;
	try {
		action();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(MeetingContextError);
	expect((failure as MeetingContextError).code).toBe(code);
};

const populate = (root: string, count: number): string[] =>
	Array.from({ length: count }, (_, index) =>
		writeEnvelope(root, `rec-${String(index).padStart(5, "0")}`, {
			transcript: fathomTranscript(segments(`r${index}`, 1)),
		}),
	).sort();

describe("meeting inventory identity", () => {
	it("derives deterministic account-scoped keys and never guesses a missing scope", () => {
		const root = createContextRoot();
		writeEnvelope(root, "shared-1", { account: "work", transcript: fathomTranscript(segments("w", 2)) });
		writeEnvelope(root, "shared-1", { account: "personal", transcript: fathomTranscript(segments("p", 2)) });
		const unmapped = writeEnvelope(root, "shared-1", { account: "legacy", transcript: [] });
		const mismatched = writeEnvelope(root, "other", { account: "work", envelopeAccount: "personal" });

		const first = inventoryMeetingSources(options(root));
		const second = inventoryMeetingSources(options(root));
		expect(second).toEqual(first);
		expect(first.status).toBe("complete");

		const work = byRef(first.entries, envelopeRef("shared-1", { account: "work" }));
		const personal = byRef(first.entries, envelopeRef("shared-1", { account: "personal" }));
		expect(work.source?.sourceKey).toBe(
			meetingSourceKey({ provider: "fathom", scope: "fathom:tenant-flow", objectId: "shared-1" }),
		);
		expect(personal.source?.sourceKey).not.toBe(work.source?.sourceKey);
		expect(work.source?.transcript).toMatchObject({ state: "available", segmentCount: 2, dropped: 0 });

		expect(byRef(first.entries, unmapped)).toMatchObject({
			disposition: "unresolved",
			source: null,
			reason: "no explicit source-scope mapping for this account label",
		});
		expect(byRef(first.entries, mismatched)).toMatchObject({ disposition: "unresolved", source: null });

		// A renamed local label bound to the same stable scope keeps the same identity.
		const renamed = inventoryMeetingSources(
			options(root, {
				accountScopes: [
					{ provider: "fathom", accountLabel: "legacy", scope: "fathom:tenant-flow" },
					{ provider: "fathom", accountLabel: "personal", scope: "fathom:tenant-personal" },
				],
			}),
		);
		expect(byRef(renamed.entries, unmapped).source?.sourceKey).toBe(work.source?.sourceKey);
		expect(byRef(renamed.entries, envelopeRef("shared-1", { account: "work" })).disposition).toBe("unresolved");
	});

	it("validates account-scope mappings", () => {
		expectCode(
			() => validateAccountScopes([{ provider: "fathom", accountLabel: "bad label", scope: "fathom:t" }]),
			"invalid_input",
		);
		expectCode(
			() => validateAccountScopes([{ provider: "fathom", accountLabel: "work", scope: "other:t" }]),
			"invalid_input",
		);
		expectCode(() => validateAccountScopes([...SCOPES, SCOPES[0]!]), "invalid_input");
	});

	it("reports legacy notes as review candidates without merging them", () => {
		const root = createContextRoot();
		writeEnvelope(root, "dup", { account: "work" });
		writeEnvelope(root, "dup", { account: "personal" });
		writeEnvelope(root, "solo", { account: "work" });
		const ambiguous = writeLegacyNote(root, "01-dup", "dup");
		const single = writeLegacyNote(root, "02-solo", "solo");
		const unmatched = writeLegacyNote(root, "03-gone", "gone");
		const noRef = writeLegacyNote(root, "04-manual", null);
		const emptyRef = writeFile(root, `${NOTES}/2026/Oct/05-empty.md`, "# Empty\n\n- Source Ref: fathom:\n");
		const otherProvider = writeFile(root, `${NOTES}/2026/Oct/06-zoom.md`, "# Zoom\n\n- Source Ref: zoom:77\n");
		const report = collectMeetingInventory(options(root));
		expect(byRef(report.entries, ambiguous)).toMatchObject({
			disposition: "legacy",
			source: null,
			legacy: { sourceRef: "fathom:dup", objectId: "dup", fingerprint: "fathom:dup:2026-10-01T10:00:00Z" },
		});
		const candidates = legacyNoteCandidates(report);
		expect(candidates.map(({ ref, resolution }) => [ref, resolution])).toEqual([
			[ambiguous, "ambiguous"],
			[single, "single-candidate"],
			[unmatched, "unmatched"],
			[noRef, "no-source-ref"],
			[emptyRef, "no-source-ref"],
			[otherProvider, "no-source-ref"],
		]);
		expect(byRef(report.entries, otherProvider).legacy).toEqual({
			sourceRef: "zoom:77",
			objectId: null,
			fingerprint: null,
		});
		expect(candidates[0]?.candidates).toHaveLength(2);
		expect(candidates[3]?.candidates).toEqual([]);
		expectCode(() => legacyNoteCandidates({ ...report, status: "incomplete" }), "incomplete_inventory");
	});
});

describe("meeting inventory completeness", () => {
	it("pages more than 500 inputs with explicit continuation and no silent cap", () => {
		const root = createContextRoot();
		const refs = populate(root, 1_201);
		const pages = [];
		let cursor: string | null = null;
		do {
			const page = inventoryMeetingSources(options(root, { cursor }));
			pages.push(page);
			cursor = page.nextCursor;
		} while (cursor !== null);
		expect(pages.map((page) => [page.status, page.entries.length, page.enumerated])).toEqual([
			["incomplete", DEFAULT_INVENTORY_PAGE_SIZE, 1_201],
			["incomplete", DEFAULT_INVENTORY_PAGE_SIZE, 1_201],
			["complete", 201, 1_201],
		]);
		const seen = pages.flatMap((page) => page.entries.map((entry) => entry.ref));
		expect(seen).toEqual(refs);
		expect(new Set(seen).size).toBe(1_201);

		const merged = collectMeetingInventory(options(root));
		expect(merged.status).toBe("complete");
		expect(merged.entries.map((entry) => entry.ref)).toEqual(refs);
		expect(merged.entries.every((entry) => entry.disposition === "indexed")).toBe(true);

		expectCode(() => inventoryMeetingSources(options(root, { pageSize: 0 })), "invalid_input");
		expectCode(() => inventoryMeetingSources(options(root, { pageSize: 2.5 })), "invalid_input");
		expectCode(
			() => inventoryMeetingSources(options(root, { pageSize: MAX_INVENTORY_PAGE_SIZE + 1 })),
			"invalid_input",
		);
	});

	it("refuses byte limits that would make the reader unbounded", () => {
		const root = createContextRoot();
		populate(root, 2);
		for (const maxArtifactBytes of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY])
			expectCode(() => collectMeetingInventory(options(root, { maxArtifactBytes })), "invalid_input");
		const bounded = collectMeetingInventory(options(root, { maxArtifactBytes: 0 }));
		expect(bounded.status).toBe("complete");
		expect(bounded.entries.map((entry) => entry.disposition)).toEqual(["oversize", "oversize"]);
	});

	it("reports an error instead of a silent gap when the tree changes between pages", () => {
		const root = createContextRoot();
		const refs = populate(root, 6);
		const first = inventoryMeetingSources(options(root, { pageSize: 3 }));
		expect(first).toMatchObject({ status: "incomplete", enumerated: 6 });
		const changedSet = {
			status: "error",
			cursor: first.nextCursor,
			nextCursor: null,
			entries: [],
			diagnostics: [{ ref: INBOX, code: "enumeration_changed" }],
		};

		// A file added before the cursor position would otherwise never be seen.
		const added = writeEnvelope(root, "late", {
			filename: "-added.json",
			transcript: fathomTranscript(segments("late", 1)),
		});
		expect(added < (refs[2] as string)).toBe(true);
		expect(inventoryMeetingSources(options(root, { pageSize: 3, cursor: first.nextCursor }))).toMatchObject({
			...changedSet,
			enumerated: 7,
		});
		rmSync(join(root, added));
		// The original set is valid again, so the cursor continues.
		expect(
			inventoryMeetingSources(options(root, { pageSize: 3, cursor: first.nextCursor })).entries.map((e) => e.ref),
		).toEqual(refs.slice(3));

		// A file renamed between pages keeps the count but is still a changed set.
		const renamed = writeEnvelope(root, "late", { filename: "-renamed.json", transcript: [] });
		rmSync(join(root, refs[5] as string));
		expect(inventoryMeetingSources(options(root, { pageSize: 3, cursor: first.nextCursor }))).toMatchObject({
			...changedSet,
			enumerated: 6,
		});
		// A file removed between pages is also a changed set.
		rmSync(join(root, renamed));
		expect(inventoryMeetingSources(options(root, { pageSize: 3, cursor: first.nextCursor }))).toMatchObject({
			...changedSet,
			enumerated: 5,
		});

		// The merged inventory keeps the pages it read and reports the change instead of "complete".
		const merged = collectMeetingInventory(
			options(root, {
				pageSize: 2,
				onEntry: (entry) => {
					if (entry.ref === refs[0]) writeEnvelope(root, "late", { filename: "-added.json", transcript: [] });
				},
			}),
		);
		expect(merged).toMatchObject({ status: "error", nextCursor: null });
		expect(merged.entries.map((entry) => entry.ref)).toEqual(refs.slice(0, 2));
		expect(merged.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["enumeration_changed"]);
		expectCode(() => legacyNoteCandidates(merged), "incomplete_inventory");

		// Content changes within an unchanged set do not invalidate the cursor; each entry carries its own hash.
		const stable = createContextRoot();
		const stableRefs = populate(stable, 4);
		const page = inventoryMeetingSources(options(stable, { pageSize: 2 }));
		writeEnvelope(stable, "rec-00000", { transcript: fathomTranscript(segments("edited", 2)) });
		expect(inventoryMeetingSources(options(stable, { pageSize: 2, cursor: page.nextCursor }))).toMatchObject({
			status: "complete",
			entries: [{ ref: stableRefs[2] }, { ref: stableRefs[3] }],
		});
	});

	it("reports interruption with a resumable cursor", () => {
		const root = createContextRoot();
		const refs = populate(root, 20);
		const controller = new AbortController();
		const interrupted = inventoryMeetingSources(
			options(root, {
				signal: controller.signal,
				onEntry: (entry) => {
					if (entry.ref === refs[6]) controller.abort();
				},
			}),
		);
		expect(interrupted.status).toBe("interrupted");
		expect(interrupted.entries.map((entry) => entry.ref)).toEqual(refs.slice(0, 7));
		expect(interrupted.nextCursor).not.toBeNull();
		const resumed = collectMeetingInventory(options(root, { cursor: interrupted.nextCursor }));
		expect(resumed).toMatchObject({ status: "complete", cursor: interrupted.nextCursor });
		// A resumed report covers only the tail, so it cannot stand in for a full inventory.
		expectCode(() => legacyNoteCandidates(resumed), "incomplete_inventory");
		const lastPage = inventoryMeetingSources(options(root, { pageSize: 15, cursor: interrupted.nextCursor }));
		expect(lastPage).toMatchObject({ status: "complete", nextCursor: null });
		expectCode(() => legacyNoteCandidates(lastPage), "incomplete_inventory");
		expect([...interrupted.entries, ...resumed.entries].map((entry) => entry.ref)).toEqual(refs);

		const aborted = new AbortController();
		aborted.abort();
		const none = collectMeetingInventory(options(root, { signal: aborted.signal }));
		expect(none).toMatchObject({ status: "interrupted", entries: [] });
		expect(inventoryMeetingSources(options(root, { cursor: none.nextCursor })).entries[0]?.ref).toBe(refs[0]);
	});

	it("marks missing, rejected and unreadable roots as errors instead of empty", () => {
		const root = createContextRoot();
		writeEnvelope(root, "kept");
		writeFile(root, "private/owner/not-a-dir", "x");
		const outside = createContextRoot();
		mkdirSync(join(outside, "notes"));
		symlinkSync(join(outside, "notes"), join(root, "private/owner/linked-notes"));
		const selection = options(root, {
			roots: [
				{ kind: "fathom-inbox", path: INBOX },
				{ kind: "legacy-notes", path: "private/owner/absent" },
				{ kind: "legacy-notes", path: "private/owner/not-a-dir" },
				{ kind: "legacy-notes", path: "private/owner/linked-notes" },
			],
		});
		const page = inventoryMeetingSources(selection);
		expect(page).toMatchObject({ status: "error", nextCursor: null });
		const report = collectMeetingInventory(selection);
		expect(report.status).toBe("error");
		expect(report.diagnostics).toEqual(page.diagnostics);
		expect(report.entries.map((entry) => entry.disposition)).toEqual(["indexed"]);
		expect(report.diagnostics.map(({ ref, code }) => [ref, code])).toEqual([
			["private/owner/absent", "root_missing"],
			["private/owner/linked-notes", "root_rejected"],
			["private/owner/not-a-dir", "root_rejected"],
		]);
	});

	it("reports enumeration failures and unreadable files as owner-visible errors", () => {
		const root = createContextRoot();
		writeEnvelope(root, "readable");
		const locked = writeEnvelope(root, "locked");
		const lockedDirectories = [`${INBOX}/personal/pending`, `${INBOX}/sealed`, `${NOTES}/2026`];
		for (const directory of lockedDirectories) {
			mkdirSync(join(root, directory), { recursive: true });
			chmodSync(join(root, directory), 0o000);
		}
		chmodSync(join(root, locked), 0o000);
		const lockedRoot = createContextRoot();
		chmodSync(join(lockedRoot, INBOX), 0o000);
		try {
			const report = collectMeetingInventory(options(root));
			expect(report.status).toBe("error");
			expect(report.diagnostics.map(({ ref, code }) => [ref, code])).toEqual(
				lockedDirectories.sort().map((ref) => [ref, "enumeration_failed"]),
			);
			expect(byRef(report.entries, locked)).toMatchObject({ disposition: "unreadable", sha256: null });
			expect(byRef(report.entries, envelopeRef("readable")).disposition).toBe("indexed");
			expect(collectMeetingInventory(options(lockedRoot))).toMatchObject({
				status: "error",
				entries: [],
				diagnostics: [{ ref: INBOX, code: "enumeration_failed" }],
			});
		} finally {
			for (const directory of lockedDirectories) chmodSync(join(root, directory), 0o700);
			chmodSync(join(root, locked), 0o600);
			chmodSync(join(lockedRoot, INBOX), 0o700);
		}
	});

	it("classifies every artifact explicitly", () => {
		const root = createContextRoot();
		const notJson = writeFile(root, `${INBOX}/work/pending/broken.json`, "{");
		const wrongShape = writeFile(root, `${INBOX}/work/pending/shape.json`, JSON.stringify({ version: 2 }));
		const nullJson = writeFile(root, `${INBOX}/work/pending/null.json`, "null");
		const arrayPayload = writeFile(
			root,
			`${INBOX}/work/pending/array.json`,
			JSON.stringify({ version: 1, source: "fathom-api", payload: [] }),
		);
		const noRecording = writeFile(
			root,
			`${INBOX}/work/pending/blank.json`,
			JSON.stringify({ version: 1, source: "fathom-api", payload: { recording_id: " " } }),
		);
		const unverified = writeEnvelope(root, "unverified", { verified: false });
		const numeric = writeEnvelope(root, 42, { transcript: "text blob", summary: "Provider summary." });
		const processed = writeEnvelope(root, "done", { bucket: "processed", transcript: null });
		const invalidBucket = writeEnvelope(root, "quarantined", { bucket: "invalid" });
		const oversize = writeEnvelope(root, "huge", { transcript: fathomTranscript(segments("x".repeat(400), 4)) });
		const textFile = writeFile(root, `${INBOX}/work/pending/readme.txt`, "x");
		mkdirSync(join(root, INBOX, "work/pending/nested.json"));
		const strayBucket = writeFile(root, `${INBOX}/work/archive/a.json`, "{}");
		const strayAccountFile = writeFile(root, `${INBOX}/stray.json`, "{}");
		const bucketFile = writeFile(root, `${INBOX}/personal/pending`, "not a directory");
		const pathological = writeFile(root, `${INBOX}/work/pending/a:b.json`, "{}");
		const otherNote = writeFile(root, `${NOTES}/2026/Oct/scan.pdf`, "%PDF");

		const report = collectMeetingInventory(options(root, { maxArtifactBytes: 1_024 }));
		const disposition = (ref: string) => byRef(report.entries, ref).disposition;
		expect(report.status).toBe("complete");
		expect(disposition(notJson)).toBe("invalid");
		expect(disposition(wrongShape)).toBe("invalid");
		expect(disposition(nullJson)).toBe("invalid");
		expect(disposition(arrayPayload)).toBe("invalid");
		expect(disposition(noRecording)).toBe("invalid");
		expect(byRef(report.entries, unverified)).toMatchObject({
			disposition: "invalid",
			reason: "envelope is not verified",
		});
		expect(byRef(report.entries, numeric).source).toMatchObject({
			objectId: "42",
			transcript: { state: "unsupported", segmentCount: 0, sha256: null },
		});
		expect(byRef(report.entries, numeric).source?.providerSummarySha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(byRef(report.entries, processed)).toMatchObject({
			bucket: "processed",
			source: { transcript: { state: "missing" }, providerSummarySha256: null },
		});
		expect(byRef(report.entries, invalidBucket).bucket).toBe("invalid");
		expect(byRef(report.entries, oversize)).toMatchObject({ disposition: "oversize", sha256: null });
		expect(disposition(textFile)).toBe("unsupported");
		expect(disposition(`${INBOX}/work/pending/nested.json`)).toBe("unsupported");
		expect(disposition(`${INBOX}/work/archive`)).toBe("unsupported");
		expect(report.entries.some((entry) => entry.ref === strayBucket)).toBe(false);
		expect(disposition(strayAccountFile)).toBe("unsupported");
		expect(disposition(bucketFile)).toBe("unsupported");
		expect(byRef(report.entries, pathological)).toMatchObject({ disposition: "unreadable" });
		expect(disposition(otherNote)).toBe("unsupported");
	});
});

describe("meeting inventory containment", () => {
	it("rejects traversal and overlapping or malformed root selections", () => {
		const root = createContextRoot();
		for (const path of ["../outside", "/etc", "a/../b", "a//b", "./a", "a\\b"])
			expectCode(
				() => inventoryMeetingSources(options(root, { roots: [{ kind: "legacy-notes", path }] })),
				"path_rejected",
			);
		expectCode(() => inventoryMeetingSources(options(root, { roots: [] })), "invalid_input");
		expectCode(
			() =>
				inventoryMeetingSources(
					options(root, {
						roots: [
							{ kind: "legacy-notes", path: "private" },
							{ kind: "fathom-inbox", path: "private/owner" },
						],
					}),
				),
			"invalid_input",
		);
		expectCode(
			() =>
				inventoryMeetingSources(
					options(root, {
						roots: [
							{ kind: "legacy-notes", path: "private" },
							{ kind: "fathom-inbox", path: "private" },
						],
					}),
				),
			"invalid_input",
		);
		expectCode(
			() =>
				inventoryMeetingSources(options(root, { roots: [{ kind: "unknown" as "legacy-notes", path: "private" }] })),
			"invalid_input",
		);
	});

	it("never follows symbolic links, even when they point inside the root", () => {
		const root = createContextRoot();
		const outside = createContextRoot();
		const secret = writeEnvelope(outside, "secret", { transcript: fathomTranscript(segments("secret", 3)) });
		const inside = writeEnvelope(root, "inside");
		mkdirSync(join(root, INBOX, "linked"), { recursive: true });
		symlinkSync(join(outside, secret), join(root, INBOX, "work/pending/escape.json"));
		symlinkSync(join(root, inside), join(root, INBOX, "work/pending/alias.json"));
		symlinkSync(join(outside, INBOX, "work/pending"), join(root, INBOX, "linked/pending"));
		symlinkSync(join(outside, INBOX, "work"), join(root, INBOX, "escaped-account"));
		mkdirSync(join(root, NOTES), { recursive: true });
		symlinkSync(join(outside, INBOX), join(root, NOTES, "escaped-dir"));
		symlinkSync(join(outside, secret), join(root, NOTES, "escaped.md"));

		const report = collectMeetingInventory(options(root));
		const links = report.entries.filter((entry) => entry.disposition === "rejected-link").map((entry) => entry.ref);
		expect(links).toEqual(
			[
				`${INBOX}/escaped-account`,
				`${INBOX}/linked/pending`,
				`${INBOX}/work/pending/alias.json`,
				`${INBOX}/work/pending/escape.json`,
				`${NOTES}/escaped-dir`,
				`${NOTES}/escaped.md`,
			].sort(),
		);
		expect(report.entries.filter((entry) => entry.source !== null).map((entry) => entry.ref)).toEqual([inside]);
		expect(JSON.stringify(report)).not.toContain("secret segment");
	});

	it("rejects a file replaced by a link after enumeration", () => {
		const root = createContextRoot();
		const refs = populate(root, 3);
		const outside = createContextRoot();
		const secret = writeEnvelope(outside, "secret", { transcript: fathomTranscript(segments("secret", 1)) });
		const report = inventoryMeetingSources(
			options(root, {
				onEntry: (entry) => {
					if (entry.ref !== refs[0]) return;
					rmSync(join(root, refs[1]!));
					symlinkSync(join(outside, secret), join(root, refs[1]!));
				},
			}),
		);
		expect(report.entries.map((entry) => entry.disposition)).toEqual(["indexed", "rejected-link", "indexed"]);
		expect(JSON.stringify(report)).not.toContain("secret segment");
	});

	it("rejects foreign, malformed and stale cursors", () => {
		const root = createContextRoot();
		populate(root, 3);
		const page = inventoryMeetingSources(options(root, { pageSize: 1 }));
		expectCode(
			() =>
				inventoryMeetingSources(
					options(root, { cursor: page.nextCursor, roots: [{ kind: "fathom-inbox", path: INBOX }] }),
				),
			"invalid_input",
		);
		expectCode(() => inventoryMeetingSources(options(root, { cursor: "not json" })), "invalid_input");
		expectCode(
			() => inventoryMeetingSources(options(root, { cursor: Buffer.from("null").toString("base64url") })),
			"invalid_input",
		);
		expectCode(
			() =>
				inventoryMeetingSources(
					options(root, { cursor: Buffer.from(JSON.stringify({ v: 2, after: "" })).toString("base64url") }),
				),
			"invalid_input",
		);
		const roots = JSON.parse(Buffer.from(page.nextCursor as string, "base64url").toString("utf8")).roots;
		for (const set of [undefined, 7])
			expectCode(
				() =>
					inventoryMeetingSources(
						options(root, {
							cursor: Buffer.from(JSON.stringify({ v: 1, roots, set, after: "" })).toString("base64url"),
						}),
					),
				"invalid_input",
			);
	});

	it("leaves every source byte, mode and timestamp unchanged", () => {
		const root = createContextRoot();
		populate(root, 30);
		writeLegacyNote(root, "01-note", "rec-00001");
		writeFile(root, `${INBOX}/work/pending/broken.json`, "{");
		symlinkSync(join(root, envelopeRef("rec-00002")), join(root, INBOX, "work/pending/alias.json"));
		const before = snapshotTree(root);
		const report = collectMeetingInventory(options(root, { pageSize: 7 }));
		legacyNoteCandidates(report);
		expect(report.status).toBe("complete");
		expect(snapshotTree(root)).toEqual(before);
	});
});
