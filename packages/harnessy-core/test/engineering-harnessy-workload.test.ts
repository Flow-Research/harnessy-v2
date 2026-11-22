import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { type EvaluationBinding, EvaluationSession } from "../src/engineering/evaluation.ts";
import {
	type FrozenEvaluatorHost,
	freezeEvaluationArtifact,
	frozenEvaluationIdentityObserver,
	frozenEvaluatorExecutor,
	inspectEvaluationSource,
} from "../src/engineering/evaluator-host.ts";
import { macosOperationIsolation } from "../src/engineering/evaluator-macos.ts";
import { prepareEvaluatorSupervisor } from "../src/engineering/evaluator-supervisor.ts";
import {
	createHarnessyWorkload,
	HARNESSY_OPERATION_DRIVER,
	HARNESSY_OPERATION_ITERATIONS,
	HARNESSY_OPERATION_MAXIMUM_ITERATIONS,
	harnessyWorkloadPlan,
} from "../src/engineering/harnessy-workload.ts";
import { execRun } from "../src/work/run.ts";

const roots: string[] = [];
const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The expected results of one iteration, written here without the workload module. */
function expectedCheckOperations(seed: string): ReadonlyArray<unknown> {
	const task = "11111111-2222-4333-8444-555555555555";
	const state = {
		schema: "harnessy.work.state.v2",
		taskId: task,
		startedAt: 1,
		binding: {
			repo: "/fixture/repo",
			worktree: "/fixture/work",
			branch: "work/fixed",
			base: "main",
			workstreamCli: ["workstream"],
			actor: `actor-${seed}`,
		},
		gitFile: "gitdir: /fixture/git/worktrees/fixed\n",
		keys: { claim: "claim", start: "start", prepare: "prepare" },
		summary: `Task ${seed}`,
	};
	const results: ReadonlyArray<readonly [string, unknown]> = [
		[
			"task.authorized-read",
			{
				value: {
					id: task,
					title: `Task ${seed}`,
					description: "Synthetic useful work",
					acceptanceCriteria: "Preserve exact output",
				},
			},
		],
		["task.untrusted-text", { value: { id: task, title: "$(do-not-execute)", description: seed } }],
		["task.missing-fields", { error: true }],
		["preparation.ready", { value: { status: "ready", admissionId: `admission-${seed}` } }],
		["preparation.pending", { value: { status: "preparing" } }],
		["preparation.missing-status", { error: true }],
		["preparation.conflict-terminal", { value: true }],
		["preparation.duplicate-key", { error: true }],
		["status.pending", { undefined: true }],
		["status.accepted", { value: "accepted" }],
		["status.revision", { value: "needs_revision" }],
		["status.rejected", { value: "rejected" }],
		["status.saved-run", { value: state }],
		["status.foreign-task", { undefined: true }],
		["actor.identity", { value: `actor-${seed}` }],
		["assignment.identity", { value: `assignment-${seed}` }],
	];
	return results.map(([caseId, result]) => ({ iteration: 0, caseId, result }));
}

