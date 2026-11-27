import { createHash } from "node:crypto";
import { z } from "zod";
import { parseJson } from "./logic.ts";

const optionalString = z.string().max(65_536).nullable().optional();

/**
 * The contributor view that `workstream task show -o json` prints
 * (`ContributorTaskDetail` in the WorkStream CLI). The runner reads the task
 * with a contributor identity, so this is the only view it can check. The
 * CLI omits a field whose value is null. `compensation` and
 * `last_assignment_outcome` belong to WorkStream's policy and assignment
 * state, so their content is not part of the task content.
 */
export const workstreamTaskSnapshotSchema = z.strictObject({
	task_id: z.string().uuid(),
	project_id: z.string().uuid(),
	title: z.string().min(1).max(65_536),
	description: z.string().max(524_288),
	task_type: optionalString,
	difficulty: optionalString,
	skill_tags: z.array(z.string().max(1000)).max(1000).nullable().optional(),
	estimated_time_minutes: z.number().int().positive().nullable().optional(),
	status: z.string().min(1).max(200),
	acceptance_criteria: optionalString,
	rejection_criteria: optionalString,
	deadline_at: z.string().datetime({ offset: true }).nullable().optional(),
	created_at: z.string().datetime({ offset: true }),
	updated_at: z.string().datetime({ offset: true }),
	compensation: z.unknown().optional(),
	last_assignment_outcome: z.unknown().optional(),
});

/** Content identity excludes status, update time, compensation policy and assignment state. */
export const workstreamTaskContentDigest = (json: string, expectedTaskId: string): string => {
	if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("WorkStream task snapshot exceeds the input limit");
	const task = workstreamTaskSnapshotSchema.parse(parseJson(json));
	if (task.task_id !== expectedTaskId) throw new Error("WorkStream returned a different task identity");
	// An omitted field and a null field are the same content.
	const content = {
		schema: "harnessy.work.task-content.v2",
		task_id: task.task_id,
		project_id: task.project_id,
		title: task.title,
		description: task.description,
		task_type: task.task_type ?? null,
		difficulty: task.difficulty ?? null,
		skill_tags: task.skill_tags ?? [],
		estimated_time_minutes: task.estimated_time_minutes ?? null,
		acceptance_criteria: task.acceptance_criteria ?? null,
		rejection_criteria: task.rejection_criteria ?? null,
		deadline_at: task.deadline_at ?? null,
		created_at: task.created_at,
	};
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
};
