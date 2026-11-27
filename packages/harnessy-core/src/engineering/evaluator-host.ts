import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { Run, RunResult } from "../work/run.ts";
import type {
	EvaluationBinding,
	EvaluationIdentityObserver,
	EvaluatorInvocation,
	TrustedEvaluatorExecutor,
} from "./evaluation.ts";
import { isSupervisorResources, type SupervisorResources } from "./evaluator-supervisor.ts";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const outside = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

const assertSourceActive = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new Error("Evaluation source observation cancelled");
};
async function boundedRegularFile(path: string, maximumBytes: number, signal?: AbortSignal): Promise<Buffer> {
	assertSourceActive(signal);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximumBytes)
			throw new Error("Evaluation input is not a bounded, singly linked regular file");
		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			assertSourceActive(signal);
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - total));
			const { bytesRead } = await file.read(chunk);
			assertSourceActive(signal);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maximumBytes) throw new Error("Evaluation input exceeded its byte limit");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		return Buffer.concat(chunks, total);
	} finally {
		await file.close();
	}
}

export interface FrozenEvaluationArtifact {
	readonly path: string;
	readonly digest: string;
}

/** Copy approved bytes into an exclusive controller-owned artifact, never a worker path. */
export async function freezeEvaluationArtifact(
	source: string,
	controllerRoot: string,
	workerRoots: ReadonlyArray<string>,
	expectedDigest: string,
): Promise<FrozenEvaluationArtifact> {
	if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Invalid approved artifact digest");
	await mkdir(controllerRoot, { recursive: true, mode: 0o700 });
	const root = await realpath(controllerRoot);
	for (const worker of workerRoots)
		if (!outside(await realpath(worker), root)) throw new Error("Evaluator custody cannot be inside a worker root");
	const rootStat = await lstat(root);
	if (
		!rootStat.isDirectory() ||
		(rootStat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && rootStat.uid !== process.getuid())
	)
		throw new Error("Evaluator custody needs a private controller-owned directory");
	const bytes = await boundedRegularFile(source, 8 * 1024 * 1024);
	if (digest(bytes) !== expectedDigest) throw new Error("Approved evaluator artifact changed");
	const path = resolve(root, expectedDigest);
	const file = await open(
		path,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o400,
	).catch((cause: unknown) => {
		if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") return undefined;
		throw cause;
	});
	try {
		await file?.writeFile(bytes);
		await file?.sync();
	} finally {
		await file?.close();
	}
	const artifact = Object.freeze({ path, digest: expectedDigest });
	await validateFrozenEvaluationArtifact(artifact, workerRoots);
	return artifact;
}

/** Validate on every use. A private file mode alone does not supply process isolation. */
export async function validateFrozenEvaluationArtifact(
	artifact: FrozenEvaluationArtifact,
	workerRoots: ReadonlyArray<string>,
): Promise<void> {
	const path = await realpath(artifact.path);
	if (path !== artifact.path) throw new Error("Frozen evaluator path changed or traverses a link");
	for (const root of workerRoots)
		if (!outside(await realpath(root), path)) throw new Error("Frozen evaluator is exposed to worker writes");
	const parent = await lstat(dirname(path));
	if (
		!parent.isDirectory() ||
		(parent.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && parent.uid !== process.getuid())
	)
		throw new Error("Frozen evaluator parent requires private controller permissions");
	const stat = await lstat(path);
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		(stat.mode & 0o222) !== 0 ||
		(stat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid())
	)
		throw new Error("Frozen evaluator permissions changed");
	if (digest(await boundedRegularFile(path, 8 * 1024 * 1024)) !== artifact.digest)
		throw new Error("Frozen evaluator bytes changed");
}

export interface EvaluationSourceSnapshot {
	readonly root: string;
	readonly sourceRevision: string;
	readonly sourceTreeDigest: string;
}

export interface EvaluationSourceLimits {
	readonly maximumFiles?: number;
	readonly maximumFileBytes?: number;
	readonly maximumTotalBytes?: number;
	readonly signal?: AbortSignal;
}

