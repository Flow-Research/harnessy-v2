import type { FileSystem, Path } from "effect";
import * as Effect from "effect/Effect";

import { causeMessage, HarnessError } from "../errors.ts";

/** True when child is equal to or nested under parent after lexical resolution. */
export const isPathWithin = (path: Path.Path, parent: string, child: string): boolean => {
	const relative = path.relative(path.resolve(parent), path.resolve(child)).replaceAll("\\", "/");
	return relative === "" || (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative));
};

const canonicalIdentity = (path: Path.Path, value: string): string => {
	const resolved = path.resolve(value);
	return resolved.includes("\\") ? resolved.toLowerCase() : resolved;
};

/** Fail when a path escapes its trusted lexical root. */
export const requirePathWithin = (
	path: Path.Path,
	parent: string,
	child: string,
	label: string,
): Effect.Effect<void, HarnessError> =>
	isPathWithin(path, parent, child)
		? Effect.void
		: Effect.fail(new HarnessError({ message: `${label} escapes trusted root ${path.resolve(parent)}: ${child}` }));

/**
 * Reject symbolic links in every existing component below a trusted directory.
 * The trusted directory itself is canonicalized once so platform aliases above
 * it (for example macOS /tmp) do not create false positives.
 */
export const requireNoSymlinkComponents = Effect.fn("CapabilityPath.requireNoSymlinkComponents")(function* (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	trustedRoot: string,
	candidate: string,
	label: string,
) {
	const absoluteRoot = path.resolve(trustedRoot);
	const absoluteCandidate = path.resolve(candidate);
	yield* requirePathWithin(path, absoluteRoot, absoluteCandidate, label);
	const canonicalRoot = yield* fs.realPath(absoluteRoot).pipe(
		Effect.mapError(
			(cause) =>
				new HarnessError({
					message: `Could not resolve trusted root ${absoluteRoot}: ${causeMessage(cause)}`,
					cause,
				}),
		),
	);
	const relative = path.relative(absoluteRoot, absoluteCandidate).replaceAll("\\", "/");
	if (relative === "") return;

	let lexicalParent = absoluteRoot;
	let canonicalParent = canonicalRoot;
	for (const segment of relative.split("/")) {
		const entries = yield* fs.readDirectory(lexicalParent).pipe(
			Effect.mapError(
				(cause) =>
					new HarnessError({
						message: `Could not inspect ${lexicalParent}: ${causeMessage(cause)}`,
						cause,
					}),
			),
		);
		if (!entries.includes(segment)) return;

		const lexicalChild = path.join(lexicalParent, segment);
		const expectedCanonical = path.join(canonicalParent, segment);
		const actualCanonical = yield* fs.realPath(lexicalChild).pipe(
			Effect.mapError(
				(cause) =>
					new HarnessError({
						message: `${label} contains an unsafe or broken symbolic link at ${lexicalChild}: ${causeMessage(cause)}`,
						cause,
					}),
			),
		);
		if (canonicalIdentity(path, actualCanonical) !== canonicalIdentity(path, expectedCanonical)) {
			return yield* new HarnessError({ message: `${label} contains a symbolic link: ${lexicalChild}` });
		}
		lexicalParent = lexicalChild;
		canonicalParent = actualCanonical;
	}
});

/** Reject a symbolic-link leaf while allowing canonical aliases above its parent. */
export const requireNoSymlinkLeaf = Effect.fn("CapabilityPath.requireNoSymlinkLeaf")(function* (
	fs: FileSystem.FileSystem,
	path: Path.Path,
	candidate: string,
	label: string,
) {
	const absolute = path.resolve(candidate);
	const parent = path.dirname(absolute);
	yield* requireNoSymlinkComponents(fs, path, parent, absolute, label);
});
