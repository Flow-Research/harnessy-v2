import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { formatManifestJson } from "../runtime/lockfile.ts";
import { CapabilityFingerprinter } from "./fingerprint.ts";
import { CAPABILITY_MANIFEST_NAME, type CapabilityResource, CapabilityResourceKind } from "./manifest.ts";
import { isPathWithin, requireNoSymlinkComponents, requireNoSymlinkLeaf } from "./path-safety.ts";
import { CapabilityArtifactMetadata, type CapabilityEntry, localCapabilityPath, makeCapabilitySlug } from "./source.ts";

/** A manifest resource copied into a capability artifact. */
export class CapabilityMaterializedResource extends Schema.Class<CapabilityMaterializedResource>(
	"CapabilityMaterializedResource",
)({
	kind: CapabilityResourceKind,
	path: Schema.String,
	target: Schema.String,
	sourcePath: Schema.String,
	targetPath: Schema.String,
}) {}

/** Retained for backward-safe structured output parsing; successful installs never skip resources. */
export class CapabilitySkippedResource extends Schema.Class<CapabilitySkippedResource>("CapabilitySkippedResource")({
	kind: CapabilityResourceKind,
	path: Schema.String,
	target: Schema.String,
	reason: Schema.String,
}) {}

/** Result of atomically installing one local capability pack. */
export class CapabilityMaterializationResult extends Schema.Class<CapabilityMaterializationResult>(
	"CapabilityMaterializationResult",
)({
	capabilityId: Schema.String,
	artifactDir: Schema.String,
	packageDir: Schema.String,
	artifact: CapabilityArtifactMetadata,
	copied: Schema.Array(CapabilityMaterializedResource),
	skipped: Schema.Array(CapabilitySkippedResource),
	issues: Schema.Array(Schema.String),
}) {}

export interface CapabilityMaterializeOptions {
	readonly dryRun?: boolean;
	readonly refresh?: boolean;
}

interface PreparedResource {
	readonly resource: CapabilityResource;
	readonly target: string;
	readonly sourcePath: string;
}

const pathsCollide = (left: string, right: string): boolean =>
	left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

/** Atomically installs local capability packs into canonical package and projection views. */
export class CapabilityMaterializer extends Context.Service<
	CapabilityMaterializer,
	{
		readonly materialize: (
			paths: HarnessPaths,
			capability: CapabilityEntry,
			options?: CapabilityMaterializeOptions,
		) => Effect.Effect<CapabilityMaterializationResult, HarnessError>;
	}
