/**
 * Tile results for the read-only portal read model.
 *
 * A reader never throws for an expected state. It reports the state of one
 * source as a tile, so that a busy database or a missing file degrades one tile
 * instead of failing a whole page.
 */
import * as Result from "effect/Result";

/** How one source could be read. Every state except `ok` carries a fixed `reason` code. */
export type ReadState = "ok" | "missing" | "busy" | "recovering" | "unsupported" | "unsafe" | "error";

export interface TileResult<A> {
	readonly state: ReadState;
	readonly data?: A;
	/** A fixed, content-free code. Never an error message, path or provider text. */
	readonly reason?: string;
	readonly readAt: string;
}

export interface ReadModelOptions {
	/** The clock for `readAt` and freshness checks. */
	readonly now?: Date;
	/** SQLite busy timeout for one read. */
	readonly timeoutMs?: number;
}

/** Short enough that a synchronous `node:sqlite` read cannot stall a server for long. */
export const DEFAULT_READ_TIMEOUT_MS = 250;
/** Text is returned only up to this size. */
export const MAX_TEXT_BYTES = 64 * 1024;

/** A degraded state raised inside a reader and turned into a tile by {@link guardTile}. */
export class ReadModelStateError extends Error {
	readonly state: Exclude<ReadState, "ok">;
	readonly reason: string;

	constructor(state: Exclude<ReadState, "ok">, reason: string) {
		super(`${state}: ${reason}`);
		this.name = "ReadModelStateError";
		this.state = state;
		this.reason = reason;
	}
}

export const okTile = <A>(data: A, now: Date): TileResult<A> => ({ state: "ok", data, readAt: now.toISOString() });

export const stateTile = <A>(state: Exclude<ReadState, "ok">, reason: string, now: Date): TileResult<A> => ({
	state,
	reason,
	readAt: now.toISOString(),
});

/** Run one reader. A {@link ReadModelStateError} keeps its state; any other error becomes `error`. */
export const guardTile = <A>(now: Date, read: () => TileResult<A>): TileResult<A> => {
	const result = Result.try(read);
	if (Result.isSuccess(result)) return result.success;
	return result.failure instanceof ReadModelStateError
		? stateTile(result.failure.state, result.failure.reason, now)
		: stateTile("error", "read_failed", now);
};

export const readTimeout = (options: ReadModelOptions): number => {
	const value = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 10_000) : DEFAULT_READ_TIMEOUT_MS;
};

export const readClock = (options: ReadModelOptions): Date => options.now ?? new Date();
