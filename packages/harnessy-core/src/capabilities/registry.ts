import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import { formatManifestJson, HarnessLockfile } from "../runtime/lockfile.ts";
import { LockfileStore } from "../runtime/lockfile-store.ts";
import { CapabilityFingerprinter, type CapabilityFingerprintResult } from "./fingerprint.ts";
import { CAPABILITY_MANIFEST_NAME, parseCapabilityManifest } from "./manifest.ts";
import { type CapabilityMaterializationResult, CapabilityMaterializer } from "./materializer.ts";
import {
	CapabilityEntry,
	CapabilityFingerprintMetadata,
	type CapabilitySource,
	defaultCapabilityName,
	localCapabilityPath,
	makeCapabilityId,
	parseCapabilitySource,
	planCapabilityResolution,
} from "./source.ts";

/** Result of recording a capability source. */
export interface AddCapabilityResult {
	/** Newly created capability entry, or the existing duplicate entry. */
	readonly capability: CapabilityEntry;
	/** Whether this call changed the lockfile. */
	readonly added: boolean;
	/** Manifest path written for a new capability. */
	readonly manifestPath: string | null;
	/** Resource materialization result for a new capability, when attempted. */
	readonly materialization: CapabilityMaterializationResult | null;
}

/** Result of materializing or refreshing one or more installed capabilities. */
export interface MaterializeCapabilitiesResult {
	/** Whether this run only previewed writes. */
	readonly dryRun: boolean;
	/** Whether existing artifact targets were eligible for overwrite. */
	readonly refresh: boolean;
	/** Materialization reports by capability. */
	readonly results: ReadonlyArray<CapabilityMaterializationResult>;
	/** Updated capability entries with refreshed provenance/fingerprints. */
	readonly capabilities: ReadonlyArray<CapabilityEntry>;
	/** User-facing issues from materialization and fingerprinting. */
	readonly issues: ReadonlyArray<string>;
}

/** Manages capability records, manifests, and local path verification. */
export class CapabilityRegistry extends Context.Service<
	CapabilityRegistry,
	{
		/** Read installed capability records from the lockfile. */
		readonly list: (paths: HarnessPaths) => Effect.Effect<ReadonlyArray<CapabilityEntry>, HarnessError>;
		/** Read one installed capability by id. */
		readonly inspect: (paths: HarnessPaths, id: string) => Effect.Effect<CapabilityEntry, HarnessError>;
		/** Record a capability source in the lockfile and emit a manifest stub for later resolvers. */
		readonly add: (
			paths: HarnessPaths,
			rawSource: string,
			rawId: string | undefined,
		) => Effect.Effect<AddCapabilityResult, HarnessError>;
		/** Materialize or refresh installed capability resources. */
		readonly materialize: (
			paths: HarnessPaths,
			id: string | undefined,
			options: { readonly dryRun?: boolean; readonly refresh?: boolean },
		) => Effect.Effect<MaterializeCapabilitiesResult, HarnessError>;
		/** Verify capability records that can be checked locally. */
		readonly verify: (
			paths: HarnessPaths,
			lockfile: HarnessLockfile,
		) => Effect.Effect<ReadonlyArray<string>, HarnessError>;
	}
