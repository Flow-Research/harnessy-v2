/**
 * Read-only Fathom summary: configured accounts, inbox counts and the V2 poll checkpoint.
 *
 * `inspectFathomStatus` looks for the V1 `~/.jarvis/state/fathom/poll-state.json`,
 * but the V2 poller writes `poll-state-v2.json` under `~/.harnessy/jarvis/state/fathom`.
 * This reader reads the V2 checkpoint, so the portal sees real poll evidence.
 * It returns counts only and never reads an envelope.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import * as Result from "effect/Result";

import { fathomAccountKey, fathomFileStoreStateFile, parseFathomFileStoreState } from "../jarvis/fathom/file-store.ts";
import { FATHOM_POLL_INTERVAL_SECONDS } from "../jarvis/fathom/poll.ts";
import { inspectFathomStatus } from "../jarvis/fathom/status.ts";
import { readBoundedFile } from "./files.ts";
import type { FathomCheckpointData, FathomConfigData, FathomInboxData } from "./schemas.ts";
import {
	guardTile,
	okTile,
	type ReadModelOptions,
	ReadModelStateError,
	readClock,
	stateTile,
	type TileResult,
} from "./tile.ts";

export const MAX_FATHOM_CHECKPOINT_BYTES = 1024 * 1024;

export interface FathomReadOptions extends ReadModelOptions {
	/** The home directory that holds `.jarvis` and `.harnessy`. */
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

/** Where the V2 poller keeps its checkpoint for one home directory. */
export const fathomV2CheckpointPath = (homeRoot: string): string =>
	join(homeRoot, ".harnessy", "jarvis", "state", "fathom", fathomFileStoreStateFile);

const readCheckpoint = (path: string, accounts: ReadonlyArray<string>, now: Date): TileResult<FathomCheckpointData> =>
	guardTile(now, () => {
		const file = readBoundedFile(path, MAX_FATHOM_CHECKPOINT_BYTES);
		if (file.truncated) throw new ReadModelStateError("unsafe", "checkpoint_oversize");
		const parsed = Result.try(() => parseFathomFileStoreState(file.bytes.toString("utf8")));
		if (Result.isFailure(parsed)) throw new ReadModelStateError("error", "checkpoint_invalid");
		const state = parsed.success;
		const known = new Set(accounts.map(fathomAccountKey));
		const staleAfterSeconds = 2 * FATHOM_POLL_INTERVAL_SECONDS;
		return okTile(
			{
				intervalSeconds: FATHOM_POLL_INTERVAL_SECONDS,
				modifiedAt: file.modifiedAt.toISOString(),
				accounts: accounts.map((account) => {
					const updatedAt = state.accounts[fathomAccountKey(account)]?.updatedAt ?? null;
					const ageSeconds =
						updatedAt === null ? null : Math.max(0, Math.floor((now.getTime() - Date.parse(updatedAt)) / 1000));
					return { account, updatedAt, ageSeconds, stale: ageSeconds === null || ageSeconds > staleAfterSeconds };
				}),
				unknownAccounts: Object.keys(state.accounts).filter((key) => !known.has(key)).length,
			},
			now,
		);
	});

/** Fathom configuration, inbox counts and V2 checkpoint freshness. Reads only. */
export const readFathomSummary = (options: FathomReadOptions = {}): FathomSummary => {
	const now = readClock(options);
	const homeRoot = resolve(options.homeRoot ?? homedir());
	const configPath = resolve(options.configPath ?? join(homeRoot, ".jarvis", "config.yaml"));
	let status: ReturnType<typeof inspectFathomStatus> | undefined;
	const config = guardTile(now, (): TileResult<FathomConfigData> => {
		if (!existsSync(configPath)) return stateTile("missing", "config_missing", now);
		status = inspectFathomStatus({
			configPath,
			stateRoot: join(homeRoot, ".harnessy", "jarvis", "state", "fathom"),
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
	const checkpoint =
		loaded === undefined
			? stateTile<FathomCheckpointData>("missing", "config_unavailable", now)
			: readCheckpoint(fathomV2CheckpointPath(homeRoot), loaded.accounts, now);
	return { config, inbox, checkpoint };
};
