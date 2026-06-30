import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { type CapabilityResource, CapabilityResourceKind } from "./manifest.ts";
import { type CapabilityEntry, localCapabilityPath, makeCapabilitySlug } from "./source.ts";

/** A manifest resource copied into a capability artifact. */
export class CapabilityMaterializedResource extends Schema.Class<CapabilityMaterializedResource>(
	"CapabilityMaterializedResource",
)({
	/** Resource family declared by the capability manifest. */
	kind: CapabilityResourceKind,
	/** Capability-root-relative source path declared by the manifest. */
	path: Schema.String,
	/** Artifact resources-relative target path used for materialization. */
	target: Schema.String,
	/** Absolute local source path copied from. */
	sourcePath: Schema.String,
	/** Absolute artifact path copied to. */
	targetPath: Schema.String,
}) {}

/** A manifest resource that was not copied, with a deterministic reason. */
export class CapabilitySkippedResource extends Schema.Class<CapabilitySkippedResource>("CapabilitySkippedResource")({
	/** Resource family declared by the capability manifest. */
	kind: CapabilityResourceKind,
	/** Capability-root-relative source path declared by the manifest. */
	path: Schema.String,
	/** Artifact resources-relative target path that would have been used. */
	target: Schema.String,
	/** User-facing reason the resource was skipped. */
	reason: Schema.String,
}) {}

/** Result of materializing one capability's local manifest resources. */
export class CapabilityMaterializationResult extends Schema.Class<CapabilityMaterializationResult>(
	"CapabilityMaterializationResult",
)({
	/** Stable capability id from the lockfile entry. */
	capabilityId: Schema.String,
	/** Absolute artifact directory for this capability. */
	artifactDir: Schema.String,
	/** Resources copied during this pass. */
	copied: Schema.Array(CapabilityMaterializedResource),
	/** Resources intentionally skipped without fetching or escaping path boundaries. */
	skipped: Schema.Array(CapabilitySkippedResource),
	/** User-facing materialization issues gathered during this pass. */
	issues: Schema.Array(Schema.String),
}) {}

/** Options for capability resource materialization. */
export interface CapabilityMaterializeOptions {
	/** Preview copies without writing files. */
	readonly dryRun?: boolean;
	/** Overwrite existing resource targets. */
	readonly refresh?: boolean;
}

/** Materializes local capability manifest resources into Harnessy artifacts. */
export class CapabilityMaterializer extends Context.Service<
	CapabilityMaterializer,
	{
		/** Copy local manifest resources into `.harnessy/capabilities/<safe-id>/resources`. */
		readonly materialize: (
			paths: HarnessPaths,
			capability: CapabilityEntry,
			options?: CapabilityMaterializeOptions,
		) => Effect.Effect<CapabilityMaterializationResult, HarnessError>;
	}
