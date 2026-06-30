import { createHash } from "node:crypto";

import { FileSystem, Path, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";

/** Filesystem kind fingerprinted by Harnessy. */
export const CapabilityFingerprintKind = Schema.Literals(["file", "directory"]);

/** Filesystem kind fingerprinted by Harnessy. */
export type CapabilityFingerprintKind = typeof CapabilityFingerprintKind.Type;

/** One file included in a deterministic directory fingerprint. */
export class CapabilityFingerprintFile extends Schema.Class<CapabilityFingerprintFile>("CapabilityFingerprintFile")({
	/** Root-relative file path using POSIX separators. */
	path: Schema.String,
	/** SHA-256 digest of this file's bytes. */
	sha256: Schema.String,
	/** File size in bytes. */
	bytes: Schema.Number,
	/** Whether any executable bit is present. */
	executable: Schema.Boolean,
}) {}

/** Result of hashing a local capability file or directory. */
export class CapabilityFingerprintResult extends Schema.Class<CapabilityFingerprintResult>(
	"CapabilityFingerprintResult",
)({
	/** Absolute filesystem path that was fingerprinted. */
	root: Schema.String,
	/** File or directory fingerprint kind. */
	kind: CapabilityFingerprintKind,
	/** Stable SHA-256 digest for the file or deterministic directory tree. */
	sha256: Schema.String,
	/** Sum of included file byte lengths. */
	bytes: Schema.Number,
	/** Deterministic directory file entries, empty for single-file fingerprints. */
	files: Schema.Array(CapabilityFingerprintFile),
	/** Non-fatal skipped paths, such as symlinks or paths escaping the root. */
	issues: Schema.Array(Schema.String),
}) {}

interface WalkDirectoryResult {
	/** Files found under the walked directory. */
	readonly files: ReadonlyArray<CapabilityFingerprintFile>;
	/** Non-fatal skip issues found while walking. */
	readonly issues: ReadonlyArray<string>;
}

const sha256Hex = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

/** Deterministically fingerprints local capability content without shelling out. */
export class CapabilityFingerprinter extends Context.Service<
	CapabilityFingerprinter,
	{
		/** Hash one local file or directory tree. */
		readonly fingerprintPath: (inputPath: string) => Effect.Effect<CapabilityFingerprintResult, HarnessError>;
	}
>()("@harnessy/core/CapabilityFingerprinter") {
	/** Live fingerprinter backed by Effect platform filesystem and path services. */
	static readonly layer = Layer.effect(
		CapabilityFingerprinter,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			/** Convert platform failures into the Harnessy typed error channel. */
			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			/** True when child is equal to or nested under parent after path resolution. */
			const isWithin = (parent: string, child: string): boolean => {
				const relative = path.relative(parent, child).replaceAll("\\", "/");
				return relative === "" || (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative));
			};

			/** Stat a path with Harnessy error mapping. */
			const stat = (filePath: string) =>
				fs.stat(filePath).pipe(Effect.mapError((cause) => mapPlatformError(`Could not stat ${filePath}`, cause)));

			/** Resolve a canonical path with Harnessy error mapping. */
			const realPath = (filePath: string) =>
				fs
					.realPath(filePath)
					.pipe(Effect.mapError((cause) => mapPlatformError(`Could not resolve ${filePath}`, cause)));

			/** Read one file and return its fingerprint entry. */
			const fingerprintFile = (
				root: string,
				filePath: string,
			): Effect.Effect<CapabilityFingerprintFile, HarnessError> =>
				Effect.gen(function* () {
					const fileStat = yield* stat(filePath);
					const bytes = yield* fs
						.readFile(filePath)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read ${filePath}`, cause)));
					const relative = path.relative(root, filePath).replaceAll("\\", "/");
					return new CapabilityFingerprintFile({
						path: relative.length === 0 ? path.basename(filePath) : relative,
						sha256: sha256Hex(bytes),
						bytes: bytes.byteLength,
						executable: (fileStat.mode & 0o111) !== 0,
					});
				});

			/** Walk a directory without following paths that resolve outside the root. */
			const walkDirectory = (root: string, directory: string): Effect.Effect<WalkDirectoryResult, HarnessError> =>
				Effect.gen(function* () {
					const files: Array<CapabilityFingerprintFile> = [];
					const issues: Array<string> = [];
					const entries = yield* fs
						.readDirectory(directory)
						.pipe(Effect.mapError((cause) => mapPlatformError(`Could not read directory ${directory}`, cause)));

					for (const entry of entries.sort()) {
						const entryPath = path.join(directory, entry);
						const entryStat = yield* stat(entryPath);
						if (entryStat.type === "SymbolicLink") {
							issues.push(`Skipped symbolic link: ${path.relative(root, entryPath).replaceAll("\\", "/")}`);
							continue;
						}

						const resolved = yield* realPath(entryPath);
						if (!isWithin(root, resolved)) {
							issues.push(
								`Skipped path resolving outside root: ${path.relative(root, entryPath).replaceAll("\\", "/")}`,
							);
							continue;
						}

						if (entryStat.type === "Directory") {
							const nested = yield* walkDirectory(root, entryPath);
							files.push(...nested.files);
							issues.push(...nested.issues);
							continue;
						}

						if (entryStat.type === "File") {
							files.push(yield* fingerprintFile(root, entryPath));
							continue;
						}

						issues.push(
							`Skipped unsupported file type ${entryStat.type}: ${path.relative(root, entryPath).replaceAll("\\", "/")}`,
						);
					}

					return { files, issues } satisfies WalkDirectoryResult;
				});

			const fingerprintPath = Effect.fn("CapabilityFingerprinter.fingerprintPath")(function* (inputPath: string) {
				const absolutePath = path.resolve(inputPath);
				const rootStat = yield* stat(absolutePath);

				if (rootStat.type === "File") {
					const entry = yield* fingerprintFile(path.dirname(absolutePath), absolutePath);
					return new CapabilityFingerprintResult({
						root: absolutePath,
						kind: "file",
						sha256: entry.sha256,
						bytes: entry.bytes,
						files: [],
						issues: [],
					});
				}

				if (rootStat.type !== "Directory") {
					return yield* new HarnessError({
						message: `Cannot fingerprint unsupported file type ${rootStat.type}: ${absolutePath}`,
					});
				}

				const realRoot = yield* realPath(absolutePath);
				const walked = yield* walkDirectory(realRoot, realRoot);
				const files = [...walked.files].sort((left, right) => left.path.localeCompare(right.path));
				const bytes = files.reduce((total, file) => total + file.bytes, 0);
				const treeHash = createHash("sha256");
				for (const file of files) {
					treeHash.update(file.path);
					treeHash.update("\0");
					treeHash.update(file.sha256);
					treeHash.update("\0");
					treeHash.update(String(file.bytes));
					treeHash.update("\0");
					treeHash.update(file.executable ? "1" : "0");
					treeHash.update("\0");
				}

				return new CapabilityFingerprintResult({
					root: realRoot,
					kind: "directory",
					sha256: treeHash.digest("hex"),
					bytes,
					files,
					issues: [...walked.issues],
				});
			});

			return { fingerprintPath };
		}),
	);
}
