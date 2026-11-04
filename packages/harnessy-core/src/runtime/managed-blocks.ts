import { FileSystem, Path } from "effect";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { causeMessage, HarnessError } from "../errors.ts";
import type { HarnessPaths } from "../paths.ts";
import type { InstallPaths } from "./install-paths.ts";

const PROJECT_BLOCK_START = "<!-- harnessy:start -->";
const PROJECT_BLOCK_END = "<!-- harnessy:end -->";
const CONTEXT_BLOCK_START = "<!-- harnessy-context:start -->";
const CONTEXT_BLOCK_END = "<!-- harnessy-context:end -->";

/** Result of syncing one managed markdown block. */
export interface ManagedBlockResult {
	/** Absolute path to the managed file. */
	readonly path: string;
	/** Whether a file write happened. */
	readonly changed: boolean;
	/** Machine-readable merge outcome. */
	readonly status: "created" | "updated" | "appended" | "current" | "dry-run";
}

/** Result of syncing both v1-style Harnessy managed files. */
export interface ManagedBlocksResult {
	/** Root AGENTS.md merge result when requested. */
	readonly agentsMd?: ManagedBlockResult;
	/** Context protocol merge result when requested. */
	readonly contextAgents?: ManagedBlockResult;
}

/** Generate the project-root managed section. */
const projectSection = (installPaths: InstallPaths): string => `${PROJECT_BLOCK_START}
## Harnessy Framework

This repo is Harnessy-managed.

- Read \`${installPaths.contextDir}/README.md\`.
- Read \`${installPaths.contextDir}/AGENTS.md\`.
- Project-local skills live in \`${installPaths.skillsDir}/\` when present.
- Runtime profiles live under \`.harnessy/profiles/\`.
- Scoped memory lives under \`.harnessy/memory/\`.
- Run \`harnessy verify\` before relying on installed capability state.
- Garden may layer enterprise workspace policy, approvals, connector auth, and audit on top of this local Harnessy state.
${PROJECT_BLOCK_END}`;

/** Generate the context-vault managed section. */
const contextSection = (installPaths: InstallPaths): string => `${CONTEXT_BLOCK_START}
## Harnessy Protocol

This file contains the project-local Harnessy agent protocol.

### Session Start

1. Read \`${installPaths.contextDir}/README.md\`.
2. Load active Harnessy profile context from \`.harnessy/profiles/default.json\` unless another profile is selected.
3. Check capability resources under \`.harnessy/capabilities/\` before invoking capability-specific behavior.
4. Check scoped memory under \`.harnessy/memory/\` for durable facts, decisions, preferences, and events.
5. Prefer project-local skills in \`${installPaths.skillsDir}/\` when present.

### Operating Rules

- Keep secrets out of memory and context files.
- Keep durable decisions in memory or context, not only in chat.
- Treat capability manifests as policy contracts for permissions, data categories, egress, and blast radius.
- Use deterministic verification before agentic repair loops.
${CONTEXT_BLOCK_END}`;

/** Initial context AGENTS.md file when no file exists. */
const initialContextFile = (installPaths: InstallPaths): string => `# Harnessy Context AGENTS

This file contains Harnessy's installed agent protocol for this repository.

Harnessy manages only the dedicated block below. Add project-specific notes outside that block.

${contextSection(installPaths)}
`;

/** Replace an existing managed block, append when absent, or create a new file. */
const mergeManagedBlock = Effect.fn("ManagedBlocks.mergeManagedBlock")(function* (
	filePath: string,
	section: string,
	initialContent: string,
	markers: { readonly start: string; readonly end: string },
	dryRun: boolean,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const exists = yield* fs.exists(filePath);
	if (!exists) {
		if (dryRun) return { path: filePath, changed: true, status: "dry-run" } satisfies ManagedBlockResult;
		yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
		yield* fs.writeFileString(filePath, initialContent);
		return { path: filePath, changed: true, status: "created" } satisfies ManagedBlockResult;
	}

	const existing = yield* fs.readFileString(filePath);
	const startIndex = existing.indexOf(markers.start);
	const endIndex = existing.indexOf(markers.end);
	if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
		const updated = `${existing.slice(0, startIndex)}${section}${existing.slice(endIndex + markers.end.length)}`;
		if (updated === existing)
			return { path: filePath, changed: false, status: "current" } satisfies ManagedBlockResult;
		if (dryRun) return { path: filePath, changed: true, status: "dry-run" } satisfies ManagedBlockResult;
		yield* fs.writeFileString(filePath, updated);
		return { path: filePath, changed: true, status: "updated" } satisfies ManagedBlockResult;
	}

	const appended = `${existing.trimEnd()}\n\n${section}\n`;
	if (dryRun) return { path: filePath, changed: true, status: "dry-run" } satisfies ManagedBlockResult;
	yield* fs.writeFileString(filePath, appended);
	return { path: filePath, changed: true, status: "appended" } satisfies ManagedBlockResult;
});

/** Managed block operations for native v1-compatible installer behavior. */
export class ManagedBlocks extends Context.Service<
	ManagedBlocks,
	{
		/** Merge the project-root AGENTS.md Harnessy managed block. */
		readonly syncProjectAgents: (
			paths: HarnessPaths,
			installPaths: InstallPaths,
			dryRun: boolean,
		) => Effect.Effect<ManagedBlockResult, HarnessError>;
		/** Merge the context-vault AGENTS.md Harnessy managed block. */
		readonly syncContextAgents: (
			paths: HarnessPaths,
			installPaths: InstallPaths,
			dryRun: boolean,
		) => Effect.Effect<ManagedBlockResult, HarnessError>;
	}
>()("@harnessy/core/ManagedBlocks") {
	/** Live markdown managed-block service. */
	static readonly layer = Layer.effect(
		ManagedBlocks,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;

			const mapPlatformError = (action: string, cause: unknown): HarnessError =>
				new HarnessError({ message: `${action}: ${causeMessage(cause)}`, cause });

			const syncProjectAgents = Effect.fn("ManagedBlocks.syncProjectAgents")(function* (
				paths: HarnessPaths,
				installPaths: InstallPaths,
				dryRun: boolean,
			) {
				const filePath = path.join(paths.targetDir, installPaths.agentsFile);
				return yield* mergeManagedBlock(
					filePath,
					projectSection(installPaths),
					`${projectSection(installPaths)}\n`,
					{ start: PROJECT_BLOCK_START, end: PROJECT_BLOCK_END },
					dryRun,
				).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
					Effect.mapError((cause) => mapPlatformError(`Could not sync ${filePath}`, cause)),
				);
			});

			const syncContextAgents = Effect.fn("ManagedBlocks.syncContextAgents")(function* (
				paths: HarnessPaths,
				installPaths: InstallPaths,
				dryRun: boolean,
			) {
				const filePath = path.join(paths.targetDir, installPaths.contextDir, "AGENTS.md");
				return yield* mergeManagedBlock(
					filePath,
					contextSection(installPaths),
					initialContextFile(installPaths),
					{ start: CONTEXT_BLOCK_START, end: CONTEXT_BLOCK_END },
					dryRun,
				).pipe(
					Effect.provideService(FileSystem.FileSystem, fs),
					Effect.provideService(Path.Path, path),
					Effect.mapError((cause) => mapPlatformError(`Could not sync ${filePath}`, cause)),
				);
			});

			return { syncProjectAgents, syncContextAgents };
		}),
	);
}
