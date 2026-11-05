import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LINKS_MAX, LinkRefused, LinksState, normalizeLinkUrl } from "../src/portal/links-state.ts";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

afterEach(cleanupPortalFixtures);

describe("saved links state", () => {
	it("adds, lists and removes links in an owner-only file", () => {
		const file = join(tempDir("links-state"), "links.json");
		const state = new LinksState(file, () => new Date("2026-11-05T10:00:00Z"));
		expect(state.read()).toEqual([]);
		const tracker = state.add("Mustard Bio tracker", "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey");
		const plain = state.add("  ", "https://docs.google.com/document/d/abc/edit");
		expect(tracker).toMatchObject({
			title: "Mustard Bio tracker",
			url: "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey",
			addedAt: "2026-11-05T10:00:00.000Z",
		});
		expect(plain.title).toBe("docs.google.com");
		expect(new LinksState(file).read().map((link) => link.id)).toEqual([tracker.id, plain.id]);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		state.remove(tracker.id);
		expect(state.read().map((link) => link.id)).toEqual([plain.id]);
		expect(() => state.remove(tracker.id)).toThrow(LinkRefused);
	});

	it("reorders only with the exact current set of links", () => {
		const state = new LinksState(join(tempDir("links-reorder"), "links.json"));
		const [a, b, c] = ["a", "b", "c"].map((name) => state.add(name, `https://example.com/${name}`));
		state.reorder([c!.id, a!.id, b!.id]);
		expect(state.read().map((link) => link.title)).toEqual(["c", "a", "b"]);
		for (const ids of [
			[a!.id, b!.id],
			[a!.id, a!.id, b!.id],
			[a!.id, b!.id, "00000000-0000-4000-8000-000000000000"],
		])
			expect(() => state.reorder(ids)).toThrow("links_changed");
		expect(state.read().map((link) => link.title)).toEqual(["c", "a", "b"]);
	});

	it("refuses addresses and names that could mislead or run code", () => {
		for (const url of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			" javascript:alert(1)",
			"data:text/html,x",
			"vbscript:x",
			"blob:https://example.com/1",
			"https://user:pass@example.com/",
			"https://exa mple.com/",
			"https://example.com/\u202egpj",
			"/Users/me/\u202egpj.exe",
			"example.com",
			"./notes.md",
			"~/notes.md",
			"/Users/me/../etc/passwd",
			"/Users//me",
			"file://server/share/x",
			"file:///Users/me/x?y",
			`https://example.com/${"a".repeat(2048)}`,
		])
			expect([url, normalizeLinkUrl(url)]).toEqual([url, undefined]);
		expect(normalizeLinkUrl("HTTPS://Example.COM")).toBe("https://example.com/");
		const state = new LinksState(join(tempDir("links-refuse"), "links.json"));
		expect(() => state.add("x", "javascript:alert(1)")).toThrow("invalid_url");
		expect(() => state.add("a".repeat(121), "https://example.com/")).toThrow("invalid_title");
		expect(() => state.add("bad‮name", "https://example.com/")).toThrow("invalid_title");
		expect(state.read()).toEqual([]);
	});

	it("accepts any other URL and full file paths, stored as file URLs", () => {
		for (const [url, stored] of [
			["/Users/me/Mustard Bio/plan.pdf", "file:///Users/me/Mustard%20Bio/plan.pdf"],
			["/Users/me/notes/", "file:///Users/me/notes/"],
			["file:///Users/me/a b.md", "file:///Users/me/a%20b.md"],
			["mailto:team@example.com", "mailto:team@example.com"],
			["vscode://file/Users/me/x.ts", "vscode://file/Users/me/x.ts"],
			["obsidian://open?vault=work", "obsidian://open?vault=work"],
			["ftp://example.com/", "ftp://example.com/"],
		])
			expect(normalizeLinkUrl(url)).toBe(stored);
		expect(normalizeLinkUrl("~/notes.md", "/Users/me")).toBe("file:///Users/me/notes.md");
		const dir = tempDir("links-files");
		writeFileSync(join(dir, "plan.pdf"), "pdf");
		const state = new LinksState(join(dir, "links.json"), undefined, dir);
		const file = state.add("", "~/plan.pdf");
		expect(file.title).toBe("plan.pdf");
		expect(state.add("", "mailto:team@example.com").title).toBe("team@example.com");
		const web = state.add("", " https://example.com/ ");
		const gone = state.add("", join(dir, "gone.pdf"));
		expect(state.filePath(file.id)).toBe(join(dir, "plan.pdf"));
		expect(() => state.filePath(web.id)).toThrow("not_a_file");
		expect(() => state.filePath(gone.id)).toThrow("file_missing");
		expect(() => state.filePath("00000000-0000-4000-8000-000000000000")).toThrow("link_missing");
		expect(new LinksState(join(dir, "links.json")).read()).toHaveLength(4);
	});

	it("caps the list and rejects a tampered file", () => {
		const dir = tempDir("links-cap");
		const file = join(dir, "links.json");
		const state = new LinksState(file);
		for (let i = 0; i < LINKS_MAX; i++) state.add(`Link ${i}`, `https://example.com/${i}`);
		expect(() => state.add("One more", "https://example.com/more")).toThrow("links_full");
		const stored = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, string>>;
		writeFileSync(file, JSON.stringify([{ ...stored[0], url: "javascript:alert(1)" }]));
		expect(() => state.read()).toThrow("invalid_links_state");
	});
});

