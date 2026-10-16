import { FileSystem, Schema } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { JarvisPaths } from "./paths.ts";

export const JARVIS_CONTEXT_FILES = [
	"preferences.md",
	"patterns.md",
	"constraints.md",
	"priorities.md",
	"goals.md",
	"projects.md",
	"recurring.md",
	"focus.md",
	"blockers.md",
	"calendar.md",
	"delegation.md",
	"decisions.md",
] as const;

export const JarvisContextSource = Schema.Literals(["none", "global", "project", "merged"]);
export type JarvisContextSource = typeof JarvisContextSource.Type;

/** One compatibility context document after applying legacy global/project precedence. */
export class JarvisContextDocument extends Schema.Class<JarvisContextDocument>("JarvisContextDocument")({
	name: Schema.String,
	source: JarvisContextSource,
	content: Schema.String,
}) {}

/** Non-sensitive context metadata safe for diagnostics and JSON output. */
export class JarvisContextDocumentSummary extends Schema.Class<JarvisContextDocumentSummary>(
	"JarvisContextDocumentSummary",
)({
	name: Schema.String,
	source: JarvisContextSource,
	loaded: Schema.Boolean,
}) {}

/** Result of loading the legacy two-tier Jarvis context contract. */
export class JarvisContextLoadResult extends Schema.Class<JarvisContextLoadResult>("JarvisContextLoadResult")({
	globalDir: Schema.String,
	projectDir: Schema.String,
	documents: Schema.Array(JarvisContextDocument),
}) {
	get summaries(): ReadonlyArray<JarvisContextDocumentSummary> {
		return this.documents.map(
			(document) =>
				new JarvisContextDocumentSummary({
					name: document.name,
					source: document.source,
					loaded: document.content.trim().length > 0,
				}),
		);
	}
}

const mergeContext = (
	globalContent: string,
	projectContent: string,
): { readonly content: string; readonly source: JarvisContextSource } => {
	if (projectContent.trim().length === 0) {
		return {
			content: globalContent,
			source: globalContent.trim().length > 0 ? "global" : "none",
		};
	}
	if (projectContent.includes("{{global}}")) {
		return {
			content: projectContent.replaceAll("{{global}}", globalContent),
			source: globalContent.trim().length > 0 ? "merged" : "project",
		};
	}
	return { content: projectContent, source: "project" };
};

/** Loads legacy Jarvis context without mutating or migrating it. */
export class JarvisContextLoader extends Context.Service<
	JarvisContextLoader,
	{
		readonly loadLegacy: (paths: JarvisPaths) => Effect.Effect<JarvisContextLoadResult, HarnessError>;
	}
>()("@harnessy/core/JarvisContextLoader") {
	static readonly layer = Layer.effect(
		JarvisContextLoader,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;

			const exists = (path: string) =>
				fs.exists(path).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: `Could not inspect Jarvis path ${path}: ${causeMessage(cause)}`,
								cause,
							}),
					),
				);
			const readOptional = Effect.fn("JarvisContextLoader.readOptional")(function* (path: string) {
				if (!(yield* exists(path))) return "";
				return yield* fs.readFileString(path).pipe(
					Effect.mapError(
						(cause) =>
							new HarnessError({
								message: `Could not read Jarvis context ${path}: ${causeMessage(cause)}`,
								cause,
							}),
					),
				);
			});

			const loadLegacy = Effect.fn("JarvisContextLoader.loadLegacy")(function* (paths: JarvisPaths) {
				const projectDir = (yield* exists(paths.legacyProjectContextDir))
					? paths.legacyProjectContextDir
					: paths.legacyFallbackContextDir;
				const documents: Array<JarvisContextDocument> = [];

				for (const name of JARVIS_CONTEXT_FILES) {
					const globalContent = yield* readOptional(`${paths.legacyGlobalContextDir}/${name}`);
					const projectContent = yield* readOptional(`${projectDir}/${name}`);
					const merged = mergeContext(globalContent, projectContent);
					documents.push(new JarvisContextDocument({ name, source: merged.source, content: merged.content }));
				}

				return new JarvisContextLoadResult({
					globalDir: paths.legacyGlobalContextDir,
					projectDir,
					documents,
				});
			});

			return { loadLegacy };
		}),
	);
}
