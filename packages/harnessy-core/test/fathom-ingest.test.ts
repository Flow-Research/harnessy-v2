import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FathomFileStore } from "../src/jarvis/fathom/file-store.ts";

import {
	createFathomHttpProvider,
	type FathomImportEnvelope,
	type FathomIngestCheckpoint,
	type FathomIngestStore,
	FathomProviderError,
	ingestFathomPage,
} from "../src/jarvis/fathom/ingest.ts";

const meeting = (id: number) => ({ recording_id: id, meeting_title: `Meeting ${id}` });

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const serve = async (listener: RequestListener) => {
	const server = createServer(listener);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	);
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing loopback address");
	return `http://127.0.0.1:${address.port}/`;
};
const httpProvider = (baseUrl: string) =>
	createFathomHttpProvider({
		baseUrl,
		credentials: { account: "personal", readApiKey: async () => "synthetic-private-key" },
	});

const storeFixture = (initial: FathomIngestCheckpoint = { cursor: null, seen: {}, updatedAt: null }) => {
	let checkpoint = initial;
	const envelopes: FathomImportEnvelope[] = [];
	const store: FathomIngestStore = {
		loadCheckpoint: async () => checkpoint,
		putPending: async (_account, _id, envelope) => {
			if (envelopes.some((existing) => existing.payload.recording_id === envelope.payload.recording_id))
				return "duplicate";
			envelopes.push(envelope);
			return "imported";
		},
		saveCheckpoint: async (_account, next) => {
			checkpoint = next;
		},
	};
	return { store, envelopes, checkpoint: () => checkpoint };
};

