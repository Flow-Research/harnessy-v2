import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { formatManifestJson, HarnessLockfile } from "../runtime/lockfile.ts";
import { LockfileStore } from "../runtime/lockfile-store.ts";
import { HarnessProfile } from "../runtime/profile.ts";
import { ProfileStore } from "../runtime/profile-store.ts";
import { CapabilityFingerprinter, type CapabilityFingerprintResult } from "./fingerprint.ts";
import { CAPABILITY_MANIFEST_NAME, type CapabilityManifest, parseCapabilityManifest } from "./manifest.ts";
import { type CapabilityMaterializationResult, CapabilityMaterializer } from "./materializer.ts";
import { isPathWithin, requireNoSymlinkComponents, requireNoSymlinkLeaf } from "./path-safety.ts";
import {
	CapabilityEntry,
	CapabilityFingerprintMetadata,
	type CapabilitySource,
	makeCapabilitySlug,
	parseCapabilitySource,
	planCapabilityResolution,
} from "./source.ts";

export interface AddCapabilityResult {
	readonly capability: CapabilityEntry;
	readonly added: boolean;
	readonly manifestPath: string | null;
	readonly materialization: CapabilityMaterializationResult | null;
}

export interface MaterializeCapabilitiesResult {
	readonly dryRun: boolean;
	readonly refresh: boolean;
	readonly results: ReadonlyArray<CapabilityMaterializationResult>;
	readonly capabilities: ReadonlyArray<CapabilityEntry>;
	readonly issues: ReadonlyArray<string>;
}

export interface CreateCapabilityResult {
	readonly directory: string;
	readonly manifestPath: string;
	readonly manifest: CapabilityManifest;
	readonly dryRun: boolean;
	readonly replaced: boolean;
}

export interface CapabilityActivationResult {
	readonly capabilityId: string;
	readonly active: boolean;
	readonly changed: boolean;
	readonly dryRun: boolean;
}

export interface ExportCapabilityResult {
	readonly capabilityId: string;
	readonly directory: string;
	readonly dryRun: boolean;
	readonly replaced: boolean;
	readonly sha256: string;
	readonly bytes: number;
	readonly fileCount: number;
}

export interface CreateCapabilityOptions {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly version?: string;
	readonly force?: boolean;
	readonly dryRun?: boolean;
}

export interface ExportCapabilityOptions {
	readonly force?: boolean;
	readonly dryRun?: boolean;
}

interface LocalPack {
	readonly source: CapabilitySource;
	readonly root: string;
	readonly manifest: CapabilityManifest;
	readonly fingerprint: CapabilityFingerprintMetadata;
}

interface ArtifactBackup {
	readonly destination: string;
	readonly backup: string | null;
}

const fingerprintMetadata = (fingerprint: CapabilityFingerprintResult) =>
	new CapabilityFingerprintMetadata({
		root: fingerprint.root,
		kind: fingerprint.kind,
		sha256: fingerprint.sha256,
		bytes: fingerprint.bytes,
		fileCount: fingerprint.kind === "file" ? 1 : fingerprint.files.length,
		issues: [...fingerprint.issues],
	});

const sameManifest = (left: CapabilityManifest | undefined, right: CapabilityManifest): boolean =>
	left !== undefined && JSON.stringify(left) === JSON.stringify(right);

/** Manages self-contained capability artifacts and default-profile activation. */
export class CapabilityRegistry extends Context.Service<
	CapabilityRegistry,
	{
		readonly list: (paths: HarnessPaths) => Effect.Effect<ReadonlyArray<CapabilityEntry>, HarnessError>;
		readonly inspect: (paths: HarnessPaths, id: string) => Effect.Effect<CapabilityEntry, HarnessError>;
		readonly create: (
			paths: HarnessPaths,
			directory: string,
			options: CreateCapabilityOptions,
		) => Effect.Effect<CreateCapabilityResult, HarnessError>;
		readonly add: (
			paths: HarnessPaths,
			rawSource: string,
			rawId: string | undefined,
		) => Effect.Effect<AddCapabilityResult, HarnessError>;
		readonly materialize: (
			paths: HarnessPaths,
			id: string | undefined,
			options: { readonly dryRun?: boolean; readonly refresh?: boolean },
		) => Effect.Effect<MaterializeCapabilitiesResult, HarnessError>;
		readonly activate: (
			paths: HarnessPaths,
			id: string,
			dryRun?: boolean,
		) => Effect.Effect<CapabilityActivationResult, HarnessError>;
		readonly deactivate: (
			paths: HarnessPaths,
			id: string,
			dryRun?: boolean,
		) => Effect.Effect<CapabilityActivationResult, HarnessError>;
		readonly exportPack: (
			paths: HarnessPaths,
			id: string,
			out: string,
			options?: ExportCapabilityOptions,
		) => Effect.Effect<ExportCapabilityResult, HarnessError>;
		readonly verify: (
			paths: HarnessPaths,
			lockfile: HarnessLockfile,
		) => Effect.Effect<ReadonlyArray<string>, HarnessError>;
	}
