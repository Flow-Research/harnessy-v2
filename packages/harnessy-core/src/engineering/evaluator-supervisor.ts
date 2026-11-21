import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseJson } from "../work/logic.ts";

const SOURCE_DIGEST = "5e47bb606ccb04db8f925f613c15447c514fd6867e1279429628242da3f95295";
const SOURCE_PATH = fileURLToPath(new URL("../../resources/engineering/evaluator-supervisor.c", import.meta.url));
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const issuedSupervisors = new WeakSet<object>();

export interface SupervisorArtifact {
	readonly executable: string;
	readonly binaryDigest: string;
	readonly sourceDigest: string;
	readonly compilerPath: string;
	readonly compilerDigest: string;
	readonly platform: "darwin" | "linux";
}

async function privateRoot(input: string): Promise<string> {
	const root = await realpath(input);
	const stat = await lstat(root);
	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
		throw new Error("Supervisor needs a private controller directory");
	return root;
}

async function compilerCommand(argv: ReadonlyArray<string>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let failure: Error | undefined;
		const child = execFile(
			"/usr/bin/cc",
			[...argv],
			{
				shell: false,
				timeout: timeoutMs,
				signal,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
				env: { PATH: "/usr/bin:/bin", LANG: "C" },
			},
			(error) => {
				failure = error ?? undefined;
			},
		);
		child.once("close", () => (failure ? reject(failure) : resolve()));
	});
}

/** Compile only the fixed, reviewed packaged source. No task-selected C source is accepted. */
export async function prepareEvaluatorSupervisor(options: {
	readonly controllerRoot: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}): Promise<SupervisorArtifact> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new Error("Invalid supervisor preparation deadline");
	const deadline = performance.now() + timeoutMs;
	const assertCurrent = () => {
		if (options.signal?.aborted) throw new Error("Supervisor preparation cancelled");
		if (performance.now() >= deadline) throw new Error("Supervisor preparation deadline reached");
	};
	assertCurrent();
	const platform = process.platform;
	if (platform !== "darwin" && platform !== "linux") throw new Error("POSIX evaluator supervisor is unsupported");
	await mkdir(options.controllerRoot, { recursive: true, mode: 0o700 });
	const root = await privateRoot(options.controllerRoot);
	const source = await readFile(SOURCE_PATH);
	if (digest(source) !== SOURCE_DIGEST)
		throw new Error("Packaged evaluator supervisor source differs from its approved digest");
	const compilerPath = await realpath("/usr/bin/cc");
	const compilerDigest = digest(await readFile(compilerPath));
	const directory = await mkdtemp(join(root, "supervisor-"));
	const sourcePath = join(directory, "supervisor.c");
	const executable = join(directory, "supervisor");
	return Promise.resolve()
		.then(async () => {
			assertCurrent();
			await writeFile(sourcePath, source, { flag: "wx", mode: 0o400 });
			await compilerCommand(
				["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", executable],
				Math.max(1, Math.floor(deadline - performance.now())),
				options.signal,
			);
			assertCurrent();
			await chmod(executable, 0o500);
			const artifact: SupervisorArtifact = Object.freeze({
				executable,
				binaryDigest: digest(await readFile(executable)),
				sourceDigest: SOURCE_DIGEST,
				compilerPath,
				compilerDigest,
				platform,
			});
			assertCurrent();
			issuedSupervisors.add(artifact);
			return artifact;
		})
		.catch(async (cause: unknown) => {
			await rm(directory, { recursive: true, force: true });
			throw cause;
		});
}

export interface SupervisorResources {
	readonly userCpuMicros: number;
	readonly systemCpuMicros: number;
	readonly peakRssBytes: number;
}

const issuedResources = new WeakSet<object>();
export function isSupervisorResources(value: unknown): value is SupervisorResources {
	return value !== null && typeof value === "object" && issuedResources.has(value);
}

const resourceReportSchema = z.strictObject({
	schema: z.literal("harnessy.engineering.resources.v1"),
	childPid: z.number().int().positive().safe(),
	reaped: z.literal(true),
	exitCode: z.number().int().min(0).max(255).nullable(),
	signal: z.number().int().min(0).max(128),
	timedOut: z.boolean(),
	cancelled: z.boolean(),
	userCpuMicros: z.number().int().nonnegative().safe(),
	systemCpuMicros: z.number().int().nonnegative().safe(),
	peakRssBytes: z.number().int().nonnegative().safe(),
});

/** Decode bounded control-channel bytes. Decoding alone never issues resource authority. */
export function decodeSupervisorReport(text: string) {
	if (Buffer.byteLength(text) > 4096) throw new Error("Supervisor control report exceeded its byte limit");
	const parsed = resourceReportSchema.parse(parseJson(text));
	if ((parsed.exitCode === null) === (parsed.signal === 0))
		throw new Error("Supervisor termination receipt is inconsistent");
	return parsed;
}

