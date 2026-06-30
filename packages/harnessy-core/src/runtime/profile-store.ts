import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { expandHomePath } from "../paths.ts";
import { type HarnessProfile, parseProfile } from "./profile.ts";

/** Result of verifying a Harnessy profile and its referenced context and memory files. */
export interface ProfileVerification {
	/** Parsed default profile. */
	readonly profile: HarnessProfile;
	/** Profile context/memory issues gathered in one pass. Empty means success. */
	readonly issues: ReadonlyArray<string>;
}

/** Reads and verifies runtime profile files. */
export class ProfileStore extends Context.Service<
	ProfileStore,
	{
		/** Read and validate the target project's default profile. */
		readonly readDefault: (paths: HarnessPaths) => Effect.Effect<HarnessProfile, HarnessError>;
		/** Verify the default profile and every context or memory path it references. */
		readonly verifyDefault: (paths: HarnessPaths) => Effect.Effect<ProfileVerification, HarnessError>;
	}
>()("@harnessy/core/ProfileStore") {
	/** Live profile store backed by platform filesystem and path services. */
	static readonly layer = Layer.effect(
		ProfileStore,
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

			/** Resolve profile paths from target-relative, absolute, or home-relative syntax. */
			const resolveProfilePath = (paths: HarnessPaths, profilePath: string) =>
				Effect.gen(function* () {
					const expanded = yield* expandHomePath(profilePath);
					return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(paths.targetDir, expanded);
				}).pipe(Effect.provideService(Path.Path, path));

			/** Verify profile-referenced files in declaration order for deterministic issue output. */
			const verifyReferencedPaths = Effect.fn("ProfileStore.verifyReferencedPaths")(function* (
				paths: HarnessPaths,
				profilePaths: ReadonlyArray<string>,
				missingMessage: string,
			) {
				const issues: Array<string> = [];
				for (const profilePath of profilePaths) {
					const resolved = yield* resolveProfilePath(paths, profilePath);
					if (!(yield* exists(resolved))) issues.push(`${missingMessage}: ${profilePath}`);
				}
				return issues;
			});

			const readDefault = Effect.fn("ProfileStore.readDefault")(function* (paths: HarnessPaths) {
				if (!(yield* exists(paths.defaultProfile))) {
					return yield* new HarnessError({ message: `Missing Harnessy profile: ${paths.defaultProfile}` });
				}
				const raw = yield* fs
					.readFileString(paths.defaultProfile)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${paths.defaultProfile}`, cause)));
				return yield* parseProfile(raw, paths.defaultProfile);
			});

			const verifyDefault = Effect.fn("ProfileStore.verifyDefault")(function* (paths: HarnessPaths) {
				const profile = yield* readDefault(paths);
				const contextIssues = yield* verifyReferencedPaths(
					paths,
					profile.context,
					"Profile context path does not exist",
				);
				const memoryIssues = yield* verifyReferencedPaths(
					paths,
					profile.memory ?? [],
					"Profile memory path does not exist",
				);
				return { profile, issues: [...contextIssues, ...memoryIssues] } satisfies ProfileVerification;
			});

			return { readDefault, verifyDefault };
		}),
	);
}
