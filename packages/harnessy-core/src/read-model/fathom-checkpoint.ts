/**
 * The V2 Fathom poll checkpoint reader, shared by the portal read model and
 * `harnessy jarvis meeting fathom status`.
 *
 * The V2 poller writes `poll-state-v2.json` under `~/.harnessy/jarvis/state/fathom`.
 * This reader validates it with the poller's own parser, reports only per-account
 * `updatedAt` freshness and never returns cursors or seen-recording hashes.
 */
import { join } from "node:path";

import * as Result from "effect/Result";

import { fathomAccountKey, fathomFileStoreStateFile, parseFathomFileStoreState } from "../jarvis/fathom/file-store.ts";
import { FATHOM_POLL_INTERVAL_SECONDS } from "../jarvis/fathom/poll.ts";
import { readBoundedFile } from "./files.ts";
import type { FathomCheckpointData } from "./schemas.ts";
import { guardTile, okTile, ReadModelStateError, type TileResult } from "./tile.ts";

export const MAX_FATHOM_CHECKPOINT_BYTES = 1024 * 1024;

/** Where the V2 poller keeps its checkpoint for one home directory. */
export const fathomV2CheckpointPath = (homeRoot: string): string =>
	join(homeRoot, ".harnessy", "jarvis", "state", "fathom", fathomFileStoreStateFile);

/**
 * Read the V2 checkpoint at `path` and report freshness for each configured account.
 * An absent file is `missing`; a symbolic link, non-file or oversize file is `unsafe`;
 * content that the poller itself would reject is `error` with reason `checkpoint_invalid`.
 */
export const readFathomCheckpoint = (
	path: string,
	accounts: ReadonlyArray<string>,
	now: Date,
): TileResult<FathomCheckpointData> =>
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