export interface SupervisedEvaluationInput {
	readonly supervisor: SupervisorArtifact;
	readonly executable: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly maximumOutputBytes?: number;
	readonly signal?: AbortSignal;
}

export interface SupervisedEvaluationResult {
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly outputExceeded: boolean;
	readonly durationMs: number;
	readonly resources: SupervisorResources;
	readonly childPid: number;
	readonly signal: number;
	readonly reaped: true;
}

/** Resource authority comes only from wait4 on a child that closed the report pipe before exec. */
export async function runSupervisedEvaluator(input: SupervisedEvaluationInput): Promise<SupervisedEvaluationResult> {
	const artifact = input.supervisor;
	if (
		!issuedSupervisors.has(artifact) ||
		artifact.platform !== process.platform ||
		artifact.sourceDigest !== SOURCE_DIGEST ||
		!isAbsolute(input.executable) ||
		!Number.isSafeInteger(input.timeoutMs) ||
		input.timeoutMs < 1 ||
		input.timeoutMs > 5_400_000
	)
		throw new Error("Invalid supervised evaluator input or platform");
	await privateRoot(dirname(artifact.executable));
	const binary = await realpath(artifact.executable);
	const stat = await lstat(binary);
	if (
		binary !== artifact.executable ||
		!stat.isFile() ||
		stat.nlink !== 1 ||
		(stat.mode & 0o277) !== 0 ||
		stat.uid !== process.getuid?.() ||
		digest(await readFile(binary)) !== artifact.binaryDigest
	)
		throw new Error("Evaluator supervisor artifact changed");
	const maximum = input.maximumOutputBytes ?? 1024 * 1024;
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024)
		throw new Error("Invalid supervised output limit");
	if (input.signal?.aborted) throw new Error("Evaluator cancelled before supervisor launch");
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const child = spawn(binary, [String(input.timeoutMs), input.executable, ...input.args], {
			cwd: input.cwd,
			env: input.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe", "pipe"],
		});
		let cancelled = false;
		let outputExceeded = false;
		let outputBytes = 0;
		let reportBytes = 0;
		let stopRequested = false;
		let ready = false;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const report: Buffer[] = [];
		const requestStop = () => {
			if (stopRequested) return;
			stopRequested = true;
			if (ready) child.kill("SIGTERM");
		};
		const cancel = () => {
			cancelled = true;
			requestStop();
		};
		input.signal?.addEventListener("abort", cancel, { once: true });
		// If the supervisor itself fails to reap, no resource receipt is issued.
		const watchdog = setTimeout(requestStop, input.timeoutMs + 2000);
		const collect = (target: Buffer[], chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > maximum) {
				outputExceeded = true;
				requestStop();
			} else target.push(chunk);
		};
		child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk));
		const channel = child.stdio[3];
		if (channel === null || channel === undefined || !("on" in channel)) {
			requestStop();
			reject(new Error("Supervisor report channel unavailable"));
			return;
		}
		channel.on("data", (chunk: Buffer) => {
			reportBytes += chunk.length;
			if (reportBytes > 4096) requestStop();
			else {
				report.push(chunk);
				if (!ready && Buffer.concat(report).toString("utf8").startsWith("HSY_EVALUATOR_READY\n")) {
					ready = true;
					if (stopRequested) child.kill("SIGTERM");
				}
			}
		});
		const cleanup = () => {
			clearTimeout(watchdog);
			input.signal?.removeEventListener("abort", cancel);
		};
		child.on("error", (cause) => {
			cleanup();
			reject(cause);
		});
		child.on("close", (exitCode) => {
			cleanup();
			Promise.resolve()
				.then(() => {
					if (exitCode !== 0 || reportBytes > 4096)
						throw new Error(
							`Supervisor did not issue a bounded reaped-child receipt (exit ${exitCode}, ${reportBytes} report bytes)`,
						);
					const raw = Buffer.concat(report).toString("utf8");
					if (!raw.startsWith("HSY_EVALUATOR_READY\n"))
						throw new Error("Supervisor readiness acknowledgment missing");
					const parsed = decodeSupervisorReport(raw.slice("HSY_EVALUATOR_READY\n".length));
					const resources = Object.freeze({
						userCpuMicros: parsed.userCpuMicros,
						systemCpuMicros: parsed.systemCpuMicros,
						peakRssBytes: parsed.peakRssBytes,
					});
					issuedResources.add(resources);
					resolve({
						exitCode: parsed.exitCode ?? undefined,
						stdout: Buffer.concat(stdout).toString("utf8"),
						stderr: Buffer.concat(stderr).toString("utf8"),
						timedOut: parsed.timedOut,
						cancelled: cancelled || parsed.cancelled,
						outputExceeded,
						durationMs: performance.now() - started,
						resources,
						childPid: parsed.childPid,
						signal: parsed.signal,
						reaped: true,
					});
				})
				.catch(reject);
		});
	});
}