>()("@harnessy/core/CapabilityMaterializer") {
	/** Live materializer backed by Effect's platform filesystem and path services. */
	static readonly layer = Layer.effect(
		CapabilityMaterializer,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			/** True when child is equal to or nested under parent after path resolution. */
			const isWithin = (parent: string, child: string): boolean => {
				const relative = path.relative(parent, child);
				return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
			};

			/** Check filesystem existence and report inspection failures consistently. */
			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			/** Stat a path with Harnessy error mapping. */
			const stat = (filePath: string) =>
				fs.stat(filePath).pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)));

			/** Resolve a canonical path with Harnessy error mapping. */
			const realPath = (filePath: string) =>
				fs
					.realPath(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not resolve ${filePath}`, cause)));

			/** Create one directory recursively with Harnessy error mapping. */
			const makeDirectory = (directory: string) =>
				fs
					.makeDirectory(directory, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${directory}`, cause)));

			/** Copy a file or directory recursively with Harnessy error mapping. */
			const copyResource = (sourcePath: string, targetPath: string) =>
				fs
					.copy(sourcePath, targetPath, { overwrite: true })
					.pipe(
						Effect.mapError((cause) => mapPlatformError(`Could not copy ${sourcePath} to ${targetPath}`, cause)),
					);

			/** Ensure an explicitly executable resource can be invoked after copying. */
			const markExecutable = Effect.fn("CapabilityMaterializer.markExecutable")(function* (targetPath: string) {
				const targetStat = yield* stat(targetPath);
				if (targetStat.type !== "File" && targetStat.type !== "Directory") return;
				yield* fs
					.chmod(targetPath, targetStat.mode | 0o111)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not chmod ${targetPath}`, cause)));
			});

			/** Build a skipped resource entry and matching issue string. */
			const skippedResource = (
				capabilityId: string,
				resource: CapabilityResource,
				target: string,
				reason: string,
			) => ({
				skipped: new CapabilitySkippedResource({
					kind: resource.kind,
					path: resource.path,
					target,
					reason,
				}),
				issue: `Capability ${capabilityId} resource ${resource.path} skipped: ${reason}`,
			});

			const materialize = Effect.fn("CapabilityMaterializer.materialize")(function* (
				paths: HarnessPaths,
				capability: CapabilityEntry,
				options: CapabilityMaterializeOptions = {},
			) {
				const dryRun = options.dryRun === true;
				const refresh = options.refresh === true;
				const artifactDir = path.join(paths.capabilitiesDir, makeCapabilitySlug(capability.id));
				const resourcesDir = path.join(artifactDir, "resources");
				const resources = capability.manifest?.resources ?? [];
				const copied: Array<CapabilityMaterializedResource> = [];
				const skipped: Array<CapabilitySkippedResource> = [];
				const issues: Array<string> = [];

				if (resources.length === 0) {
					return new CapabilityMaterializationResult({
						capabilityId: capability.id,
						artifactDir,
						copied,
						skipped,
						issues,
					});
				}

				const localRoot = yield* localCapabilityPath(paths.targetDir, capability.source).pipe(
					Effect.provideService(Path.Path, path),
				);
				if (localRoot === null) {
					const reason = `Capability source ${capability.source.type}:${capability.source.value} is remote or unresolved; fetching is not supported by the local materializer.`;
					for (const resource of resources) {
						const target = resource.target ?? resource.path;
						const result = skippedResource(capability.id, resource, target, reason);
						skipped.push(result.skipped);
						issues.push(result.issue);
					}
					return new CapabilityMaterializationResult({
						capabilityId: capability.id,
						artifactDir,
						copied,
						skipped,
						issues,
					});
				}

				const sourceRoot = path.resolve(localRoot);
				if (!(yield* exists(sourceRoot))) {
					const reason = `Local capability source path does not exist: ${sourceRoot}`;
					for (const resource of resources) {
						const target = resource.target ?? resource.path;
						const result = skippedResource(capability.id, resource, target, reason);
						skipped.push(result.skipped);
						issues.push(result.issue);
					}
					return new CapabilityMaterializationResult({
						capabilityId: capability.id,
						artifactDir,
						copied,
						skipped,
						issues,
					});
				}

				const realSourceRoot = yield* realPath(sourceRoot);

				for (const resource of resources) {
					const target = resource.target ?? resource.path;
					const sourcePath = path.resolve(sourceRoot, resource.path);
					const targetPath = path.resolve(resourcesDir, target);

					if (!isWithin(sourceRoot, sourcePath)) {
						const result = skippedResource(
							capability.id,
							resource,
							target,
							`Resource source path escapes capability root: ${resource.path}`,
						);
						skipped.push(result.skipped);
						issues.push(result.issue);
						continue;
					}

					if (!isWithin(resourcesDir, targetPath)) {
						const result = skippedResource(
							capability.id,
							resource,
							target,
							`Resource target path escapes capability artifact resources: ${target}`,
						);
						skipped.push(result.skipped);
						issues.push(result.issue);
						continue;
					}

					if (!(yield* exists(sourcePath))) {
						const result = skippedResource(
							capability.id,
							resource,
							target,
							`Resource source path does not exist: ${resource.path}`,
						);
						skipped.push(result.skipped);
						issues.push(result.issue);
						continue;
					}

					const realSourcePath = yield* realPath(sourcePath);
					if (!isWithin(realSourceRoot, realSourcePath)) {
						const result = skippedResource(
							capability.id,
							resource,
							target,
							`Resource source path resolves outside capability root: ${resource.path}`,
						);
						skipped.push(result.skipped);
						issues.push(result.issue);
						continue;
					}

					const sourceStat = yield* stat(sourcePath);
					if (sourceStat.type !== "File" && sourceStat.type !== "Directory") {
						const result = skippedResource(
							capability.id,
							resource,
							target,
							`Resource source path is not a file or directory: ${resource.path}`,
						);
						skipped.push(result.skipped);
						issues.push(result.issue);
						continue;
					}

					const targetExists = yield* exists(targetPath);
					if (targetExists && !refresh) {
						skipped.push(
							new CapabilitySkippedResource({
								kind: resource.kind,
								path: resource.path,
								target,
								reason: `Target already exists: ${target}. Use --refresh to overwrite it.`,
							}),
						);
						continue;
					}

					if (!dryRun) {
						yield* makeDirectory(path.dirname(targetPath));
						yield* copyResource(sourcePath, targetPath);
						if (resource.executable === true) yield* markExecutable(targetPath);
					}
					copied.push(
						new CapabilityMaterializedResource({
							kind: resource.kind,
							path: resource.path,
							target,
							sourcePath,
							targetPath,
						}),
					);
				}

				return new CapabilityMaterializationResult({
					capabilityId: capability.id,
					artifactDir,
					copied,
					skipped,
					issues,
				});
			});

			return { materialize };
		}),
	);
}
