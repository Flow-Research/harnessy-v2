import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

interface WireFile {
	id: string;
	name: string;
	mimeType: string;
	parents: Array<string>;
	appProperties: Record<string, string>;
	trashed: boolean;
}

export interface FailureResponse {
	readonly method: string;
	readonly path: string;
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: unknown;
	readonly rawBody?: string;
	readonly delayMillis?: number;
	readonly closeConnection?: boolean;
}

export interface WireState {
	ownerEmail: string;
	readonly botId: string;
	readonly channelId: string;
	channelResponseId: string;
	duplicateDocumentMatches: boolean;
	readonly files: Map<string, WireFile>;
	readonly permissions: Set<string>;
	readonly documents: Map<string, unknown>;
	readonly messagesByNonce: Map<string, { readonly id: string; readonly channelId: string; content: string }>;
	readonly requests: Array<{
		readonly method: string;
		readonly path: string;
		readonly authorization: string;
		readonly body: unknown;
	}>;
	readonly failures: Array<FailureResponse>;
	lostGoogleDocumentCreateResponses: number;
	lostDiscordMessageCreateResponses: number;
	fileSequence: number;
	messageSequence: number;
	onRequest?: (request: { readonly method: string; readonly path: string }) => void;
}

export const makeWireState = (): WireState => ({
	ownerEmail: "owner@example.test",
	botId: "444444444444444444",
	channelId: "555555555555555555",
	channelResponseId: "555555555555555555",
	duplicateDocumentMatches: false,
	files: new Map(),
	permissions: new Set(),
	documents: new Map(),
	messagesByNonce: new Map(),
	requests: [],
	failures: [],
	lostGoogleDocumentCreateResponses: 0,
	lostDiscordMessageCreateResponses: 0,
	fileSequence: 0,
	messageSequence: 0,
});

const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
	const chunks: Array<Buffer> = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	if (chunks.length === 0) return null;
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const json = (
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Readonly<Record<string, string>> = {},
) => {
	response.writeHead(status, { "content-type": "application/json", ...headers });
	response.end(JSON.stringify(body));
};

const asStringRecord = (value: unknown): Record<string, string> => {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, entry]) => (typeof entry === "string" ? [[key, entry]] : [])),
	);
};

export const nonceFrom = (body: unknown) => (isRecord(body) && typeof body.nonce === "string" ? body.nonce : "");

