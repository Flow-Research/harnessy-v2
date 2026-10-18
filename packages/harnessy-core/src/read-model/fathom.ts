/**
 * Read-only Fathom summary: configured accounts, inbox counts and the V2 poll checkpoint.
 *
 * The checkpoint tile comes from `inspectFathomStatus`, which reads the V2
 * `poll-state-v2.json` under `~/.harnessy/jarvis/state/fathom` with
 * {@link readFathomCheckpoint}, so the portal and the CLI report the same poll evidence.
 * It returns counts only and never reads an envelope.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { inspectFathomStatus } from "../jarvis/fathom/status.ts";
import { fathomV2CheckpointPath, MAX_FATHOM_CHECKPOINT_BYTES, readFathomCheckpoint } from "./fathom-checkpoint.ts";
import { assertDelegatedFileBounded } from "./files.ts";
import type { FathomCheckpointData, FathomConfigData, FathomInboxData } from "./schemas.ts";
import { guardTile, okTile, type ReadModelOptions, readClock, stateTile, type TileResult } from "./tile.ts";

export { fathomV2CheckpointPath, MAX_FATHOM_CHECKPOINT_BYTES, readFathomCheckpoint };

export interface FathomReadOptions extends ReadModelOptions {
	/** The home directory that holds `.jarvis` and `.harnessy` and that a leading `~` in a configured path expands to. */
	readonly homeRoot?: string;
	/** Defaults to `<homeRoot>/.jarvis/config.yaml`. */
	readonly configPath?: string;
	/** The project-private source root that holds `meeting-inbox/fathom`. */
	readonly sourceRoot?: string;
}

export interface FathomSummary {
	readonly config: TileResult<FathomConfigData>;
	readonly inbox: TileResult<FathomInboxData>;
	readonly checkpoint: TileResult<FathomCheckpointData>;
}

/** Fathom configuration, inbox counts and V2 checkpoint freshness. Reads only. */
export const readFathomSummary = (options: FathomReadOptions = {}): FathomSummary => {
	const now = readClock(options);
	const homeRoot = resolve(options.homeRoot ?? homedir());
	const configPath = resolve(options.configPath ?? join(homeRoot, ".jarvis", "config.yaml"));
	let status: ReturnType<typeof inspectFathomStatus> | undefined;
	const config = guardTile(now, (): TileResult<FathomConfigData> => {
		if (!existsSync(configPath)) return stateTile("missing", "config_missing", now);
		const stateRoot = join(homeRoot, ".harnessy", "jarvis", "state", "fathom");
		// `inspectFathomStatus` reads these whole; refuse a FIFO or an oversize file first.
		// Its inbox scan lists directories only and never opens an envelope.
		assertDelegatedFileBounded(configPath);
		assertDelegatedFileBounded(join(stateRoot, "poll-state.json"));
		status = inspectFathomStatus({
			homeRoot,
			configPath,
			stateRoot,
			now,
			...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
		});
		if (status.issues.includes("configuration has invalid YAML")) return stateTile("error", "config_invalid", now);
		return okTile(
			{
				accounts: [...status.accounts],
				defaultAccount: status.defaultAccount,
				pollingConfigured: status.polling.configured,
				pollAccounts: [...status.polling.accounts],
				issueCount: status.issues.length + status.polling.issues.length,
			},
			now,
		);
	});
	const loaded = config.state === "ok" ? status : undefined;
	const inbox = guardTile(now, (): TileResult<FathomInboxData> => {
		if (loaded === undefined) return stateTile("missing", "config_unavailable", now);
		if (!existsSync(loaded.inboxPath)) return stateTile("missing", "inbox_missing", now);
		const totals = { pending: 0, processed: 0, invalid: 0 };
		const accounts: Record<string, { pending: number; processed: number; invalid: number }> = {};
		for (const [account, counts] of Object.entries(loaded.inboxCounts)) {
			// `inspectFathomStatus` always reports all three buckets.
			const buckets = { pending: counts.pending!, processed: counts.processed!, invalid: counts.invalid! };
			accounts[account] = buckets;
			totals.pending += buckets.pending;
			totals.processed += buckets.processed;
			totals.invalid += buckets.invalid;
		}
		return okTile({ accounts, totals }, now);
	});
	let checkpoint: TileResult<FathomCheckpointData> = stateTile("missing", "config_unavailable", now);
	if (loaded !== undefined) {
		const { path: _path, ...tile } = loaded.pollCheckpoint;
		checkpoint = tile;
	}
	return { config, inbox, checkpoint };
};
