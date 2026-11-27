import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EvaluationBinding, EvaluatorInvocation } from "../src/engineering/evaluation.ts";
import {
	type FrozenEvaluatorHost,
	freezeEvaluationArtifact,
	frozenEvaluationIdentityObserver,
	frozenEvaluatorExecutor,
	inspectEvaluationSource,
	validateFrozenEvaluationArtifact,
} from "../src/engineering/evaluator-host.ts";
import { execRun } from "../src/work/run.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const validateOutput = (stdout: string) => {
	if (stdout !== "correct") throw new Error("Semantic output differs from protected expected output");
	return { outputDigest: digest(stdout), completedCases: ["authorized"], completedWork: 100 };
};
const roots: string[] = [];

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "engineering-host-")));
	roots.push(root);
	const repo = join(root, "repo");
	await mkdir(repo);
	for (const args of [
		["init", "-q"],
		["config", "user.email", "fixture@example.invalid"],
		["config", "user.name", "Fixture"],
	]) {
		const result = await execRun(["/usr/bin/git", "-C", repo, ...args], { timeoutMs: 2000 });
		expect(result.exitCode).toBe(0);
	}
	await writeFile(join(repo, "source.js"), "export const usefulWork = 100;\n");
	await execRun(["/usr/bin/git", "-C", repo, "add", "source.js"], { timeoutMs: 2000 });
	await execRun(["/usr/bin/git", "-C", repo, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture"], {
		timeoutMs: 2000,
	});
	const evaluatorSource = join(root, "evaluator.mjs");
	await writeFile(evaluatorSource, "// Approved independent evaluator\n");
	const workloadSource = join(root, "workload.json");
	await writeFile(workloadSource, '{"fixedSyntheticItems":100}\n');
	const custody = join(root, "controller");
	const evaluator = await freezeEvaluationArtifact(
		evaluatorSource,
		custody,
		[repo],
		digest(await readFile(evaluatorSource, "utf8")),
	);
	const workload = await freezeEvaluationArtifact(
		workloadSource,
		custody,
		[repo],
		digest(await readFile(workloadSource, "utf8")),
	);
	const source = await inspectEvaluationSource(execRun, repo);
	const binding: EvaluationBinding = {
		runId: "run",
		grantId: "grant",
		...source,
		evaluatorDigest: evaluator.digest,
		workloadDigest: workload.digest,
		environmentDigest: digest("actual tools"),
	};
	const host: FrozenEvaluatorHost = {
		sources: { baseline: repo, candidate: repo },
		evaluator,
		workload,
		bindings: { baseline: binding, candidate: binding },
		run: execRun,
		environmentDigest: async () => digest("actual tools"),
	};
	const invocation: EvaluatorInvocation = {
		argv: ["pinned-evaluator"],
		kind: "sample",
		pairIndex: 0,
		side: "candidate",
	};
	return { root, repo, custody, evaluatorSource, evaluator, workload, source, binding, host, invocation };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("frozen evaluation artifacts", () => {
	it("copies approved bytes into private immutable custody outside the worker", async () => {
		const { evaluator, evaluatorSource, custody, repo } = await fixture();
		await validateFrozenEvaluationArtifact(evaluator, [repo]);
		expect(evaluator.path.startsWith(custody)).toBe(true);
		expect(await freezeEvaluationArtifact(evaluatorSource, custody, [repo], evaluator.digest)).toEqual(evaluator);
		await writeFile(evaluatorSource, "Changed original does not change the frozen copy");
		await validateFrozenEvaluationArtifact(evaluator, [repo]);
	});

	it("refuses wrong digests and custody inside a worker", async () => {
		const { evaluatorSource, repo, root } = await fixture();
		await expect(
			freezeEvaluationArtifact(evaluatorSource, join(root, "wrong"), [repo], digest("wrong")),
		).rejects.toThrow("changed");
		await expect(
			freezeEvaluationArtifact(evaluatorSource, join(root, "bad-digest"), [repo], "invalid"),
		).rejects.toThrow("digest");
		await expect(
			freezeEvaluationArtifact(evaluatorSource, join(repo, "custody"), [repo], digest("x")),
		).rejects.toThrow("inside");
	});

	it("refuses writable custody, writable artifacts, modified bytes, and links", async () => {
		const { root, evaluatorSource, evaluator, repo } = await fixture();
		const publicRoot = join(root, "public");
		await mkdir(publicRoot, { mode: 0o755 });
		await expect(freezeEvaluationArtifact(evaluatorSource, publicRoot, [repo], evaluator.digest)).rejects.toThrow(
			"private",
		);
		await chmod(evaluator.path, 0o600);
		await expect(validateFrozenEvaluationArtifact(evaluator, [repo])).rejects.toThrow("permissions");
		await writeFile(evaluator.path, "tampered");
		await chmod(evaluator.path, 0o400);
		await expect(validateFrozenEvaluationArtifact(evaluator, [repo])).rejects.toThrow("bytes changed");
		const link = join(root, "linked-evaluator");
		await symlink(evaluator.path, link);
		await expect(validateFrozenEvaluationArtifact({ path: link, digest: evaluator.digest }, [repo])).rejects.toThrow(
			"link",
		);
		await expect(
			freezeEvaluationArtifact(link, join(root, "linked-source"), [repo], evaluator.digest),
		).rejects.toThrow();
	});
});

