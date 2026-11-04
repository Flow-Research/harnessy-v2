import { homedir } from "node:os";

import { Path } from "effect";
import * as Effect from "effect/Effect";

import {
	CAPABILITIES_DIR_NAME,
	CONTEXT_DIR_NAME,
	DEFAULT_HARNESS_DIR,
	LOCKFILE_NAME,
	MEMORY_DIR_NAME,
	PROFILES_DIR_NAME,
} from "./constants.ts";

/** Absolute paths derived for a target project. */
export interface HarnessPaths {
	/** Absolute target project directory. */
	readonly targetDir: string;
	/** Absolute Harnessy state directory. */
	readonly harnessDir: string;
	/** Absolute lockfile path. */
	readonly lockfile: string;
	/** Absolute context vault directory. */
	readonly contextDir: string;
	/** Absolute default context guidance file path. */
	readonly contextAgentsFile: string;
	/** Absolute profile directory. */
	readonly profilesDir: string;
	/** Absolute default profile path. */
	readonly defaultProfile: string;
	/** Absolute capability artifact directory. */
	readonly capabilitiesDir: string;
	/** Absolute scoped memory directory. */
	readonly memoryDir: string;
}

/** Expand a leading `~` segment without touching other path content. */
export const expandHomePath = Effect.fn("HarnessPaths.expandHomePath")(function* (input: string) {
	if (input === "~") return yield* Effect.sync(() => homedir());
	if (input.startsWith("~/")) {
		const home = yield* Effect.sync(() => homedir());
		const path = yield* Path.Path;
		return path.join(home, input.slice(2));
	}
	return input;
});

/** Resolve a CLI target argument to an absolute project directory. */
export const resolveTargetDir = Effect.fn("HarnessPaths.resolveTargetDir")(function* (target: string) {
	const path = yield* Path.Path;
	const expanded = yield* expandHomePath(target);
	return path.resolve(expanded);
});

/** Build every Harnessy path for a target directory and optional harness dir override. */
export const pathsForTarget = Effect.fn("HarnessPaths.pathsForTarget")(function* (
	targetDir: string,
	harnessDir = DEFAULT_HARNESS_DIR,
) {
	const path = yield* Path.Path;
	const harnessRoot = path.isAbsolute(harnessDir) ? harnessDir : path.join(targetDir, harnessDir);
	const contextDir = path.join(harnessRoot, CONTEXT_DIR_NAME);
	const profilesDir = path.join(harnessRoot, PROFILES_DIR_NAME);
	const capabilitiesDir = path.join(harnessRoot, CAPABILITIES_DIR_NAME);
	const memoryDir = path.join(harnessRoot, MEMORY_DIR_NAME);
	return {
		targetDir,
		harnessDir: harnessRoot,
		lockfile: path.join(harnessRoot, LOCKFILE_NAME),
		contextDir,
		contextAgentsFile: path.join(contextDir, "AGENTS.md"),
		profilesDir,
		defaultProfile: path.join(profilesDir, "default.json"),
		capabilitiesDir,
		memoryDir,
	};
});

/** Convert an absolute path to target-relative form when it stays inside the target. */
export const toTargetRelative = Effect.fn("HarnessPaths.toTargetRelative")(function* (
	targetDir: string,
	absolutePath: string,
) {
	const path = yield* Path.Path;
	const relative = path.relative(targetDir, absolutePath).replaceAll("\\", "/");
	return relative.startsWith("..") ? absolutePath : relative.length > 0 ? relative : ".";
});

/** Resolve user CLI target input into the full path set used by Harnessy operations. */
export const resolveTargetPaths = Effect.fn("HarnessPaths.resolveTargetPaths")(function* (target: string) {
	const targetDir = yield* resolveTargetDir(target);
	return yield* pathsForTarget(targetDir);
});
