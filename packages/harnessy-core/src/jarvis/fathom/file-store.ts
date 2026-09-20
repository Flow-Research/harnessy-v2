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

import type { FathomImportEnvelope, FathomIngestCheckpoint, FathomIngestStore } from "./ingest.ts";

const STATE_FILE = "poll-state-v2.json";

interface PersistedState {
	readonly version: 1;
	readonly accounts: Readonly<Record<string, FathomIngestCheckpoint>>;
}

const emptyCheckpoint = (): FathomIngestCheckpoint => ({ cursor: null, seen: {}, updatedAt: null });

const accountKey = (account: string): string => createHash("sha256").update(account).digest("hex").slice(0, 24);
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

const parseState = (raw: string): PersistedState => {
	const value = JSON.parse(raw) as Partial<PersistedState>;
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
			? (parseState(readFileSync(this.#statePath, "utf8")).accounts[accountKey(account)] ?? emptyCheckpoint())
			: emptyCheckpoint();
		this.#loaded.set(accountKey(account), JSON.stringify(checkpoint));
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
				? parseState(readFileSync(this.#statePath, "utf8"))
				: { version: 1 as const, accounts: {} };
			const key = accountKey(account);
			const expected = this.#loaded.get(key);
			if (expected !== undefined && expected !== JSON.stringify(current.accounts[key] ?? emptyCheckpoint()))
				throw new Error("Fathom checkpoint changed; reload before retrying");
			const next: PersistedState = {
				version: 1,
				accounts: { ...current.accounts, [accountKey(account)]: checkpoint },
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