/** Hash actual maintained bytes, not only Git's dirty flag or index metadata. */
export async function inspectEvaluationSource(
	run: Run,
	rootInput: string,
	gitExecutable = "/usr/bin/git",
	limits: EvaluationSourceLimits = {},
): Promise<EvaluationSourceSnapshot> {
	assertSourceActive(limits.signal);
	if (!isAbsolute(gitExecutable)) throw new Error("Git executable must be host-controlled and absolute");
	const maximumFiles = limits.maximumFiles ?? 100_000;
	const maximumFileBytes = limits.maximumFileBytes ?? 16 * 1024 * 1024;
	const maximumTotalBytes = limits.maximumTotalBytes ?? 512 * 1024 * 1024;
	if (
		![maximumFiles, maximumFileBytes, maximumTotalBytes].every((limit) => Number.isSafeInteger(limit) && limit > 0) ||
		maximumFiles > 100_000 ||
		maximumFileBytes > 16 * 1024 * 1024 ||
		maximumTotalBytes > 512 * 1024 * 1024
	)
		throw new Error("Invalid evaluation source limits");
	const root = await realpath(rootInput);
	assertSourceActive(limits.signal);
	const git = async (args: ReadonlyArray<string>): Promise<string> => {
		assertSourceActive(limits.signal);
		const argv = [gitExecutable, "-C", root, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args];
		const result =
			limits.signal === undefined
				? await run(argv, { timeoutMs: 30000 })
				: await new Promise<RunResult>((resolve, reject) => {
						let outcome: RunResult | undefined, failure: Error | undefined;
						const child = execFile(
							gitExecutable,
							argv.slice(1),
							{
								shell: false,
								signal: limits.signal,
								killSignal: "SIGKILL",
								timeout: 30000,
								maxBuffer: 16 * 1024 * 1024,
							},
							(error, stdout, stderr) => {
								if (error) failure = error;
								else outcome = { exitCode: 0, stdout, stderr };
							},
						);
						child.once("close", () =>
							failure
								? reject(failure)
								: outcome
									? resolve(outcome)
									: reject(new Error("Source Git observation did not settle")),
						);
					});
		assertSourceActive(limits.signal);
		if (result.exitCode !== 0 || result.timedOut) throw new Error("Cannot observe exact evaluation source");
		return result.stdout;
	};
	if ((await realpath((await git(["rev-parse", "--show-toplevel"])).trim())) !== root)
		throw new Error("Evaluation source must be the exact registered Git root");
	const sourceRevision = (await git(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
	if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("Invalid observed source revision");
	const paths = [
		...new Set(
			(await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean),
		),
	].sort();
	if (paths.length > maximumFiles) throw new Error("Evaluation source file limit exceeded");
	const hash = createHash("sha256").update("harnessy.engineering.source.v1\0").update(sourceRevision).update("\0");
	let totalBytes = 0;
	for (const path of paths) {
		assertSourceActive(limits.signal);
		const full = resolve(root, path);
		if (outside(root, full) || (await realpath(full)) !== full)
			throw new Error("Evaluation source path or symlink escapes its snapshot");
		const bytes = await boundedRegularFile(full, maximumFileBytes, limits.signal);
		const mode = (await lstat(full)).mode & 0o777;
		totalBytes += bytes.length;
		if (totalBytes > maximumTotalBytes) throw new Error("Evaluation source byte limit exceeded");
		hash.update(JSON.stringify([path, mode, bytes.length, digest(bytes)])).update("\0");
	}
	assertSourceActive(limits.signal);
	return Object.freeze({ root, sourceRevision, sourceTreeDigest: hash.digest("hex") });
}

export interface FrozenEvaluatorHost {
	readonly sources: Readonly<Record<"baseline" | "candidate", string>>;
	readonly evaluator: FrozenEvaluationArtifact;
	readonly workload: FrozenEvaluationArtifact;
	readonly bindings: Readonly<Record<"baseline" | "candidate", EvaluationBinding>>;
	readonly run: Run;
	/** Re-observe the actual toolchain and relevant host state, not the expected value. */
	readonly environmentDigest: () => Promise<string>;
	readonly gitExecutable?: string;
	readonly sourceLimits?: EvaluationSourceLimits;
}

export function frozenEvaluationIdentityObserver(host: FrozenEvaluatorHost): EvaluationIdentityObserver {
	return async (side) => {
		assertSourceActive(host.sourceLimits?.signal);
		const roots = Object.values(host.sources);
		await validateFrozenEvaluationArtifact(host.evaluator, roots);
		await validateFrozenEvaluationArtifact(host.workload, roots);
		const source = await inspectEvaluationSource(host.run, host.sources[side], host.gitExecutable, host.sourceLimits);
		return Object.freeze({
			...host.bindings[side],
			sourceRevision: source.sourceRevision,
			sourceTreeDigest: source.sourceTreeDigest,
			evaluatorDigest: host.evaluator.digest,
			workloadDigest: host.workload.digest,
			environmentDigest: await host.environmentDigest(),
		});
	};
}

export interface IsolatedEvaluationRequest {
	readonly evaluator: FrozenEvaluationArtifact;
	readonly workload: FrozenEvaluationArtifact;
	readonly sourceRoot: string;
	readonly invocation: EvaluatorInvocation;
	readonly binding: EvaluationBinding;
}

/**
 * Host enforcement capability. Implementations must deny source/control writes,
 * credentials and network, bound resources, and supervise the whole process tree.
 * An unisolated `Run` function does not implement this interface.
 */
export interface EvaluationIsolationAdapter {
	readonly execute: (
		request: IsolatedEvaluationRequest,
	) => Promise<RunResult & { readonly resources?: SupervisorResources }>;
}

export interface ValidatedSemanticOutput {
	readonly outputDigest: string;
	readonly completedCases: ReadonlyArray<string>;
	readonly completedWork: number;
}

/** Runs in the protected controller. Never import candidate code into this validator. */
export type ProtectedSemanticValidator = (
	stdout: string,
	invocation: EvaluatorInvocation,
	bindings: EvaluationBinding,
) => ValidatedSemanticOutput;

export const EVALUATION_WALL_METRIC = "tests.runtime";
export const EVALUATION_THROUGHPUT_METRIC = "server.useful_throughput";

/** No fallback to execRun exists when the host cannot enforce evaluator isolation. */
export function frozenEvaluatorExecutor(
	host: FrozenEvaluatorHost,
	isolation?: EvaluationIsolationAdapter,
	validateOutput?: ProtectedSemanticValidator,
): TrustedEvaluatorExecutor {
	return async (invocation, binding) => {
		if (isolation === undefined) throw new Error("Evaluator isolation adapter is unavailable. Execution is refused.");
		if (validateOutput === undefined) throw new Error("A protected semantic output validator is required");
		if (
			Object.keys(host.bindings[invocation.side]).some(
				(key) =>
					binding[key as keyof EvaluationBinding] !==
					host.bindings[invocation.side][key as keyof EvaluationBinding],
			)
		)
			throw new Error("Invocation does not match the approved host binding");
		await validateFrozenEvaluationArtifact(host.evaluator, Object.values(host.sources));
		await validateFrozenEvaluationArtifact(host.workload, Object.values(host.sources));
		if (binding.evaluatorDigest !== host.evaluator.digest || binding.workloadDigest !== host.workload.digest)
			throw new Error("Invocation does not match frozen evaluator artifacts");
		const sourceRoot = await realpath(host.sources[invocation.side]);
		const started = performance.now();
		const result = await isolation.execute(
			Object.freeze({
				evaluator: host.evaluator,
				workload: host.workload,
				sourceRoot,
				invocation,
				binding,
			}),
		);
		const durationMs = performance.now() - started;
		if (result.exitCode !== 0 || result.timedOut)
			return {
				exitCode: result.exitCode,
				timedOut: result.timedOut,
				outputDigest: "",
				completedCases: [],
				completedWork: 0,
				measurements: {},
			};
		if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new Error("Evaluator output limit exceeded");
		const semantic = validateOutput(result.stdout, invocation, binding);
		if (
			!/^[a-f0-9]{64}$/.test(semantic.outputDigest) ||
			!Number.isSafeInteger(semantic.completedWork) ||
			semantic.completedWork <= 0 ||
			!Array.isArray(semantic.completedCases) ||
			semantic.completedCases.length === 0 ||
			semantic.completedCases.some((id: unknown) => typeof id !== "string" || id === "") ||
			!Number.isFinite(durationMs) ||
			durationMs <= 0
		)
			throw new Error("Invalid protected semantic result");
		const measurements: Record<string, number> = {
			[EVALUATION_WALL_METRIC]: durationMs,
			[EVALUATION_THROUGHPUT_METRIC]: (semantic.completedWork * 1000) / durationMs,
		};
		if (result.resources !== undefined) {
			if (!isSupervisorResources(result.resources))
				throw new Error("Resource evidence was not issued by the trusted supervisor");
			measurements["cpu.time_per_operation"] =
				(result.resources.userCpuMicros + result.resources.systemCpuMicros) / semantic.completedWork;
			measurements["memory.peak_resident"] = result.resources.peakRssBytes;
			measurements["cost.compute_time"] =
				(result.resources.userCpuMicros + result.resources.systemCpuMicros) / 1_000_000;
		}
		return Object.freeze({
			...semantic,
			completedCases: Object.freeze([...semantic.completedCases]),
			exitCode: 0,
			measurements: Object.freeze(measurements),
		});
	};
}
