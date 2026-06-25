import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { causeMessage, type HarnessError } from "./errors.ts";

/**
 * A single external command to execute.
 *
 * Commands are always described as an explicit argv array — an executable plus
 * a list of already-split arguments. We never accept a shell string, so there
 * is no shell parsing, word-splitting, globbing, or `&&`/`|` interpretation:
 * piped or compound v1 commands (e.g. `curl ... | sh`) are intentionally not
 * representable here and stay manual/plan-only.
 */
export interface ExternalCommand {
	/** Stable identifier tying the result back to the planned action. */
	readonly id: string;
	/** Human-readable label. */
	readonly label: string;
	/** Executable resolved from PATH (no shell). */
	readonly executable: string;
	/** Already-split arguments. */
	readonly args: ReadonlyArray<string>;
	/** Working directory for the command. */
	readonly cwd?: string;
	/** Extra environment entries, merged over the parent environment. */
	readonly env?: Readonly<Record<string, string>>;
}

/** Outcome of attempting to run an external command. */
export const CommandRunStatus = Schema.Literals(["succeeded", "failed"]);
export type CommandRunStatus = typeof CommandRunStatus.Type;

/** Structured, captured result of running one external command. */
export class CommandRunResult extends Schema.Class<CommandRunResult>("CommandRunResult")({
	/** Identifier echoed from the requested command. */
	id: Schema.String,
	/** Human-readable label echoed from the requested command. */
	label: Schema.String,
	/** Display-only rendering of the argv (quoted where needed). Never executed. */
	command: Schema.String,
	/** Executable that was run. */
	executable: Schema.String,
	/** Arguments that were passed. */
	args: Schema.Array(Schema.String),
	/** Working directory used, when set. */
	cwd: Schema.optional(Schema.String),
	/** Process exit code, or undefined when the process could not be spawned. */
	exitCode: Schema.optional(Schema.Number),
	/** Captured stdout tail. */
	stdout: Schema.String,
	/** Captured stderr tail. */
	stderr: Schema.String,
	/** Whether the command exited 0 (`succeeded`) or failed to spawn / exited non-zero (`failed`). */
	status: CommandRunStatus,
	/** Spawn-level error message when the process could not start. */
	error: Schema.optional(Schema.String),
}) {}

/** Cap captured output so a chatty command cannot balloon the result. */
const MAX_CAPTURED_CHARS = 16 * 1024;

/**
 * Drain a text stream while keeping only the last {@link MAX_CAPTURED_CHARS}.
 * Folding as we go bounds memory to ~2× the cap even for a process that writes
 * megabytes — unlike materializing the whole output and truncating afterwards.
 */
const captureTail = <E>(stream: Stream.Stream<string, E>): Effect.Effect<string, E> =>
	Stream.runFold(
		stream,
		() => "",
		(accumulated, chunk) => {
			const combined = accumulated + chunk;
			return combined.length <= MAX_CAPTURED_CHARS ? combined : combined.slice(combined.length - MAX_CAPTURED_CHARS);
		},
	);

const SHELL_SAFE_ARG = /^[A-Za-z0-9_./:@%+=,-]+$/;

/** Quote one argv part for POSIX-shell copy/paste display. Display only — never parsed back. */
const shellQuote = (part: string): string => {
	if (part !== "" && SHELL_SAFE_ARG.test(part)) return part;
	return `'${part.replaceAll("'", "'\\''")}'`;
};

/** Render an argv as a copy-pasteable display string. Display only — never parsed back. */
export const displayCommand = (executable: string, args: ReadonlyArray<string>): string =>
	[executable, ...args].map(shellQuote).join(" ");

/**
 * Executes explicit argv external commands and captures their result.
 *
 * This service performs no gating of its own: callers decide whether and when
 * to run a command. It only ever runs what it is handed, as a direct argv
 * spawn through the injectable {@link ChildProcessSpawner} seam, so tests swap
 * in a recording spawner and never touch real binaries.
 */
export class CommandRunner extends Context.Service<
	CommandRunner,
	{
		/** Run one external command and return its captured result. Never throws on a non-zero exit. */
		readonly run: (command: ExternalCommand) => Effect.Effect<CommandRunResult, HarnessError>;
	}
>()("@harnessy/core/CommandRunner") {
	/** Live runner backed by the platform child-process spawner. */
	static readonly layer = Layer.effect(
		CommandRunner,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

			const run = Effect.fn("CommandRunner.run")(function* (command: ExternalCommand) {
				const display = displayCommand(command.executable, command.args);
				const spec = ChildProcess.make(command.executable, [...command.args], {
					cwd: command.cwd,
					...(command.env === undefined ? {} : { env: { ...command.env }, extendEnv: true }),
				});

				// Drain stdout/stderr concurrently with awaiting the exit code so a full
				// pipe buffer cannot deadlock the process. A non-zero exit is a normal
				// value here; only a spawn failure (e.g. executable not found) errors,
				// which we capture as a failed result rather than propagating.
				const outcome = yield* Effect.scoped(
					Effect.gen(function* () {
						const handle = yield* spawner.spawn(spec);
						return yield* Effect.all(
							{
								exitCode: handle.exitCode,
								stdout: captureTail(Stream.decodeText(handle.stdout)),
								stderr: captureTail(Stream.decodeText(handle.stderr)),
							},
							{ concurrency: "unbounded" },
						);
					}),
				).pipe(
					Effect.map((result) => ({
						exitCode: Number(result.exitCode) as number | undefined,
						stdout: result.stdout,
						stderr: result.stderr,
						error: undefined as string | undefined,
					})),
					Effect.catch((cause) =>
						Effect.succeed({
							exitCode: undefined as number | undefined,
							stdout: "",
							stderr: "",
							error: causeMessage(cause),
						}),
					),
				);

				const status: CommandRunStatus =
					outcome.error === undefined && outcome.exitCode === 0 ? "succeeded" : "failed";

				return new CommandRunResult({
					id: command.id,
					label: command.label,
					command: display,
					executable: command.executable,
					args: [...command.args],
					cwd: command.cwd,
					exitCode: outcome.exitCode,
					stdout: outcome.stdout,
					stderr: outcome.stderr,
					status,
					error: outcome.error,
				});
			});

			return { run };
		}),
	);
}
