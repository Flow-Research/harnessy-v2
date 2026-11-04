/**
 * Shared, read-only API data. Each path is fetched once for all its readers and
 * refreshed every {@link REFRESH_MS} while anything reads it. The server caches
 * for 5 s, so a refresh never costs more than one read of each source.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

import type { ApiResult, SessionClient } from "./session.ts";

export const REFRESH_MS = 30_000;

export interface Resource<T> {
	readonly status: "loading" | "ok" | "error" | "signed_out";
	readonly data?: T;
	readonly message?: string;
	/** When the data now shown was fetched (ms). */
	readonly fetchedAt?: number;
}

const LOADING: Resource<never> = { status: "loading" };

export class DataStore {
	readonly #client: Pick<SessionClient, "get">;
	readonly #now: () => number;
	readonly #values = new Map<string, Resource<unknown>>();
	readonly #listeners = new Map<string, Set<() => void>>();
	readonly #inFlight = new Map<string, Promise<void>>();
	readonly #signedOut = new Set<() => void>();

	constructor(client: Pick<SessionClient, "get">, now: () => number = Date.now) {
		this.#client = client;
		this.#now = now;
	}

	get(path: string): Resource<unknown> {
		return this.#values.get(path) ?? LOADING;
	}

	subscribe(path: string, listener: () => void): () => void {
		const listeners = this.#listeners.get(path) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(path, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) this.#listeners.delete(path);
		};
	}

	onSignedOut(listener: () => void): () => void {
		this.#signedOut.add(listener);
		return () => this.#signedOut.delete(listener);
	}

	/** Fetch `path` again unless a fetch is already running. Keeps the old data on error. */
	refresh(path: string): Promise<void> {
		const running = this.#inFlight.get(path);
		if (running !== undefined) return running;
		const next = this.#client.get(path).then((result: ApiResult) => {
			this.#inFlight.delete(path);
			const previous = this.#values.get(path);
			if (result.kind === "ok") this.#values.set(path, { status: "ok", data: result.body, fetchedAt: this.#now() });
			else if (result.kind === "signed_out") {
				this.#values.set(path, { status: "signed_out" });
				for (const listener of this.#signedOut) listener();
			} else
				this.#values.set(path, {
					status: "error",
					message: result.message,
					...(previous?.data === undefined ? {} : { data: previous.data, fetchedAt: previous.fetchedAt }),
				});
			for (const listener of this.#listeners.get(path) ?? []) listener();
		});
		this.#inFlight.set(path, next);
		return next;
	}

	/** Fetch every path that something reads again, keeping what is shown until the answers arrive. */
	refreshAll(): Promise<void> {
		return Promise.all([...this.#listeners.keys()].map((path) => this.refresh(path))).then(() => undefined);
	}

	/** Forget every value, for example after a new sign-in. */
	reset(): void {
		this.#values.clear();
		for (const [path, listeners] of this.#listeners) {
			void this.refresh(path);
			for (const listener of listeners) listener();
		}
	}
}

const DataContext = createContext<DataStore | null>(null);

export const DataProvider = ({ store, children }: { readonly store: DataStore; readonly children: ReactNode }) => (
	<DataContext.Provider value={store}>{children}</DataContext.Provider>
);

export const useDataStore = (): DataStore => {
	const store = useContext(DataContext);
	if (store === null) throw new Error("DataProvider is missing");
	return store;
};

/** Read one API path. `null` reads nothing. */
export const useResource = <T,>(path: string | null): Resource<T> & { readonly refresh: () => void } => {
	const store = useDataStore();
	const subscribe = useCallback(
		(listener: () => void) => (path === null ? () => undefined : store.subscribe(path, listener)),
		[store, path],
	);
	const value = useSyncExternalStore(subscribe, () => (path === null ? LOADING : store.get(path)));
	useEffect(() => {
		if (path === null) return undefined;
		void store.refresh(path);
		const timer = setInterval(() => void store.refresh(path), REFRESH_MS);
		return () => clearInterval(timer);
	}, [store, path]);
	const refresh = useCallback(() => {
		if (path !== null) void store.refresh(path);
	}, [store, path]);
	return { ...(value as Resource<T>), refresh };
};