const serveWireRequest = async (state: WireState, request: IncomingMessage, response: ServerResponse) => {
	const method = request.method ?? "GET";
	const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
	const path = requestUrl.pathname;
	const body = await bodyOf(request);
	state.requests.push({
		method,
		path,
		authorization: String(request.headers.authorization ?? ""),
		body,
	});
	state.onRequest?.({ method, path });
	const failureIndex = state.failures.findIndex((failure) => failure.method === method && failure.path === path);
	if (failureIndex >= 0) {
		const [failure] = state.failures.splice(failureIndex, 1);
		if (failure === undefined) return;
		if (failure.delayMillis !== undefined) await new Promise((resolve) => setTimeout(resolve, failure.delayMillis));
		if (failure.closeConnection === true) {
			request.socket.destroy();
			return;
		}
		if (failure.rawBody !== undefined) {
			response.writeHead(failure.status, { "content-type": "application/json", ...failure.headers });
			response.end(failure.rawBody);
			return;
		}
		json(response, failure.status, failure.body ?? null, failure.headers);
		return;
	}

	if (method === "GET" && path === "/about") {
		json(response, 200, { user: { emailAddress: state.ownerEmail }, ignored: "UPSTREAM_SUCCESS_BODY_SENTINEL" });
		return;
	}
	if (method === "GET" && path === "/files") {
		const q = requestUrl.searchParams.get("q") ?? "";
		const property = q.includes("harnessyMeetingFolderKey") ? "harnessyMeetingFolderKey" : "harnessyMeetingItemId";
		const value = /value='([^']+)'/u.exec(q)?.[1] ?? "";
		let files = [...state.files.values()].filter((file) => file.appProperties[property] === value);
		if (state.duplicateDocumentMatches && property === "harnessyMeetingItemId" && files.length === 1) {
			files = [...files, { ...files[0]!, id: "duplicate-document" }];
		}
		json(response, 200, { files });
		return;
	}
	if (method === "POST" && path === "/files") {
		const input = isRecord(body) ? body : {};
		const mimeType = typeof input.mimeType === "string" ? input.mimeType : "";
		state.fileSequence += 1;
		const id = mimeType.endsWith("folder") ? `folder-${state.fileSequence}` : `document-${state.fileSequence}`;
		const file: WireFile = {
			id,
			name: typeof input.name === "string" ? input.name : "",
			mimeType,
			parents: Array.isArray(input.parents)
				? input.parents.filter((entry): entry is string => typeof entry === "string")
				: [],
			appProperties: asStringRecord(input.appProperties),
			trashed: false,
		};
		state.files.set(id, file);
		if (mimeType.endsWith("document")) state.documents.set(id, { body: { content: [{ endIndex: 1 }] } });
		if (mimeType.endsWith("document") && state.lostGoogleDocumentCreateResponses > 0) {
			state.lostGoogleDocumentCreateResponses -= 1;
			request.socket.destroy();
			return;
		}
		json(response, 200, { id });
		return;
	}
	const permissionMatch = /^\/files\/([^/]+)\/permissions$/u.exec(path);
	if (permissionMatch !== null) {
		const docId = permissionMatch[1] ?? "";
		if (method === "GET") {
			json(response, 200, {
				permissions: state.permissions.has(docId) ? [{ id: "permission-1", type: "anyone", role: "reader" }] : [],
			});
			return;
		}
		if (method === "POST") {
			state.permissions.add(docId);
			json(response, 200, { id: "permission-1", type: "anyone", role: "reader" });
			return;
		}
	}
	const fileMatch = /^\/files\/([^/]+)$/u.exec(path);
	if (fileMatch !== null) {
		const id = fileMatch[1] ?? "";
		const file = state.files.get(id);
		if (file === undefined) return json(response, 404, { code: "missing" });
		if (method === "GET") return json(response, 200, file);
		if (method === "PATCH") {
			const input = isRecord(body) ? body : {};
			if (typeof input.name === "string") file.name = input.name;
			file.appProperties = { ...file.appProperties, ...asStringRecord(input.appProperties) };
			return json(response, 200, { id });
		}
	}
	const documentMatch = /^\/documents\/([^/:]+)(:batchUpdate)?$/u.exec(path);
	if (documentMatch !== null) {
		const id = documentMatch[1] ?? "";
		if (method === "GET") return json(response, 200, state.documents.get(id) ?? { body: { content: [] } });
		if (method === "POST") {
			state.documents.set(id, { body: { content: [{ endIndex: 100 }] }, lastBatch: body });
			return json(response, 200, {});
		}
	}
	if (method === "GET" && path === "/users/@me") return json(response, 200, { id: state.botId });
	if (method === "GET" && path === `/channels/${state.channelId}`) {
		return json(response, 200, { id: state.channelResponseId, type: 0 });
	}
	if (method === "POST" && path === `/channels/${state.channelId}/messages`) {
		const input = isRecord(body) ? body : {};
		const nonce = typeof input.nonce === "string" ? input.nonce : "";
		const existing = state.messagesByNonce.get(nonce);
		if (existing !== undefined) return json(response, 200, { id: existing.id, channel_id: existing.channelId });
		state.messageSequence += 1;
		const message = {
			id: String(700_000_000_000_000_000n + BigInt(state.messageSequence)),
			channelId: state.channelId,
			content: typeof input.content === "string" ? input.content : "",
		};
		state.messagesByNonce.set(nonce, message);
		if (state.lostDiscordMessageCreateResponses > 0) {
			state.lostDiscordMessageCreateResponses -= 1;
			request.socket.destroy();
			return;
		}
		return json(response, 200, { id: message.id, channel_id: message.channelId });
	}
	const updateMatch = new RegExp(`^/channels/${state.channelId}/messages/(\\d+)$`, "u").exec(path);
	if (method === "PATCH" && updateMatch !== null) {
		const input = isRecord(body) ? body : {};
		const id = updateMatch[1] ?? "";
		const message = [...state.messagesByNonce.values()].find((entry) => entry.id === id);
		if (message === undefined) return json(response, 404, { code: "missing" });
		message.content = typeof input.content === "string" ? input.content : "";
		return json(response, 200, { id, channel_id: state.channelId });
	}
	json(response, 404, { code: "unhandled" });
};

export const startWireServer = async (state: WireState) => {
	const server = createServer((request, response) => {
		void serveWireRequest(state, request, response).catch(() => json(response, 500, { code: "fixture_failed" }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
};
