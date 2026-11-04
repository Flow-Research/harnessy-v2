import { createHash } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export const FATHOM_API_BASE_URL = "https://api.fathom.ai/external/v1";
export const FATHOM_INGEST_MAX_LIMIT = 100;
export const FATHOM_INGEST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface FathomMeetingPayload {
	readonly recording_id: string | number;
	readonly [key: string]: unknown;
}

export interface FathomPage {
	readonly items: ReadonlyArray<FathomMeetingPayload>;
	readonly nextCursor: string | null;
}

export interface FathomProviderRequest {
	readonly account: string;
	readonly cursor: string | null;
	/** Restrict polling to the recent rolling window; proven by the V1 client. */
	readonly createdAfter?: string | null;
	readonly limit: number;
	readonly signal?: AbortSignal;
}

export interface FathomProvider {
	readonly listMeetings: (request: FathomProviderRequest) => Promise<FathomPage>;
}

/** Resolve credentials at call time; the key is never part of an ingest receipt. */
export interface FathomCredentialBinding {
	readonly account: string;
	readonly readApiKey: () => Promise<string>;
}

export interface FathomImportEnvelope {
	readonly version: 1;
	readonly verified: true;
	readonly account: string;
	readonly source: "fathom-api";
	readonly fetchedAt: string;
	readonly payload: FathomMeetingPayload;
}

export interface FathomIngestCheckpoint {
	readonly cursor: string | null;
	/** Fixed rolling-window floor paired with an unfinished cursor; absent on legacy state. */
	readonly windowCreatedAfter?: string | null;
	readonly seen: Readonly<Record<string, string>>;
	readonly updatedAt: string | null;
}

export interface FathomIngestStore {
	readonly loadCheckpoint: (account: string) => Promise<FathomIngestCheckpoint>;
	/** The id is the idempotency key. A duplicate must not rewrite the envelope. */
	readonly putPending: (
		account: string,
		recordingId: string,
		envelope: FathomImportEnvelope,
	) => Promise<"imported" | "duplicate">;
	readonly saveCheckpoint: (account: string, checkpoint: FathomIngestCheckpoint) => Promise<void>;
}

export interface FathomIngestOptions {
	readonly account: string;
	readonly provider: FathomProvider;
	readonly store: FathomIngestStore;
	readonly limit?: number;
	readonly createdAfter?: string | null;
	readonly now?: () => string;
	readonly signal?: AbortSignal;
}

export interface FathomIngestReceipt {
	readonly account: string;
	readonly fetched: number;
	readonly imported: number;
	readonly duplicates: number;
	readonly nextCursor: string | null;
	readonly checkpointAdvanced: boolean;
	readonly failure: FathomIngestFailure | null;
}

export interface FathomIngestFailure {
	readonly code: "provider" | "credential" | "checkpoint" | "import";
	readonly retryable: boolean;
	readonly message: string;
}

export class FathomProviderError extends Error {
	readonly retryable: boolean;
	readonly status: number | null;

	constructor(message: string, options: { readonly retryable: boolean; readonly status?: number | null }) {
		super(message);
		this.name = "FathomProviderError";
		this.retryable = options.retryable;
		this.status = options.status ?? null;
	}
}

const boundedLimit = (limit: number | undefined): number => {
	const value = Math.trunc(limit ?? 20);
	if (!Number.isSafeInteger(value) || value < 1) return 1;
	return Math.min(value, FATHOM_INGEST_MAX_LIMIT);
};

const recordingId = (value: unknown): string | null => {
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
	return null;
};

const failureFrom = (code: FathomIngestFailure["code"], error: unknown): FathomIngestFailure => ({
	code,
	retryable: error instanceof FathomProviderError ? error.retryable : code === "checkpoint",
	message: `Fathom ${code} operation failed`,
});

const settlePromise = async <A>(promise: Promise<A>): Promise<{ readonly value?: A; readonly error?: unknown }> => {
	const exit = await Effect.runPromiseExit(Effect.tryPromise({ try: () => promise, catch: (error) => error }));
	return Exit.isSuccess(exit) ? { value: exit.value } : { error: Cause.squash(exit.cause) };
};

