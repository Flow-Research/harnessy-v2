/** Read-only skills summary. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { readBoundedDirectory } from "./files.ts";
import type { SkillsSummaryData } from "./schemas.ts";
import { guardTile, okTile, type ReadModelOptions, readClock, type TileResult } from "./tile.ts";

export interface SkillsReadOptions extends ReadModelOptions {
	readonly homeRoot?: string;
	/** The most skill entries to count. */
	readonly maxEntries?: number;
}

/** The number of installed skills under `~/.agents/skills`. Names and contents are not returned. */
export const readSkillsSummary = (options: SkillsReadOptions = {}): TileResult<SkillsSummaryData> => {
	const now = readClock(options);
	return guardTile(now, () => {
		const root = join(resolve(options.homeRoot ?? homedir()), ".agents", "skills");
		const listing = readBoundedDirectory(root, options.maxEntries ?? 2_000, true);
		const count = listing.entries.filter(
			(entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
		).length;
		return okTile({ count, truncated: listing.truncated }, now);
	});
};
