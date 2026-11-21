import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { runSupervisedEvaluator, type SupervisorArtifact, type SupervisorResources } from "./evaluator-supervisor.ts";

export interface SingleProcessEvaluation {
	readonly executable: string;
	readonly args: ReadonlyArray<string>;
	readonly sourceRoots: ReadonlyArray<string>;
	readonly evaluatorRoot: string;
	readonly scratch: string;
	readonly deniedRoots: ReadonlyArray<string>;
	readonly timeoutMs: number;
	readonly maximumOutputBytes?: number;
	readonly signal?: AbortSignal;
	readonly supervisor?: SupervisorArtifact;
}

export interface SandboxedEvaluationResult {
	readonly isolation: "macos-seatbelt-single-process-v1";
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | number | null;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly outputExceeded: boolean;
	readonly stdout: string;
	readonly stderr: string;
	readonly outputDigest: string;
	readonly durationMs: number;
	readonly resources?: SupervisorResources;
	readonly childPid?: number;
	readonly reaped?: true;
}

const inside = (root: string, path: string): boolean => {
	const suffix = relative(root, path);
	return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
const directory = (path: string): string => {
	const canonical = realpathSync(path);
	if (!isAbsolute(path) || canonical !== path || !lstatSync(path).isDirectory())
		throw new Error("Evaluator directories must be canonical absolute directories");
	return canonical;
};

/**
 * Narrow evaluator boundary. Fork, networking and general IPC remain denied.
 * This is deliberately not a general test runner or a coding-agent sandbox.
 */
export const runSingleProcessEvaluation = async (
	input: SingleProcessEvaluation,
): Promise<SandboxedEvaluationResult> => {
	if (process.platform !== "darwin")
		throw new Error("Single-process evaluator isolation is not qualified on this host platform");
	if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 90 * 60_000)
		throw new Error("Evaluator timeout must be within the verification deadline");
	const maximum = input.maximumOutputBytes ?? 1024 * 1024;
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024)
		throw new Error("Invalid evaluator output limit");
	const executable = realpathSync(input.executable);
	if (executable !== input.executable || !lstatSync(executable).isFile())
		throw new Error("Evaluator executable must be a canonical regular file");
	const sources = input.sourceRoots.map(directory);
	const evaluator = directory(input.evaluatorRoot);
	const scratch = directory(input.scratch);
	const scratchStat = lstatSync(scratch);
	if ((scratchStat.mode & 0o077) !== 0 || (process.getuid !== undefined && scratchStat.uid !== process.getuid()))
		throw new Error("Evaluator scratch requires private owner permissions");
	if (
		sources.some((source) => inside(source, scratch) || inside(scratch, source)) ||
		inside(evaluator, scratch) ||
		inside(scratch, evaluator)
	)
		throw new Error("Evaluator scratch must be separate from source and evaluator artifacts");
	const denied = input.deniedRoots.map(directory);
	if (
		denied.some(
			(root) => inside(root, scratch) || sources.some((source) => inside(root, source)) || inside(root, evaluator),
		)
	)
		throw new Error("Read roots overlap protected controller state");
	const quote = (path: string): string => {
		if ([...path].some((character) => character.charCodeAt(0) < 32)) throw new Error("Invalid evaluator path");
		return JSON.stringify(path);
	};
	const profile = [
		"(version 1)",
		"(deny default)",
		"(allow process-exec)",
		"(allow process-info* (target same-sandbox))",
		"(allow mach-priv-task-port (target same-sandbox))",
		"(allow signal (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow file-read-metadata)",
		'(allow file-read* (literal "/"))',
		'(allow mach-lookup (global-name "com.apple.system.logger"))',
		'(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))',
		`(allow file-read* (literal ${quote(executable)}) ${[...sources, evaluator, scratch].map((path) => `(subpath ${quote(path)})`).join(" ")})`,
		`(allow file-write* (subpath ${quote(scratch)}) (literal "/dev/null"))`,
		...denied.map((path) => `(deny file-read* file-write* (subpath ${quote(path)}))`),
		'(deny file-read-data (regex #"/\\.env[^/]*(/|$)" #"/\\.npmrc$" #"/\\.git(/|$)" #"/\\.claude(/|$)"))',
	].join("\n");
	if (input.signal?.aborted) throw new Error("Evaluator cancelled before launch");
	if (input.supervisor !== undefined) {
		const result = await runSupervisedEvaluator({
			supervisor: input.supervisor,
			executable: "/usr/bin/sandbox-exec",
			args: ["-p", profile, executable, ...input.args],
			cwd: scratch,
			env: { PATH: "/usr/bin:/bin", TMPDIR: scratch, LANG: "C", TZ: "UTC" },
			timeoutMs: input.timeoutMs,
			maximumOutputBytes: maximum,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		return {
			isolation: "macos-seatbelt-single-process-v1",
			...result,
			exitCode: result.exitCode ?? null,
			signal: result.signal === 0 ? null : result.signal,
			outputDigest: createHash("sha256").update(result.stdout).digest("hex"),
		};
	}
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, executable, ...input.args], {
			cwd: scratch,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// No inherited provider credentials, loader injection, HOME configuration or proxy settings.
			env: { PATH: "/usr/bin:/bin", TMPDIR: scratch, LANG: "C", TZ: "UTC" },
		});
		let bytes = 0;
		let timedOut = false;
		let cancelled = false;
		let outputExceeded = false;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const stop = () => {
			child.kill("SIGKILL");
		};
		const cancel = () => {
			cancelled = true;
			stop();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, input.timeoutMs);
		input.signal?.addEventListener("abort", cancel, { once: true });
		const collect = (target: Buffer[], data: Buffer) => {
			bytes += data.byteLength;
			if (bytes > maximum) {
				outputExceeded = true;
				stop();
				return;
			}
			target.push(data);
		};
		child.stdout.on("data", (data: Buffer) => collect(stdout, data));
		child.stderr.on("data", (data: Buffer) => collect(stderr, data));
		child.on("error", reject);
		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", cancel);
			const output = Buffer.concat(stdout);
			const error = Buffer.concat(stderr);
			resolve({
				isolation: "macos-seatbelt-single-process-v1",
				exitCode,
				signal,
				timedOut,
				cancelled,
				outputExceeded,
				stdout: output.toString("utf8"),
				stderr: error.toString("utf8"),
				outputDigest: createHash("sha256").update(output).digest("hex"),
				durationMs: performance.now() - started,
			});
		});
	});
};