const settleSync = <A>(thunk: () => A): { readonly value?: A; readonly error?: unknown } => {
	const exit = Effect.runSyncExit(Effect.try({ try: thunk, catch: (error) => error }));
	return Exit.isSuccess(exit) ? { value: exit.value } : { error: Cause.squash(exit.cause) };
};

/** One bounded page. A failed page never advances the checkpoint, so retrying is safe. */
export const ingestFathomPage = async (options: FathomIngestOptions): Promise<FathomIngestReceipt> => {
	const limit = boundedLimit(options.limit);
	const now = options.now ?? (() => new Date().toISOString());
	const checkpointResult = await settlePromise(options.store.loadCheckpoint(options.account));
	if (checkpointResult.error !== undefined) {
		return {
			account: options.account,
			fetched: 0,
			imported: 0,
			duplicates: 0,
			nextCursor: null,
			checkpointAdvanced: false,
			failure: failureFrom("checkpoint", checkpointResult.error),
		};
	}
	const checkpoint = checkpointResult.value as FathomIngestCheckpoint;
	const savedWindow = checkpoint.windowCreatedAfter;
	if (
		(savedWindow != null &&
			(typeof savedWindow !== "string" ||
				!Number.isFinite(Date.parse(savedWindow)) ||
				checkpoint.cursor === null)) ||
		(options.createdAfter != null && !Number.isFinite(Date.parse(options.createdAfter)))
	) {
		return {
			account: options.account,
			fetched: 0,
			imported: 0,
			duplicates: 0,
			nextCursor: checkpoint.cursor,
			checkpointAdvanced: false,
			failure: failureFrom("checkpoint", new Error("invalid window")),
		};
	}
	const createdAfter = options.createdAfter == null ? null : (savedWindow ?? options.createdAfter);
	const cursor = options.createdAfter == null ? checkpoint.cursor : savedWindow == null ? null : checkpoint.cursor;
	let page: FathomPage;
	const pageResult = await settlePromise(
		options.provider.listMeetings({
			account: options.account,
			// Continue an unfinished window with its original filter. Legacy historical
			// cursors have no matching filter and must not be reused for a rolling poll.
			cursor,
			createdAfter,
			limit,
			signal: options.signal,
		}),
	);
	if (pageResult.error !== undefined) {
		return {
			account: options.account,
			fetched: 0,
			imported: 0,
			duplicates: 0,
			nextCursor: checkpoint.cursor,
			checkpointAdvanced: false,
			failure: failureFrom("provider", pageResult.error),
		};
	}
	page = pageResult.value as FathomPage;
	let imported = 0;
	let duplicates = 0;
	const seen = { ...checkpoint.seen };
	for (const payload of page.items) {
		const id = recordingId(payload.recording_id);
		if (id === null) throw new Error("Fathom page contains a meeting without a recording ID");
		const envelope: FathomImportEnvelope = {
			version: 1,
			verified: true,
			account: options.account,
			source: "fathom-api",
			fetchedAt: now(),
			payload,
		};
		const putResult =
			seen[id] === undefined
				? await settlePromise(options.store.putPending(options.account, id, envelope))
				: { value: "duplicate" as const };
		if (putResult.error !== undefined) {
			return {
				account: options.account,
				fetched: page.items.length,
				imported,
				duplicates,
				nextCursor: checkpoint.cursor,
				checkpointAdvanced: false,
				failure: failureFrom("import", putResult.error),
			};
		}
		const result = putResult.value as "imported" | "duplicate";
		if (result === "imported") imported += 1;
		else duplicates += 1;
		seen[id] = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	}
	const nextCheckpoint: FathomIngestCheckpoint = {
		cursor: page.nextCursor,
		windowCreatedAfter: page.nextCursor === null ? null : createdAfter,
		seen,
		updatedAt: now(),
	};
	const saveResult = await settlePromise(options.store.saveCheckpoint(options.account, nextCheckpoint));
	if (saveResult.error !== undefined) {
		return {
			account: options.account,
			fetched: page.items.length,
			imported,
			duplicates,
			nextCursor: checkpoint.cursor,
			checkpointAdvanced: false,
			failure: failureFrom("checkpoint", saveResult.error),
		};
	}
	return {
		account: options.account,
		fetched: page.items.length,
		imported,
		duplicates,
		nextCursor: page.nextCursor,
		checkpointAdvanced: true,
		failure: null,
	};
};

