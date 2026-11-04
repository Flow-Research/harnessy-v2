import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import { RuntimeEnvironment } from "./environment.ts";

/** Build PATH lookup candidates for a command on the current platform. */
export const executableCandidates = (
	command: string,
	executableExtensions: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	if (executableExtensions.length === 0 || /\.[^\\/]+$/.test(command)) return [command];

	const candidates = new Set<string>([command]);
	for (const extension of executableExtensions) {
		if (extension.length === 0) continue;
		const normalized = extension.startsWith(".") ? extension : `.${extension}`;
		candidates.add(`${command}${normalized}`);
		candidates.add(`${command}${normalized.toLowerCase()}`);
		candidates.add(`${command}${normalized.toUpperCase()}`);
	}
	return [...candidates];
};

/** Shared executable lookup for PATH-based checks. Never invokes a shell. */
export class CommandLookup extends Context.Service<
	CommandLookup,
	{
		/** True when the command resolves to an executable file on PATH. */
		readonly commandAvailable: (command: string) => Effect.Effect<boolean, HarnessError>;
	}
>()("@harnessy/core/CommandLookup") {
	/** Live lookup backed by platform filesystem, path, and environment services. */
	static readonly layer = Layer.effect(
		CommandLookup,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const environment = yield* RuntimeEnvironment;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const isExecutableFile = (filePath: string) =>
				Effect.gen(function* () {
					const exists = yield* fs
						.exists(filePath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));
					if (!exists) return false;
					const stat = yield* fs
						.stat(filePath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)));
					return stat.type === "File" && (stat.mode & 0o111) !== 0;
				});

			const commandAvailable = Effect.fn("CommandLookup.commandAvailable")(function* (command: string) {
				const pathEntries = yield* environment.pathEntries;
				const extensions = yield* environment.executableExtensions;
				for (const pathEntry of pathEntries) {
					for (const candidate of executableCandidates(command, extensions)) {
						if (yield* isExecutableFile(path.join(pathEntry, candidate))) return true;
					}
				}
				return false;
			});

			return { commandAvailable };
		}),
	);
}
