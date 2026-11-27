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
	harnessyWorkloadPlan,
} from "../src/engineering/harnessy-workload.ts";
import { execRun } from "../src/work/run.ts";

const roots: string[] = [];
const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("protected Harnessy task/preparation/status workload", () => {
	it("keeps expected outputs out of the worker input and refuses invalid sizes", () => {
		const workload = createHarnessyWorkload("fixed", 2);
		expect(workload.cases).toHaveLength(16);
		expect(workload.completedWork).toBe(32);
		expect(workload.input).not.toContain('"expected"');
		for (const args of [
			["", 1],
			["x", 0],
			["x", 129],
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
