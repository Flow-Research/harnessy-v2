import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
	type FathomImportEnvelope,
	type FathomIngestCheckpoint,
	type FathomIngestStore,
	type FathomMeetingPayload,
	fathomPayloadHash,
} from "./ingest.ts";
import { tryProcessLock } from "./process-lock.ts";

const STATE_FILE = "poll-state-v2.json";
const SOURCE_FIELDS = ["action_items", "default_summary", "transcript", "highlights"] as const;

const emptySource = (value: unknown): boolean =>
	value === undefined ||
	value === null ||
	value === "" ||
	(Array.isArray(value) && value.length === 0) ||
	(typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.keys(value).length === 0 ||
			("markdown_formatted" in value && !(value as { markdown_formatted?: unknown }).markdown_formatted)));

/** The newer payload, with each source field it leaves empty taken from the stored one. */
export const mergeSourceFields = (
	stored: FathomMeetingPayload,
	incoming: FathomMeetingPayload,
): FathomMeetingPayload => {
	const merged: Record<string, unknown> = { ...incoming };
	for (const field of SOURCE_FIELDS)
		if (emptySource(incoming[field]) && !emptySource(stored[field])) merged[field] = stored[field];
	return merged as FathomMeetingPayload;
};

export interface FathomPersistedPollState {
	readonly version: 1;
	readonly accounts: Readonly<Record<string, FathomIngestCheckpoint>>;
}

const emptyCheckpoint = (): FathomIngestCheckpoint => ({ cursor: null, seen: {}, updatedAt: null });

/** The state-file key of one account label: the label itself is never stored. */
export const fathomAccountKey = (account: string): string =>
	createHash("sha256").update(account).digest("hex").slice(0, 24);
const recordingKey = (recordingId: string): string => createHash("sha256").update(recordingId).digest("hex");

const validateCheckpoint = (value: FathomIngestCheckpoint): void => {
	if (
		!value ||
		typeof value !== "object" ||
		(value.cursor !== null && (typeof value.cursor !== "string" || value.cursor.length === 0)) ||
		(value.updatedAt !== null &&
			(typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)))) ||
		!value.seen ||
		typeof value.seen !== "object" ||
		Array.isArray(value.seen) ||
		Object.values(value.seen).some((hash) => typeof hash !== "string") ||
		(value.windowCreatedAfter != null &&
			(typeof value.windowCreatedAfter !== "string" ||
				!Number.isFinite(Date.parse(value.windowCreatedAfter)) ||
				value.cursor === null))
	)
		throw new Error("invalid V2 Fathom checkpoint");
};

/** Parse and validate the V2 poll state file; throws on any invalid content. */
export const parseFathomFileStoreState = (raw: string): FathomPersistedPollState => {
	const value = JSON.parse(raw) as Partial<FathomPersistedPollState>;
	if (
		!value ||
		value.version !== 1 ||
		value.accounts === null ||
		typeof value.accounts !== "object" ||
		Array.isArray(value.accounts)
	)
		throw new Error("invalid V2 Fathom poll state");
	for (const checkpoint of Object.values(value.accounts)) validateCheckpoint(checkpoint);
	return { version: 1, accounts: value.accounts as Readonly<Record<string, FathomIngestCheckpoint>> };
};

/** V2-owned durable store for bounded Fathom polling; it never mutates V1 state. */
export class FathomFileStore implements FathomIngestStore {
	readonly #inboxRoot: string;
	readonly #statePath: string;
	readonly #loaded = new Map<string, string>();

	constructor(options: { readonly inboxRoot: string; readonly stateRoot: string }) {
		this.#inboxRoot = options.inboxRoot;
		this.#statePath = join(options.stateRoot, STATE_FILE);
	}