describe("links routes", () => {
	it("lists, adds and removes links only with a page token and the portal origin", async () => {
		const root = tempDir("links-routes");
		const token = "d".repeat(43);
		const links = new LinksState(join(root, "links.json"));
		const server = await startPortalServer({
			installToken: token,
			port: 0,
			version: "test",
			links,
			sources: createPortalSources({
				homeRoot: root,
				env: {},
				probe: () => "unsupported",
				probePort: async () => false,
				timeoutMs: 250,
				clock: () => new Date(),
			}),
		});
		try {
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
			const bearer = `Bearer ${(grant.json as { token: string }).token}`;
			const auth = { Origin: server.origin, "Content-Type": "application/json", Authorization: bearer };
			const post = (body: unknown, headers: Record<string, string> = auth) =>
				rawRequest(server.port, {
					method: "POST",
					path: "/v1/links/action",
					headers,
					body: typeof body === "string" ? body : JSON.stringify(body),
				});

			// Install proofs read snapshots; they never read or change links.
			expect(
				(
					await rawRequest(server.port, {
						path: "/v1/links",
						headers: await installProof(server.port, token, "GET", "/v1/links"),
					})
				).status,
			).toBe(401);
			expect(
				(await post({ action: "add", title: "", url: "https://example.com/" }, { ...auth, Authorization: "" }))
					.status,
			).toBe(401);
			const { Origin: _origin, ...noOrigin } = auth;
			expect((await post({ action: "add", title: "", url: "https://example.com/" }, noOrigin)).status).toBe(403);
			for (const body of ["null", "[]", "{", { action: "add", url: "https://example.com/" }, { action: "remove" }])
				expect((await post(body)).status).toBe(400);
			expect((await post({ action: "add", title: "x", url: "javascript:alert(1)" })).json).toEqual({
				error: "invalid_url",
			});

			const added = await post({
				action: "add",
				title: "Tracker",
				url: "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey",
			});
			expect(added.status).toBe(200);
			const id = (added.json as { link: { id: string } }).link.id;
			const listed = await rawRequest(server.port, { path: "/v1/links", headers: { Authorization: bearer } });
			expect((listed.json as { links: Array<{ title: string; url: string }> }).links).toEqual([
				expect.objectContaining({ id, title: "Tracker", url: "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey" }),
			]);
			const second = (
				(await post({ action: "add", title: "Second", url: "https://example.com/second" })).json as {
					link: { id: string };
				}
			).link.id;
			expect((await post({ action: "reorder", ids: [second, id] })).status).toBe(200);
			expect(links.read().map((link) => link.id)).toEqual([second, id]);
			expect((await post({ action: "reorder", ids: [id] })).json).toEqual({ error: "links_changed" });
			expect((await post({ action: "reorder", ids: "x" })).status).toBe(400);
			expect((await post({ action: "remove", id: second })).status).toBe(200);
			expect((await post({ action: "remove", id })).status).toBe(200);
			expect((await post({ action: "remove", id })).json).toEqual({ error: "link_missing" });
			// This server was started without a file opener.
			expect((await post({ action: "open", id })).json).toEqual({ error: "file_open_unavailable" });
			expect(links.read()).toEqual([]);
		} finally {
			await server.close();
		}
	});

	it("answers 503 when the portal has no links store", async () => {
		const root = tempDir("links-missing");
		const token = "e".repeat(43);
		const server = await startPortalServer({
			installToken: token,
			port: 0,
			version: "test",
			sources: createPortalSources({
				homeRoot: root,
				env: {},
				probe: () => "unsupported",
				probePort: async () => false,
				timeoutMs: 250,
				clock: () => new Date(),
			}),
		});
		try {
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
			const listed = await rawRequest(server.port, {
				path: "/v1/links",
				headers: { Authorization: `Bearer ${(grant.json as { token: string }).token}` },
			});
			expect(listed.status).toBe(503);
		} finally {
			await server.close();
		}
	});

	it("opens only a saved file link that exists, through the injected opener", async () => {
		const root = tempDir("links-open");
		writeFileSync(join(root, "plan.pdf"), "pdf");
		const token = "e".repeat(43);
		const links = new LinksState(join(root, "links.json"));
		const opened: string[] = [];
		let fail = false;
		const server = await startPortalServer({
			installToken: token,
			port: 0,
			version: "test",
			links,
			openFile: async (path) => {
				if (fail) throw new Error("no opener");
				opened.push(path);
			},
			sources: createPortalSources({
				homeRoot: root,
				env: {},
				probe: () => "unsupported",
				probePort: async () => false,
				timeoutMs: 250,
				clock: () => new Date(),
			}),
		});
		try {
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
			const headers = {
				Origin: server.origin,
				"Content-Type": "application/json",
				Authorization: `Bearer ${(grant.json as { token: string }).token}`,
			};
			const post = (body: unknown) =>
				rawRequest(server.port, { method: "POST", path: "/v1/links/action", headers, body: JSON.stringify(body) });
			const file = links.add("Plan", join(root, "plan.pdf"));
			const web = links.add("Web", "https://example.com/");
			const gone = links.add("Gone", join(root, "gone.pdf"));
			expect((await post({ action: "open", id: file.id })).json).toEqual({ opened: true });
			expect(opened).toEqual([join(root, "plan.pdf")]);
			expect((await post({ action: "open", id: web.id })).json).toEqual({ error: "not_a_file" });
			const missing = await post({ action: "open", id: gone.id });
			expect([missing.status, missing.json]).toEqual([404, { error: "file_missing" }]);
			expect((await post({ action: "open", id: "/etc/passwd" })).json).toEqual({ error: "link_missing" });
			expect((await post({ action: "open", path: join(root, "plan.pdf") })).status).toBe(400);
			fail = true;
			const failed = await post({ action: "open", id: file.id });
			expect([failed.status, failed.json]).toEqual([503, { error: "file_open_failed" }]);
			expect(opened).toHaveLength(1);
		} finally {
			await server.close();
		}
	});
});
