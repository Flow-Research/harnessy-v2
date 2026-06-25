import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/**
 * A recording, in-memory {@link ChildProcessSpawner} for deterministic tests.
 *
 * Mirrors the opencode test pattern: swap the real spawner for a fake that
 * records every command and returns canned output, so tests never run real
 * binaries, never hit the network, and never flake on tool availability or
 * timing. The `calls` array captures each spawn in order.
 */
export interface RecordedSpawn {
	readonly executable: string;
	readonly args: ReadonlyArray<string>;
	readonly cwd: string | undefined;
	readonly env: Record<string, string | undefined> | undefined;
}

/** Canned response for a single spawned command. */
export interface FakeResponse {
	/** Exit code to report. Defaults to 0. */
	readonly exitCode?: number;
	/** stdout bytes to emit. */
	readonly stdout?: string;
	/** stderr bytes to emit. */
	readonly stderr?: string;
	/** When set, the spawn itself fails (e.g. executable not found) with this message. */
	readonly spawnError?: string;
}

export interface FakeSpawner {
	/** Layer providing the recording spawner in place of the real platform one. */
	readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
	/** Commands recorded so far, in spawn order. */
	readonly calls: ReadonlyArray<RecordedSpawn>;
}

const encoder = new TextEncoder();

const unwrap = (command: ChildProcess.Command): ChildProcess.StandardCommand | undefined => {
	let current = command;
	while (!ChildProcess.isStandardCommand(current)) {
		current = current.left;
	}
	return current;
};

/**
 * Build a recording fake spawner.
 *
 * @param handler maps each recorded spawn to a canned response (default: exit 0, no output).
 */
export const makeFakeSpawner = (handler: (call: RecordedSpawn) => FakeResponse = () => ({})): FakeSpawner => {
	const calls: Array<RecordedSpawn> = [];
	const spawner = ChildProcessSpawner.make((command) => {
		const standard = unwrap(command);
		const recorded: RecordedSpawn = {
			executable: standard?.command ?? "",
			args: standard?.args ?? [],
			cwd: standard?.options.cwd,
			env: standard?.options.env,
		};
		calls.push(recorded);

		const response = handler(recorded);
		if (response.spawnError !== undefined) {
			return Effect.fail(
				PlatformError.systemError({
					_tag: "NotFound",
					module: "ChildProcess",
					method: "spawn",
					description: response.spawnError,
				}),
			);
		}

		const stdout = response.stdout ?? "";
		const stderr = response.stderr ?? "";
		return Effect.succeed(
			ChildProcessSpawner.makeHandle({
				pid: ChildProcessSpawner.ProcessId(4242),
				exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode ?? 0)),
				isRunning: Effect.succeed(false),
				kill: () => Effect.void,
				stdin: Sink.drain,
				stdout: stdout === "" ? Stream.empty : Stream.make(encoder.encode(stdout)),
				stderr: stderr === "" ? Stream.empty : Stream.make(encoder.encode(stderr)),
				all: Stream.make(encoder.encode(stdout + stderr)),
				getInputFd: () => Sink.drain,
				getOutputFd: () => Stream.empty,
				unref: Effect.succeed(Effect.void),
			}),
		);
	});

	return {
		layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
		get calls() {
			return calls;
		},
	};
};
