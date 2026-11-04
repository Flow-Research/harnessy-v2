import { Schema } from "effect";
import * as Effect from "effect/Effect";

import { CapabilityEntry } from "../capabilities/source.ts";
import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { toTargetRelative } from "../paths.ts";
import { defaultInstallPaths, InstallPaths } from "./install-paths.ts";

/** Project-local lockfile schema. */
export class HarnessLockfile extends Schema.Class<HarnessLockfile>("HarnessLockfile")({
	/** Lockfile schema version. */
	version: Schema.Literal(1),
	/** Harness directory path, usually relative to the target project. */
	harnessDir: Schema.String,
	/** Context vault directory path, usually relative to the target project. */
	contextDir: Schema.String,
	/** Active profile path, usually relative to the target project. */
	profile: Schema.String,
	/** V1-compatible install destination choices saved for repeat installs. */
	installPaths: Schema.optional(InstallPaths),
	/** Capabilities recorded for this project. */
	capabilities: Schema.Array(CapabilityEntry),
}) {}

/** Decode lockfile text with Effect Schema instead of handwritten shape probing. */
const HarnessLockfileJson = Schema.fromJsonString(HarnessLockfile);

/** Create the initial empty lockfile for a freshly initialized project. */
export const emptyLockfile = Effect.fn("HarnessLockfile.empty")(function* (
	paths: HarnessPaths,
	installPaths?: InstallPaths,
) {
	const harnessDir = yield* toTargetRelative(paths.targetDir, paths.harnessDir);
	const contextDir = yield* toTargetRelative(paths.targetDir, paths.contextDir);
	const profile = yield* toTargetRelative(paths.targetDir, paths.defaultProfile);
	const resolvedInstallPaths = installPaths ?? (yield* defaultInstallPaths(paths));
	return new HarnessLockfile({
		version: 1,
		harnessDir,
		contextDir,
		profile,
		installPaths: resolvedInstallPaths,
		capabilities: [],
	});
});

/** Parse and validate lockfile text as an Effect. */
export const parseLockfile = Effect.fn("HarnessLockfile.parse")(function* (raw: string, sourcePath: string) {
	return yield* Schema.decodeUnknownEffect(HarnessLockfileJson)(raw).pipe(
		Effect.mapError(
			(cause) =>
				new HarnessError({
					message: `Invalid Harnessy lockfile ${sourcePath}: ${causeMessage(cause)}`,
					cause,
				}),
		),
	);
});

/** Format lockfiles with stable JSON output. */
export const formatLockfile = (lockfile: HarnessLockfile): string => `${JSON.stringify(lockfile, null, "\t")}\n`;

/** Format arbitrary manifest JSON with the same stable style as the lockfile. */
export const formatManifestJson = (value: unknown): string => `${JSON.stringify(value, null, "\t")}\n`;
