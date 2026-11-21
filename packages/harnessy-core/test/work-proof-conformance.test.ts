import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildProof } from "../src/work/logic.ts";

const fixture = new URL("./fixtures/workstream-harnessy-proof/", import.meta.url);
const head = "a".repeat(40);
const landed = "b".repeat(40);
const prUrl = "https://github.com/fixture/app/pull/7";
const runUrl = "https://github.com/fixture/app/actions/runs/9";
const proof = () =>
	buildProof({
		task_id: "11111111-2222-4333-8444-555555555555",
		repo: "fixture/app",
		commit_sha: landed,
		merge_commit_sha: landed,
		source_head_sha: head,
		pr_url: prUrl,
		ci_run_url: runUrl,
		ci_conclusion: "success",
		duration_seconds: 10,
		billing: "included-only",
		actual_charge_usd: "unavailable",
		reported_usage_value_usd: 0.1,
	});
const facts = () => ({
	schema_version: "workstream.forge_change_facts.v1",
	forge: "github",
	forge_origin: "https://github.com",
	repository: "fixture/app",
	change_number: 7,
	change_url: prUrl,
	state: "closed",
	merged: true,
	landed_commit_sha: landed,
	base_ref: "main",
	head_sha: head,
	head_commit_message: "Complete the approved task",
	author: { login: "agent-bot", id: 1, kind: "bot" },
	reviews: [
		{
			id: "review-1",
			reviewer: { login: "reviewer", id: 2, kind: "user" },
			reviewer_write_access: true,
			state: "approved",
			commit_id: head,
			submitted_at: "2026-11-21T10:00:00Z",
		},
	],
	changed_files_count: 1,
	changed_files: [{ path: "src/value.ts", previous_path: null, status: "modified" }],
	required_checks: [
		{
			name: "required-tests",
			conclusion: "success",
			required_producer: "github_app:1",
			judged: [{ producer: "github_app:1", sha: head }],
			run_url: runUrl,
		},
	],
	fetched_at: "2026-11-21T10:05:00Z",
	responses: [{ request: "pull_request", sha256: `sha256:${"c".repeat(64)}` }],
});
const evaluate = (candidate: ReturnType<typeof proof>, ownerFacts = facts()): Array<{ code: string }> => {
	const result = spawnSync(
		process.env.HARNESSY_TEST_PROOF_PYTHON ?? "python3",
		["-I", "-B", fileURLToPath(new URL("evaluate.py", fixture))],
		{
			input: JSON.stringify({
				proof: candidate,
				facts: ownerFacts,
				configuration: {
					workstream_forge_facts_version: "v1",
					forge: "github",
					forge_origin: "https://github.com",
					repository: "fixture/app",
					base_branch: "main",
				},
			}),
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 1024 * 1024,
		},
	);
	if (result.error !== undefined || result.status !== 0)
		throw new Error(`Pinned checker failed: ${result.error?.message ?? result.stderr}`);
	return JSON.parse(result.stdout);
};

describe("current WorkStream landed-proof compatibility", () => {
	it("uses the unchanged pinned checker source", () => {
		expect(
			createHash("sha256")
				.update(readFileSync(new URL("checker.py", fixture)))
				.digest("hex"),
		).toBe("29e6a031addae960545108fd81d41fa7053f8a10a22822693f2134b38f931c9e");
	});
	it("accepts landed commit proof while required checks and review remain bound to the source head", () => {
		expect(evaluate(proof())).toEqual([]);
	});
	it("rejects the old head-as-landed proof after squash or merge", () => {
		expect(evaluate({ ...proof(), commit_sha: head }).map((finding) => finding.code)).toContain(
			"harnessy.proof.forge.landed_commit_sha",
		);
	});
	it("rejects CI evidence from the landed commit instead of the reviewed source head", () => {
		const changed = facts();
		changed.required_checks[0]!.judged[0]!.sha = landed;
		expect(evaluate(proof(), changed).map((finding) => finding.code)).toContain("harnessy.proof.forge.facts_binding");
	});
	it("rejects a stale independent approval", () => {
		const changed = facts();
		changed.reviews[0]!.commit_id = landed;
		expect(evaluate(proof(), changed).map((finding) => finding.code)).toContain(
			"harnessy.proof.forge.independent_approval_missing",
		);
	});
});
