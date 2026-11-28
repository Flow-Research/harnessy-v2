import { describe, expect, it } from "vitest";

import {
	extractMeetingItems,
	MEETING_ITEM_CONFIDENCE,
	meetingSourceHash,
	sameCommitment,
	TRANSCRIPT_ITEMS_MAX,
	wordOverlapSimilarity,
} from "../src/jarvis/fathom/followup-extract.ts";
import { extractBriefTasks } from "../src/read-model/followups.ts";
import { dueFromText, isoDue, ownerByVerb, ownerLead, personOwner } from "../src/read-model/owner-due.ts";

const SHARE = "https://fathom.video/share/abc";

const summary = (steps: string) => ({
	markdown_formatted: `## Meeting Purpose\n\nPlan the pilot.\n\n## Key Takeaways\n\n- It went well.\n\n## Next Steps\n\n${steps}\n`,
});

describe("owner and due parsing", () => {
	it("reads the brief forms, including plural own", () => {
		expect(ownerLead("Ada Obi — confirm the venue")).toEqual({ owner: "Ada Obi", title: "confirm the venue" });
		expect(ownerByVerb("Sam owes the signed terms")).toBe("Sam");
		expect(ownerByVerb("Sam owns the rollout")).toBe("Sam");
		expect(ownerByVerb("Ada and Sam own the rollout")).toBe("Ada and Sam");
		expect(ownerByVerb("Their own plan is late")).toBeNull();
		expect(ownerByVerb("We own this together")).toBeNull();
		expect(ownerByVerb("the team owns it")).toBeNull();
	});

	it("gives the brief parser the plural form", () => {
		const tasks = extractBriefTasks("## Delegated or Waiting\n\n- Ada and Sam own the venue booking.\n");
		expect(tasks).toMatchObject([{ owner: "Ada and Sam", status: "waiting", followup: true }]);
	});

	it("treats group names as no owner", () => {
		expect(personOwner("All")).toBeNull();
		expect(personOwner("All Contributors")).toBeNull();
		expect(personOwner(" Ada ")).toBe("Ada");
	});

	it("resolves due dates from the meeting date (Thursday 2026-11-26)", () => {
		const anchor = "2026-11-26";
		expect(isoDue("by 2026-12-02")).toBe("2026-12-02");
		expect(isoDue("by 2026-02-31")).toBeNull();
		expect(dueFromText("send it tomorrow", anchor)).toBe("2026-11-27");
		expect(dueFromText("by Friday", anchor)).toBe("2026-11-27");
		expect(dueFromText("next Monday", anchor)).toBe("2026-11-30");
		expect(dueFromText("by Thursday", anchor)).toBe("2026-12-03");
		expect(dueFromText("by end of week", anchor)).toBe("2026-11-27");
		expect(dueFromText("before next week", anchor)).toBe("2026-11-30");
		expect(dueFromText("by 5 December", anchor)).toBe("2026-12-05");
		expect(dueFromText("on Jan 3rd", anchor)).toBe("2027-01-03");
		expect(dueFromText("soon", anchor)).toBeNull();
		expect(dueFromText("by Friday", null)).toBeNull();
	});
});

