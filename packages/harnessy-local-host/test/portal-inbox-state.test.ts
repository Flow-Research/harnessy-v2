import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxItemData, InboxListData } from "@harnessy/core/read-model";
import { expect, it } from "vitest";
import { inboxRevision } from "../src/portal/inbox-revision.ts";
import { InboxState } from "../src/portal/inbox-state.ts";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import { buildPortalHome, cleanupPortalFixtures, FIXTURE_NOW } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

it("expires oldest non-visible records at capacity while retaining visible archives and new selections", () => {
	const root = mkdtempSync(join(tmpdir(), "inbox-retention-"));
	try {
		const file = join(root, "archive.json");
		const state = new InboxState(file);
		const item: InboxItemData = {
			key: "new",
			title: "New alert",
			severity: "attention",
			context: "Inspect",
			detail: "Review",
			since: null,
			actions: [],
			source: "life",
			owner: { service: "life", label: "Life", port: null },
		};
		const visible = { ...item, key: "old-0" };
		const entries = Array.from({ length: 1000 }, (_, i) => [`old-${i}`, inboxRevision({ ...item, key: `old-${i}` })]);
		writeFileSync(file, JSON.stringify(entries));
		state.update("archive", [{ key: item.key, revision: inboxRevision(item) }], [visible, item]);
		const stored = new InboxState(file).read();
		expect(stored.size).toBe(1000);
		expect(stored.get(visible.key)).toBe(inboxRevision(visible));
		expect(stored.has("old-1")).toBe(false);
		expect(stored.get(item.key)).toBe(inboxRevision(item));
		// A partial source read is not a reason to prune while capacity remains.
		state.update("restore", [{ key: item.key, revision: inboxRevision(item) }], []);
		expect(state.read().size).toBe(999);
		expect(state.read().has("old-2")).toBe(true);
		// Byte capacity uses the same retention policy.
		writeFileSync(file, JSON.stringify([["large-old", "x".repeat(8 * 1024 * 1024 - 32)]]));
		state.update("archive", [{ key: item.key, revision: inboxRevision(item) }], [item]);
		expect([...state.read()]).toEqual([[item.key, inboxRevision(item)]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("persists archives, restores them, refuses a stale batch atomically and preserves corrupt state", () => {
	const root = mkdtempSync(join(tmpdir(), "inbox-state-"));
	try {
		const file = join(root, "archive.json");
		const state = new InboxState(file);
		const a = {
			key: "fathom:aa:stale",
			title: "Poll failed",
			severity: "attention",
			context: "10 min ago",
			detail: "Inspect",
			since: null,
			actions: [],
			source: "fathom",
			owner: { service: "fathom", label: "Fathom", port: null },
		} as InboxItemData;
		const b = { ...a, key: "b" };
		const pick = (item: InboxItemData) => ({ key: item.key, revision: inboxRevision(item) });
		state.update("archive", [pick(a), pick(b)], [a, b]);
		expect(new InboxState(file).read().size).toBe(2);
		expect(inboxRevision({ ...a, context: "11 min ago" })).toBe(inboxRevision(a));
		expect(inboxRevision({ ...a, severity: "action_required" })).not.toBe(inboxRevision(a));
		const before = readFileSync(file, "utf8");
		expect(() => state.update("archive", [pick(a), pick({ ...b, title: "stale" })], [a, b])).toThrow("inbox_changed");
		expect(readFileSync(file, "utf8")).toBe(before);
		state.update("restore", [pick(a)], []);
		state.update("restore", [pick(a)], []);
		expect(state.read().has(a.key)).toBe(false);
		expect(() => state.update("restore", [pick({ ...b, title: "changed" })], [b])).toThrow("inbox_changed");
		for (const invalid of [
			"{}",
			"[[1,2]]",
			JSON.stringify(Array.from({ length: 1001 }, (_, i) => [String(i), "v"])),
		]) {
			writeFileSync(file, invalid);
			expect(() => state.read()).toThrow("invalid_inbox_state");
		}
		writeFileSync(file, " ".repeat(8 * 1024 * 1024 + 1));
		expect(() => state.read()).toThrow("invalid_inbox_state");
		rmSync(file);
		const target = join(root, "untouched.json");
		writeFileSync(target, "[]");
		symlinkSync(target, file);
		expect(() => state.read()).toThrow();
		expect(readFileSync(target, "utf8")).toBe("[]");
		rmSync(file);
		writeFileSync(file, "broken");
		expect(() => state.update("archive", [pick(a)], [a])).toThrow();
		expect(readFileSync(file, "utf8")).toBe("broken");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("authenticates archive writes, updates counts and archive reads, and retains source drafts", async () => {
	const fixture = await buildPortalHome("inbox-archive");
	const token = newPortalSecret();
	const state = new InboxState(join(fixture.home, "inbox-archive.json"));
	const sources = createPortalSources({
		homeRoot: fixture.home,
		env: {},
		probe: () => "unsupported",
		probePort: async () => false,
		timeoutMs: 250,
		clock: () => FIXTURE_NOW,
	});
	let changed = false;
	const server = await startPortalServer({
		installToken: token,
		port: 0,
		version: "test",
		cacheTtlMs: 0,
		sources: {
			...sources,
			inbox: async () => {
				const tiles = await sources.inbox({});
				const data = tiles.inbox.data as InboxListData;
				return {
					...tiles,
					inbox: {
						...tiles.inbox,
						data: {
							...data,
							items: data.items.map((item) => (changed ? { ...item, title: `${item.title} changed` } : item)),
						},
					},
				};
			},
		},
		inboxState: state,
	});
	try {
		const path = "/v1/inbox/action";
		const issued = await rawRequest(server.port, {
			method: "POST",
			path: "/v1/session/code",
			headers: await installProof(server.port, token, "POST", "/v1/session/code"),
		});
		const grant = await rawRequest(server.port, {
			method: "POST",
			path: "/v1/session/exchange",
			headers: { Origin: server.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ code: (issued.json as { code: string }).code }),
		});
		const auth = { Authorization: `Bearer ${(grant.json as { token: string }).token}` };
		const original = await sources.inbox({});
		const item = (original.inbox.data as InboxListData).items.find((item) => item.key.startsWith("life-weekly:"))!;
		expect(item).toBeDefined();
		const body = JSON.stringify({ action: "archive", items: [{ key: item.key, revision: inboxRevision(item) }] });
		const post = (body: string, headers: Record<string, string> = {}) =>
			rawRequest(server.port, {
				method: "POST",
				path,
				body,
				headers: { "Content-Type": "application/json", ...headers },
			});
		expect((await post(body)).status).toBe(401);
		expect((await post(body, await installProof(server.port, token, "POST", path))).status).toBe(401);
		expect((await post(body, auth)).status).toBe(403);
		const headers = { ...auth, Origin: server.origin };
		for (const invalid of [
			"null",
			"{",
			'{"action":"delete","items":[]}',
			JSON.stringify({ action: "archive", items: [] }),
		])
			expect((await post(invalid, headers)).status).toBe(400);
		expect((await post(body, { ...headers, Origin: "https://other.test" })).status).toBe(403);
		await rawRequest(server.port, { path: "/v1/inbox", headers: auth });
		expect((await post(body, headers)).status).toBe(200);
		expect((await rawRequest(server.port, { path: "/v1/inbox", headers: auth })).text).not.toContain(item.key);
		expect((await rawRequest(server.port, { path: "/v1/inbox/archived", headers: auth })).text).toContain(item.key);
		expect(((await sources.inbox({})).inbox.data as InboxListData).items).toContainEqual(item);
		changed = true;
		expect((await rawRequest(server.port, { path: "/v1/inbox", headers: auth })).text).toContain(item.key);
		expect((await post(body, headers)).status).toBe(409);
		changed = false;
		expect((await post(body.replace('"archive"', '"restore"'), headers)).status).toBe(200);
		expect((await rawRequest(server.port, { path: "/v1/inbox", headers: auth })).text).toContain(item.key);
		expect((await rawRequest(server.port, { path: "/v1/inbox/archived", headers: auth })).text).not.toContain(
			item.key,
		);
	} finally {
		await server.close();
		cleanupPortalFixtures();
	}
});
