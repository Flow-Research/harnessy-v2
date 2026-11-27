import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { arch, cpus, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { Run } from "../work/run.ts";
import { calibrationProblems, hostIdentityDigest } from "./calibration.ts";
import { type CommandRuntimeLock, freezeCommandDependencies } from "./command-dependencies.ts";
import { macosCommandIsolation } from "./command-isolation.ts";
import {
	createHarnessyCommandWorkload,
	HARNESSY_COMMAND_DRIVER,
	type HarnessyCommandProfile,
	harnessyCommandPlan,
} from "./command-workload.ts";
import { type EvaluationBinding, EvaluationSession } from "./evaluation.ts";
import {
	freezeEvaluationArtifact,
	frozenEvaluationIdentityObserver,
	frozenEvaluatorExecutor,
	inspectEvaluationSource,
} from "./evaluator-host.ts";
import { macosOperationIsolation } from "./evaluator-macos.ts";
import { prepareEvaluatorSupervisor } from "./evaluator-supervisor.ts";
import { createHarnessyWorkload, HARNESSY_OPERATION_DRIVER, harnessyWorkloadPlan } from "./harnessy-workload.ts";

export interface HarnessyBenchmarkOptions {
	readonly profile?: "pure-task-operations" | HarnessyCommandProfile;
	readonly baseline: string;
	readonly candidate: string;
	/** New directory under an existing private owner directory, outside both Git roots. */
	readonly output: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	/**
	 * A null calibration record of this profile on this host. With it, the
	 * decision uses the exact signed-rank interval. Without it, the verdict of a
	 * noisy metric stays inconclusive. A record that does not match is refused.
	 */
	readonly calibration?: unknown;
}

const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const contains = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

async function regularBytes(path: string, maximum = 16 * 1024 * 1024, current: () => void = () => {}): Promise<Buffer> {
	current();
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	return Promise.resolve()
		.then(async () => {
			const before = await file.stat();
			if (!before.isFile() || before.nlink !== 1 || before.size > maximum)
				throw new Error("Benchmark input requires bounded regular files without hardlinks");
			const chunks: Buffer[] = [];
			let length = 0;
			for (;;) {
				current();
				const chunk = Buffer.alloc(Math.min(65536, maximum - length + 1));
				const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
				current();
				if (bytesRead === 0) break;
				length += bytesRead;
				if (length > maximum) throw new Error("Benchmark input exceeded its byte limit");
				chunks.push(chunk.subarray(0, bytesRead));
			}
			return Buffer.concat(chunks, length);
		})
		.finally(() => file.close());
}

async function privateDirectory(path: string): Promise<string> {
	if (!isAbsolute(path) || (await realpath(path)) !== path)
		throw new Error("Benchmark directories must be canonical absolute paths without symlinks");
	const stat = await lstat(path);
	if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
		throw new Error("Benchmark custody requires an owner-only directory");
	return path;
}

async function dependencyIdentity(root: string, current: () => void, copyTo?: string): Promise<string> {
	if ((await realpath(root)) !== root) throw new Error("Benchmark dependency root changed to a symlink");
	const hashState = createHash("sha256");
	const copiedState = createHash("sha256");
	let bytes = 0;
	let count = 0;
	const files: string[] = [];
	const walk = async (directory: string): Promise<void> => {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			current();
			if (++count > 20000) throw new Error("Benchmark dependency inventory exceeded its limit");
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Benchmark dependency closure contains a symlink");
			if (entry.isDirectory()) {
				if (copyTo) await mkdir(join(copyTo, relative(root, path)), { recursive: true, mode: 0o700 });
				await walk(path);
				continue;
			}
			files.push(path);
			if (files.length > 10000) throw new Error("Benchmark dependency file limit exceeded");
		}
	};
	await walk(root);
	for (let offset = 0; offset < files.length; offset += 4) {
		current();
		const batch = files.slice(offset, offset + 4);
		const observed = await Promise.all(
			batch.map(async (path) => ({
				path,
				data: await regularBytes(path, undefined, current),
				mode: (await lstat(path)).mode & 0o777,
			})),
		);
		for (const { path, data, mode } of observed) {
			bytes += data.length;
			if (bytes > 128 * 1024 * 1024) throw new Error("Benchmark dependency closure exceeded its limits");
			hashState.update(JSON.stringify([relative(root, path), mode, data.length, hash(data)])).update("\0");
			if (copyTo) {
				copiedState.update(JSON.stringify([relative(root, path), 0o400, data.length, hash(data)])).update("\0");
				await writeFile(join(copyTo, relative(root, path)), data, { flag: "wx", mode: 0o400 });
			}
		}
	}
	if (copyTo && (await dependencyIdentity(copyTo, current)) !== copiedState.digest("hex"))
		throw new Error("Frozen dependency copy differs from approved bytes");
	return hashState.digest("hex");
}