>()("@harnessy/core/CapabilityRegistry") {
	/** Live capability registry backed by the lockfile store and platform filesystem services. */
	static readonly layer = Layer.effect(
		CapabilityRegistry,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const lockfiles = yield* LockfileStore;
			const materializer = yield* CapabilityMaterializer;
			const fingerprinter = yield* CapabilityFingerprinter;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			/** Read a local capability-owned manifest when the source root contains one. */
			const readLocalManifest = (paths: HarnessPaths, source: CapabilitySource) =>
				Effect.gen(function* () {
					const localPath = yield* localCapabilityPath(paths.targetDir, source).pipe(
						Effect.provideService(Path.Path, path),
					);
					if (localPath === null) return null;
					if (
						!(yield* fs
							.exists(localPath)
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${localPath}`, cause))))
					) {
						return null;
					}
					const manifestPath = path.join(localPath, CAPABILITY_MANIFEST_NAME);
					if (
						!(yield* fs
							.exists(manifestPath)
							.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${manifestPath}`, cause))))
					) {
						return null;
					}
					const raw = yield* fs
						.readFileString(manifestPath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${manifestPath}`, cause)));
					return yield* parseCapabilityManifest(raw, manifestPath);
				});

			/** Summarize a potentially large deterministic fingerprint for lockfile storage. */
			const fingerprintMetadata = (fingerprint: CapabilityFingerprintResult) =>
				new CapabilityFingerprintMetadata({
					root: fingerprint.root,
					kind: fingerprint.kind,
					sha256: fingerprint.sha256,
					bytes: fingerprint.bytes,
					fileCount: fingerprint.kind === "file" ? 1 : fingerprint.files.length,
					issues: [...fingerprint.issues],
				});

			/** Add deterministic source and fingerprint metadata to a capability entry. */
			const withProvenance = (paths: HarnessPaths, capability: CapabilityEntry) =>
				Effect.gen(function* () {
					const resolvedSource = yield* planCapabilityResolution(
						paths.targetDir,
						capability.source,
						capability.id,
					).pipe(Effect.provideService(Path.Path, path));
					const localRootExists =
						resolvedSource.local === null
							? false
							: yield* fs
									.exists(resolvedSource.local.root)
									.pipe(
										Effect.mapError((cause) =>
											mapPlatformError(`Could not inspect ${resolvedSource.local?.root}`, cause),
										),
									);
					const fingerprint =
						resolvedSource.local === null || !localRootExists
							? undefined
							: fingerprintMetadata(yield* fingerprinter.fingerprintPath(resolvedSource.local.root));
					return new CapabilityEntry({
						...capability,
						resolvedSource,
						...(fingerprint === undefined ? {} : { fingerprint }),
					});
				});

			/** Materialize local capability resources into the Harnessy artifact directory for new entries. */
			const materializeCapability = (paths: HarnessPaths, capability: CapabilityEntry) =>
				capability.manifest?.resources === undefined
					? Effect.succeed(null)
					: materializer.materialize(paths, capability, { refresh: true });

			const capabilityManifestPath = (paths: HarnessPaths, capability: CapabilityEntry): string => {
				const filename = capability.id.replace(/[^a-z0-9._-]+/g, "-");
				return path.join(paths.capabilitiesDir, `${filename}.json`);
			};

			/** Write an adjacent per-capability manifest for easy inspection by humans and agents. */
			const writeCapabilityManifest = (paths: HarnessPaths, capability: CapabilityEntry) =>
				Effect.gen(function* () {
					const manifestPath = capabilityManifestPath(paths, capability);
					yield* fs
						.writeFileString(manifestPath, formatManifestJson(capability))
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not write ${manifestPath}`, cause)));
					return manifestPath;
				});

			const syncCapabilityArtifacts = Effect.fn("CapabilityRegistry.syncCapabilityArtifacts")(function* (
				paths: HarnessPaths,
				capability: CapabilityEntry,
			) {
				const manifestPath = yield* writeCapabilityManifest(paths, capability);
				const materialization = yield* materializeCapability(paths, capability);
				return { manifestPath, materialization } as const;
			});

			/** Verify one local capability path. Remote capability sources are deferred to later resolvers. */
			const verifyLocalCapability = (paths: HarnessPaths, capability: CapabilityEntry) =>
				Effect.gen(function* () {
					const localPath = yield* localCapabilityPath(paths.targetDir, capability.source).pipe(
						Effect.provideService(Path.Path, path),
					);
					if (localPath === null) return null;
					const exists = yield* fs
						.exists(localPath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not inspect ${localPath}`, cause)));
					if (!exists) return `Local capability ${capability.id} points to missing path: ${localPath}`;
					yield* readLocalManifest(paths, capability.source);
					return null;
				});

			const list = Effect.fn("CapabilityRegistry.list")(function* (paths: HarnessPaths) {
				const lockfile = yield* lockfiles.read(paths);
				return lockfile.capabilities;
			});

			const inspect = Effect.fn("CapabilityRegistry.inspect")(function* (paths: HarnessPaths, id: string) {
				const lockfile = yield* lockfiles.read(paths);
				const capability = lockfile.capabilities.find((entry) => entry.id === id);
				if (capability === undefined) {
					return yield* new HarnessError({ message: `Capability not found: ${id}` });
				}
				return capability;
			});

			const add = Effect.fn("CapabilityRegistry.add")(function* (
				paths: HarnessPaths,
				rawSource: string,
				rawId: string | undefined,
			) {
				const lockfile = yield* lockfiles.read(paths);
				const source = yield* parseCapabilitySource(rawSource);
				const manifest = yield* readLocalManifest(paths, source);
				const name =
					manifest?.name ?? (yield* defaultCapabilityName(source).pipe(Effect.provideService(Path.Path, path)));
				const id = rawId ?? manifest?.id ?? makeCapabilityId(source.type, name);
				const duplicate = lockfile.capabilities.find(
					(capability) => capability.id === id || capability.source.value === source.value,
				);
				if (duplicate !== undefined) {
					const capability = yield* withProvenance(paths, duplicate);
					const artifacts = yield* syncCapabilityArtifacts(paths, capability);
					const nextLockfile = new HarnessLockfile({
						...lockfile,
						capabilities: lockfile.capabilities.map((entry) => (entry.id === duplicate.id ? capability : entry)),
					});
					yield* lockfiles.write(paths, nextLockfile);
					return {
						capability,
						added: false,
						manifestPath: artifacts.manifestPath,
						materialization: artifacts.materialization,
					} satisfies AddCapabilityResult;
				}

				const manifestFields = manifest === null ? {} : { manifest };
				const capability = yield* withProvenance(
					paths,
					new CapabilityEntry({
						id,
						source,
						addedAt: new Date().toISOString(),
						...manifestFields,
					}),
				);
				const nextLockfile = new HarnessLockfile({
					...lockfile,
					capabilities: [...lockfile.capabilities, capability],
				});
				const artifacts = yield* syncCapabilityArtifacts(paths, capability);
				yield* lockfiles.write(paths, nextLockfile);
				return {
					capability,
					added: true,
					manifestPath: artifacts.manifestPath,
					materialization: artifacts.materialization,
				} satisfies AddCapabilityResult;
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
					id === undefined
						? lockfile.capabilities
						: lockfile.capabilities.filter((capability) => capability.id === id);
				if (id !== undefined && selected.length === 0) {
					return yield* new HarnessError({ message: `Capability not found: ${id}` });
				}

				const updatedById = new Map<string, CapabilityEntry>();
				const results: Array<CapabilityMaterializationResult> = [];
				const issues: Array<string> = [];

				for (const capability of selected) {
					const updated = yield* withProvenance(paths, capability);
					updatedById.set(updated.id, updated);
					const result = yield* materializer.materialize(paths, updated, { dryRun, refresh });
					results.push(result);
					issues.push(...result.issues);
				}

				const nextCapabilities = lockfile.capabilities.map(
					(capability) => updatedById.get(capability.id) ?? capability,
				);
				const updatedCapabilities = nextCapabilities.filter((capability) => updatedById.has(capability.id));
				if (!dryRun) {
					const nextLockfile = new HarnessLockfile({ ...lockfile, capabilities: nextCapabilities });
					yield* lockfiles.write(paths, nextLockfile);
					for (const capability of updatedCapabilities) {
						yield* writeCapabilityManifest(paths, capability);
					}
				}

				return {
					dryRun,
					refresh,
					results,
					capabilities: updatedCapabilities,
					issues,
				} satisfies MaterializeCapabilitiesResult;
			});

			const verify = Effect.fn("CapabilityRegistry.verify")(function* (
				paths: HarnessPaths,
				lockfile: HarnessLockfile,
			) {
				const issues: Array<string> = [];
				for (const capability of lockfile.capabilities) {
					const issue = yield* verifyLocalCapability(paths, capability);
					if (issue !== null) issues.push(issue);
				}
				return issues;
			});

			return { list, inspect, add, materialize, verify };
		}),
	);
}
