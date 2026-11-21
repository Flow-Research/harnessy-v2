import { describe, expect, it } from "vitest";
import { workstreamTaskContentDigest } from "../src/work/task-content.ts";
import { workTaskSnapshot } from "./fixtures/work-task-snapshot.ts";

const id = "11111111-2222-4333-8444-555555555555";
const task = () => workTaskSnapshot(id);
const digest = (value: unknown) => workstreamTaskContentDigest(JSON.stringify(value), id);

describe("approved WorkStream task content", () => {
	it("has canonical identity independent of JSON key order", () => {
		expect(digest(task())).toMatch(/^[a-f0-9]{64}$/);
		expect(digest(Object.fromEntries(Object.entries(task()).reverse()))).toBe(digest(task()));
	});
	it("ignores normal workflow changes and policy locks owned by WorkStream", () => {
		expect(
			digest({
				...task(),
				status: "in_progress",
				assigned_to: "actor",
				updated_at: "2026-11-21T11:00:00Z",
				locked_review_policy_hash: "policy-locked-by-owner",
				locked_review_policy_generation: 1,
			}),
		).toBe(digest(task()));
	});
	it.each([
		{ title: "Different work" },
		{ description: "Different instructions" },
		{ acceptance_criteria: "Different required output" },
		{ rejection_criteria: "Different rejection" },
		{ deadline_at: "2026-11-22T10:00:00Z" },
		{ project_id: "77777777-8888-4777-8666-555555555555" },
		{ source_payload_hash: `sha256:${"a".repeat(64)}` },
		{ source_ref: "another-import" },
		{ source_type: "json_import" },
		{ external_task_id: "another-task" },
		{ difficulty: "large" },
		{ skill_tags: ["python"] },
		{ estimated_time_minutes: 60 },
	])("invalidates changed scope or source provenance %j", (change) => {
		expect(digest({ ...task(), ...change })).not.toBe(digest(task()));
	});
	it("refuses foreign task identity, reduced projections, duplicate keys, and unknown fields", () => {
		expect(() => digest({ ...task(), id: "77777777-8888-4777-8666-555555555555" })).toThrow("different task");
		expect(() => digest({ id, title: "Incomplete", description: "Incomplete" })).toThrow();
		expect(() => digest({ ...task(), workerApproved: true })).toThrow();
		const duplicate = JSON.stringify(task()).replace('"title":', '"title":"forged","title":');
		expect(() => workstreamTaskContentDigest(duplicate, id)).toThrow();
		expect(() => workstreamTaskContentDigest(" ".repeat(1024 * 1024 + 1), id)).toThrow("input limit");
	});
});
