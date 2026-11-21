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
				updated_at: "2026-11-21T11:00:00Z",
				compensation: "unpaid",
				last_assignment_outcome: { outcome: "released" },
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
		{ task_type: "docs" },
		{ created_at: "2026-11-20T10:00:00Z" },
		{ difficulty: "large" },
		{ skill_tags: ["python"] },
		{ estimated_time_minutes: 60 },
	])("invalidates changed scope or source provenance %j", (change) => {
		expect(digest({ ...task(), ...change })).not.toBe(digest(task()));
	});
	it("accepts the real contributor view, where the command omits null fields", () => {
		const { deadline_at: _deadline, ...withoutDeadline } = task();
		expect(digest(withoutDeadline)).toBe(digest(task()));
		const { rejection_criteria: _rejection, ...withoutRejection } = { ...task(), rejection_criteria: null };
		expect(digest(withoutRejection)).toBe(digest({ ...task(), rejection_criteria: null }));
		// The manager view has other fields (`id`, `locked_*`). The runner never reads it, and it is refused.
		const { task_id: _taskId, ...rest } = task();
		expect(() => digest({ ...rest, id, locked_guide_version: null })).toThrow();
	});
	it("refuses foreign task identity, reduced projections, duplicate keys, and unknown fields", () => {
		expect(() => digest({ ...task(), task_id: "77777777-8888-4777-8666-555555555555" })).toThrow("different task");
		expect(() => digest({ task_id: id, title: "Incomplete", description: "Incomplete" })).toThrow();
		expect(() => digest({ ...task(), workerApproved: true })).toThrow();
		const duplicate = JSON.stringify(task()).replace('"title":', '"title":"forged","title":');
		expect(() => workstreamTaskContentDigest(duplicate, id)).toThrow();
		expect(() => workstreamTaskContentDigest(" ".repeat(1024 * 1024 + 1), id)).toThrow("input limit");
	});
});