interface Projection {
	readonly root: string;
	readonly paths: ReadonlyArray<string>;
	readonly revision: string;
	readonly digest: string;
}
async function sourceProjection(
	run: Run,
	source: { root: string; sourceRevision: string; sourceTreeDigest: string },
	output: string,
	dependencies: Readonly<Record<string, string>>,
	current: () => void,
): Promise<Projection> {
	const result = await run(
		[
			"/usr/bin/git",
			"-C",
			source.root,
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.hooksPath=/dev/null",
			"ls-files",
			"--cached",
			"--others",
			"--exclude-standard",
			"-z",
		],
		{ timeoutMs: 30000 },
	);
	if (result.exitCode !== 0) throw new Error("Cannot list exact maintained projection source");
	const paths = [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
	if (paths.length > 100000 || paths.some((path) => path.split("/").includes("node_modules")))
		throw new Error(
			"Fixed pure-task profile does not support maintained dependency directories or oversized source inventories",
		);
	await mkdir(output, { mode: 0o700 });
	let total = 0;
	for (const path of paths) {
		current();
		const from = resolve(source.root, path),
			to = resolve(output, path);
		if (!contains(source.root, from) || !contains(output, to) || (await realpath(from)) !== from)
			throw new Error("Projection source path or symlink escaped custody");
		const bytes = await regularBytes(from, undefined, current);
		total += bytes.length;
		if (total > 512 * 1024 * 1024) throw new Error("Projection source exceeded its total byte limit");
		await mkdir(dirname(to), { recursive: true, mode: 0o700 });
		await writeFile(to, bytes, { flag: "wx", mode: 0o600 });
		await chmod(to, (await lstat(from)).mode & 0o777);
	}
	await mkdir(join(output, "node_modules"), { mode: 0o700 });
	for (const [name, target] of Object.entries(dependencies)) {
		current();
		await mkdir(dirname(join(output, "node_modules", name)), { recursive: true, mode: 0o700 });
		await symlink(target, join(output, "node_modules", name));
	}
	const projection = { root: output, paths, revision: source.sourceRevision, digest: source.sourceTreeDigest };
	await projectionIdentity(projection, dependencies, current);
	return projection;
}
async function projectionIdentity(
	projection: Projection,
	dependencies: Readonly<Record<string, string>>,
	current: () => void,
): Promise<string> {
	const observed: string[] = [];
	let entries = 0;
	const walk = async (directory: string): Promise<void> => {
		current();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			current();
			if (++entries > 200000) throw new Error("Projection inventory exceeded its limit");
			const path = join(directory, entry.name),
				rel = relative(projection.root, path);
			if (rel === "node_modules") {
				if (!entry.isDirectory() || (await realpath(path)) !== path)
					throw new Error("Projection dependency mapping changed");
				const actual: string[] = [];
				const mappedEntries = await readdir(path, { withFileTypes: true });
				const expectedTop = [
					...new Set(Object.keys(dependencies).map((name) => (name.startsWith("@") ? name.split("/")[0] : name))),
				].sort();
				if (JSON.stringify(mappedEntries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedTop))
					throw new Error("Projection dependency inventory changed");
				for (const mapped of mappedEntries) {
					current();
					if (mapped.name.startsWith("@") && mapped.isDirectory()) {
						if ((await realpath(join(path, mapped.name))) !== join(path, mapped.name))
							throw new Error("Projection dependency scope changed");
						for (const name of await readdir(join(path, mapped.name))) actual.push(`${mapped.name}/${name}`);
					} else actual.push(mapped.name);
				}
				if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(dependencies).sort()))
					throw new Error("Projection dependency inventory changed");
				for (const [name, target] of Object.entries(dependencies))
					if (
						!(await lstat(join(path, name))).isSymbolicLink() ||
						(await readlink(join(path, name))) !== target ||
						(await realpath(join(path, name))) !== target
					)
						throw new Error("Projection dependency mapping changed");
				continue;
			}
			if (entry.isSymbolicLink()) throw new Error("Projection contains an unexpected symlink");
			if (entry.isDirectory()) await walk(path);
			else observed.push(rel);
		}
	};
	await walk(projection.root);
	if (JSON.stringify(observed.sort()) !== JSON.stringify(projection.paths))
		throw new Error("Projection inventory changed");
	const state = createHash("sha256")
		.update("harnessy.engineering.source.v1\0")
		.update(projection.revision)
		.update("\0");
	for (const path of projection.paths) {
		current();
		const full = join(projection.root, path),
			bytes = await regularBytes(full, undefined, current);
		state.update(JSON.stringify([path, (await lstat(full)).mode & 0o777, bytes.length, hash(bytes)])).update("\0");
	}
	const digest = state.digest("hex");
	if (digest !== projection.digest) throw new Error("Projection differs from exact maintained source bytes or modes");
	return digest;
}

