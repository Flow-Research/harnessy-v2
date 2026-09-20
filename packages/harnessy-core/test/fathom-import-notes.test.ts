import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { importRecentFathomNotes } from "../src/jarvis/fathom/import-notes.ts";

describe("importRecentFathomNotes", () => {
	it("contains path-bearing provider IDs and never overwrites a reviewed note", () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-containment-"));
		const inbox = join(root, "inbox", "personal", "pending");
		mkdirSync(inbox, { recursive: true });
		writeFileSync(
			join(inbox, "one.json"),
			JSON.stringify({
				version: 1,
				verified: true,
				source: "fathom-api",
				account: "personal",
				fetchedAt: "2026-09-19T00:00:00Z",
				payload: {
					recording_id: "../../../../escaped",
					meeting_title: "Review",
					created_at: "2026-09-19T00:00:00Z",
				},
			}),
		);
		const options = {
			inboxRoot: join(root, "inbox"),
			sourceRoot: join(root, "source"),
			now: new Date("2026-09-19T12:00:00Z"),
		};
		const first = importRecentFathomNotes(options);
		expect(first.paths).toHaveLength(1);
		expect(relative(options.sourceRoot, first.paths[0]).split(sep)).toEqual([
			"2026",
			"Sep",
			expect.stringMatching(/^19-review-~[a-f0-9]{64}\.md$/),
		]);
		writeFileSync(first.paths[0], "owner reviewed content");
		expect(importRecentFathomNotes(options)).toMatchObject({ imported: 0, existing: 1 });
		expect(readFileSync(first.paths[0], "utf8")).toBe("owner reviewed content");
	});
	it("promotes a recent verified envelope idempotently", () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-import-"));
		const inbox = join(root, "inbox", "personal", "pending");
		mkdirSync(inbox, { recursive: true });
		writeFileSync(
			join(inbox, "one.json"),
			JSON.stringify({
				version: 1,
				verified: true,
				account: "personal",
				source: "fathom-api",
				fetchedAt: "2026-09-19T10:00:00Z",
				payload: {
					recording_id: 42,
					meeting_title: "Weekly Team Meeting",
					recording_start_time: "2026-09-19T09:00:00Z",
					created_at: "2026-09-19T09:15:00Z",
					default_summary: { markdown_formatted: "## Key Takeaways\n\n- A decision." },
				},
			}),
		);
		const sourceRoot = join(root, "source");
		const first = importRecentFathomNotes({
			inboxRoot: join(root, "inbox"),
			sourceRoot,
			now: new Date("2026-09-19T12:00:00Z"),
		});
		expect(first.imported).toBe(1);
		expect(first.paths[0]).toBe(join(sourceRoot, "2026", "Sep", "19-weekly-team-meeting-42.md"));
		const second = importRecentFathomNotes({
			inboxRoot: join(root, "inbox"),
			sourceRoot,
			now: new Date("2026-09-19T12:00:00Z"),
		});
		expect(second.existing).toBe(1);
	});
});