const responseText = async (response: Response): Promise<string> => {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > FATHOM_INGEST_MAX_RESPONSE_BYTES)
		throw new FathomProviderError("Fathom response exceeds the bounded size", { retryable: false });
	const body = await response.text();
	if (new TextEncoder().encode(body).byteLength > FATHOM_INGEST_MAX_RESPONSE_BYTES)
		throw new FathomProviderError("Fathom response exceeds the bounded size", { retryable: false });
	return body;
};

/** HTTP provider; it is inert until the caller invokes listMeetings. */
export const createFathomHttpProvider = (options: {
	readonly credentials: FathomCredentialBinding;
	readonly fetch?: typeof globalThis.fetch;
	readonly baseUrl?: string;
}): FathomProvider => {
	const fetcher = options.fetch ?? globalThis.fetch;
	const baseUrl = options.baseUrl ?? FATHOM_API_BASE_URL;
	return {
		listMeetings: async ({ account, cursor, createdAfter, limit, signal }) => {
			if (account !== options.credentials.account)
				throw new FathomProviderError("credential account mismatch", { retryable: false });
			const apiKey = await options.credentials.readApiKey();
			if (apiKey.trim().length === 0) throw new FathomProviderError("Fathom API key is empty", { retryable: false });
			const url = new URL("meetings", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
			url.searchParams.set("limit", String(boundedLimit(limit)));
			url.searchParams.set("include_transcript", "true");
			url.searchParams.set("include_summary", "true");
			url.searchParams.set("include_action_items", "true");
			if (cursor !== null) url.searchParams.set("cursor", cursor);
			if (createdAfter != null) url.searchParams.set("created_after", createdAfter);
			let response: Response;
			const responseResult = await settlePromise(
				fetcher(url, { headers: { "x-api-key": apiKey, accept: "application/json" }, signal, redirect: "error" }),
			);
			if (responseResult.error !== undefined)
				throw new FathomProviderError("Fathom request failed", { retryable: true });
			response = responseResult.value as Response;
			if (!response.ok) {
				throw new FathomProviderError(`Fathom returned HTTP ${response.status}`, {
					retryable: response.status === 408 || response.status === 429 || response.status >= 500,
					status: response.status,
				});
			}
			const bodyResult = await settlePromise(responseText(response));
			if (bodyResult.error !== undefined) {
				throw new FathomProviderError("Invalid Fathom response body", { retryable: false });
			}
			const parsedResult = settleSync(() => JSON.parse(bodyResult.value as string));
			if (parsedResult.error !== undefined) {
				throw new FathomProviderError("Invalid Fathom response JSON", {
					retryable: false,
				});
			}
			const parsed = parsedResult.value;
			if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { items?: unknown }).items))
				throw new FathomProviderError("Fathom response does not contain an items array", { retryable: false });
			const raw = parsed as { items: unknown[]; next_cursor?: unknown };
			const validItems = raw.items.every((item) => {
				if (typeof item !== "object" || item === null) return false;
				return recordingId((item as { recording_id?: unknown }).recording_id) !== null;
			});
			if (!validItems) throw new FathomProviderError("Invalid Fathom meeting page", { retryable: false });
			if (raw.next_cursor != null && typeof raw.next_cursor !== "string")
				throw new FathomProviderError("Invalid Fathom page cursor", { retryable: false });
			return {
				items: raw.items as FathomMeetingPayload[],
				nextCursor: typeof raw.next_cursor === "string" && raw.next_cursor.length > 0 ? raw.next_cursor : null,
			};
		},
	};
};