/** Local measurement only. No job approval, generic argv, provider, merge, or deployment port exists. */
export async function benchmarkHarnessy(options: HarnessyBenchmarkOptions) {
	if (process.platform !== "darwin")
		throw new Error(
			"Protected Harnessy benchmarks require the qualified macOS single-process sandbox. Other platforms and repository collectors are unsupported.",
		);
	const profile = options.profile ?? "pure-task-operations";
	if (!["pure-task-operations", "preparation-plan", "local-status"].includes(profile))
		throw new Error("Unsupported Harnessy workload profile");
	const timeout = options.timeoutMs ?? 300_000;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)
		throw new Error("Benchmark deadline must be between 1 and 600000 milliseconds");
	const controller = new AbortController();
	const deadline = performance.now() + timeout;
	const cancel = () => controller.abort();
	options.signal?.addEventListener("abort", cancel, { once: true });
	if (options.signal?.aborted) controller.abort();
	const timer = setTimeout(cancel, timeout);
	const current = () => {
		if (controller.signal.aborted || performance.now() >= deadline)
			throw new Error("Benchmark cancelled or overall deadline reached");
	};
	const run: Run = async (argv, args) => {
		current();
		if (argv[0] !== "/usr/bin/git") throw new Error("Only host-controlled Git source observation is permitted");
		const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
			let output: { exitCode: number; stdout: string; stderr: string } | undefined, failure: Error | undefined;
			const child = execFile(
				argv[0],
				argv.slice(1),
				{
					shell: false,
					signal: controller.signal,
					killSignal: "SIGKILL",
					maxBuffer: 16 * 1024 * 1024,
					timeout: Math.max(1, Math.min(args?.timeoutMs ?? 30000, Math.floor(deadline - performance.now()))),
				},
				(error, stdout, stderr) => {
					if (error) failure = error;
					else output = { exitCode: 0, stdout, stderr };
				},
			);
			child.once("close", () =>
				failure
					? reject(failure)
					: output
						? resolve(output)
						: reject(new Error("Benchmark Git observation did not settle")),
			);
		});
		current();
		return result;
	};
	let created = false;
	let reportPath: string | undefined;
	return Promise.resolve()
		.then(async () => {
			current();
			const roots = { baseline: await realpath(options.baseline), candidate: await realpath(options.candidate) };
			for (const side of ["baseline", "candidate"] as const) {
				if (!isAbsolute(options[side]) || options[side] !== roots[side])
					throw new Error("Benchmark sources must be canonical absolute Git roots");
				const marker: unknown = JSON.parse(
					(await regularBytes(join(roots[side], "packages/harnessy-core/package.json"), 65536, current)).toString(
						"utf8",
					),
				);
				if (
					typeof marker !== "object" ||
					marker === null ||
					!("name" in marker) ||
					marker.name !== "@harnessy/core"
				)
					throw new Error("Only the Harnessy repository workload is supported");
			}
			const output = resolve(options.output);
			if (!isAbsolute(options.output) || options.output !== output)
				throw new Error("Benchmark output requires a canonical absolute path");
			if (Object.values(roots).some((root) => contains(root, output) || contains(output, root)))
				throw new Error("Benchmark output must be outside both source Git roots");
			await privateDirectory(dirname(output));
			// Observe both exact Git roots before creating artifacts or compiling any code.
			const source = {
				baseline: await inspectEvaluationSource(run, roots.baseline, "/usr/bin/git", { signal: controller.signal }),
				candidate: await inspectEvaluationSource(run, roots.candidate, "/usr/bin/git", {
					signal: controller.signal,
				}),
			};
			const require = createRequire(import.meta.url);
			const effectRoot = await realpath(dirname(require.resolve("effect/package.json")));
			for (const root of profile === "pure-task-operations" ? Object.values(roots) : []) {
				const selected = await realpath(
					dirname(
						createRequire(join(root, "packages/harnessy-core/src/work/logic.ts")).resolve("effect/package.json"),
					),
				);
				if (selected !== effectRoot)
					throw new Error("Baseline and candidate must resolve the same trusted installed Effect dependency");
			}
			current();
			await mkdir(output, { mode: 0o700 }); // Exclusive creation refuses existing files, directories and symlinks.
			created = true;
			await privateDirectory(output);
			const reports = join(output, "reports"),
				artifacts = join(output, "artifacts"),
				scratch = join(output, "scratch"),
				supervisorRoot = join(output, "supervisor"),
				projectionsRoot = join(output, "projections"),
				dependenciesRoot = join(output, "dependencies");
			for (const path of [reports, artifacts, scratch, supervisorRoot, projectionsRoot, dependenciesRoot])
				await mkdir(path, { mode: 0o700 });
			reportPath = join(reports, "benchmark.json");
			const commandProfile = profile === "pure-task-operations" ? undefined : profile;
			const frozenEffect = join(dependenciesRoot, "effect");
			let originalDependencyDigest: string;
			let frozenDependencyDigest: string;
			let dependencyMappings: Readonly<Record<string, string>>;
			let observeDependencies: () => Promise<string>;
			let runtimeLock: CommandRuntimeLock | undefined;
			if (commandProfile) {
				const closure = await freezeCommandDependencies(
					Object.values(roots),
					join(dependenciesRoot, "commands"),
					controller.signal,
				);
				originalDependencyDigest = closure.digest;
				frozenDependencyDigest = closure.digest;
				dependencyMappings = closure.mappings;
				runtimeLock = closure.runtimeLock;
				observeDependencies = closure.observe;
			} else {
				await mkdir(frozenEffect, { mode: 0o700 });
				originalDependencyDigest = await dependencyIdentity(effectRoot, current, frozenEffect);
				frozenDependencyDigest = await dependencyIdentity(frozenEffect, current);
				dependencyMappings = { effect: frozenEffect };
				observeDependencies = async () => {
					if (
						(await dependencyIdentity(effectRoot, current)) !== originalDependencyDigest ||
						(await dependencyIdentity(frozenEffect, current)) !== frozenDependencyDigest
					)
						throw new Error("Pinned dependency closure changed");
					return originalDependencyDigest;
				};
			}
			await observeDependencies();
			const projections = {
				baseline: await sourceProjection(
					run,
					source.baseline,
					join(projectionsRoot, "baseline"),
					dependencyMappings,
					current,
				),
				candidate: await sourceProjection(
					run,
					source.candidate,
					join(projectionsRoot, "candidate"),
					dependencyMappings,
					current,
				),
			};
			await writeFile(join(artifacts, "package.json"), '{"type":"commonjs"}\n', { flag: "wx", mode: 0o400 });
			const commandWorkload = commandProfile
				? await createHarnessyCommandWorkload(commandProfile, join(output, "fixtures"), controller.signal)
				: undefined;
			const workload = commandWorkload ?? createHarnessyWorkload(randomUUID(), 64);
			const driverSource = join(output, "driver-source.cjs"),
				workloadSource = join(output, "workload-source.json");
			await writeFile(driverSource, commandWorkload ? HARNESSY_COMMAND_DRIVER : HARNESSY_OPERATION_DRIVER, {
				flag: "wx",
				mode: 0o400,
			});
			await writeFile(workloadSource, workload.input, { flag: "wx", mode: 0o400 });
			const evaluator = await freezeEvaluationArtifact(
				driverSource,
				artifacts,
				Object.values(roots),
				workload.driverDigest,
			);
			const data = await freezeEvaluationArtifact(
				workloadSource,
				artifacts,
				Object.values(roots),
				workload.inputDigest,
			);
			current();
			const supervisor = await prepareEvaluatorSupervisor({
				controllerRoot: supervisorRoot,
				timeoutMs: Math.max(1, Math.min(30000, Math.floor(deadline - performance.now()))),
				signal: controller.signal,
			});
			const executable = await realpath(process.execPath);
			const environment = async () => {
				current();
				await privateDirectory(output);
				const tools = await Promise.all(
					[executable, "/usr/bin/git", "/usr/bin/cc", "/usr/bin/sandbox-exec", supervisor.executable].map(
						async (path) => ({ path, digest: hash(await readFile(path, { signal: controller.signal })) }),
					),
				);
				const dependencyDigest = await observeDependencies(),
					frozenDigest = frozenDependencyDigest;
				const fixtureDigest = commandWorkload ? await commandWorkload.observeFixtures() : undefined;
				const projectionDigests = {
					baseline: await projectionIdentity(projections.baseline, dependencyMappings, current),
					candidate: await projectionIdentity(projections.candidate, dependencyMappings, current),
				};
				const identity = {
					platform: process.platform,
					arch: arch(),
					os: release(),
					cpus: cpus().map((cpu) => cpu.model),
					node: process.version,
					tools,
					supervisorSource: supervisor.sourceDigest,
					compiler: supervisor.compilerDigest,
					dependencyRoot: effectRoot,
					dependencyDigest,
					frozenDependencyDigest: frozenDigest,
					projectionDigests,
					...(commandWorkload
						? {
								profile,
								sqliteVersion: process.versions.sqlite,
								runtimeLock,
								fixtureDigest,
								measurementWindow:
									"Protected invocation includes fixed fixture setup, command driver startup, commands, fixture readback, and cleanup. CPU/RSS cover only the supervised child.",
							}
						: {}),
					artifactPackage: hash(await regularBytes(join(artifacts, "package.json"), 65536, current)),
				};
				current();
				return { identity, digest: hash(JSON.stringify(identity)) };
			};
			const initialEnvironment = await environment();
			const runId = randomUUID(),
				grantId = randomUUID(); // Local experiment correlation only, never an execution grant.
			const binding = (side: "baseline" | "candidate"): EvaluationBinding => ({
				runId,
				grantId,
				sourceRevision: source[side].sourceRevision,
				sourceTreeDigest: source[side].sourceTreeDigest,
				evaluatorDigest: evaluator.digest,
				workloadDigest: data.digest,
				environmentDigest: initialEnvironment.digest,
			});
			const host = {
				sources: roots,
				evaluator,
				workload: data,
				bindings: { baseline: binding("baseline"), candidate: binding("candidate") },
				run,
				sourceLimits: { signal: controller.signal },
				environmentDigest: async () => (await environment()).digest,
			};
			let evaluationFailure: unknown;
			const execute = frozenEvaluatorExecutor(
				host,
				{
					execute: async (request) => {
						current();
						const isolationOptions = {
							executable,
							scratchRoot: scratch,
							additionalReadRoots: commandWorkload ? [join(dependenciesRoot, "commands")] : [frozenEffect],
							deniedRoots: [reports, supervisorRoot, ...new Set(Object.values(roots))],
							timeoutMs: Math.max(
								1,
								Math.min(commandWorkload ? 15000 : 5000, Math.floor(deadline - performance.now())),
							),
							signal: controller.signal,
							supervisor,
						};
						const adapter = commandWorkload
							? macosCommandIsolation(isolationOptions, commandWorkload)
							: macosOperationIsolation(isolationOptions);
						return adapter
							.execute({ ...request, sourceRoot: projections[request.invocation.side].root })
							.catch((cause: unknown) => {
								evaluationFailure = cause;
								throw cause;
							});
					},
				},
				workload.validateOutput,
			);
			const basePlan = (side: "baseline" | "candidate") => {
				const value = commandWorkload
					? harnessyCommandPlan(binding(side), commandWorkload)
					: harnessyWorkloadPlan(binding(side), workload as ReturnType<typeof createHarnessyWorkload>);
				return {
					...value,
					guardrails: [
						...value.guardrails,
						{ id: "cpu.time_per_operation", direction: "lower" as const, maximumRegression: 0.05 },
					],
				};
			};
			const calibrated = options.calibration !== undefined;
			if (calibrated) {
				const reference = basePlan("baseline");
				const problems = calibrationProblems(options.calibration, {
					profile,
					hostDigest: hostIdentityDigest(initialEnvironment.identity),
					evaluatorDigest: evaluator.digest,
					completedWork: reference.workload.completedWork,
					metrics: [reference.primary.id, ...reference.guardrails.map((guard) => guard.id)],
					now: Date.now(),
				});
				if (problems.length > 0)
					throw new Error(`The calibration does not support this benchmark: ${problems.join(", ")}`);
			}
			const assumptions = calibrated
				? { independentPairs: true, approximatelyNormalDifferences: false, symmetricDifferences: true }
				: { independentPairs: false, approximatelyNormalDifferences: false };
			const plan = (side: "baseline" | "candidate") => {
				const value = basePlan(side);
				return calibrated
					? { ...value, primary: { ...value.primary, method: "paired-signed-rank" as const }, assumptions }
					: value;
			};
			const session = new EvaluationSession();
			const receipts = await session.collectPair(
				plan("baseline"),
				plan("candidate"),
				(invocation, binding) =>
					execute(invocation, binding).catch((cause: unknown) => {
						evaluationFailure = cause;
						if (commandWorkload) controller.abort();
						throw cause;
					}),
				frozenEvaluationIdentityObserver(host),
			);
			if (commandWorkload && evaluationFailure !== undefined)
				throw new Error("Protected command workload failed", { cause: evaluationFailure });
			current();
			const decision = await session.compare(receipts.baseline, receipts.candidate);
			const finalEnvironment = await environment();
			current();
			const valid =
				receipts.baseline.valid &&
				receipts.candidate.valid &&
				receipts.baseline.samples.length === 10 &&
				receipts.candidate.samples.length === 10 &&
				[...receipts.baseline.samples, ...receipts.candidate.samples].every((sample) =>
					["cpu.time_per_operation", "memory.peak_resident"].every(
						(id) => Number.isFinite(sample.measurements[id]) && sample.measurements[id] > 0,
					),
				);
			if (!valid || initialEnvironment.digest !== finalEnvironment.digest)
				throw new Error("Protected benchmark behavior, resource evidence or identity validation failed", {
					cause: evaluationFailure,
				});
			const report = {
				schema: "harnessy.engineering.benchmark.v1",
				measurementStatus: "observed",
				profile,
				scope:
					commandWorkload?.scope ??
					"Fixed synthetic pure-task-operation profile from byte-identical maintained source projections. Not startup, end-to-end, whole-repository performance, release or native-device qualification.",
				collectedAt: new Date().toISOString(),
				sources: source,
				environment: initialEnvironment,
				supervisor,
				baseline: receipts.baseline,
				candidate: receipts.candidate,
				decision,
				assumptions,
				...(calibrated ? { calibrationDigest: hash(JSON.stringify(options.calibration)) } : {}),
				notice:
					"Persisted JSON is audit evidence only. Re-run to obtain fresh controller receipts. No source change, approval, merge or deployment is authorized.",
			};
			const encoded = `${JSON.stringify(report, null, 2)}\n`;
			if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error("Benchmark report exceeded its byte limit");
			await writeFile(reportPath, encoded, { flag: "wx", mode: 0o400 });
			return { schema: report.schema, measurementStatus: report.measurementStatus, reportPath, decision };
		})
		.catch(async (cause: unknown) => {
			if (created && reportPath !== undefined)
				await writeFile(
					reportPath,
					`${JSON.stringify({
						schema: "harnessy.engineering.benchmark.v1",
						measurementStatus: "failed",
						reason: cause instanceof Error ? cause.message : "Protected benchmark failed",
					})}\n`,
					{ flag: "wx", mode: 0o400 },
				).catch(() => undefined);
			throw cause;
		})
		.finally(async () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			if (created) await rm(join(options.output, "scratch"), { recursive: true, force: true });
		});
}
