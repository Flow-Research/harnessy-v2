import { lstat, mkdtemp, opendir, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HarnessyCommandWorkload } from "./command-workload.ts";
import type { EvaluationIsolationAdapter } from "./evaluator-host.ts";
import type { MacosOperationAdapterOptions } from "./evaluator-macos.ts";
import { runSingleProcessEvaluation } from "./sandbox.ts";

async function boundedScratch(scratch: string, workload: HarnessyCommandWorkload, signal?: AbortSignal) {
	const current = () => {
		if (signal?.aborted) throw new Error("Command fixture readback cancelled");
	};
	const expected = workload.profile === "local-status" ? workload.cases : [];
	const inspect = async (path: string, names: ReadonlyArray<string>, directories: boolean) => {
		current();
		const stat = await lstat(path);
		if (
			!stat.isDirectory() ||
			(await realpath(path)) !== path ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0
		)
			throw new Error("Command scratch directory changed");
		const directory = await opendir(path, { bufferSize: 32 });
		const found = new Set<string>();
		try {
			for (;;) {
				current();
				const entry = await directory.read();
				current();
				if (entry === null) break;
				if (
					found.size >= names.length ||
					!names.includes(entry.name) ||
					found.has(entry.name) ||
					entry.isSymbolicLink() ||
					(directories ? !entry.isDirectory() : !entry.isFile())
				)
					throw new Error("Command scratch inventory exceeded the fixed fixture");
				found.add(entry.name);
			}
		} finally {
			await directory.close();
		}
		if (found.size !== names.length) throw new Error("Command scratch fixture is incomplete");
	};
	await inspect(scratch, expected, true);
	for (const name of expected) await inspect(join(scratch, name), ["state.sqlite"], false);
}

/** Fixed commands only. Fixture setup and readback run in the controller, outside candidate authority. */
export function macosCommandIsolation(
	options: MacosOperationAdapterOptions,
	workload: HarnessyCommandWorkload,
): EvaluationIsolationAdapter {
	return {
		execute: async (request) => {
			if (
				request.invocation.argv.length !== 2 ||
				request.invocation.argv[0] !== "harnessy-pinned-commands" ||
				request.invocation.argv[1] !== request.invocation.kind
			)
				throw new Error("Only fixed Harnessy command workloads are supported");
			if (dirname(request.evaluator.path) !== dirname(request.workload.path))
				throw new Error("Command artifacts need one private root");
			if (options.signal?.aborted) throw new Error("Command evaluator cancelled before fixture preparation");
			const scratch = await realpath(await mkdtemp(join(await realpath(options.scratchRoot), "commands-")));
			try {
				await workload.prepareScratch(scratch);
				if (options.signal?.aborted) throw new Error("Command evaluator cancelled during fixture preparation");
				const result = await runSingleProcessEvaluation({
					executable: options.executable,
					args: [
						"--experimental-strip-types",
						request.evaluator.path,
						request.sourceRoot,
						request.workload.path,
						request.invocation.kind,
					],
					sourceRoots: [request.sourceRoot, ...(options.additionalReadRoots ?? [])],
					evaluatorRoot: dirname(request.evaluator.path),
					scratch,
					deniedRoots: options.deniedRoots,
					timeoutMs: options.timeoutMs,
					maximumOutputBytes: 1024 * 1024,
					signal: options.signal,
					supervisor: options.supervisor,
				});
				if (options.signal?.aborted) throw new Error("Command evaluator cancelled before fixture readback");
				if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.outputExceeded)
					throw new Error("Fixed Harnessy command workload failed before semantic validation", {
						cause: result.stderr.slice(-2048),
					});
				await boundedScratch(scratch, workload, options.signal);
				await workload.validateScratch(scratch);
				return {
					exitCode: result.exitCode ?? undefined,
					stdout: result.stdout,
					stderr: result.stderr,
					timedOut: result.timedOut || result.cancelled || result.outputExceeded,
					...(result.resources ? { resources: result.resources } : {}),
				};
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		},
	};
}
