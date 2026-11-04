import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import {
	capabilitiesReadmeTemplate,
	contextTemplate,
	memoryReadmeTemplate,
	memoryScopesRegistryTemplate,
	memoryScopeTemplate,
	profileTemplate,
} from "./templates.ts";

/** Presence checks for files Harnessy owns inside `.harnessy`. */
export interface GeneratedFileStatus {
	/** Whether the `.harnessy` directory exists. */
	readonly harnessDirExists: boolean;
	/** Whether `.harnessy/context/AGENTS.md` exists. */
	readonly contextExists: boolean;
	/** Whether `.harnessy/profiles/default.json` exists. */
	readonly profileExists: boolean;
	/** Whether `.harnessy/capabilities` exists. */
	readonly capabilitiesDirExists: boolean;
	/** Whether `.harnessy/memory` exists. */
	readonly memoryDirExists: boolean;
}

/** Result of installing or refreshing generated Harnessy project files. */
export interface GeneratedFileInstallResult {
	/** Absolute file paths written during this install pass. */
	readonly written: ReadonlyArray<string>;
}

/** Installs and inspects Harnessy-owned generated project files. */
export class GeneratedFiles extends Context.Service<
	GeneratedFiles,
	{
		/** Ensure directories and starter files exist, respecting `force` for existing files. */
		readonly install: (
			paths: HarnessPaths,
			force: boolean,
		) => Effect.Effect<GeneratedFileInstallResult, HarnessError>;
		/** Ensure only scoped memory files exist, respecting `force` for existing files. */
		readonly installMemory: (
			paths: HarnessPaths,
			force: boolean,
		) => Effect.Effect<GeneratedFileInstallResult, HarnessError>;
		/** Inspect generated file presence without mutating the project. */
		readonly inspect: (paths: HarnessPaths) => Effect.Effect<GeneratedFileStatus, HarnessError>;
	}
>()("@harnessy/core/GeneratedFiles") {
	/** Live file installer backed by Effect's platform filesystem and path services. */
	static readonly layer = Layer.effect(
		GeneratedFiles,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			/** Check filesystem existence and report inspection failures consistently. */
			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			/** Create one directory recursively with Harnessy error mapping. */
			const makeDirectory = (directory: string) =>
				fs
					.makeDirectory(directory, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${directory}`, cause)));

			/** Write a generated file unless it exists and the caller did not request force. */
			const writeFileIfMissing = (filePath: string, content: string, force: boolean) =>
				Effect.gen(function* () {
					const alreadyExists = yield* exists(filePath);
					if (alreadyExists && !force) return false;
					yield* fs
						.writeFileString(filePath, content)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${filePath}`, cause)));
					return true;
				});

			const installMemory = Effect.fn("GeneratedFiles.installMemory")(function* (
				paths: HarnessPaths,
				force: boolean,
			) {
				yield* makeDirectory(paths.memoryDir);
				const memoryReadmePath = path.join(paths.memoryDir, "README.md");
				const memoryScopesPath = path.join(paths.memoryDir, "_scopes.yaml");
				const orgMemoryPath = path.join(paths.memoryDir, "org.md");
				const projectMemoryPath = path.join(paths.memoryDir, "project.md");
				const decisionsMemoryPath = path.join(paths.memoryDir, "decisions.md");
				const eventsMemoryPath = path.join(paths.memoryDir, "events.md");
				const wroteMemoryReadme = yield* writeFileIfMissing(memoryReadmePath, memoryReadmeTemplate, force);
				const wroteMemoryScopes = yield* writeFileIfMissing(memoryScopesPath, memoryScopesRegistryTemplate, force);
				const wroteOrgMemory = yield* writeFileIfMissing(
					orgMemoryPath,
					memoryScopeTemplate("Organization Memory"),
					force,
				);
				const wroteProjectMemory = yield* writeFileIfMissing(
					projectMemoryPath,
					memoryScopeTemplate("Project Memory"),
					force,
				);
				const wroteDecisionsMemory = yield* writeFileIfMissing(
					decisionsMemoryPath,
					memoryScopeTemplate("Decisions"),
					force,
				);
				const wroteEventsMemory = yield* writeFileIfMissing(eventsMemoryPath, memoryScopeTemplate("Events"), force);
				const written = [
					wroteMemoryReadme ? memoryReadmePath : null,
					wroteMemoryScopes ? memoryScopesPath : null,
					wroteOrgMemory ? orgMemoryPath : null,
					wroteProjectMemory ? projectMemoryPath : null,
					wroteDecisionsMemory ? decisionsMemoryPath : null,
					wroteEventsMemory ? eventsMemoryPath : null,
				].filter((filePath): filePath is string => filePath !== null);
				return { written } satisfies GeneratedFileInstallResult;
			});

			const install = Effect.fn("GeneratedFiles.install")(function* (paths: HarnessPaths, force: boolean) {
				yield* makeDirectory(paths.contextDir);
				yield* makeDirectory(paths.profilesDir);
				yield* makeDirectory(paths.capabilitiesDir);

				const capabilitiesReadmePath = path.join(paths.capabilitiesDir, "README.md");
				const wroteContext = yield* writeFileIfMissing(paths.contextAgentsFile, contextTemplate, force);
				const wroteProfile = yield* writeFileIfMissing(paths.defaultProfile, profileTemplate, force);
				const wroteCapabilitiesReadme = yield* writeFileIfMissing(
					capabilitiesReadmePath,
					capabilitiesReadmeTemplate,
					force,
				);
				const memory = yield* installMemory(paths, force);
				const written = [
					wroteContext ? paths.contextAgentsFile : null,
					wroteProfile ? paths.defaultProfile : null,
					wroteCapabilitiesReadme ? capabilitiesReadmePath : null,
					...memory.written,
				].filter((filePath): filePath is string => filePath !== null);
				return { written } satisfies GeneratedFileInstallResult;
			});

			const inspect = Effect.fn("GeneratedFiles.inspect")(function* (paths: HarnessPaths) {
				const harnessDirExists = yield* exists(paths.harnessDir);
				const contextExists = yield* exists(paths.contextAgentsFile);
				const profileExists = yield* exists(paths.defaultProfile);
				const capabilitiesDirExists = yield* exists(paths.capabilitiesDir);
				const memoryDirExists = yield* exists(paths.memoryDir);
				return {
					harnessDirExists,
					contextExists,
					profileExists,
					capabilitiesDirExists,
					memoryDirExists,
				} satisfies GeneratedFileStatus;
			});

			return { install, installMemory, inspect };
		}),
	);
}