describe("native Fathom ingest contract", () => {
	it.each([0, 7])("accepts an empty terminal cursor with %s numeric-ID meetings", async (count) => {
		const items = Array.from({ length: count }, (_, index) => meeting(index + 1));
		const baseUrl = await serve((_request, response) =>
			response.end(JSON.stringify({ items, limit: 20, next_cursor: "" })),
		);
		const fixture = storeFixture({
			cursor: "page2",
			windowCreatedAfter: "2026-09-17T00:00:00Z",
			seen: {},
			updatedAt: null,
		});
		const result = await ingestFathomPage({
			account: "personal",
			provider: httpProvider(baseUrl),
			store: fixture.store,
			createdAfter: "2026-09-18T00:00:00Z",
			limit: 20,
		});
		expect(result).toMatchObject({
			fetched: count,
			imported: count,
			nextCursor: null,
			checkpointAdvanced: true,
			failure: null,
		});
		expect(fixture.envelopes.map((envelope) => envelope.payload)).toEqual(items);
		expect(fixture.checkpoint()).toMatchObject({ cursor: null, windowCreatedAfter: null });
	});
	it("preserves all records when the provider page exceeds the requested limit", async () => {
		const baseUrl = await serve((_request, response) =>
			response.end(JSON.stringify({ items: [meeting(1), meeting(2)], next_cursor: "next" })),
		);
		const fixture = storeFixture();
		const result = await ingestFathomPage({
			account: "personal",
			provider: httpProvider(baseUrl),
			store: fixture.store,
			limit: 1,
		});
		expect(result).toMatchObject({ fetched: 2, imported: 2, checkpointAdvanced: true, nextCursor: "next" });
		expect(fixture.envelopes.map((envelope) => envelope.payload.recording_id)).toEqual([1, 2]);
	});
	it("resumes a fixed rolling window across store reopen, then starts a fresh window", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-window-"));
		cleanup.push(() => rmSync(root, { recursive: true, force: true }));
		const store = () => new FathomFileStore({ inboxRoot: join(root, "inbox"), stateRoot: join(root, "state") });
		await store().saveCheckpoint("personal", { cursor: "legacy-unbound", seen: {}, updatedAt: null });
		const requests: Array<{ cursor: string | null; floor: string | null }> = [];
		let fail = false;
		const baseUrl = await serve((request, response) => {
			const url = new URL(request.url ?? "", "http://127.0.0.1");
			const cursor = url.searchParams.get("cursor");
			requests.push({ cursor, floor: url.searchParams.get("created_after") });
			if (fail) {
				response.writeHead(503).end("private response");
				return;
			}
			response.end(
				JSON.stringify({
					items: [meeting(cursor === null ? 1 : 2)],
					next_cursor: cursor === null ? "page2" : null,
				}),
			);
		});
		const poll = (floor: string) =>
			ingestFathomPage({
				account: "personal",
				provider: httpProvider(baseUrl),
				store: store(),
				limit: 1,
				createdAfter: floor,
			});
		const firstFloor = "2026-09-17T00:00:00Z";
		const newFloor = "2026-09-18T00:00:00Z";
		expect((await poll(firstFloor)).imported).toBe(1);
		const saved = await store().loadCheckpoint("personal");
		expect(saved).toMatchObject({ cursor: "page2", windowCreatedAfter: firstFloor });
		fail = true;
		expect((await poll(newFloor)).checkpointAdvanced).toBe(false);
		expect(await store().loadCheckpoint("personal")).toEqual(saved);
		fail = false;
		expect((await poll(newFloor)).imported).toBe(1);
		expect(await store().loadCheckpoint("personal")).toMatchObject({ cursor: null, windowCreatedAfter: null });
		expect((await poll(newFloor)).duplicates).toBe(1);
		expect(requests).toEqual([
			{ cursor: null, floor: firstFloor },
			{ cursor: "page2", floor: firstFloor },
			{ cursor: "page2", floor: firstFloor },
			{ cursor: null, floor: newFloor },
		]);
	});

	it.each(["not-a-date", 42, "2026-09-17T00:00:00Z"])(
		"fails closed on invalid saved window pairing %s",
		async (window) => {
			let calls = 0;
			const fixture = storeFixture({
				cursor: window === "2026-09-17T00:00:00Z" ? null : "next",
				seen: {},
				updatedAt: null,
				windowCreatedAfter: window as string,
			});
			const before = fixture.checkpoint();
			const result = await ingestFathomPage({
				account: "personal",
				store: fixture.store,
				createdAfter: "2026-09-18T00:00:00Z",
				provider: {
					listMeetings: async () => {
						calls++;
						return { items: [], nextCursor: null };
					},
				},
			});
			expect(result).toMatchObject({ checkpointAdvanced: false, failure: { code: "checkpoint" } });
			expect(calls).toBe(0);
			expect(fixture.checkpoint()).toBe(before);
		},
	);

	it.each([
		{ items: [meeting(1), { title: "missing ID" }], next_cursor: "skip" },
		{ items: [meeting(1), null], next_cursor: "skip" },
		{ items: [meeting(1)], next_cursor: 42 },
		{ items: [meeting(1)], next_cursor: false },
	])("rejects entire malformed real HTTP page without advancing: %j", async (body) => {
		const baseUrl = await serve((_request, response) => response.end(JSON.stringify(body)));
		const fixture = storeFixture({ cursor: "before", seen: {}, updatedAt: null });
		const before = fixture.checkpoint();
		const result = await ingestFathomPage({
			account: "personal",
			provider: httpProvider(baseUrl),
			store: fixture.store,
		});
		expect(result).toMatchObject({ imported: 0, checkpointAdvanced: false, failure: { code: "provider" } });
		expect(fixture.envelopes).toEqual([]);
		expect(fixture.checkpoint()).toBe(before);
	});

	it.each([302, 307, 308])("rejects real cross-origin redirect %s without sending credentials", async (status) => {
		let targetRequests = 0;
		let originRequests = 0;
		const target = await serve((_request, response) => {
			targetRequests++;
			response.end('{"items":[]}');
		});
		const origin = await serve((request, response) => {
			originRequests++;
			expect(request.headers["x-api-key"]).toBe("synthetic-private-key");
			response.writeHead(status, { location: target }).end();
		});
		await expect(
			httpProvider(origin).listMeetings({ account: "personal", cursor: null, limit: 1 }),
		).rejects.toMatchObject({ message: "Fathom request failed" });
		expect(originRequests).toBe(1);
		expect(targetRequests).toBe(0);
	});

	it("never exposes malformed response text in provider errors or ingest receipts", async () => {
		const secret = "PRIVATE_MEETING_CONTENT_SENTINEL";
		const baseUrl = await serve((_request, response) => response.end(secret));
		await expect(
			httpProvider(baseUrl).listMeetings({ account: "personal", cursor: null, limit: 1 }),
		).rejects.toMatchObject({ message: "Invalid Fathom response JSON" });
		const result = await ingestFathomPage({
			account: "personal",
			provider: httpProvider(baseUrl),
			store: storeFixture().store,
		});
		expect(result.failure?.message).toBe("Fathom provider operation failed");
		expect(JSON.stringify(result)).not.toContain(secret);
	});
	it("imports one bounded page and advances its cursor", async () => {
		const fixture = storeFixture();
		const receipt = await ingestFathomPage({
			account: "personal",
			provider: {
				listMeetings: async ({ limit, createdAfter, cursor }) => {
					expect(createdAfter).toBeNull();
					expect(cursor).toBeNull();
					return { items: [meeting(1), meeting(2)], nextCursor: `next-${limit}` };
				},
			},
			store: fixture.store,
			now: () => "2026-09-18T00:00:00.000Z",
			limit: 200,
		});
		expect(receipt).toMatchObject({
			fetched: 2,
			imported: 2,
			duplicates: 0,
			nextCursor: "next-100",
			checkpointAdvanced: true,
			failure: null,
		});
		expect(fixture.envelopes[0]).toMatchObject({ verified: true, source: "fathom-api", account: "personal" });
		expect(fixture.checkpoint().cursor).toBe("next-100");
	});

	it("deduplicates by recording ID without rewriting an existing envelope", async () => {
		const fixture = storeFixture({ cursor: "old", seen: { "1": "existing" }, updatedAt: null });
		const receipt = await ingestFathomPage({
			account: "personal",
			provider: { listMeetings: async () => ({ items: [meeting(1), meeting(2)], nextCursor: null }) },
			store: fixture.store,
		});
		expect(receipt).toMatchObject({ fetched: 2, imported: 1, duplicates: 1, checkpointAdvanced: true });
		expect(fixture.envelopes).toHaveLength(1);
	});

	it("does not advance the checkpoint after a retryable provider failure", async () => {
		const fixture = storeFixture({ cursor: "retry-me", seen: {}, updatedAt: null });
		const receipt = await ingestFathomPage({
			account: "personal",
			provider: {
				listMeetings: async () => {
					throw new FathomProviderError("temporarily unavailable", { retryable: true, status: 503 });
				},
			},
			store: fixture.store,
		});
		expect(receipt).toMatchObject({
			fetched: 0,
			checkpointAdvanced: false,
			nextCursor: "retry-me",
			failure: { code: "provider", retryable: true },
		});
		expect(fixture.checkpoint().cursor).toBe("retry-me");
	});

	it("does not advance after a sink failure, preserving the page for retry", async () => {
		const fixture = storeFixture();
		const store: FathomIngestStore = {
			...fixture.store,
			putPending: async () => {
				throw new Error("disk full");
			},
		};
		const receipt = await ingestFathomPage({
			account: "personal",
			provider: { listMeetings: async () => ({ items: [meeting(3)], nextCursor: "uncommitted" }) },
			store,
		});
		expect(receipt).toMatchObject({
			fetched: 1,
			imported: 0,
			checkpointAdvanced: false,
			failure: { code: "import", retryable: false },
		});
		expect(fixture.checkpoint().cursor).toBeNull();
	});

	it("binds credentials to the configured account and bounds the HTTP request", async () => {
		let request: Request | undefined;
		let keyReads = 0;
		const provider = createFathomHttpProvider({
			credentials: {
				account: "personal",
				readApiKey: async () => {
					keyReads += 1;
					return "secret";
				},
			},
			fetch: async (input, init) => {
				request = new Request(input, init);
				return new Response(JSON.stringify({ items: [meeting(4)], next_cursor: "cursor" }), { status: 200 });
			},
			baseUrl: "http://127.0.0.1:8787/external/v1",
		});
		const page = await provider.listMeetings({
			account: "personal",
			cursor: null,
			createdAfter: "2026-09-17T00:00:00.000Z",
			limit: 999,
		});
		expect(page).toMatchObject({ nextCursor: "cursor", items: [meeting(4)] });
		expect(request?.url).toContain("limit=100");
		expect(request?.url).toContain("created_after=2026-09-17T00%3A00%3A00.000Z");
		expect(request?.headers.get("x-api-key")).toBe("secret");
		expect(keyReads).toBe(1);
	});

	it("classifies authentication failures as non-retryable", async () => {
		const provider = createFathomHttpProvider({
			credentials: { account: "personal", readApiKey: async () => "secret" },
			fetch: async () => new Response("", { status: 401 }),
			baseUrl: "http://127.0.0.1:8787/external/v1",
		});
		await expect(provider.listMeetings({ account: "personal", cursor: null, limit: 1 })).rejects.toMatchObject({
			name: "FathomProviderError",
			retryable: false,
			status: 401,
		});
	});

	it("rejects a foreign account before reading credentials or fetching", async () => {
		let reads = 0;
		let calls = 0;
		const provider = createFathomHttpProvider({
			credentials: {
				account: "personal",
				readApiKey: async () => {
					reads++;
					return "secret";
				},
			},
			fetch: async () => {
				calls++;
				return new Response();
			},
		});
		await expect(provider.listMeetings({ account: "foreign", cursor: null, limit: 1 })).rejects.toMatchObject({
			message: "credential account mismatch",
		});
		expect(reads).toBe(0);
		expect(calls).toBe(0);
	});

	it("sanitizes credential resolver exceptions in the persisted receipt surface", async () => {
		const provider = createFathomHttpProvider({
			credentials: {
				account: "personal",
				readApiKey: async () => {
					throw new Error("PRIVATE_KEY_SENTINEL");
				},
			},
		});
		const result = await ingestFathomPage({ account: "personal", provider, store: storeFixture().store });
		expect(result.failure?.message).toBe("Fathom provider operation failed");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY_SENTINEL");
	});
});