>()("@harnessy/core/CapabilityRegistry") {
	static readonly layer = Layer.effect(
		CapabilityRegistry,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const lockfiles = yield* LockfileStore;
			const profiles = yield* ProfileStore;
			const materializer = yield* CapabilityMaterializer;
			const fingerprinter = yield* CapabilityFingerprinter;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const exists = (filePath: string) =>
				fs
					.exists(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${filePath}`, cause)));

			const remove = (filePath: string) =>
				fs
					.remove(filePath, { recursive: true, force: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not remove ${filePath}`, cause)));

			const artifactDir = (paths: HarnessPaths, capability: CapabilityEntry): string =>
				path.join(paths.capabilitiesDir, makeCapabilitySlug(capability.id));

			const packageDir = (paths: HarnessPaths, capability: CapabilityEntry): string =>
				path.join(artifactDir(paths, capability), "package");

			const replaceDirectory = Effect.fn("CapabilityRegistry.replaceDirectory")(function* (
				candidate: string,
				destination: string,
				replace: boolean,
			) {
				const destinationExists = yield* exists(destination);
				if (destinationExists && !replace) {
					return yield* new HarnessError({
						message: `Destination already exists: ${destination}. Use --force to replace it.`,
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

			const restoreArtifactBackups = Effect.fn("CapabilityRegistry.restoreArtifactBackups")(function* (
				backups: ReadonlyArray<ArtifactBackup>,
			) {
				for (const entry of [...backups].reverse()) {
					yield* remove(entry.destination);
					if (entry.backup !== null) {
						yield* fs
							.rename(entry.backup, entry.destination)
							.pipe(
								Effect.mapError((cause) => mapPlatformError(`Could not restore ${entry.destination}`, cause)),
							);
					}
				}
			});

			const discardArtifactBackups = Effect.fn("CapabilityRegistry.discardArtifactBackups")(function* (
				backups: ReadonlyArray<ArtifactBackup>,
			) {
				for (const entry of backups) {
					if (entry.backup !== null) yield* remove(entry.backup);
				}
			});

			const backupArtifacts = Effect.fn("CapabilityRegistry.backupArtifacts")(function* (
				paths: HarnessPaths,
				capabilities: ReadonlyArray<CapabilityEntry>,
			) {
				const destinations = capabilities.map((capability) => artifactDir(paths, capability));
				if (new Set(destinations).size !== destinations.length) {
					return yield* new HarnessError({ message: "Capability ids collide on an installed artifact path." });
				}
				const backups: Array<ArtifactBackup> = [];
				return yield* Effect.gen(function* () {
					for (const destination of destinations) {
						if (!(yield* exists(destination))) {
							backups.push({ destination, backup: null });
							continue;
						}
						const backup = yield* fs
							.makeTempDirectory({
								directory: path.dirname(destination),
								prefix: `.${path.basename(destination)}.transaction-`,
							})
							.pipe(
								Effect.mapError((cause) =>
									mapPlatformError(`Could not stage backup for ${destination}`, cause),
								),
							);
						yield* remove(backup);
						yield* fs
							.rename(destination, backup)
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not back up ${destination}`, cause)));
						backups.push({ destination, backup });
					}
					return backups;
				}).pipe(Effect.catch((error) => restoreArtifactBackups(backups).pipe(Effect.andThen(Effect.fail(error)))));
			});

			const readLocalPack = Effect.fn("CapabilityRegistry.readLocalPack")(function* (
				paths: HarnessPaths,
				source: CapabilitySource,
			) {
				const plan = yield* planCapabilityResolution(paths.targetDir, source).pipe(
					Effect.provideService(Path.Path, path),
				);
				if (plan.requiresFetch || plan.local === null) {
					return yield* new HarnessError({
						message: `Capability source ${source.type}:${source.value} is unresolved; remote fetching is not supported. Export the pack locally and add that directory instead.`,
					});
				}
				const root = path.resolve(plan.local.root);
				if (!(yield* exists(root))) {
					return yield* new HarnessError({ message: `Local capability source path does not exist: ${root}` });
				}
				yield* requireNoSymlinkLeaf(fs, path, root, "Capability source");
				const manifestPath = path.join(root, CAPABILITY_MANIFEST_NAME);
				if (!(yield* exists(manifestPath))) {
					return yield* new HarnessError({ message: `Missing Harnessy capability manifest: ${manifestPath}` });
				}
				yield* requireNoSymlinkComponents(fs, path, root, manifestPath, "Capability manifest");
				const raw = yield* fs
					.readFileString(manifestPath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${manifestPath}`, cause)));
				const manifest = yield* parseCapabilityManifest(raw, manifestPath);
				const fingerprint = yield* fingerprinter.fingerprintPath(root);
				if (fingerprint.issues.length > 0) {
					return yield* new HarnessError({
						message: `Capability source is unsafe: ${fingerprint.issues.join("; ")}`,
					});
				}
				return {
					source,
					root,
					manifest,
					fingerprint: fingerprintMetadata(fingerprint),
				} satisfies LocalPack;
			});

			const artifactIssues = Effect.fn("CapabilityRegistry.artifactIssues")(function* (
				paths: HarnessPaths,
				capability: CapabilityEntry,
			) {
				const issues: Array<string> = [];
				if (capability.source.type !== "local") {
					issues.push(
						`Capability ${capability.id} has unresolved ${capability.source.type} source; remote fetching is not supported.`,
					);
					return issues;
				}
				if (capability.artifact === undefined) {
					issues.push(
						`Capability ${capability.id} has no installed artifact metadata. Run capability materialize.`,
					);
					return issues;
				}
				const expectedRoot = artifactDir(paths, capability);
				const expectedRelative = path.relative(paths.targetDir, expectedRoot).replaceAll("\\", "/");
				if (capability.artifact.path !== expectedRelative) {
					issues.push(
						`Capability ${capability.id} artifact path mismatch: expected ${expectedRelative}, found ${capability.artifact.path}.`,
					);
					return issues;
				}
				if (!(yield* exists(expectedRoot))) {
					issues.push(`Capability ${capability.id} installed artifact is missing: ${expectedRoot}`);
					return issues;
				}
				const safetyError = yield* requireNoSymlinkComponents(
					fs,
					path,
					paths.targetDir,
					expectedRoot,
					`Capability artifact ${capability.id}`,
				).pipe(Effect.flip, Effect.option);
				if (safetyError._tag === "Some") {
					issues.push(safetyError.value.message);
					return issues;
				}
				const installedPackage = packageDir(paths, capability);
				const installedProjection = path.join(expectedRoot, "resources");
				if (!(yield* exists(installedPackage))) issues.push(`Capability ${capability.id} package view is missing.`);
				if (!(yield* exists(installedProjection)))
					issues.push(`Capability ${capability.id} projection view is missing.`);
				if (issues.length > 0) return issues;

				const fingerprintAttempt = yield* fingerprinter.fingerprintPath(expectedRoot).pipe(
					Effect.match({
						onFailure: (error) => ({ _tag: "failure", error }) as const,
						onSuccess: (fingerprint) => ({ _tag: "success", fingerprint }) as const,
					}),
				);
				if (fingerprintAttempt._tag === "failure") {
					issues.push(
						`Capability ${capability.id} artifact could not be fingerprinted: ${fingerprintAttempt.error.message}`,
					);
					return issues;
				}
				const installedFingerprint = fingerprintAttempt.fingerprint;
				if (installedFingerprint.issues.length > 0) {
					issues.push(
						...installedFingerprint.issues.map((issue) => `Capability ${capability.id} artifact: ${issue}`),
					);
				}
				if (
					installedFingerprint.sha256 !== capability.artifact.sha256 ||
					installedFingerprint.bytes !== capability.artifact.bytes ||
					installedFingerprint.files.length !== capability.artifact.fileCount
				) {
					issues.push(`Capability ${capability.id} installed artifact integrity mismatch.`);
				}

				const manifestPath = path.join(installedPackage, CAPABILITY_MANIFEST_NAME);
				if (!(yield* exists(manifestPath))) {
					issues.push(`Capability ${capability.id} installed manifest is missing.`);
					return issues;
				}
				const raw = yield* fs
					.readFileString(manifestPath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${manifestPath}`, cause)));
				const parsedManifest = yield* parseCapabilityManifest(raw, manifestPath).pipe(
					Effect.match({
						onFailure: (error) => ({ _tag: "failure", error }) as const,
						onSuccess: (manifest) => ({ _tag: "success", manifest }) as const,
					}),
				);
				if (parsedManifest._tag === "failure") {
					issues.push(parsedManifest.error.message);
					return issues;
				}
				const manifest = parsedManifest.manifest;
				if (manifest.id !== capability.id) {
					issues.push(`Capability ${capability.id} installed manifest id is ${manifest.id}.`);
				}
				if (!sameManifest(capability.manifest, manifest)) {
					issues.push(`Capability ${capability.id} installed manifest does not match the lockfile.`);
				}
				for (const resource of manifest.resources ?? []) {
					const packagePath = path.resolve(installedPackage, resource.path);
					const projectionPath = path.resolve(installedProjection, resource.target ?? resource.path);
					if (!isPathWithin(path, installedPackage, packagePath) || !(yield* exists(packagePath))) {
						issues.push(`Capability ${capability.id} installed package resource is missing: ${resource.path}`);
					}
					if (!isPathWithin(path, installedProjection, projectionPath) || !(yield* exists(projectionPath))) {
						issues.push(
							`Capability ${capability.id} installed projection resource is missing: ${resource.target ?? resource.path}`,
						);
					}
				}
				return issues;
			});

			const list = Effect.fn("CapabilityRegistry.list")(function* (paths: HarnessPaths) {
				return (yield* lockfiles.read(paths)).capabilities;
			});

			const inspect = Effect.fn("CapabilityRegistry.inspect")(function* (paths: HarnessPaths, id: string) {
				const capability = (yield* lockfiles.read(paths)).capabilities.find((entry) => entry.id === id);
				if (capability === undefined) return yield* new HarnessError({ message: `Capability not found: ${id}` });
				return capability;
			});

			const create = Effect.fn("CapabilityRegistry.create")(function* (
				paths: HarnessPaths,
				directory: string,
				options: CreateCapabilityOptions,
			) {
				const destination = path.resolve(paths.targetDir, directory);
				if (destination === paths.targetDir || !isPathWithin(path, paths.targetDir, destination)) {
					return yield* new HarnessError({
						message: `Capability create destination must be below ${paths.targetDir}: ${directory}`,
					});
				}
				if (isPathWithin(path, paths.harnessDir, destination)) {
					return yield* new HarnessError({
						message: `Capability create destination cannot be inside ${paths.harnessDir}.`,
					});
				}
				yield* requireNoSymlinkComponents(fs, path, paths.targetDir, destination, "Capability create destination");
				const destinationExists = yield* exists(destination);
				if (destinationExists && options.force !== true) {
					return yield* new HarnessError({
						message: `Destination already exists: ${destination}. Use --force to replace it.`,
					});
				}
				const manifestPath = path.join(destination, CAPABILITY_MANIFEST_NAME);
				const manifest = yield* parseCapabilityManifest(
					formatManifestJson({
						id: options.id,
						name: options.name,
						...(options.description === undefined ? {} : { description: options.description }),
						...(options.version === undefined ? {} : { version: options.version }),
					}),
					manifestPath,
				);
				if (options.dryRun === true) {
					return { directory: destination, manifestPath, manifest, dryRun: true, replaced: destinationExists };
				}
				const parent = path.dirname(destination);
				yield* fs
					.makeDirectory(parent, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${parent}`, cause)));
				const stage = yield* fs
					.makeTempDirectory({ directory: parent, prefix: `.${path.basename(destination)}.stage-` })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stage ${destination}`, cause)));
				return yield* Effect.gen(function* () {
					yield* fs
						.writeFileString(path.join(stage, CAPABILITY_MANIFEST_NAME), formatManifestJson(manifest))
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${manifestPath}`, cause)));
					yield* replaceDirectory(stage, destination, options.force === true);
					return { directory: destination, manifestPath, manifest, dryRun: false, replaced: destinationExists };
				}).pipe(Effect.ensuring(remove(stage).pipe(Effect.ignore)));
			});

			const add = Effect.fn("CapabilityRegistry.add")(function* (
				paths: HarnessPaths,
				rawSource: string,
				rawId: string | undefined,
			) {
				const lockfile = yield* lockfiles.read(paths);
				const source = yield* parseCapabilitySource(rawSource);
				const pack = yield* readLocalPack(paths, source);
				if (rawId !== undefined && rawId !== pack.manifest.id) {
					return yield* new HarnessError({
						message: `Requested capability id ${rawId} does not match manifest id ${pack.manifest.id}.`,
					});
				}
				const id = pack.manifest.id;
				const plan = yield* planCapabilityResolution(paths.targetDir, source, id).pipe(
					Effect.provideService(Path.Path, path),
				);
				const existingById = lockfile.capabilities.find((capability) => capability.id === id);
				const existingBySource = lockfile.capabilities.find(
					(capability) => capability.resolvedSource?.normalizedSource.value === plan.normalizedSource.value,
				);
				const existingBySlug = lockfile.capabilities.find(
					(capability) => makeCapabilitySlug(capability.id) === makeCapabilitySlug(id),
				);
				const existingIdMatchesSource =
					existingById?.resolvedSource?.normalizedSource.value === plan.normalizedSource.value ||
					(existingById?.resolvedSource === undefined &&
						existingById?.source.type === source.type &&
						existingById.source.value === source.value);
				if (existingById !== undefined && !existingIdMatchesSource) {
					return yield* new HarnessError({
						message: `Capability id ${id} is already installed from another source.`,
					});
				}
				if (existingBySource !== undefined && existingBySource.id !== id) {
					return yield* new HarnessError({
						message: `Capability source is already installed as ${existingBySource.id}; manifest id changed to ${id}.`,
					});
				}
				if (existingBySlug !== undefined && existingBySlug.id !== id) {
					return yield* new HarnessError({
						message: `Capability id ${id} collides with ${existingBySlug.id} on the installed artifact path.`,
					});
				}
				const provisional = new CapabilityEntry({
					id,
					source,
					resolvedSource: plan,
					fingerprint: pack.fingerprint,
					addedAt: existingById?.addedAt ?? new Date().toISOString(),
					manifest: pack.manifest,
				});
				yield* materializer.materialize(paths, provisional, { dryRun: true, refresh: true });
				const backups = yield* backupArtifacts(paths, [provisional]);
				return yield* Effect.gen(function* () {
					const materialization = yield* materializer.materialize(paths, provisional);
					const capability = new CapabilityEntry({ ...provisional, artifact: materialization.artifact });
					const next = new HarnessLockfile({
						...lockfile,
						capabilities:
							existingById === undefined
								? [...lockfile.capabilities, capability]
								: lockfile.capabilities.map((entry) => (entry.id === id ? capability : entry)),
					});
					yield* lockfiles.write(paths, next);
					return {
						capability,
						added: existingById === undefined,
						manifestPath: path.join(materialization.packageDir, CAPABILITY_MANIFEST_NAME),
						materialization,
					} satisfies AddCapabilityResult;
				}).pipe(
					Effect.catch((error) => restoreArtifactBackups(backups).pipe(Effect.andThen(Effect.fail(error)))),
					Effect.tap(() => discardArtifactBackups(backups).pipe(Effect.ignore)),
				);
			});

			const materialize = Effect.fn("CapabilityRegistry.materialize")(function* (
				paths: HarnessPaths,
				id: string | undefined,
				options: { readonly dryRun?: boolean; readonly refresh?: boolean },
			) {
				const dryRun = options.dryRun === true;
				const refresh = options.refresh === true;
				const lockfile = yield* lockfiles.read(paths);
				const selected =
					id === undefined ? lockfile.capabilities : lockfile.capabilities.filter((entry) => entry.id === id);
				if (id !== undefined && selected.length === 0)
					return yield* new HarnessError({ message: `Capability not found: ${id}` });

				const prepared: Array<CapabilityEntry> = [];
				for (const capability of selected) {
					if (capability.source.type !== "local") {
						return yield* new HarnessError({
							message: `Capability ${capability.id} has unresolved ${capability.source.type} source; remote fetching is not supported.`,
						});
					}
					const pack = yield* readLocalPack(paths, capability.source);
					if (pack.manifest.id !== capability.id) {
						return yield* new HarnessError({
							message: `Capability ${capability.id} source manifest id changed to ${pack.manifest.id}.`,
						});
					}
					if (!refresh && capability.manifest !== undefined && !sameManifest(capability.manifest, pack.manifest)) {
						return yield* new HarnessError({
							message: `Capability ${capability.id} source manifest changed. Use --refresh to install it.`,
						});
					}
					prepared.push(
						new CapabilityEntry({
							...capability,
							manifest: refresh || capability.manifest === undefined ? pack.manifest : capability.manifest,
							fingerprint: pack.fingerprint,
							resolvedSource: yield* planCapabilityResolution(
								paths.targetDir,
								capability.source,
								capability.id,
							).pipe(Effect.provideService(Path.Path, path)),
						}),
					);
				}

				const plannedResults: Array<CapabilityMaterializationResult> = [];
				for (const capability of prepared) {
					if (!refresh && (yield* exists(artifactDir(paths, capability)))) {
						return yield* new HarnessError({
							message: `Capability artifact already exists: ${artifactDir(paths, capability)}. Use --refresh to replace it.`,
						});
					}
					plannedResults.push(yield* materializer.materialize(paths, capability, { dryRun: true, refresh }));
				}
				if (dryRun) {
					const plannedById = new Map(
						prepared.map((capability, index) => [
							capability.id,
							new CapabilityEntry({ ...capability, artifact: plannedResults[index]?.artifact }),
						]),
					);
					return {
						dryRun: true,
						refresh,
						results: plannedResults,
						capabilities: prepared.map((entry) => plannedById.get(entry.id) ?? entry),
						issues: [],
					} satisfies MaterializeCapabilitiesResult;
				}

				const backups = yield* backupArtifacts(paths, prepared);
				return yield* Effect.gen(function* () {
					const results: Array<CapabilityMaterializationResult> = [];
					const updatedById = new Map<string, CapabilityEntry>();
					for (const capability of prepared) {
						const result = yield* materializer.materialize(paths, capability);
						results.push(result);
						updatedById.set(capability.id, new CapabilityEntry({ ...capability, artifact: result.artifact }));
					}
					const nextCapabilities = lockfile.capabilities.map((entry) => updatedById.get(entry.id) ?? entry);
					yield* lockfiles.write(paths, new HarnessLockfile({ ...lockfile, capabilities: nextCapabilities }));
					return {
						dryRun: false,
						refresh,
						results,
						capabilities: prepared.map((entry) => updatedById.get(entry.id) ?? entry),
						issues: [],
					} satisfies MaterializeCapabilitiesResult;
				}).pipe(
					Effect.catch((error) => restoreArtifactBackups(backups).pipe(Effect.andThen(Effect.fail(error)))),
					Effect.tap(() => discardArtifactBackups(backups).pipe(Effect.ignore)),
				);
			});

			const setActive = Effect.fn("CapabilityRegistry.setActive")(function* (
				paths: HarnessPaths,
				id: string,
				active: boolean,
				dryRun: boolean,
			) {
				const capability = yield* inspect(paths, id);
				if (active) {
					const issues = yield* artifactIssues(paths, capability);
					if (issues.length > 0) {
						return yield* new HarnessError({ message: `Cannot activate ${id}: ${issues.join("; ")}` });
					}
				}
				const profile = yield* profiles.readDefault(paths);
				const nextCapabilities = active
					? [...new Set([...profile.capabilities, id])].sort()
					: profile.capabilities.filter((capabilityId) => capabilityId !== id);
				const changed = JSON.stringify(nextCapabilities) !== JSON.stringify(profile.capabilities);
				if (changed && !dryRun) {
					yield* profiles.writeDefault(paths, new HarnessProfile({ ...profile, capabilities: nextCapabilities }));
				}
				return { capabilityId: id, active, changed, dryRun } satisfies CapabilityActivationResult;
			});

			const activate = Effect.fn("CapabilityRegistry.activate")((paths: HarnessPaths, id: string, dryRun = false) =>
				setActive(paths, id, true, dryRun),
			);

			const deactivate = Effect.fn("CapabilityRegistry.deactivate")(
				(paths: HarnessPaths, id: string, dryRun = false) => setActive(paths, id, false, dryRun),
			);

			const exportPack = Effect.fn("CapabilityRegistry.exportPack")(function* (
				paths: HarnessPaths,
				id: string,
				out: string,
				options: ExportCapabilityOptions = {},
			) {
				const capability = yield* inspect(paths, id);
				const issues = yield* artifactIssues(paths, capability);
				if (issues.length > 0)
					return yield* new HarnessError({ message: `Cannot export ${id}: ${issues.join("; ")}` });
				const destination = path.resolve(paths.targetDir, out);
				if (destination === paths.targetDir || !isPathWithin(path, paths.targetDir, destination)) {
					return yield* new HarnessError({
						message: `Capability export destination must be below ${paths.targetDir}: ${out}`,
					});
				}
				if (isPathWithin(path, paths.harnessDir, destination)) {
					return yield* new HarnessError({
						message: `Capability export destination cannot be inside ${paths.harnessDir}.`,
					});
				}
				yield* requireNoSymlinkComponents(fs, path, paths.targetDir, destination, "Capability export destination");
				const destinationExists = yield* exists(destination);
				if (destinationExists && options.force !== true) {
					return yield* new HarnessError({
						message: `Destination already exists: ${destination}. Use --force to replace it.`,
					});
				}
				const installedPackage = packageDir(paths, capability);
				const packageFingerprint = yield* fingerprinter.fingerprintPath(installedPackage);
				if (options.dryRun === true) {
					return {
						capabilityId: id,
						directory: destination,
						dryRun: true,
						replaced: destinationExists,
						sha256: packageFingerprint.sha256,
						bytes: packageFingerprint.bytes,
						fileCount: packageFingerprint.files.length,
					};
				}
				const parent = path.dirname(destination);
				yield* fs
					.makeDirectory(parent, { recursive: true })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not create ${parent}`, cause)));
				const stage = yield* fs
					.makeTempDirectory({ directory: parent, prefix: `.${path.basename(destination)}.stage-` })
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not stage export ${destination}`, cause)));
				return yield* Effect.gen(function* () {
					const entries = yield* fs
						.readDirectory(installedPackage)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${installedPackage}`, cause)));
					for (const entry of entries.sort()) {
						yield* fs
							.copy(path.join(installedPackage, entry), path.join(stage, entry), {
								overwrite: false,
								preserveTimestamps: true,
							})
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not export ${entry}`, cause)));
					}
					const stagedFingerprint = yield* fingerprinter.fingerprintPath(stage);
					if (stagedFingerprint.sha256 !== packageFingerprint.sha256) {
						return yield* new HarnessError({
							message: `Exported capability ${id} did not preserve package integrity.`,
						});
					}
					yield* replaceDirectory(stage, destination, options.force === true);
					return {
						capabilityId: id,
						directory: destination,
						dryRun: false,
						replaced: destinationExists,
						sha256: stagedFingerprint.sha256,
						bytes: stagedFingerprint.bytes,
						fileCount: stagedFingerprint.files.length,
					};
				}).pipe(Effect.ensuring(remove(stage).pipe(Effect.ignore)));
			});

			const verify = Effect.fn("CapabilityRegistry.verify")(function* (
				paths: HarnessPaths,
				lockfile: HarnessLockfile,
			) {
				const issues: Array<string> = [];
				for (const capability of lockfile.capabilities) issues.push(...(yield* artifactIssues(paths, capability)));
				return issues;
			});

			return { list, inspect, create, add, materialize, activate, deactivate, exportPack, verify };
		}),
	);
}
