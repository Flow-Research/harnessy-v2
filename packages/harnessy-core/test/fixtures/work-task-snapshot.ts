/**
 * Synthetic contributor view of a task, in the shape that
 * `workstream task show -o json` printed on a real local stack on
 * 2026-11-21. It holds no credential and no private task data.
 */
export const workTaskSnapshot = (id: string) => ({
	task_id: id,
	project_id: "99999999-8888-4777-8666-555555555555",
	title: "Improve fixture",
	description: "Change one value.",
	task_type: "code" as string | null,
	difficulty: "small" as string | null,
	skill_tags: ["typescript"],
	estimated_time_minutes: 10,
	status: "ready",
	acceptance_criteria: "The approved output stays correct." as string | null,
	rejection_criteria: "Do not remove required behavior." as string | null,
	deadline_at: null as string | null,
	created_at: "2026-11-21T10:00:00Z",
	updated_at: "2026-11-21T10:00:00Z",
	compensation: {
		contribution_policy_version_id: "01a16713-4ed2-7d9e-ab56-39182a4969d6",
		accepted_submission: [{ instrument: "project_points", unit: "FLOW", quantity: "10" }],
		completed_review: [{ instrument: "project_points", unit: "FLOW", quantity: "1" }],
	} as unknown,
});