	async loadCheckpoint(account: string): Promise<FathomIngestCheckpoint> {
		const checkpoint = existsSync(this.#statePath)
			? (parseFathomFileStoreState(readFileSync(this.#statePath, "utf8")).accounts[fathomAccountKey(account)] ??
				emptyCheckpoint())
			: emptyCheckpoint();
		this.#loaded.set(fathomAccountKey(account), JSON.stringify(checkpoint));
		return checkpoint;
	}

	async putPending(
		account: string,
		recordingId: string,
		envelope: FathomImportEnvelope,
	): Promise<"imported" | "duplicate"> {
		if (!/^[A-Za-z0-9_-]+$/.test(account)) throw new Error("invalid Fathom account path");
		const directory = join(this.#inboxRoot, account, "pending");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const destination = join(directory, `${recordingKey(recordingId)}.json`);
		if (existsSync(destination)) return "duplicate";
		const temporary = `${destination}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(envelope)}\n`);
			fsyncSync(fd);
			const linked = Effect.runSyncExit(
				Effect.try({ try: () => linkSync(temporary, destination), catch: (error) => error }),
			);
			if (Exit.isFailure(linked)) {
				const error = Cause.squash(linked.cause);
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return "duplicate";
				throw error;
			}
			return "imported";
		} finally {
			closeSync(fd);
			unlinkSync(temporary);
		}
	}

	/**
	 * Replace the pending envelope with the newer listing, keeping any source
	 * field (`action_items`, `default_summary`, `transcript`, `highlights`) that
	 * the new payload leaves empty. A processed or missing envelope is left to
	 * its owner. Callers hold `lockAccount`, so no other poll writes meanwhile.
	 */
	async reconcilePending(
		account: string,
		recordingId: string,
		envelope: FathomImportEnvelope,
	): Promise<{ readonly outcome: "refreshed" | "unchanged" | "missing"; readonly payloadHash: string | null }> {
		if (!/^[A-Za-z0-9_-]+$/.test(account)) throw new Error("invalid Fathom account path");
		const destination = join(this.#inboxRoot, account, "pending", `${recordingKey(recordingId)}.json`);
		if (!existsSync(destination)) return { outcome: "missing", payloadHash: null };
		const parsed = Effect.runSyncExit(
			Effect.try({
				try: () => JSON.parse(readFileSync(destination, "utf8")) as FathomImportEnvelope,
				catch: () => null,
			}),
		);
		const stored = Exit.isSuccess(parsed) && parsed.value?.payload ? parsed.value.payload : null;
		const payload = stored === null ? envelope.payload : mergeSourceFields(stored, envelope.payload);
		if (stored !== null && JSON.stringify(stored) === JSON.stringify(payload))
			return { outcome: "unchanged", payloadHash: fathomPayloadHash(stored) };
		const temporary = `${destination}.${randomUUID()}.tmp`;
		const fd = openSync(temporary, "wx", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify({ ...envelope, payload })}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		const renamed = Effect.runSyncExit(
			Effect.try({ try: () => renameSync(temporary, destination), catch: (error) => error }),
		);
		if (Exit.isFailure(renamed)) {
			unlinkSync(temporary);
			throw Cause.squash(renamed.cause);
		}
		return { outcome: "refreshed", payloadHash: fathomPayloadHash(payload) };
	}

	/**
	 * One poll at a time for each account (`poll-<account key>.lock`, 0600). The
	 * lock belongs to the polling process (`tryProcessLock`): it is free again
	 * only when that process has exited, never because of its age.
	 */
	async lockAccount(account: string): Promise<() => void> {
		const stateRoot = join(this.#statePath, "..");
		const release = tryProcessLock(join(stateRoot, `poll-${fathomAccountKey(account)}.lock`));
		if (release === null) throw new Error("Fathom poll already running for this account");
		return release;
	}

	async saveCheckpoint(account: string, checkpoint: FathomIngestCheckpoint): Promise<void> {
		validateCheckpoint(checkpoint);
		const stateRoot = join(this.#statePath, "..");
		mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
		// Never clear a competing or crash-left lock automatically.
		const lockPath = `${this.#statePath}.lock`;
		const lock = openSync(lockPath, "wx", 0o600);
		const temporary = `${this.#statePath}.${randomUUID()}.tmp`;
		try {
			const current = existsSync(this.#statePath)
				? parseFathomFileStoreState(readFileSync(this.#statePath, "utf8"))
				: { version: 1 as const, accounts: {} };
			const key = fathomAccountKey(account);
			const expected = this.#loaded.get(key);
			if (expected !== undefined && expected !== JSON.stringify(current.accounts[key] ?? emptyCheckpoint()))
				throw new Error("Fathom checkpoint changed; reload before retrying");
			const next: FathomPersistedPollState = {
				version: 1,
				accounts: { ...current.accounts, [fathomAccountKey(account)]: checkpoint },
			};
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, this.#statePath);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
			closeSync(lock);
			unlinkSync(lockPath);
		}
	}
}

export const fathomFileStoreStateFile = STATE_FILE;
