/**
 * Sync the local task cache with the hosted primary store.
 *
 * The VPS is the source of truth. `~/.harnessy/portal/tasks.json` is a cache.
 * When the VPS cannot be reached, mutations are applied locally and queued
 * until `harnessy jarvis tasks sync` (or the next successful remote write)
 * replays them with conflict retry on stale revisions.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
	defaultTasksFile,
	type FollowupInput,
	type TaskOutcome,
	TaskRefused,
	TasksState,
	type TasksStore,
} from "./store.ts";

export const DEFAULT_SYNC_CONFIG_PATH = join(homedir(), ".config", "harnessy", "tasks-sync.json");
export const DEFAULT_SYNC_TOKEN_PATH = join(homedir(), ".config", "harnessy", "tasks-sync.token");
export const DEFAULT_SYNC_QUEUE_NAME = "tasks-sync-queue.json";

export interface TasksSyncConfig {
	readonly endpoint: string;
	readonly tokenFile: string;
}

export type QueuedMutation =
	| {
			readonly op: "add" | "addFollowup";
			readonly fields: FollowupInput & { readonly id?: string; readonly index?: number };
	  }
	| {
			readonly op: "outcome";
			readonly id: string;
			readonly outcome: TaskOutcome;
			readonly owner?: string | null;
			readonly date?: string;
	  }
	| {
			readonly op: "resolve";
			readonly id: string;
			readonly note?: string | null;
	  }
	| {
			readonly op: "closeout";
			readonly outcomes: ReadonlyArray<{
				readonly id: string;
				readonly outcome: TaskOutcome;
				readonly owner?: string;
			}>;
			readonly followups?: ReadonlyArray<FollowupInput & { readonly id?: string }>;
			readonly resolve?: ReadonlyArray<{ readonly id: string; readonly note?: string | null }>;
			readonly date?: string;
	  }
	| {
			readonly op: "ingest";
			readonly markdown: string;
			readonly date: string;
			readonly path?: string;
			readonly displayRef?: string;
	  };

export interface TasksSyncQueue {
	readonly version: 1;
	readonly items: readonly QueuedMutation[];
}

export interface TasksRemoteResult {
	readonly ok: boolean;
	readonly revision?: number;
	readonly error?: string;
	readonly item?: unknown;
	readonly items?: unknown;
	readonly created?: number;
	readonly matched?: number;
	readonly updated?: unknown;
	readonly unchanged?: number;
}

export interface TasksTransport {
	request: (input: {
		readonly method: string;
		readonly path: string;
		readonly body?: unknown;
		readonly revision?: number;
		readonly token: string;
		readonly endpoint: string;
	}) => Promise<{ readonly status: number; readonly body: TasksRemoteResult }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

export const defaultQueuePath = (tasksFile: string): string => join(dirname(tasksFile), DEFAULT_SYNC_QUEUE_NAME);

export const parseSyncConfig = (value: unknown): TasksSyncConfig => {
	if (!isRecord(value) || typeof value.endpoint !== "string" || typeof value.tokenFile !== "string")
		throw new TaskRefused("invalid_sync_config");
	const endpoint = value.endpoint.trim().replace(/\/$/, "");
	const tokenFile = value.tokenFile.trim();
	if (!/^https?:\/\//u.test(endpoint) || tokenFile.length === 0) throw new TaskRefused("invalid_sync_config");
	return { endpoint, tokenFile };
};

export const readSyncConfigFile = (path: string): TasksSyncConfig | undefined => {
	try {
		return parseSyncConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		if (error instanceof TaskRefused) throw error;
		throw new TaskRefused("invalid_sync_config");
	}
};

export const resolveSyncConfig = (input: {
	readonly endpoint?: string;
	readonly tokenFile?: string;
	readonly configFile?: string;
	readonly env?: NodeJS.ProcessEnv;
}): TasksSyncConfig | undefined => {
	const env = input.env ?? process.env;
	const endpoint = input.endpoint?.trim() || env.HARNESSY_TASKS_ENDPOINT?.trim() || "";
	const tokenFile = input.tokenFile?.trim() || env.HARNESSY_TASKS_TOKEN_FILE?.trim() || "";
	if (endpoint !== "" && tokenFile !== "") return parseSyncConfig({ endpoint, tokenFile });
	const fromFile = readSyncConfigFile(input.configFile ?? env.HARNESSY_TASKS_SYNC_CONFIG ?? DEFAULT_SYNC_CONFIG_PATH);
	if (fromFile === undefined)
		return endpoint === "" && tokenFile === "" ? undefined : parseSyncConfig({ endpoint, tokenFile });
	return parseSyncConfig({
		endpoint: endpoint || fromFile.endpoint,
		tokenFile: tokenFile || fromFile.tokenFile,
	});
};

export const readSyncToken = (tokenFile: string): string => {
	const token = readFileSync(tokenFile, "utf8").trim();
	if (token.length === 0) throw new TaskRefused("missing_token");
	return token;
};

export const readQueue = (path: string): TasksSyncQueue => {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items))
			throw new TaskRefused("invalid_queue");
		return { version: 1, items: value.items as QueuedMutation[] };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: [] };
		if (error instanceof TaskRefused) throw error;
		throw new TaskRefused("invalid_queue");
	}
};

const atomicWrite = (file: string, value: unknown): void => {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// The temp file may already be gone.
		}
		throw error;
	}
};

export const writeQueue = (path: string, queue: TasksSyncQueue): void => {
	if (queue.items.length === 0) {
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return;
	}
	atomicWrite(path, queue);
};

export const enqueueMutation = (path: string, mutation: QueuedMutation): void => {
	const queue = readQueue(path);
	writeQueue(path, { version: 1, items: [...queue.items, mutation] });
};

export const fetchTransport: TasksTransport = {
	request: async ({ method, path, body, revision, token, endpoint }) => {
		const headers: Record<string, string> = {
			authorization: `Bearer ${token}`,
			accept: "application/json",
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (revision !== undefined) headers["if-match"] = `"${revision}"`;
		const response = await fetch(`${endpoint}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await response.text();
		let parsed: unknown = {};
		if (text.trim() !== "") {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = { ok: false, error: "invalid_body" };
			}
		}
		const record = isRecord(parsed) ? parsed : { ok: false, error: "invalid_body" };
		return {
			status: response.status,
			body: {
				ok: record.ok === true,
				revision: typeof record.revision === "number" ? record.revision : undefined,
				error: typeof record.error === "string" ? record.error : undefined,
				item: record.item,
				items: record.items,
				created: typeof record.created === "number" ? record.created : undefined,
				matched: typeof record.matched === "number" ? record.matched : undefined,
				updated: record.updated,
				unchanged: typeof record.unchanged === "number" ? record.unchanged : undefined,
			},
		};
	},
};

const getStore = async (
	transport: TasksTransport,
	config: TasksSyncConfig,
	token: string,
): Promise<{ revision: number; items: TasksStore["items"] }> => {
	const response = await transport.request({
		method: "GET",
		path: "/v1/tasks?includeDone=1",
		token,
		endpoint: config.endpoint,
	});
	if (response.status === 401) throw new TaskRefused("unauthorized");
	if (!response.body.ok || response.body.revision === undefined || !Array.isArray(response.body.items))
		throw new TaskRefused(response.body.error ?? "sync_failed");
	return { revision: response.body.revision, items: response.body.items as TasksStore["items"] };
};

const pathFor = (mutation: QueuedMutation): { method: string; path: string; body: unknown } => {
	switch (mutation.op) {
		case "add":
			return { method: "POST", path: "/v1/tasks", body: mutation.fields };
		case "addFollowup":
			return { method: "POST", path: "/v1/followups", body: mutation.fields };
		case "outcome":
			return {
				method: "POST",
				path: "/v1/tasks/outcome",
				body: { id: mutation.id, outcome: mutation.outcome, owner: mutation.owner, date: mutation.date },
			};
		case "resolve":
			return { method: "POST", path: "/v1/followups/resolve", body: { id: mutation.id, note: mutation.note } };
		case "closeout":
			return {
				method: "POST",
				path: "/v1/tasks/closeout",
				body: {
					outcomes: mutation.outcomes,
					followups: mutation.followups,
					resolve: mutation.resolve,
					date: mutation.date,
				},
			};
		case "ingest":
			return {
				method: "POST",
				path: "/v1/tasks/ingest",
				body: {
					markdown: mutation.markdown,
					date: mutation.date,
					path: mutation.path,
					displayRef: mutation.displayRef,
				},
			};
	}
};

const replayOne = async (
	transport: TasksTransport,
	config: TasksSyncConfig,
	token: string,
	mutation: QueuedMutation,
	revision: number,
): Promise<{ readonly status: number; readonly revision: number; readonly body: TasksRemoteResult }> => {
	const request = pathFor(mutation);
	const response = await transport.request({
		method: request.method,
		path: request.path,
		body: request.body,
		revision,
		token,
		endpoint: config.endpoint,
	});
	if (response.status === 401) throw new TaskRefused("unauthorized");
	if (response.body.ok && response.body.revision !== undefined)
		return { status: response.status, revision: response.body.revision, body: response.body };
	if (response.status === 409 || response.body.error === "stale_revision") {
		const latest = await getStore(transport, config, token);
		const retry = await transport.request({
			method: request.method,
			path: request.path,
			body: request.body,
			revision: latest.revision,
			token,
			endpoint: config.endpoint,
		});
		if (retry.body.ok && retry.body.revision !== undefined)
			return { status: retry.status, revision: retry.body.revision, body: retry.body };
		throw new TaskRefused(retry.body.error ?? "sync_conflict");
	}
	throw new TaskRefused(response.body.error ?? "sync_failed");
};

export const syncTasks = async (input: {
	readonly tasksFile: string;
	readonly config: TasksSyncConfig;
	readonly queuePath?: string;
	readonly transport?: TasksTransport;
	readonly token?: string;
}): Promise<{
	readonly ok: true;
	readonly revision: number;
	readonly replayed: number;
	readonly remaining: number;
	readonly pulled: number;
}> => {
	const transport = input.transport ?? fetchTransport;
	const token = input.token ?? readSyncToken(input.config.tokenFile);
	const queuePath = input.queuePath ?? defaultQueuePath(input.tasksFile);
	const state = new TasksState(input.tasksFile);
	const queue = readQueue(queuePath);
	const remote = await getStore(transport, input.config, token);
	let revision = remote.revision;
	let replayed = 0;
	const remaining: QueuedMutation[] = [];
	for (const mutation of queue.items) {
		const result = await replayOne(transport, input.config, token, mutation, revision);
		revision = result.revision;
		replayed += 1;
	}
	const latest = await getStore(transport, input.config, token);
	state.installSnapshot({ version: 1, revision: latest.revision, items: latest.items });
	writeQueue(queuePath, { version: 1, items: remaining });
	return { ok: true, revision: latest.revision, replayed, remaining: remaining.length, pulled: latest.items.length };
};

export const applyMutation = async (input: {
	readonly tasksFile: string;
	readonly config?: TasksSyncConfig;
	readonly queuePath?: string;
	readonly transport?: TasksTransport;
	readonly mutation: QueuedMutation;
	readonly applyLocal: (state: TasksState) => unknown;
}): Promise<{ readonly mode: "remote" | "queued"; readonly revision: number; readonly result: unknown }> => {
	const state = new TasksState(input.tasksFile);
	if (input.config === undefined) {
		const result = input.applyLocal(state);
		return { mode: "remote", revision: state.read().revision, result };
	}
	const transport = input.transport ?? fetchTransport;
	const queuePath = input.queuePath ?? defaultQueuePath(input.tasksFile);
	try {
		const token = readSyncToken(input.config.tokenFile);
		const remote = await getStore(transport, input.config, token);
		// Replay any queued work first so this mutation lands on a consistent primary.
		let revision = remote.revision;
		const queue = readQueue(queuePath);
		for (const pending of queue.items) {
			const result = await replayOne(transport, input.config, token, pending, revision);
			revision = result.revision;
		}
		writeQueue(queuePath, { version: 1, items: [] });
		const applied = await replayOne(transport, input.config, token, input.mutation, revision);
		const latest = await getStore(transport, input.config, token);
		state.installSnapshot({ version: 1, revision: latest.revision, items: latest.items });
		return { mode: "remote" as const, revision: applied.revision, result: applied.body };
	} catch (error) {
		if (error instanceof TaskRefused && (error.code === "unauthorized" || error.code === "sync_conflict"))
			throw error;
		const result = input.applyLocal(state);
		enqueueMutation(queuePath, input.mutation);
		return { mode: "queued" as const, revision: state.read().revision, result };
	}
};

export const writeSyncConfig = (path: string, config: TasksSyncConfig): void => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ endpoint: config.endpoint, tokenFile: config.tokenFile }, null, 2)}\n`, {
		mode: 0o600,
		flag: "w",
	});
	chmodSync(path, 0o600);
};

export const defaultTasksFileFromHome = (homeRoot?: string): string => defaultTasksFile(homeRoot ?? homedir());
