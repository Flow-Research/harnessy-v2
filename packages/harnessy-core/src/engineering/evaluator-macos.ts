import { mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EvaluationIsolationAdapter } from "./evaluator-host.ts";
import type { SupervisorArtifact } from "./evaluator-supervisor.ts";
import { runSingleProcessEvaluation } from "./sandbox.ts";

export interface MacosOperationAdapterOptions {
	readonly executable: string;
	readonly scratchRoot: string;
	readonly additionalReadRoots?: ReadonlyArray<string>;
	readonly deniedRoots: ReadonlyArray<string>;
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	readonly supervisor?: SupervisorArtifact;
}

/** Candidate code runs here. Protected semantic validation remains in the controller. */
export function macosOperationIsolation(options: MacosOperationAdapterOptions): EvaluationIsolationAdapter {
	return {
		execute: async (request) => {
			if (
				request.invocation.argv.length !== 2 ||
				request.invocation.argv[0] !== "harnessy-pinned-operations" ||
				request.invocation.argv[1] !== request.invocation.kind
			)
				throw new Error("Only the pinned Harnessy operation workload is supported by this adapter");
			if (dirname(request.evaluator.path) !== dirname(request.workload.path))
				throw new Error("Frozen evaluator and workload need one private artifact root");
			const scratch = await realpath(await mkdtemp(join(await realpath(options.scratchRoot), "evaluation-")));
			try {
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
				return {
					exitCode: result.exitCode ?? undefined,
					stdout: result.stdout,
					stderr: result.stderr,
					timedOut: result.timedOut || result.cancelled || result.outputExceeded,
					...(result.resources === undefined ? {} : { resources: result.resources }),
				};
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		},
	};
}