describe("extractMeetingItems", () => {
	it("keeps action items first with confidence 1 and their original key", () => {
		const items = extractMeetingItems(
			{
				action_items: [
					{
						description: "Draft the pilot terms by Friday",
						assignee: { name: "Ada" },
						completed: false,
						recording_timestamp: "00:12:05",
						recording_playback_url: `${SHARE}?timestamp=725`,
					},
				],
			},
			{ meetingDate: "2026-11-26" },
		);
		expect(items).toEqual([
			{
				text: "Draft the pilot terms by Friday",
				owner: "Ada",
				due: "2026-11-27",
				completed: false,
				source: "action_items",
				confidence: 1,
				quote: "Draft the pilot terms by Friday",
				timestamp: "00:12:05",
				link: `${SHARE}?timestamp=725`,
				key: "Draft the pilot terms by Friday",
			},
		]);
	});

	it("reads flat and nested Next Steps bullets with owners and timestamps", () => {
		const items = extractMeetingItems(
			{
				default_summary: summary(
					[
						`  - [**Ada Obi:** Share the company documents with Sam.](${SHARE}?tab=summary&timestamp=2287.0)`,
						`  - [**All:** Schedule a follow-up interview.](${SHARE}?tab=summary&timestamp=2300.0)`,
						`  - [**Rise:**](${SHARE}?tab=summary&timestamp=1119.0)`,
						`      - [Secure staging access to unblock threat modelling.](${SHARE}?tab=summary&timestamp=1119.0)`,
						`      - [Coordinate with Natachi on the QA sweep.](${SHARE}?tab=summary&timestamp=1140.0)`,
						"  - Sam Eze — send the signed terms by 5 December",
					].join("\n"),
				),
			},
			{ meetingDate: "2026-11-26" },
		);
		expect(items.map((item) => [item.owner, item.text, item.timestamp, item.due])).toEqual([
			["Ada Obi", "Share the company documents with Sam", "00:38:07", null],
			[null, "Schedule a follow-up interview", "00:38:20", null],
			["Rise", "Secure staging access to unblock threat modelling", "00:18:39", null],
			["Rise", "Coordinate with Natachi on the QA sweep", "00:19:00", null],
			["Sam Eze", "send the signed terms by 5 December", null, "2026-12-05"],
		]);
		expect(
			items.every((item) => item.source === "summary" && item.confidence === MEETING_ITEM_CONFIDENCE.summary),
		).toBe(true);
		expect(items[0]!.key).toBe("summary\0Share the company documents with Sam");
		expect(items[0]!.quote).toBe("Ada Obi: Share the company documents with Sam.");
	});

	it("drops a summary line that restates an action item, also a completed one", () => {
		const items = extractMeetingItems(
			{
				action_items: [
					{
						description: "Share the company documents with Sam Eze",
						assignee: { name: "Ada Obi" },
						completed: false,
					},
					{ description: "Book the venue for the launch", assignee: { name: "Sam Eze" }, completed: true },
				],
				default_summary: summary(
					[
						"  - [**Ada:** Share company documents with Sam.](https://fathom.video/share/x)",
						"  - [**Sam:** Book the launch venue.](https://fathom.video/share/x)",
						"  - [**Sam:** Prepare the press list.](https://fathom.video/share/x)",
					].join("\n"),
				),
			},
			{ meetingDate: "2026-11-26" },
		);
		expect(items.map((item) => [item.source, item.text, item.completed])).toEqual([
			["action_items", "Share the company documents with Sam Eze", false],
			["action_items", "Book the venue for the launch", true],
			["summary", "Prepare the press list", false],
		]);
	});

	it("keeps similar items with different owners apart", () => {
		expect(
			sameCommitment(
				{ text: "Send the GitHub links", owner: "Samuel" },
				{ text: "Send the GitHub links", owner: null },
			),
		).toBe(true);
		expect(
			sameCommitment(
				{ text: "Send the GitHub setup links", owner: "Samuel" },
				{ text: "Send GitHub setup links", owner: "Patrick" },
			),
		).toBe(false);
		expect(wordOverlapSimilarity("Book the venue", "")).toBe(0);
	});

	it("reads spoken commitments with the speaker as owner, and in fallback mode only when nothing else gave items", () => {
		const transcript = [
			{
				speaker: { display_name: "Ada Obi" },
				text: "Thanks all. I'll send the revised deck to Sam by Friday.",
				timestamp: "00:05:10",
			},
			{
				speaker: { display_name: "Sam Eze" },
				text: "Let me share my screen. Can you send it today?",
				timestamp: "00:05:20",
			},
			{
				speaker: { display_name: "Sam Eze" },
				text: "Okay. Tunde owns the vendor contract now.",
				timestamp: "00:06:00",
			},
			{
				speaker: { display_name: "Ada Obi" },
				text: "I'll send the revised deck to Sam by Friday.",
				timestamp: "00:09:00",
			},
		];
		const only = extractMeetingItems({ transcript }, { meetingDate: "2026-11-26" });
		expect(only.map((item) => [item.owner, item.text, item.timestamp, item.due, item.confidence])).toEqual([
			["Ada Obi", "Send the revised deck to Sam by Friday", "00:05:10", "2026-11-27", 0.5],
			["Tunde", "Tunde owns the vendor contract now", "00:06:00", null, 0.5],
		]);
		expect(only[0]!.quote).toBe("Ada Obi: I'll send the revised deck to Sam by Friday.");
		const withSummary = extractMeetingItems(
			{ transcript, default_summary: summary("  - **Ada:** Send the revised deck.") },
			{ meetingDate: "2026-11-26", transcript: "fallback" },
		);
		expect(withSummary.map((item) => item.source)).toEqual(["summary"]);
		expect(extractMeetingItems({ transcript }, { meetingDate: "2026-11-26", transcript: "off" })).toEqual([]);
	});

	it("caps transcript items", () => {
		const transcript = Array.from({ length: 20 }, (_, index) => ({
			speaker: { display_name: "Ada" },
			text: `I will prepare report number ${index} for the board.`,
			timestamp: `00:00:${String(index).padStart(2, "0")}`,
		}));
		expect(extractMeetingItems({ transcript }, { meetingDate: "2026-11-26", similarity: () => 0 })).toHaveLength(
			TRANSCRIPT_ITEMS_MAX,
		);
	});

	it("finds no owner in a possessive inside an imperative (finding 10)", () => {
		expect(ownerByVerb("Use your own account for the demo")).toBeNull();
		expect(ownerByVerb("Bring their own laptops")).toBeNull();
		expect(ownerByVerb("Ada and Sam own the rollout")).toBe("Ada and Sam");
	});

	it("uses an explicit year and refuses invalid dates in both month orders (finding 11)", () => {
		expect(dueFromText("Send by 5 December 2027", "2026-11-28")).toBe("2027-12-05");
		expect(dueFromText("Send by December 5, 2027", "2026-11-28")).toBe("2027-12-05");
		expect(dueFromText("Send by 5 December", "2026-11-28")).toBe("2026-12-05");
		expect(dueFromText("Send by 5 November", "2026-11-28")).toBe("2027-11-05");
		expect(dueFromText("Send by 31 February 2027", "2026-11-28")).toBeNull();
		expect(dueFromText("Send by February 30", "2026-11-28")).toBeNull();
	});

	it("keeps negation, numbers and recipients apart, and needs compatible owners for exact titles (finding 7)", () => {
		expect(wordOverlapSimilarity("Approve the pilot release", "Do not approve the pilot release")).toBe(0);
		expect(wordOverlapSimilarity("Send report 3 to the board", "Send report 4 to the board")).toBe(0);
		expect(wordOverlapSimilarity("Send the deck to Sam", "Send the deck to Ada")).toBe(0);
		expect(wordOverlapSimilarity("Book the launch venue", "Book the venue for the launch")).toBeGreaterThanOrEqual(
			0.6,
		);
		const same = (a: string, ownerA: string | null, b: string, ownerB: string | null) =>
			sameCommitment({ text: a, owner: ownerA }, { text: b, owner: ownerB }, wordOverlapSimilarity, 0.6);
		expect(same("Send the signed form", "Ada", "Send the signed form", "Sam")).toBe(false);
		expect(same("Send the signed form", "Ada", "Send the signed form", "Ada")).toBe(true);
	});

	it("keeps a spoken commitment beside a completed action item (finding 9)", () => {
		const items = extractMeetingItems(
			{
				action_items: [{ description: "Confirm the caterer", assignee: { name: "Sam" }, completed: true }],
				transcript: [
					{ speaker: { display_name: "Ada" }, text: "I will send the budget tomorrow.", timestamp: "00:01:00" },
				],
			},
			{ meetingDate: "2026-11-26" },
		);
		expect(items.map((item) => [item.source, item.completed, item.text, item.due])).toEqual([
			["action_items", true, "Confirm the caterer", null],
			["transcript", false, "Send the budget tomorrow", "2026-11-27"],
		]);
	});

	it("skips conditional, possible and reported speech but keeps a direct promise (finding 12)", () => {
		const said = (text: string) => ({ speaker: { display_name: "Ada" }, text, timestamp: "00:02:00" });
		const items = extractMeetingItems(
			{
				transcript: [
					said("If I can send the file, Sam can review it."),
					said("Maybe I'll send the notes later."),
					said("He said I'll send the slides."),
					said("I will send the file if Sam agrees."),
					said("I'll send the file to Sam today."),
				],
			},
			{ meetingDate: "2026-11-26" },
		);
		expect(items.map((item) => [item.owner, item.text])).toEqual([["Ada", "Send the file to Sam today"]]);
	});

	it("hashes only the follow-up sources", () => {
		const base = { action_items: [], default_summary: summary("- x"), transcript: [], title: "A" };
		expect(meetingSourceHash(base)).toBe(meetingSourceHash({ ...base, title: "B" }));
		expect(meetingSourceHash(base)).not.toBe(
			meetingSourceHash({ ...base, action_items: [{ description: "New", completed: false }] }),
		);
	});
});