describe("protected Harnessy task/preparation/status workload", () => {
	it("keeps expected outputs out of the worker input and refuses invalid sizes", () => {
		const workload = createHarnessyWorkload("fixed", 2);
		expect(workload.cases).toHaveLength(16);
		expect(workload.completedWork).toBe(32);
		expect(workload.input).not.toContain('"expected"');
		for (const args of [
			["", 1],
			["x", 0],
			["x", HARNESSY_OPERATION_MAXIMUM_ITERATIONS + 1],
		] as const)
			expect(() => createHarnessyWorkload(args[0], args[1])).toThrow();
		expect(() =>
			workload.validateOutput(
				'{"passed":true,"measurements":{"cpu":0}}',
				{ argv: [], kind: "sample", side: "candidate" },
				{} as EvaluationBinding,
			),
		).toThrow("Protected");
		expect(() => harnessyWorkloadPlan({ workloadDigest: "wrong" } as EvaluationBinding, workload)).toThrow(
			"identities",
		);
	});

	it("makes a long sample by default and expects one digest that covers each iteration", () => {
		const sample = { argv: [], kind: "sample", side: "candidate" } as const;
		const workload = createHarnessyWorkload("fixed");
		expect(HARNESSY_OPERATION_ITERATIONS).toBeGreaterThanOrEqual(32_768);
		expect(workload.completedWork).toBe(16 * HARNESSY_OPERATION_ITERATIONS);
		const two = createHarnessyWorkload("fixed", 2);
		const three = createHarnessyWorkload("fixed", 3);
		const lines = (count: number): string =>
			Array.from(
				{ length: count },
				(_, iteration) =>
					`${JSON.stringify(
						(JSON.parse(checkOutput) as { operations: Array<Record<string, unknown>> }).operations.map(
							(operation) => ({ ...operation, iteration }),
						),
					)}\n`,
			).join("");
		const output = (iterations: number, operationsDigest: string): string =>
			`${JSON.stringify({
				schema: "harnessy.engineering.operation-digest.v1",
				iterations,
				operations: 16 * iterations,
				operationsDigest,
			})}\n`;
		// The check output of the controller is the expected result of iteration zero.
		const checkOutput = `${JSON.stringify({
			schema: "harnessy.engineering.operation-output.v1",
			operations: expectedCheckOperations("fixed"),
		})}\n`;
		expect(digest(checkOutput)).toBe(two.checkDigest);
		const good = output(2, digest(lines(2)));
		expect(digest(good)).toBe(two.sampleDigest);
		expect(two.validateOutput(good, sample, {} as EvaluationBinding).completedWork).toBe(32);
		// A digest of fewer iterations, of other results, or the check output is not a valid sample.
		expect(() => two.validateOutput(output(2, digest(lines(1))), sample, {} as EvaluationBinding)).toThrow(
			"Protected",
		);
		expect(() =>
			two.validateOutput(
				output(2, digest(lines(2).replace("accepted", "rejected"))),
				sample,
				{} as EvaluationBinding,
			),
		).toThrow("Protected");
		expect(() => two.validateOutput(checkOutput, sample, {} as EvaluationBinding)).toThrow("Protected");
		expect(() => three.validateOutput(good, sample, {} as EvaluationBinding)).toThrow("Protected");
	});

	it("runs the fixed driver on the maintained functions and refuses one wrong result in a late iteration", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "harnessy-operation-driver-")));
		roots.push(root);
		const iterations = 300;
		const workload = createHarnessyWorkload("driver-seed", iterations);
		await writeFile(join(root, "driver.cjs"), HARNESSY_OPERATION_DRIVER);
		await writeFile(join(root, "workload.json"), workload.input);
		const drive = async (sourceRoot: string, kind: "check" | "sample") => {
			const result = await execRun(
				[
					process.execPath,
					"--experimental-strip-types",
					join(root, "driver.cjs"),
					sourceRoot,
					join(root, "workload.json"),
					kind,
				],
				{ timeoutMs: 20_000 },
			);
			expect(result.exitCode).toBe(0);
			return result.stdout;
		};
		const sample = { argv: [], kind: "sample", side: "candidate" } as const;
		const check = { argv: [], kind: "check", side: "candidate" } as const;
		const stdout = await drive(checkout, "sample");
		expect(Buffer.byteLength(stdout)).toBeLessThan(1024);
		const validated = workload.validateOutput(stdout, sample, {} as EvaluationBinding);
		expect(validated.completedWork).toBe(16 * iterations);
		expect(validated.outputDigest).toBe(workload.sampleDigest);
		expect(workload.validateOutput(await drive(checkout, "check"), check, {} as EvaluationBinding).outputDigest).toBe(
			workload.checkDigest,
		);
		// This source gives one wrong result, in iteration 250 only. The check passes; the sample does not.
		const forged = join(root, "forged");
		await mkdir(join(forged, "packages/harnessy-core/src/work"), { recursive: true });
		await writeFile(
			join(forged, "packages/harnessy-core/src/work/logic.ts"),
			`const real = require(${JSON.stringify(join(checkout, "packages/harnessy-core/src/work/logic.ts"))});
let calls = 0;
module.exports = { ...real, parseActor: (...args) => (++calls === 250 ? "forged" : real.parseActor(...args)) };
`,
		);
		expect(workload.validateOutput(await drive(forged, "check"), check, {} as EvaluationBinding).outputDigest).toBe(
			workload.checkDigest,
		);
		expect(() =>
			workload.validateOutput(stdout.replace(/[a-f0-9]{64}/, "0".repeat(64)), sample, {} as EvaluationBinding),
		).toThrow("Protected");
		const forgedSample = await drive(forged, "sample");
		expect(forgedSample).not.toBe(stdout);
		expect(() => workload.validateOutput(forgedSample, sample, {} as EvaluationBinding)).toThrow("Protected");
	}, 60_000);

	it.skipIf(process.platform !== "darwin")(
		"runs the existing pure functions inside the real sandbox and validates outputs in the controller",
		async () => {
			const root = await realpath(await mkdtemp(join(tmpdir(), "harnessy-operation-workload-")));
			roots.push(root);
			const repo = join(root, "candidate");
			await mkdir(join(repo, "packages/harnessy-core/src/work"), { recursive: true });
			await copyFile(
				join(checkout, "packages/harnessy-core/src/work/logic.ts"),
				join(repo, "packages/harnessy-core/src/work/logic.ts"),
			);
			await writeFile(join(repo, ".gitignore"), "node_modules\n");
			const dependencies = await realpath(join(checkout, "node_modules"));
			await symlink(dependencies, join(repo, "node_modules"));
			for (const args of [
				["init", "-q"],
				["config", "user.email", "fixture@example.invalid"],
				["config", "user.name", "Fixture"],
				["add", "packages/harnessy-core/src/work/logic.ts", ".gitignore"],
				["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Workload fixture"],
			])
				expect((await execRun(["/usr/bin/git", "-C", repo, ...args], { timeoutMs: 2000 })).exitCode).toBe(0);
			const workload = createHarnessyWorkload("frozen-seed", 2);
			const driverSource = join(root, "driver.cjs");
			const workloadSource = join(root, "workload.json");
			await writeFile(driverSource, HARNESSY_OPERATION_DRIVER);
			await writeFile(workloadSource, workload.input);
			const artifacts = join(root, "artifacts");
			const evaluator = await freezeEvaluationArtifact(driverSource, artifacts, [repo], workload.driverDigest);
			const data = await freezeEvaluationArtifact(workloadSource, artifacts, [repo], workload.inputDigest);
			const source = await inspectEvaluationSource(execRun, repo);
			const executable = await realpath(process.execPath);
			const effectRoot = await realpath(join(dependencies, "effect"));
			const environmentDigest = async () => {
				const hash = createHash("sha256").update(await readFile(executable));
				const entries = await readdir(effectRoot, { recursive: true, withFileTypes: true });
				if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("Dependency snapshot contains a link");
				const files = entries
					.filter((entry) => entry.isFile())
					.map((entry) => join(entry.parentPath, entry.name))
					.sort();
				for (let offset = 0; offset < files.length; offset += 16) {
					const batch = files.slice(offset, offset + 16);
					const bytes = await Promise.all(batch.map((file) => readFile(file)));
					for (let index = 0; index < batch.length; index++)
						hash.update(JSON.stringify([relative(effectRoot, batch[index]), digest(bytes[index])])).update("\0");
				}
				return hash.digest("hex");
			};
			const binding: EvaluationBinding = {
				runId: "run",
				grantId: "grant",
				sourceRevision: source.sourceRevision,
				sourceTreeDigest: source.sourceTreeDigest,
				evaluatorDigest: evaluator.digest,
				workloadDigest: data.digest,
				environmentDigest: await environmentDigest(),
			};
			const host: FrozenEvaluatorHost = {
				sources: { baseline: repo, candidate: repo },
				evaluator,
				workload: data,
				bindings: { baseline: binding, candidate: binding },
				run: execRun,
				environmentDigest,
			};
			const scratchRoot = join(root, "scratch");
			const privateState = join(root, "private-state");
			await mkdir(scratchRoot, { mode: 0o700 });
			await mkdir(privateState, { mode: 0o700 });
			const supervisor = await prepareEvaluatorSupervisor({ controllerRoot: join(root, "supervisor-custody") });
			const adapter = macosOperationIsolation({
				executable,
				scratchRoot,
				additionalReadRoots: [effectRoot],
				deniedRoots: [privateState],
				timeoutMs: 5000,
				supervisor,
			});
			const execute = frozenEvaluatorExecutor(host, adapter, workload.validateOutput);
			const result = await execute(
				{ argv: ["harnessy-pinned-operations", "sample"], kind: "sample", pairIndex: 0, side: "candidate" },
				binding,
			);
			expect(result.completedWork).toBe(32);
			expect(result.outputDigest).toBe(workload.sampleDigest);
			expect(result.measurements["tests.runtime"]).toBeGreaterThan(0);
			expect(result.measurements["memory.peak_resident"]).toBeGreaterThan(0);
			expect(result.measurements["cpu.time_per_operation"]).toBeGreaterThan(0);
			const session = new EvaluationSession();
			const plan = harnessyWorkloadPlan(binding, workload);
			const receipts = await session.collectPair(plan, plan, execute, frozenEvaluationIdentityObserver(host));
			expect(receipts.baseline.valid).toBe(true);
			expect(receipts.candidate.valid).toBe(true);
			const decision = await session.compare(receipts.baseline, receipts.candidate);
			expect(decision.verdict).toBe("inconclusive");
			if (process.env.HARNESSY_ENGINEERING_EVIDENCE_DIR !== undefined) {
				await writeFile(
					join(process.env.HARNESSY_ENGINEERING_EVIDENCE_DIR, "harnessy-operation-qualification.json"),
					`${JSON.stringify(
						{
							schema: "harnessy.engineering.workload-qualification.v1",
							collectedAt: new Date().toISOString(),
							scope: "Synthetic existing Harnessy pure functions, not full services or claimed improvement",
							nodeVersion: process.version,
							sourceModuleDigest: digest(
								await readFile(join(checkout, "packages/harnessy-core/src/work/logic.ts")),
							),
							binding,
							supervisor: {
								sourceDigest: supervisor.sourceDigest,
								binaryDigest: supervisor.binaryDigest,
								compilerDigest: supervisor.compilerDigest,
							},
							baseline: receipts.baseline,
							candidate: receipts.candidate,
							decision,
						},
						null,
						2,
					)}\n`,
					{ mode: 0o600 },
				);
			}
			await expect(
				adapter.execute({
					evaluator,
					workload: data,
					sourceRoot: repo,
					binding,
					invocation: { argv: ["sh", "hostile"], kind: "sample", side: "candidate" },
				}),
			).rejects.toThrow("pinned Harnessy");
		},
		60_000,
	);
});
