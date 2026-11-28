import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { importRecentFathomNotes } from "../src/jarvis/fathom/import-notes.ts";
import { loadMeetingRouteRules } from "../src/jarvis/fathom/routes.ts";

/** `<root>/private` with Flow, an aliased Garden, and one routed project; inbox under meeting-inbox/fathom. */
const routedFixture = () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-routed-"));
	const privateRoot = join(root, "private");
	for (const project of ["flow", "garden", "acme-health"])
		mkdirSync(join(privateRoot, project, "meetings"), { recursive: true });
	writeFileSync(
		join(privateRoot, "meeting-routes.yaml"),
		"project_aliases:\n  garden: flow\nroutes:\n  - project: acme-health\n    keywords: [acme]\n  - project: garden\n    keywords: [coach agent]\n",
	);
	const inboxRoot = join(privateRoot, "meeting-inbox", "fathom");
	const pending = join(inboxRoot, "personal", "pending");
	mkdirSync(pending, { recursive: true });
	const envelope = (name: string, payload: Record<string, unknown>) =>
		writeFileSync(
			join(pending, `${name}.json`),
			JSON.stringify({
				version: 1,
				verified: true,
				account: "personal",
				source: "fathom-api",
				fetchedAt: "2026-11-27T10:00:00Z",
				payload,
			}),
		);
	return {
		root,
		privateRoot,
		inboxRoot,
		envelope,
		options: {
			inboxRoot,
			sourceRoot: join(privateRoot, "flow", "meetings"),
			project: "flow",
			routing: loadMeetingRouteRules(privateRoot, "flow"),
			now: new Date("2026-11-27T12:00:00Z"),
		},
	};
};

describe("importRecentFathomNotes", () => {
	it("does not import existing envelopes from accounts outside the selected scope", () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-scope-"));
		try {
			for (const account of ["research", "excluded"]) {
				const pending = join(root, "inbox", account, "pending");
				mkdirSync(pending, { recursive: true });
				writeFileSync(
					join(pending, "one.json"),
					JSON.stringify({
						verified: true,
						source: "fathom-api",
						account,
						payload: { recording_id: account, title: account, created_at: "2026-09-19T09:00:00Z" },
					}),
				);
			}
			const result = importRecentFathomNotes({
				inboxRoot: join(root, "inbox"),
				sourceRoot: join(root, "source"),
				accounts: ["research"],
				project: "example-research",
				now: new Date("2026-09-19T12:00:00Z"),
			});
			expect(result.imported).toBe(1);
			expect(result.paths[0]).toContain("research");
			expect(readFileSync(result.paths[0], "utf8")).toContain("- Project: example-research\n");
			expect(readFileSync(result.paths[0], "utf8")).not.toContain("- Project: flow");
			expect(readFileSync(join(root, "inbox", "excluded", "pending", "one.json"), "utf8")).toContain("excluded");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
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
		expect(readFileSync(first.paths[0], "utf8")).not.toContain("- Project:");
		expect(first.paths[0]).toBe(join(sourceRoot, "2026", "Sep", "19-weekly-team-meeting-42.md"));
		const second = importRecentFathomNotes({
			inboxRoot: join(root, "inbox"),
			sourceRoot,
			now: new Date("2026-09-19T12:00:00Z"),
		});
		expect(second.existing).toBe(1);
	});
	it("routes a note to its project folder with Project, alias tags and Action Items", () => {
		const fixture = routedFixture();
		try {
			fixture.envelope("acme", {
				recording_id: 501,
				meeting_title: "Acme product review",
				recording_start_time: "2026-11-27T09:00:00Z",
				created_at: "2026-11-27T09:40:00Z",
				share_url: "https://fathom.video/share/example-acme",
				default_summary: { markdown_formatted: "## Key Takeaways\n\n- Ship the pilot." },
				action_items: [
					{ description: "Send the pilot plan", completed: false, assignee: { name: "Ada Obi" } },
					{ description: "Book the venue\nfor Friday", completed: true, assignee: { name: null } },
				],
			});
			fixture.envelope("coach", {
				recording_id: 502,
				meeting_title: "Coach agent sync",
				recording_start_time: "2026-11-27T08:00:00Z",
				created_at: "2026-11-27T08:30:00Z",
			});
			fixture.envelope("other", {
				recording_id: 503,
				meeting_title: "Impromptu call",
				recording_start_time: "2026-11-27T07:00:00Z",
				created_at: "2026-11-27T07:30:00Z",
			});
			const result = importRecentFathomNotes(fixture.options);
			expect(result.imported).toBe(3);
			const acme = join(
				fixture.privateRoot,
				"acme-health",
				"meetings",
				"2026",
				"Nov",
				"27-acme-product-review-501.md",
			);
			const coach = join(fixture.privateRoot, "flow", "meetings", "2026", "Nov", "27-coach-agent-sync-502.md");
			const other = join(fixture.privateRoot, "flow", "meetings", "2026", "Nov", "27-impromptu-call-503.md");
			expect([...result.paths].sort()).toEqual([acme, coach, other].sort());
			const acmeNote = readFileSync(acme, "utf8");
			expect(acmeNote).toContain("- Project: acme-health\n");
			expect(acmeNote).toContain(
				"## Action Items\n\n- [ ] Send the pilot plan (owner: Ada Obi)\n- [x] Book the venue for Friday\n\n<!-- Imported",
			);
			expect(readFileSync(coach, "utf8")).toContain("- Project: flow\n");
			expect(readFileSync(coach, "utf8")).toContain("- Tags: fathom, garden\n");
			expect(readFileSync(coach, "utf8")).not.toContain("## Action Items");
			const note = result.notes.find((entry) => entry.path === acme);
			expect(note).toMatchObject({
				project: "acme-health",
				shareUrl: "https://fathom.video/share/example-acme",
				fingerprint: "fathom:501:2026-11-27T09:40:00Z",
			});
			const lines = acmeNote.split("\n");
			for (const item of note?.actionItems ?? []) expect(lines[item.line - 1]).toContain(item.text);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
	it("never imports a recording again when a Flow note or stub already holds it", () => {
		const fixture = routedFixture();
		try {
			fixture.envelope("acme", {
				recording_id: 601,
				meeting_title: "Acme kickoff",
				recording_start_time: "2026-11-27T09:00:00Z",
				created_at: "2026-11-27T09:40:00Z",
			});
			const flowCopy = join(fixture.privateRoot, "flow", "meetings", "2026", "Nov", "27-acme-kickoff-601.md");
			mkdirSync(join(flowCopy, ".."), { recursive: true });
			writeFileSync(flowCopy, "Moved to [x](x.md) on 2026-11-28.\n");
			expect(importRecentFathomNotes(fixture.options)).toMatchObject({ imported: 0, existing: 1, notes: [] });
			const routed = join(fixture.privateRoot, "acme-health", "meetings", "2026", "Nov", "27-acme-kickoff-601.md");
			rmSync(flowCopy);
			mkdirSync(join(routed, ".."), { recursive: true });
			writeFileSync(routed, "owner edits");
			expect(importRecentFathomNotes(fixture.options)).toMatchObject({ imported: 0, existing: 1 });
			expect(readFileSync(routed, "utf8")).toBe("owner edits");
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});