describe("artifact resource and authority boundaries", () => {
	it("rejects hardlinks into private files and changed custody directory permissions", async () => {
		const { root, repo, evaluator, custody } = await fixture();
		const secret = join(root, "private-secret");
		await writeFile(secret, "private", { mode: 0o600 });
		await link(secret, join(repo, "innocent.js"));
		await expect(inspectEvaluationSource(execRun, repo)).rejects.toThrow("singly linked");
		await link(evaluator.path, join(root, "artifact-hardlink"));
		await expect(validateFrozenEvaluationArtifact(evaluator, [repo])).rejects.toThrow("permissions");
		await rm(join(root, "artifact-hardlink"));
		await chmod(custody, 0o755);
		await expect(validateFrozenEvaluationArtifact(evaluator, [repo])).rejects.toThrow("parent requires private");
	});
	it("refuses oversized artifacts and an existing file inside worker authority", async () => {
		const { root, repo, evaluatorSource, evaluator } = await fixture();
		const huge = join(root, "huge-evaluator");
		const file = await open(huge, "w");
		await file.truncate(8 * 1024 * 1024 + 1);
		await file.close();
		await expect(
			freezeEvaluationArtifact(huge, join(root, "huge-custody"), [repo], digest("not the file")),
		).rejects.toThrow("bounded");
		await expect(
			freezeEvaluationArtifact(root, join(root, "directory-source"), [repo], evaluator.digest),
		).rejects.toThrow("bounded");
		const exposed = join(repo, "exposed-evaluator");
		await writeFile(exposed, await readFile(evaluatorSource), { mode: 0o400 });
		await expect(
			validateFrozenEvaluationArtifact({ path: exposed, digest: evaluator.digest }, [repo]),
		).rejects.toThrow("worker writes");
	});
});

describe("actual source identity observation", () => {
	it.skipIf(process.platform === "win32")("aborts an actual Git probe and waits for its child to exit", async () => {
		const { root, repo } = await fixture();
		const pidFile = join(root, "git-probe.pid"),
			probe = join(root, "git-probe.cjs");
		await writeFile(
			probe,
			`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);\n`,
			{ mode: 0o700 },
		);
		const signal = new AbortController();
		let pid: number | undefined;
		const timer = setInterval(() => {
			void readFile(pidFile, "utf8")
				.then((value) => {
					const observed = Number(value);
					if (!Number.isSafeInteger(observed) || observed < 1) return;
					pid = observed;
					signal.abort();
				})
				.catch(() => undefined);
		}, 5);
		await expect(inspectEvaluationSource(execRun, repo, probe, { signal: signal.signal })).rejects.toThrow();
		clearInterval(timer);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid!, 0)).toThrow();
		await expect(inspectEvaluationSource(execRun, repo, "/usr/bin/git", { signal: signal.signal })).rejects.toThrow(
			/cancelled/,
		);
	});
	it("detects changed tracked bytes even when Git marks them assume-unchanged", async () => {
		const { repo, source } = await fixture();
		await execRun(["/usr/bin/git", "-C", repo, "update-index", "--assume-unchanged", "source.js"], {
			timeoutMs: 2000,
		});
		await writeFile(join(repo, "source.js"), "export const usefulWork = 1;\n");
		const changed = await inspectEvaluationSource(execRun, repo);
		expect(changed.sourceRevision).toBe(source.sourceRevision);
		expect(changed.sourceTreeDigest).not.toBe(source.sourceTreeDigest);
	});

	it("binds maintained source permission modes as well as bytes", async () => {
		const { repo, source } = await fixture();
		await chmod(join(repo, "source.js"), 0o700);
		expect((await inspectEvaluationSource(execRun, repo)).sourceTreeDigest).not.toBe(source.sourceTreeDigest);
	});

	it("includes untracked maintained files and rejects deleted or escaped source", async () => {
		const { repo, root, source } = await fixture();
		await writeFile(join(repo, "extra.js"), "new maintained source");
		expect((await inspectEvaluationSource(execRun, repo)).sourceTreeDigest).not.toBe(source.sourceTreeDigest);
		await symlink(join(root, "evaluator.mjs"), join(repo, "escape.js"));
		await expect(inspectEvaluationSource(execRun, repo)).rejects.toThrow("symlink");
		await rm(join(repo, "escape.js"));
		await rm(join(repo, "source.js"));
		await expect(inspectEvaluationSource(execRun, repo)).rejects.toThrow();
	});

	it("requires an exact repository root and a host-controlled Git executable", async () => {
		const { repo } = await fixture();
		const child = join(repo, "child");
		await mkdir(child);
		await expect(inspectEvaluationSource(execRun, child)).rejects.toThrow("exact registered Git root");
		await expect(inspectEvaluationSource(execRun, repo, "git")).rejects.toThrow("absolute");
		await expect(
			inspectEvaluationSource(async () => ({ exitCode: 1, stdout: "", stderr: "no" }), repo),
		).rejects.toThrow("observe");
	});

	it("enforces declared source file and byte limits without reading an unbounded tree", async () => {
		const { repo } = await fixture();
		await writeFile(join(repo, "extra.js"), "Extra maintained source bytes");
		await expect(inspectEvaluationSource(execRun, repo, "/usr/bin/git", { maximumFiles: 1 })).rejects.toThrow(
			"file limit",
		);
		await expect(inspectEvaluationSource(execRun, repo, "/usr/bin/git", { maximumFileBytes: 1 })).rejects.toThrow(
			"bounded",
		);
		await expect(inspectEvaluationSource(execRun, repo, "/usr/bin/git", { maximumTotalBytes: 1 })).rejects.toThrow(
			"byte limit",
		);
		await expect(inspectEvaluationSource(execRun, repo, "/usr/bin/git", { maximumFiles: 0 })).rejects.toThrow(
			"limits",
		);
		await expect(
			inspectEvaluationSource(execRun, repo, "/usr/bin/git", { maximumFileBytes: 100_000_000 }),
		).rejects.toThrow("limits");
	});

	it("recomputes source, artifact, and environment identities for the current side", async () => {
		const { repo, host, binding } = await fixture();
		const observe = frozenEvaluationIdentityObserver(host);
		expect(await observe("candidate")).toMatchObject(binding);
		await writeFile(join(repo, "source.js"), "Changed source bytes");
		expect((await observe("candidate")).sourceTreeDigest).not.toBe(binding.sourceTreeDigest);
		const differentEnvironment = frozenEvaluationIdentityObserver({
			...host,
			environmentDigest: async () => digest("new tools"),
		});
		expect((await differentEnvironment("candidate")).environmentDigest).not.toBe(binding.environmentDigest);
	});
});

