import { createHash } from "node:crypto";
import { z } from "zod";
import { parseJson } from "./logic.ts";

const nullableString = z.string().max(65_536).nullable();

/** Full TaskResponse at WorkStream a2154e8a. Reduced projections cannot qualify. */
export const workstreamTaskSnapshotSchema = z.strictObject({
	id: z.string().uuid(),
	project_id: z.string().uuid(),
	locked_contribution_policy_version_id: nullableString,
	locked_guide_version: nullableString,
	locked_review_policy_id: nullableString,
	locked_review_policy_generation: z.number().int().nullable(),
	locked_review_policy_hash: nullableString,
	locked_revision_policy_id: nullableString,
	locked_revision_policy_generation: z.number().int().nullable(),
	locked_revision_policy_hash: nullableString,
	locked_guide_source_snapshot_id: nullableString,
	locked_guide_source_snapshot_hash: nullableString,
	locked_effective_project_submission_artifact_policy_id: nullableString,
	locked_effective_project_submission_artifact_policy_hash: nullableString,
	locked_pre_submit_checker_policy_id: nullableString,
	locked_pre_submit_checker_bundle_hash: nullableString,
	source_type: z.string().min(1).max(200),
	source_ref: nullableString,
	source_payload_hash: nullableString,
	import_batch_id: nullableString,
	external_task_id: nullableString,
	title: z.string().max(65_536),
	description: z.string().max(524_288),
	task_type: nullableString,
	difficulty: nullableString,
	skill_tags: z.array(z.string().max(1000)).max(1000),
	estimated_time_minutes: z.number().int().positive().nullable(),
	status: z.string().min(1).max(200),
	acceptance_criteria: nullableString,
	rejection_criteria: nullableString,
	deadline_at: z.string().datetime({ offset: true }).nullable(),
	created_by: nullableString,
	assigned_to: nullableString,
	created_at: z.string().datetime({ offset: true }),
	updated_at: z.string().datetime({ offset: true }),
});

/** Content identity excludes normal assignment, status, and claim-time policy locking. */
export const workstreamTaskContentDigest = (json: string, expectedTaskId: string): string => {
	if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("WorkStream task snapshot exceeds the input limit");
	const task = workstreamTaskSnapshotSchema.parse(parseJson(json));
	if (task.id !== expectedTaskId) throw new Error("WorkStream returned a different task identity");
	const content = {
		schema: "harnessy.work.task-content.v1",
		id: task.id,
		project_id: task.project_id,
		source_type: task.source_type,
		source_ref: task.source_ref,
		source_payload_hash: task.source_payload_hash,
		import_batch_id: task.import_batch_id,
		external_task_id: task.external_task_id,
		title: task.title,
		description: task.description,
		task_type: task.task_type,
		difficulty: task.difficulty,
		skill_tags: task.skill_tags,
		estimated_time_minutes: task.estimated_time_minutes,
		acceptance_criteria: task.acceptance_criteria,
		rejection_criteria: task.rejection_criteria,
		deadline_at: task.deadline_at,
		created_by: task.created_by,
		created_at: task.created_at,
	};
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
};