>()("@harnessy/core/CapabilityMaterializer") {
	static readonly layer = Layer.effect(
		CapabilityMaterializer,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const fingerprinter = yield* CapabilityFingerprinter;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			const stat = (filePath: string) =>
				fs.stat(filePath).pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)));

			const makeDirectory = (directory: string) =>
				fs
					.makeDirectory(directory, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${directory}`, cause)));

			const remove = (filePath: string) =>
				fs
					.remove(filePath, { recursive: true, force: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not remove ${filePath}`, cause)));

			const copy = (sourcePath: string, targetPath: string) =>
				fs
					.copy(sourcePath, targetPath, { overwrite: false, preserveTimestamps: true })
					.pipe(
						Effect.mapError((cause) => mapPlatformError(`Could not copy ${sourcePath} to ${targetPath}`, cause)),
					);

			const markExecutable = Effect.fn("CapabilityMaterializer.markExecutable")(function* (targetPath: string) {
				const targetStat = yield* stat(targetPath);
				if (targetStat.type !== "File" && targetStat.type !== "Directory") return;
				yield* fs
					.chmod(targetPath, targetStat.mode | 0o111)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not chmod ${targetPath}`, cause)));
			});

			const replaceDirectory = Effect.fn("CapabilityMaterializer.replaceDirectory")(function* (
				candidate: string,
				destination: string,
				refresh: boolean,
			) {
				const destinationExists = yield* exists(destination);
				if (destinationExists && !refresh) {
					return yield* new HarnessError({
						message: `Capability artifact already exists: ${destination}. Use --refresh to replace it.`,
					});
				}
				if (!destinationExists) {
					yield* fs
						.rename(candidate, destination)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not install ${destination}`, cause)));
					return;
				}

				const backup = yield* fs
					.makeTempDirectory({
						directory: path.dirname(destination),
						prefix: `.${path.basename(destination)}.backup-`,
					})
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stage backup for ${destination}`, cause)));
				yield* remove(backup);
				yield* fs
					.rename(destination, backup)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not back up ${destination}`, cause)));
				yield* fs.rename(candidate, destination).pipe(
					Effect.mapError((cause) => mapPlatformError(`Could not install ${destination}`, cause)),
					Effect.catch((error) =>
						fs.rename(backup, destination).pipe(
							Effect.mapError((cause) => mapPlatformError(`Could not restore ${destination}`, cause)),
							Effect.andThen(Effect.fail(error)),
						),
					),
				);
				yield* remove(backup).pipe(Effect.ignore);
			});

			const prepareResources = Effect.fn("CapabilityMaterializer.prepareResources")(function* (
				sourceRoot: string,
				capability: CapabilityEntry,
			) {
				const resources = capability.manifest?.resources ?? [];
				const prepared: Array<PreparedResource> = [];
				for (const resource of resources) {
					const sourcePath = path.resolve(sourceRoot, resource.path);
					if (!isPathWithin(path, sourceRoot, sourcePath)) {
						return yield* new HarnessError({
							message: `Capability ${capability.id} resource source escapes its pack: ${resource.path}`,
						});
					}
					if (!(yield* exists(sourcePath))) {
						return yield* new HarnessError({
							message: `Capability ${capability.id} resource does not exist: ${resource.path}`,
						});
					}
					yield* requireNoSymlinkComponents(
						fs,
						path,
						sourceRoot,
						sourcePath,
						`Capability resource ${resource.path}`,
					);
					const sourceStat = yield* stat(sourcePath);
					if (sourceStat.type !== "File" && sourceStat.type !== "Directory") {
						return yield* new HarnessError({
							message: `Capability ${capability.id} resource is not a file or directory: ${resource.path}`,
						});
					}
					const target = resource.target ?? resource.path;
					for (const previous of prepared) {
						if (pathsCollide(previous.resource.path, resource.path)) {
							return yield* new HarnessError({
								message: `Capability ${capability.id} has colliding package paths: ${previous.resource.path} and ${resource.path}`,
							});
						}
						if (pathsCollide(previous.target, target)) {
							return yield* new HarnessError({
								message: `Capability ${capability.id} has colliding projection targets: ${previous.target} and ${target}`,
							});
						}
					}
					if (
						resource.path === CAPABILITY_MANIFEST_NAME ||
						resource.path.startsWith(`${CAPABILITY_MANIFEST_NAME}/`)
					) {
						return yield* new HarnessError({
							message: `Capability ${capability.id} resource collides with its manifest: ${resource.path}`,
						});
					}
					prepared.push({ resource, target, sourcePath });
				}
				return prepared;
			});

			const materialize = Effect.fn("CapabilityMaterializer.materialize")(function* (
				paths: HarnessPaths,
				capability: CapabilityEntry,
				options: CapabilityMaterializeOptions = {},
			) {
				const dryRun = options.dryRun === true;
				const refresh = options.refresh === true;
				if (capability.source.type !== "local") {
					return yield* new HarnessError({
						message: `Capability source ${capability.source.type}:${capability.source.value} is unresolved; remote fetching is not supported. Add a local exported pack instead.`,
					});
				}
				if (capability.manifest === undefined) {
					return yield* new HarnessError({ message: `Capability ${capability.id} has no validated manifest.` });
				}
				if (capability.manifest.id !== capability.id) {
					return yield* new HarnessError({
						message: `Capability manifest id ${capability.manifest.id} does not match installed id ${capability.id}.`,
					});
				}

				const localRoot = yield* localCapabilityPath(paths.targetDir, capability.source).pipe(
					Effect.provideService(Path.Path, path),
				);
				if (localRoot === null || !(yield* exists(localRoot))) {
					return yield* new HarnessError({
						message: `Local capability source path does not exist: ${localRoot ?? capability.source.value}`,
					});
				}
				const sourceRoot = path.resolve(localRoot);
				yield* requireNoSymlinkLeaf(fs, path, sourceRoot, `Capability source ${capability.id}`);
				const sourceStat = yield* stat(sourceRoot);
				if (sourceStat.type !== "Directory") {
					return yield* new HarnessError({ message: `Capability source must be a directory: ${sourceRoot}` });
				}

				const artifactDir = path.join(paths.capabilitiesDir, makeCapabilitySlug(capability.id));
				const packageDir = path.join(artifactDir, "package");
				if (isPathWithin(path, sourceRoot, artifactDir) || isPathWithin(path, artifactDir, sourceRoot)) {
					return yield* new HarnessError({
						message: `Capability source and installed artifact must not overlap: ${sourceRoot}`,
					});
				}
				yield* requireNoSymlinkComponents(
					fs,
					path,
					paths.targetDir,
					artifactDir,
					`Capability artifact ${capability.id}`,
				);

				const sourceFingerprint = yield* fingerprinter.fingerprintPath(sourceRoot);
				if (sourceFingerprint.issues.length > 0) {
					return yield* new HarnessError({
						message: `Capability source ${capability.id} is unsafe: ${sourceFingerprint.issues.join("; ")}`,
					});
				}
				if (
					capability.fingerprint !== undefined &&
					(sourceFingerprint.sha256 !== capability.fingerprint.sha256 ||
						sourceFingerprint.bytes !== capability.fingerprint.bytes ||
						sourceFingerprint.files.length !== capability.fingerprint.fileCount)
				) {
					return yield* new HarnessError({
						message: `Capability source changed after validation: ${sourceRoot}`,
					});
				}
				const prepared = yield* prepareResources(sourceRoot, capability);
				const capabilitiesDirectoryExists = yield* exists(paths.capabilitiesDir);
				if (!dryRun) yield* makeDirectory(paths.capabilitiesDir);
				const stageDir = yield* fs
					.makeTempDirectory({
						...(capabilitiesDirectoryExists || !dryRun ? { directory: paths.capabilitiesDir } : {}),
						prefix: `.${makeCapabilitySlug(capability.id)}.stage-`,
					})
					.pipe(
						Effect.mapError((cause) => mapPlatformError(`Could not stage capability ${capability.id}`, cause)),
					);

				return yield* Effect.gen(function* () {
					const stagePackageDir = path.join(stageDir, "package");
					const stageResourcesDir = path.join(stageDir, "resources");
					yield* makeDirectory(stagePackageDir);
					yield* makeDirectory(stageResourcesDir);
					yield* fs
						.writeFileString(
							path.join(stagePackageDir, CAPABILITY_MANIFEST_NAME),
							formatManifestJson(capability.manifest),
						)
						.pipe(
							Effect.mapError((cause) =>
								mapPlatformError(`Could not stage manifest for ${capability.id}`, cause),
							),
						);

					const copied: Array<CapabilityMaterializedResource> = [];
					for (const item of prepared) {
						const packagePath = path.join(stagePackageDir, item.resource.path);
						const targetPath = path.join(stageResourcesDir, item.target);
						yield* makeDirectory(path.dirname(packagePath));
						yield* makeDirectory(path.dirname(targetPath));
						yield* copy(item.sourcePath, packagePath);
						yield* copy(item.sourcePath, targetPath);
						if (item.resource.executable === true) {
							yield* markExecutable(packagePath);
							yield* markExecutable(targetPath);
						}
						copied.push(
							new CapabilityMaterializedResource({
								kind: item.resource.kind,
								path: item.resource.path,
								target: item.target,
								sourcePath: item.sourcePath,
								targetPath: path.join(artifactDir, "resources", item.target),
							}),
						);
					}

					const stagedFingerprint = yield* fingerprinter.fingerprintPath(stageDir);
					if (stagedFingerprint.issues.length > 0) {
						return yield* new HarnessError({
							message: `Staged artifact for ${capability.id} is unsafe: ${stagedFingerprint.issues.join("; ")}`,
						});
					}
					const sourceAfter = yield* fingerprinter.fingerprintPath(sourceRoot);
					if (sourceAfter.issues.length > 0 || sourceAfter.sha256 !== sourceFingerprint.sha256) {
						return yield* new HarnessError({
							message: `Capability source changed while installing: ${sourceRoot}`,
						});
					}

					const artifact = new CapabilityArtifactMetadata({
						path: path.relative(paths.targetDir, artifactDir).replaceAll("\\", "/"),
						sha256: stagedFingerprint.sha256,
						bytes: stagedFingerprint.bytes,
						fileCount: stagedFingerprint.files.length,
					});
					if (!dryRun) yield* replaceDirectory(stageDir, artifactDir, refresh);
					return new CapabilityMaterializationResult({
						capabilityId: capability.id,
						artifactDir,
						packageDir,
						artifact,
						copied,
						skipped: [],
						issues: [],
					});
				}).pipe(Effect.ensuring(remove(stageDir).pipe(Effect.ignore)));
			});

			return { materialize };
		}),
	).pipe(Layer.provide(CapabilityFingerprinter.layer));
}