describe("isolated host executor adapter boundary", () => {
	it("refuses execution without an actual isolation adapter", async () => {
		const { host, binding, invocation } = await fixture();
		await expect(frozenEvaluatorExecutor(host)(invocation, binding)).rejects.toThrow(
			"isolation adapter is unavailable",
		);
	});

	it("binds the trusted adapter call and refuses changed execution identities", async () => {
		const { host, binding, invocation } = await fixture();
		const execute = frozenEvaluatorExecutor(
			host,
			{
				execute: async (request) => {
					expect(request.evaluator.digest).toBe(host.evaluator.digest);
					expect(request.sourceRoot).toBe(host.sources.candidate);
					return { exitCode: 0, stdout: "correct", stderr: "" };
				},
			},
			validateOutput,
		);
		const result = await execute(invocation, binding);
		expect(result).toMatchObject({ exitCode: 0, completedWork: 100 });
		expect(result.measurements["tests.runtime"]).toBeGreaterThan(0);
		expect(result.measurements).not.toHaveProperty("cpu");
		await expect(execute(invocation, { ...binding, grantId: "foreign" })).rejects.toThrow("approved host binding");
		await expect(
			frozenEvaluatorExecutor(
				{ ...host, bindings: { baseline: binding, candidate: { ...binding, evaluatorDigest: digest("wrong") } } },
				{ execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
				validateOutput,
			)(invocation, { ...binding, evaluatorDigest: digest("wrong") }),
		).rejects.toThrow("frozen evaluator artifacts");
	});

	it("refuses incomplete, oversized, or failed evaluator output", async () => {
		const { host, binding, invocation } = await fixture();
		for (const stdout of ["not-json", '{"schema":"worker-pass","passed":true}', "x".repeat(1024 * 1024 + 1)]) {
			await expect(
				frozenEvaluatorExecutor(
					host,
					{ execute: async () => ({ exitCode: 0, stdout, stderr: "" }) },
					validateOutput,
				)(invocation, binding),
			).rejects.toThrow();
		}
		const failed = await frozenEvaluatorExecutor(
			host,
			{
				execute: async () => ({ exitCode: 1, stdout: "", stderr: "failure" }),
			},
			validateOutput,
		)(invocation, binding);
		expect(failed).toMatchObject({ exitCode: 1, completedWork: 0, measurements: {} });
	});

	it("refuses a child-generated pass or measurement report without protected output validation", async () => {
		const { host, binding, invocation } = await fixture();
		let invoked = false;
		await expect(
			frozenEvaluatorExecutor(host, {
				execute: async () => {
					invoked = true;
					return { exitCode: 0, stdout: '{"passed":true,"measurements":{"cpu":0}}', stderr: "" };
				},
			})(invocation, binding),
		).rejects.toThrow("protected semantic output validator");
		expect(invoked).toBe(false);
	});

	it("refuses resource numbers copied from untrusted child output", async () => {
		const { host, binding, invocation } = await fixture();
		await expect(
			frozenEvaluatorExecutor(
				host,
				{
					execute: async () => ({
						exitCode: 0,
						stdout: "correct",
						stderr: "",
						resources: { userCpuMicros: 0, systemCpuMicros: 0, peakRssBytes: 0 },
					}),
				},
				validateOutput,
			)(invocation, binding),
		).rejects.toThrow("not issued by the trusted supervisor");
	});
});
