/**
 * Authenticated HTTP API for the task store. The VPS hosts this service as the
 * always-on primary copy. Schema `version` stays 1; document `revision` is the
 * optimistic-concurrency token and is also returned as ETag.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import * as Result from "effect/Result";
import { extractBriefTasks } from "../../read-model/followups.ts";
import { candidatesFromExtracted } from "./ingest.ts";
import { applyMeetingFollowupBatch, parseMeetingFollowupBatch } from "./meeting-followups.ts";
import { commitPriorityBatch } from "./priority-apply.ts";
import {
	type FollowupInput,
	type FollowupView,
	followupsForView,
	lagosCalendarDate,
	type ResolveEntry,
	type TaskOutcome,
	TaskRefused,
	TasksState,
	type TasksStore,
} from "./store.ts";

export const TASKS_SERVICE_PORT = 8787;

export interface TasksHttpOptions {
	readonly file: string;
	readonly token: string;
	readonly host?: string;
	readonly port?: number;
}

export interface TasksHttpServer {
	readonly url: string;
	readonly port: number;
	readonly host: string;
	close: () => Promise<void>;
}

const FOLLOWUP_VIEWS: ReadonlyArray<FollowupView> = ["open", "overdue", "resolved", "all"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const readToken = (token: string, tokenFile?: string): string => {
	if (token.trim() !== "") return token;
	if (tokenFile !== undefined && tokenFile.trim() !== "") return readFileSync(tokenFile, "utf8").trim();
	throw new Error("missing_token");
};

export const loadTasksAuthToken = (env: NodeJS.ProcessEnv = process.env): string =>
	readToken(env.TASKS_AUTH_TOKEN ?? "", env.TASKS_TOKEN_FILE);

const authorised = (req: IncomingMessage, token: string): boolean => {
	const header = req.headers.authorization;
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
	const provided = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(token);
	if (provided.length !== expected.length) {
		timingSafeEqual(expected, Buffer.alloc(expected.length));
		return false;
	}
	return timingSafeEqual(provided, expected);
};

const readBody = (req: IncomingMessage, max = 256 * 1024): Promise<unknown> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > max) {
				reject(new TaskRefused("invalid_body"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			const parsed = Result.try((): unknown => JSON.parse(Buffer.concat(chunks).toString("utf8")));
			if (Result.isFailure(parsed)) {
				reject(new TaskRefused("invalid_body"));
				return;
			}
			resolve(parsed.success);
		});
		req.on("error", reject);
	});

const revisionOf = (req: IncomingMessage, body: unknown): number | undefined => {
	const match = req.headers["if-match"];
	if (typeof match === "string" && match.trim() !== "") {
		const raw = match.trim().replaceAll(/^W\//g, "").replaceAll(/"/g, "");
		const value = Number(raw);
		if (!Number.isInteger(value) || value < 0) throw new TaskRefused("invalid_revision");
		return value;
	}
	if (isRecord(body) && body.revision !== undefined) {
		if (typeof body.revision !== "number" || !Number.isInteger(body.revision) || body.revision < 0)
			throw new TaskRefused("invalid_revision");
		return body.revision;
	}
	return undefined;
};

const requireRevision = (req: IncomingMessage, body: unknown): number => {
	const value = revisionOf(req, body);
	if (value === undefined) throw new TaskRefused("revision_required");
	return value;
};

const send = (res: ServerResponse, status: number, body: unknown, revision?: number): void => {
	const json = `${JSON.stringify(body)}\n`;
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	if (revision !== undefined) res.setHeader("etag", `"${revision}"`);
	res.end(json);
};

const errorStatus = (code: string): number => {
	if (code === "stale_revision") return 409;
	if (code === "revision_required" || code === "invalid_revision" || code === "invalid_body") return 400;
	if (code === "task_missing") return 404;
	if (code === "tasks_busy") return 423;
	if (code === "tasks_full" || code === "unwritable" || code === "unreadable") return 500;
	return 400;
};

const textField = (row: Record<string, unknown>, key: string): string | null | undefined => {
	const value = row[key];
	if (value === undefined || value === null) return value;
	if (typeof value !== "string") throw new TaskRefused("invalid_body");
	return value;
};

const followupInput = (value: unknown): FollowupInput & { id?: string; index?: number } => {
	if (!isRecord(value) || typeof value.title !== "string") throw new TaskRefused("invalid_title");
	if (value.priority !== undefined && !Number.isInteger(value.priority)) throw new TaskRefused("invalid_priority");
	return {
		title: value.title,
		owner: textField(value, "owner") ?? null,
		waitingOn: textField(value, "waitingOn") ?? null,
		due: textField(value, "due") ?? null,
		link: textField(value, "link") ?? null,
		project: textField(value, "project") ?? null,
		...(value.priority === undefined ? {} : { priority: value.priority as number }),
		...(typeof value.id === "string" ? { id: value.id } : {}),
		...(typeof value.index === "number" && Number.isInteger(value.index) ? { index: value.index } : {}),
	};
};

const snapshot = (state: TasksState): TasksStore => state.read();

const handle = async (state: TasksState, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> => {
	const host = req.headers.host ?? "localhost";
	const url = new URL(req.url ?? "/", `http://${host}`);
	const method = req.method ?? "GET";
	if (method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
		send(res, 200, { ok: true });
		return;
	}
	if (!authorised(req, token)) {
		send(res, 401, { ok: false, error: "unauthorized" });
		return;
	}
	if (method === "GET" && url.pathname === "/v1/tasks") {
		const includeDone = url.searchParams.get("includeDone") === "1" || url.searchParams.get("includeDone") === "true";
		const store = snapshot(state);
		const items = store.items.filter((item) => includeDone || (item.status !== "done" && item.status !== "dropped"));
		send(res, 200, { ok: true, revision: store.revision, items }, store.revision);
		return;
	}
	if (method === "GET" && url.pathname === "/v1/followups") {
		const viewRaw = (url.searchParams.get("view") ?? "open").trim().toLowerCase();
		const view = FOLLOWUP_VIEWS.find((entry) => entry === viewRaw);
		if (view === undefined) throw new TaskRefused("invalid_view");
		const today = url.searchParams.get("today") ?? lagosCalendarDate(new Date());
		const store = snapshot(state);
		const items = followupsForView(store.items, view, today);
		const overdue = items.filter(
			(item) => item.status !== "done" && item.status !== "dropped" && item.due !== null && item.due < today,
		).length;
		send(
			res,
			200,
			{ ok: true, revision: store.revision, view, today, count: items.length, overdue, items },
			store.revision,
		);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/tasks/action") {
		const body = await readBody(req);
		const revision = commitPriorityBatch(state, requireRevision(req, body), body);
		send(res, 200, { ok: true, revision }, revision);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/tasks") {
		const body = await readBody(req);
		const expected = requireRevision(req, body);
		if (!isRecord(body)) throw new TaskRefused("invalid_body");
		const item = state.add({ ...followupInput(body), expectedRevision: expected });
		const store = snapshot(state);
		send(res, 201, { ok: true, revision: store.revision, item }, store.revision);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/tasks/outcome") {
		const body = await readBody(req);
		const expected = requireRevision(req, body);
		if (!isRecord(body) || typeof body.id !== "string" || typeof body.outcome !== "string")
			throw new TaskRefused("invalid_body");
		const outcome = body.outcome as TaskOutcome;
		if (outcome !== "done" && outcome !== "carried" && outcome !== "dropped" && outcome !== "delegated")
			throw new TaskRefused("invalid_outcome");
		const item = state.applyOutcome(body.id, outcome, {
			owner: textField(body, "owner") ?? null,
			date: typeof body.date === "string" ? body.date : undefined,
			expectedRevision: expected,
		});
		const store = snapshot(state);
		send(res, 200, { ok: true, revision: store.revision, item }, store.revision);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/tasks/closeout") {
		const body = await readBody(req);
		const expected = requireRevision(req, body);
		if (!isRecord(body) || !Array.isArray(body.outcomes)) throw new TaskRefused("invalid_body");
		const followups = Array.isArray(body.followups) ? body.followups.map(followupInput) : [];
		const resolveEntries: ResolveEntry[] = Array.isArray(body.resolve)
			? body.resolve.map((entry) => {
					if (!isRecord(entry) || typeof entry.id !== "string") throw new TaskRefused("invalid_body");
					return { id: entry.id, note: textField(entry, "note") ?? null };
				})
			: [];
		const outcomes = body.outcomes.map((entry) => {
			if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.outcome !== "string")
				throw new TaskRefused("invalid_body");
			const outcome = entry.outcome as TaskOutcome;
			if (outcome !== "done" && outcome !== "carried" && outcome !== "dropped" && outcome !== "delegated")
				throw new TaskRefused("invalid_outcome");
			return { id: entry.id, outcome, ...(typeof entry.owner === "string" ? { owner: entry.owner } : {}) };
		});
		const result = state.closeout(outcomes, typeof body.date === "string" ? body.date : undefined, {
			followups,
			resolve: resolveEntries,
			expectedRevision: expected,
		});
		const store = snapshot(state);
		send(res, 200, { ok: true, revision: store.revision, ...result }, store.revision);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/tasks/ingest") {
		const body = await readBody(req);
		const expected = requireRevision(req, body);
		if (!isRecord(body) || typeof body.markdown !== "string" || typeof body.date !== "string")
			throw new TaskRefused("invalid_body");
		const path = typeof body.path === "string" ? body.path : `remote-brief/${body.date}.md`;
		const displayRef = typeof body.displayRef === "string" ? body.displayRef : `brief ${body.date}`;
		const extracted = extractBriefTasks(body.markdown);
		const allocations = Array.isArray(body.allocations)
			? body.allocations.filter(
					(entry): entry is { id: string; fingerprint: string } =>
						!!entry &&
						typeof entry === "object" &&
						typeof (entry as { id?: unknown }).id === "string" &&
						typeof (entry as { fingerprint?: unknown }).fingerprint === "string",
				)
			: [];
		const ids = new Map(allocations.map((entry) => [entry.fingerprint, entry.id]));
		const candidates = candidatesFromExtracted("brief", extracted, displayRef).map((candidate) => {
			const id = ids.get(candidate.fingerprint);
			return id === undefined ? candidate : { ...candidate, id };
		});
		const result = state.ingest(
			candidates,
			{ kind: "brief", path, displayRef, briefDate: body.date },
			undefined,
			expected,
		);
		const store = snapshot(state);
		send(
			res,
			200,
			{ ok: true, revision: store.revision, created: result.created, matched: result.matched, items: result.items },
			store.revision,
		);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/followups") {
		const body = await readBody(req);
		const expected = requireRevision(req, body);
		const item = state.addFollowup({ ...followupInput(body), expectedRevision: expected });
		const store = snapshot(state);
		send(res, 201, { ok: true, revision: store.revision, item }, store.revision);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/followups/ingest") {
		const body = await readBody(req);
		const expected = requireRevision(req, body);
		const result = applyMeetingFollowupBatch(state, parseMeetingFollowupBatch(body), expected);
		const store = snapshot(state);
		send(
			res,
			200,
			{
				ok: true,
				revision: store.revision,
				created: result.created,
				unchanged: result.existing,
				items: result.items,
			},
			store.revision,
		);
		return;
	}
	if (method === "POST" && url.pathname === "/v1/followups/resolve") {
		const body = await readBody(req);
		const expected = requireRevision(req, body);
		if (!isRecord(body) || typeof body.id !== "string") throw new TaskRefused("invalid_body");
		const item = state.resolve(body.id, textField(body, "note") ?? null, expected);
		const store = snapshot(state);
		send(res, 200, { ok: true, revision: store.revision, item }, store.revision);
		return;
	}
	send(res, 404, { ok: false, error: "not_found" });
};

export const startTasksHttpServer = (options: TasksHttpOptions): Promise<TasksHttpServer> =>
	new Promise((resolve, reject) => {
		const token = options.token;
		if (token.length === 0) {
			reject(new Error("missing_token"));
			return;
		}
		const state = new TasksState(options.file);
		const server: Server = createServer((req, res) => {
			void handle(state, token, req, res).catch((error: unknown) => {
				const code = error instanceof TaskRefused ? error.code : "failed";
				const revision = code === "stale_revision" ? state.read().revision : undefined;
				send(
					res,
					errorStatus(code),
					{ ok: false, error: code, ...(revision === undefined ? {} : { revision }) },
					revision,
				);
			});
		});
		server.once("error", reject);
		const host = options.host ?? "127.0.0.1";
		server.listen(options.port ?? 0, host, () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("listen_failed"));
				return;
			}
			resolve({
				host,
				port: address.port,
				url: `http://${host}:${address.port}`,
				close: () =>
					new Promise((closeResolve, closeReject) => {
						server.close((error) => (error ? closeReject(error) : closeResolve()));
					}),
			});
		});
	});
