import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceAccess } from "../src/portal/device-access.ts";
import {
	FOLDER_DEPTH_MAX,
	FOLDERS_MAX,
	fileRunsCode,
	isFileEntry,
	LINKS_MAX,
	LinkRefused,
	LinksState,
	normalizeLinkUrl,
} from "../src/portal/links-state.ts";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

afterEach(cleanupPortalFixtures);

describe("saved links state", () => {
	it("adds, lists and removes links in an owner-only file", () => {
		const file = join(tempDir("links-state"), "links.json");
		const state = new LinksState(file, () => new Date("2026-11-05T10:00:00Z"));
		expect(state.read()).toEqual({ version: 2, folders: [], links: [] });
		const tracker = state.add("Mustard Bio tracker", "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey");
		const plain = state.add("  ", "https://docs.google.com/document/d/abc/edit");
		expect(tracker).toMatchObject({
			title: "Mustard Bio tracker",
			url: "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey",
			addedAt: "2026-11-05T10:00:00.000Z",
		});
		expect(plain.title).toBe("docs.google.com");
		expect(new LinksState(file).read().links.map((link) => link.id)).toEqual([tracker.id, plain.id]);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		state.remove(tracker.id);
		expect(state.read().links.map((link) => link.id)).toEqual([plain.id]);
		expect(() => state.remove(tracker.id)).toThrow(LinkRefused);
	});

	it("reorders only with the exact current set of links", () => {
		const state = new LinksState(join(tempDir("links-reorder"), "links.json"));
		const [a, b, c] = ["a", "b", "c"].map((name) => state.add(name, `https://example.com/${name}`));
		state.reorder("links", null, [c!.id, a!.id, b!.id]);
		expect(state.read().links.map((link) => link.title)).toEqual(["c", "a", "b"]);
		for (const ids of [
			[a!.id, b!.id],
			[a!.id, a!.id, b!.id],
			[a!.id, b!.id, "00000000-0000-4000-8000-000000000000"],
		])
			expect(() => state.reorder("links", null, ids)).toThrow("links_changed");
		expect(state.read().links.map((link) => link.title)).toEqual(["c", "a", "b"]);
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
		expect(state.read()).toEqual({ version: 2, folders: [], links: [] });
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
		expect(state.fileTarget(file.id)).toEqual({ path: join(dir, "plan.pdf"), reveal: false });
		expect(() => state.fileTarget(web.id)).toThrow("not_a_file");
		expect(() => state.fileTarget(gone.id)).toThrow("file_missing");
		expect(() => state.fileTarget("00000000-0000-4000-8000-000000000000")).toThrow("link_missing");
		expect(new LinksState(join(dir, "links.json")).read().links).toHaveLength(4);
	});

	it("derives a usable name when none is given, so every saved entry stays readable", () => {
		const dir = tempDir("links-default-names");
		writeFileSync(join(dir, " report.pdf"), "pdf");
		const state = new LinksState(join(dir, "links.json"));
		expect(state.add("", join(dir, " report.pdf")).title).toBe("report.pdf");
		expect(state.add("", "mailto:").title).toBe("mailto:");
		expect(state.add(" ", "/").title).toBe("file:///");
		expect(state.add("", "file:///tmp/a%01b").title).toBe("file:///tmp/a%01b");
		expect(state.add("", `mailto:${"a".repeat(200)}@example.com`).title).toHaveLength(120);
		expect(new LinksState(join(dir, "links.json")).read().links).toHaveLength(5);
	});

	it("marks files that could start a program, so the portal only reveals them", () => {
		const dir = tempDir("links-runnable");
		const make = (name: string, mode = 0o644) => {
			writeFileSync(join(dir, name), "x", { mode });
			chmodSync(join(dir, name), mode);
			return join(dir, name);
		};
		expect(fileRunsCode(make("plan.pdf"))).toBe(false);
		mkdirSync(join(dir, "Folder"));
		expect(fileRunsCode(join(dir, "Folder"))).toBe(false);
		for (const name of ["run.command", "Setup.PKG", "notes.webloc", "deploy.sh", "Tool.terminal"])
			expect([name, fileRunsCode(make(name))]).toEqual([name, true]);
		mkdirSync(join(dir, "Calculator.app"));
		expect(fileRunsCode(`${join(dir, "Calculator.app")}/`)).toBe(true);
		expect(fileRunsCode(make("tool", 0o755))).toBe(true);
		// A harmless-looking name that points at a script is judged by its target.
		symlinkSync(join(dir, "deploy.sh"), join(dir, "report.pdf"));
		expect(fileRunsCode(join(dir, "report.pdf"))).toBe(true);
		expect(["/x", "~/x", " file:///x", "FILE:///x"].every(isFileEntry)).toBe(true);
		expect(["https://example.com/", "mailto:a@example.com"].some(isFileEntry)).toBe(false);
	});

	it("caps the list and rejects a tampered file", () => {
		const dir = tempDir("links-cap");
		const file = join(dir, "links.json");
		const state = new LinksState(file);
		for (let i = 0; i < LINKS_MAX; i++) state.add(`Link ${i}`, `https://example.com/${i}`);
		expect(() => state.add("One more", "https://example.com/more")).toThrow("links_full");
		const stored = JSON.parse(readFileSync(file, "utf8")) as { links: Array<Record<string, string>> };
		writeFileSync(file, JSON.stringify([{ ...stored.links[0], url: "javascript:alert(1)" }]));
		expect(() => state.read()).toThrow("invalid_links_state");
	});
});

describe("saved link folders", () => {
	const at = "2026-11-05T10:00:00.000Z";
	const link = (title: string, parentId: string | null = null, id: string = randomUUID()) => ({
		id,
		title,
		url: `https://example.com/${encodeURIComponent(title)}`,
		addedAt: at,
		parentId,
	});
	const folder = (name: string, parentId: string | null = null, id: string = randomUUID()) => ({
		id,
		name,
		parentId,
		addedAt: at,
	});

	it("reads a version 1 file as top-level links and saves version 2 on the next write", () => {
		const file = join(tempDir("links-v1"), "links.json");
		const old = [
			{ id: randomUUID(), title: "Tracker", url: "https://example.com/tracker", addedAt: at },
			{ id: randomUUID(), title: "Plan", url: "file:///Users/me/plan.pdf", addedAt: at },
		];
		writeFileSync(file, JSON.stringify(old), { mode: 0o600 });
		const state = new LinksState(file, () => new Date(at));
		expect(state.read()).toEqual({
			version: 2,
			folders: [],
			links: old.map((entry) => ({ ...entry, parentId: null })),
		});
		// Reading never rewrites the file.
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(old);
		const work = state.addFolder("Work", null);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			version: 2,
			folders: [{ id: work.id, name: "Work", parentId: null, addedAt: at }],
			links: old.map((entry) => ({ ...entry, parentId: null })),
		});
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it("adds, renames, moves and removes folders and the links inside them", () => {
		const file = join(tempDir("links-folders"), "links.json");
		const state = new LinksState(file);
		const work = state.addFolder("Work", null);
		const bio = state.addFolder("  Bio  ", work.id);
		expect(bio).toMatchObject({ name: "Bio", parentId: work.id });
		const inBio = state.add("Tracker", "https://example.com/tracker", bio.id);
		const top = state.add("Top", "https://example.com/top");
		expect(inBio.parentId).toBe(bio.id);
		expect(top.parentId).toBeNull();
		const missing = randomUUID();
		expect(() => state.add("x", "https://example.com/x", missing)).toThrow("folder_missing");
		expect(() => state.addFolder("x", missing)).toThrow("folder_missing");
		for (const name of ["", "   ", "a".repeat(81), "bad\u202ename", "tab\tname"])
			expect(() => state.addFolder(name, null)).toThrow("invalid_name");

		state.rename(bio.id, " Mustard Bio ");
		state.rename(inBio.id, "");
		expect(() => state.rename(bio.id, "")).toThrow("invalid_name");
		expect(() => state.rename(inBio.id, "a".repeat(121))).toThrow("invalid_title");
		expect(() => state.rename(missing, "x")).toThrow("link_missing");
		expect(state.read().folders.map((entry) => entry.name)).toEqual(["Work", "Mustard Bio"]);
		expect(state.read().links.map((entry) => entry.title)).toEqual(["example.com", "Top"]);

		// Into a folder, back to the top level at the front, and past the end (last).
		state.move(top.id, work.id, 0);
		expect(state.read().links.find((entry) => entry.id === top.id)?.parentId).toBe(work.id);
		state.move(inBio.id, null, 0);
		state.move(top.id, null, 0);
		expect(state.read().links.map((entry) => entry.id)).toEqual([top.id, inBio.id]);
		state.move(top.id, null, 99);
		expect(state.read().links.map((entry) => entry.id)).toEqual([inBio.id, top.id]);
		state.move(bio.id, null, 0);
		expect(state.read().folders.map((entry) => [entry.name, entry.parentId])).toEqual([
			["Mustard Bio", null],
			["Work", null],
		]);
		state.move(work.id, bio.id, 0);
		expect(() => state.move(bio.id, work.id, 0)).toThrow("invalid_move");
		expect(() => state.move(bio.id, bio.id, 0)).toThrow("invalid_move");
		expect(() => state.move(top.id, missing, 0)).toThrow("folder_missing");
		expect(() => state.move(missing, null, 0)).toThrow("link_missing");

		// Removing a folder removes every folder and link inside it, and nothing else.
		state.move(top.id, work.id, 0);
		state.remove(bio.id);
		expect(state.read()).toEqual({ version: 2, folders: [], links: [expect.objectContaining({ id: inBio.id })] });
		expect(() => state.remove(bio.id)).toThrow("link_missing");
	});

	it("keeps folders within the depth and count limits", () => {
		const state = new LinksState(join(tempDir("links-depth"), "links.json"));
		let parent: string | null = null;
		const chain: string[] = [];
		for (let level = 1; level <= FOLDER_DEPTH_MAX; level++) {
			parent = state.addFolder(`Level ${level}`, parent).id;
			chain.push(parent);
		}
		expect(() => state.addFolder("Too deep", parent)).toThrow("folder_too_deep");
		expect(state.add("Deep link", "https://example.com/deep", parent).parentId).toBe(parent);
		// A folder two levels tall fits under level 4, not under level 5.
		const tall = state.addFolder("Tall", null);
		state.addFolder("Inner", tall.id);
		expect(() => state.move(tall.id, chain[4]!, 0)).toThrow("folder_too_deep");
		state.move(tall.id, chain[3]!, 0);
		expect(state.read().folders.find((entry) => entry.id === tall.id)?.parentId).toBe(chain[3]);

		const full = new LinksState(join(tempDir("links-folders-full"), "links.json"));
		for (let i = 0; i < FOLDERS_MAX; i++) full.addFolder(`Folder ${i}`, null);
		expect(() => full.addFolder("One more", null)).toThrow("folders_full");
	});

	it("reorders each sibling list on its own and refuses a stale list", () => {
		const state = new LinksState(join(tempDir("links-per-parent"), "links.json"));
		const a = state.addFolder("A", null);
		const b = state.addFolder("B", null);
		const one = state.add("One", "https://example.com/1", a.id);
		const two = state.add("Two", "https://example.com/2", a.id);
		const top = state.add("Top", "https://example.com/top");
		state.reorder("folders", null, [b.id, a.id]);
		state.reorder("links", a.id, [two.id, one.id]);
		expect(state.read().folders.map((entry) => entry.name)).toEqual(["B", "A"]);
		expect(state.read().links.map((entry) => entry.title)).toEqual(["Two", "One", "Top"]);
		for (const [kind, parent, ids] of [
			["links", a.id, [two.id]],
			["links", null, [two.id, one.id]],
			["links", a.id, [two.id, one.id, top.id]],
			["folders", null, [a.id, a.id]],
			["folders", a.id, [b.id]],
		] as const)
			expect(() => state.reorder(kind, parent, ids)).toThrow("links_changed");
		state.reorder("folders", a.id, []);
		expect(state.read().links.map((entry) => entry.title)).toEqual(["Two", "One", "Top"]);
	});

	it("refuses a tampered version 2 file", () => {
		const file = join(tempDir("links-v2-tampered"), "links.json");
		const state = new LinksState(file);
		const root = folder("Root");
		const ok = { version: 2, folders: [root], links: [link("In root", root.id)] };
		writeFileSync(file, JSON.stringify(ok));
		expect(state.read()).toEqual(ok);
		const a = randomUUID();
		const b = randomUUID();
		const deep: Array<ReturnType<typeof folder>> = [];
		for (let level = 0; level <= FOLDER_DEPTH_MAX; level++)
			deep.push(folder(`Level ${level}`, deep[level - 1]?.id ?? null));
		for (const [why, value] of [
			["dangling link parent", { version: 2, folders: [], links: [link("x", randomUUID())] }],
			["dangling folder parent", { version: 2, folders: [folder("x", randomUUID())], links: [] }],
			["cycle", { version: 2, folders: [folder("a", b, a), folder("b", a, b)], links: [] }],
			["own parent", { version: 2, folders: [folder("a", a, a)], links: [] }],
			["duplicate folder and link id", { version: 2, folders: [folder("a", null, a)], links: [link("x", null, a)] }],
			["duplicate link id", { version: 2, folders: [], links: [link("x", null, a), link("y", null, a)] }],
			["too deep", { version: 2, folders: deep, links: [] }],
			["version 3", { ...ok, version: 3 }],
			["extra key", { ...ok, extra: true }],
			["folders not an array", { version: 2, folders: {}, links: [] }],
			["links not an array", { version: 2, folders: [], links: {} }],
			["folder name with a control", { version: 2, folders: [folder("a\u0007")], links: [] }],
			["empty folder name", { version: 2, folders: [folder("")], links: [] }],
			["untrimmed folder name", { version: 2, folders: [folder(" a")], links: [] }],
			["folder extra key", { version: 2, folders: [{ ...folder("a"), x: 1 }], links: [] }],
			["folder id not a UUID", { version: 2, folders: [folder("a", null, "../a")], links: [] }],
			["folder bad date", { version: 2, folders: [{ ...folder("a"), addedAt: "never" }], links: [] }],
			["link without parent", { version: 2, folders: [], links: [{ ...link("x"), parentId: undefined }] }],
			["link parent a number", { version: 2, folders: [], links: [{ ...link("x"), parentId: 1 }] }],
			[
				"too many folders",
				{ version: 2, folders: Array.from({ length: FOLDERS_MAX + 1 }, (_, i) => folder(`F${i}`)), links: [] },
			],
			[
				"too many links",
				{ version: 2, folders: [], links: Array.from({ length: LINKS_MAX + 1 }, (_, i) => link(`L${i}`)) },
			],
			[
				"version 1 duplicate id",
				[
					{ ...link("x", null, a), parentId: undefined },
					{ ...link("y", null, a), parentId: undefined },
				],
			],
			["version 1 with a parent", [link("x")]],
			["null", null],
			["string", "links"],
		] as const) {
			writeFileSync(file, JSON.stringify(value));
			expect(() => state.read(), why).toThrow("invalid_links_state");
		}
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
			expect(listed.json).toEqual({
				version: 2,
				folders: [],
				links: [
					expect.objectContaining({
						id,
						title: "Tracker",
						url: "https://claude.ai/artifact/XStpSz874WTZqyJqzktrey",
						parentId: null,
					}),
				],
			});
			const second = (
				(await post({ action: "add", title: "Second", url: "https://example.com/second" })).json as {
					link: { id: string };
				}
			).link.id;
			expect((await post({ action: "reorder", kind: "links", parentId: null, ids: [second, id] })).status).toBe(200);
			expect(links.read().links.map((link) => link.id)).toEqual([second, id]);
			expect((await post({ action: "reorder", kind: "links", parentId: null, ids: [id] })).json).toEqual({
				error: "links_changed",
			});
			// The version 1 form, without a kind and a parent, is refused.
			expect((await post({ action: "reorder", ids: [second, id] })).status).toBe(400);
			expect((await post({ action: "reorder", kind: "links", parentId: null, ids: "x" })).status).toBe(400);
			expect((await post({ action: "remove", id: second })).status).toBe(200);
			expect((await post({ action: "remove", id })).status).toBe(200);
			expect((await post({ action: "remove", id })).json).toEqual({ error: "link_missing" });
			// This server was started without a file opener.
			expect((await post({ action: "open", id })).json).toEqual({ error: "file_open_unavailable" });
			expect(links.read().links).toEqual([]);
		} finally {
			await server.close();
		}
	});

	it("adds folders, renames, moves, removes and reorders per parent through the action route", async () => {
		const root = tempDir("links-folder-routes");
		const token = "c".repeat(43);
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
			const auth = {
				Origin: server.origin,
				"Content-Type": "application/json",
				Authorization: `Bearer ${(grant.json as { token: string }).token}`,
			};
			const post = (body: unknown, headers: Record<string, string> = auth) =>
				rawRequest(server.port, { method: "POST", path: "/v1/links/action", headers, body: JSON.stringify(body) });

			const { Origin: _origin, ...noOrigin } = auth;
			expect((await post({ action: "addFolder", name: "Work", parentId: null }, noOrigin)).status).toBe(403);
			expect(
				(await post({ action: "addFolder", name: "Work", parentId: null }, { ...auth, Authorization: "" })).status,
			).toBe(401);
			const work = (
				(await post({ action: "addFolder", name: "Work", parentId: null })).json as { folder: { id: string } }
			).folder.id;
			const bio = (
				(await post({ action: "addFolder", name: "Bio", parentId: work })).json as { folder: { id: string } }
			).folder.id;
			const added = await post({ action: "add", title: "Tracker", url: "https://example.com/t", parentId: bio });
			const tracker = (added.json as { link: { id: string; parentId: string } }).link;
			expect(tracker.parentId).toBe(bio);
			const top = (
				(await post({ action: "add", title: "Top", url: "https://example.com/top", parentId: null })).json as {
					link: { id: string };
				}
			).link.id;
			expect(
				(await post({ action: "add", title: "x", url: "https://example.com/", parentId: randomUUID() })).json,
			).toEqual({ error: "folder_missing" });
			expect((await post({ action: "addFolder", name: "", parentId: null })).json).toEqual({
				error: "invalid_name",
			});
			expect((await post({ action: "rename", id: bio, name: "Mustard Bio" })).status).toBe(200);
			expect((await post({ action: "rename", id: tracker.id, name: "Tracker sheet" })).status).toBe(200);
			expect((await post({ action: "move", id: top, parentId: work, index: 0 })).status).toBe(200);
			expect((await post({ action: "move", id: work, parentId: bio, index: 0 })).json).toEqual({
				error: "invalid_move",
			});
			expect((await post({ action: "reorder", kind: "folders", parentId: null, ids: [work] })).status).toBe(200);
			expect((await post({ action: "reorder", kind: "links", parentId: work, ids: [] })).json).toEqual({
				error: "links_changed",
			});
			const listed = await rawRequest(server.port, {
				path: "/v1/links",
				headers: { Authorization: auth.Authorization },
			});
			expect(listed.json).toEqual({
				version: 2,
				folders: [
					expect.objectContaining({ id: work, name: "Work", parentId: null }),
					expect.objectContaining({ id: bio, name: "Mustard Bio", parentId: work }),
				],
				links: [
					expect.objectContaining({ id: tracker.id, title: "Tracker sheet", parentId: bio }),
					expect.objectContaining({ id: top, title: "Top", parentId: work }),
				],
			});
			for (const body of [
				{ action: "add", title: "x", url: "https://example.com/", parentId: 5 },
				{ action: "add", title: "x", url: "https://example.com/", parentId: "a".repeat(65) },
				{ action: "add", title: 5, url: "https://example.com/" },
				{ action: "addFolder", name: "x" },
				{ action: "addFolder", name: 5, parentId: null },
				{ action: "addFolder", name: "x", parentId: 5 },
				{ action: "rename", id: 5, name: "x" },
				{ action: "rename", id: bio, name: 5 },
				{ action: "rename", id: bio },
				{ action: "move", id: top, parentId: null },
				{ action: "move", id: 5, parentId: null, index: 0 },
				{ action: "move", id: top, parentId: 5, index: 0 },
				{ action: "move", id: top, parentId: null, index: "0" },
				{ action: "move", id: top, parentId: null, index: 1.5 },
				{ action: "move", id: top, parentId: null, index: -1 },
				{ action: "move", id: top, parentId: null, index: LINKS_MAX + 1 },
				{ action: "remove", id: 5 },
				{ action: "open", id: 5 },
				{ action: "reorder", kind: "pages", parentId: null, ids: [] },
				{ action: "reorder", kind: "links", parentId: 5, ids: [] },
				{ action: "reorder", kind: "links", parentId: null, ids: Array.from({ length: LINKS_MAX + 1 }, () => top) },
				{ action: "reorder", kind: "links", parentId: null, ids: [5] },
				{ action: "reorder", kind: "links", ids: [] },
				{ action: "unknown" },
			])
				expect([body, (await post(body)).status]).toEqual([body, 400]);
			expect((await post({ action: "remove", id: work })).status).toBe(200);
			expect(links.read()).toEqual({ version: 2, folders: [], links: [] });
			// A tampered file is neither listed nor changed.
			writeFileSync(links.file, JSON.stringify({ version: 2, folders: [], links: [{ id: "x" }] }));
			const unreadable = await rawRequest(server.port, {
				path: "/v1/links",
				headers: { Authorization: auth.Authorization },
			});
			expect([unreadable.status, unreadable.json]).toEqual([503, { error: "links_unreadable" }]);
			const unwritable = await post({ action: "addFolder", name: "Work", parentId: null });
			expect([unwritable.status, unwritable.json]).toEqual([503, { error: "links_unwritable" }]);

			// The OpenAPI document describes the tree and every action.
			const document = (await rawRequest(server.port, { path: "/v1/openapi.json" })).json as {
				paths: Record<string, Record<string, Record<string, unknown>>>;
			};
			const action = document.paths["/v1/links/action"]!.post!;
			expect(action.security).toEqual([{ bearer: [] }]);
			const schema = (
				action.requestBody as { content: Record<string, { schema: { oneOf: Array<Record<string, unknown>> } }> }
			).content["application/json"]!.schema;
			expect(schema.oneOf.map((entry) => (entry.properties as { action: { const: string } }).action.const)).toEqual([
				"add",
				"addFolder",
				"rename",
				"move",
				"remove",
				"reorder",
				"open",
			]);
			expect(schema.oneOf[0]!.required).toEqual(["action", "title", "url"]);
			const list = document.paths["/v1/links"]!.get!.responses as Record<
				string,
				{ content: Record<string, { schema: { properties: Record<string, unknown> } }> }
			>;
			expect(list["200"]!.content["application/json"]!.schema.properties.version).toEqual({ const: 2 });
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
			openFile: async (path, reveal) => {
				if (fail) throw new Error("no opener");
				opened.push(`${reveal ? "reveal" : "open"} ${path}`);
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
			expect((await post({ action: "open", id: file.id })).json).toEqual({ opened: true, revealed: false });
			writeFileSync(join(root, "run.command"), "x");
			const script = links.add("Script", join(root, "run.command"));
			expect((await post({ action: "open", id: script.id })).json).toEqual({ opened: true, revealed: true });
			expect(opened).toEqual([`open ${join(root, "plan.pdf")}`, `reveal ${join(root, "run.command")}`]);
			expect((await post({ action: "open", id: web.id })).json).toEqual({ error: "not_a_file" });
			const missing = await post({ action: "open", id: gone.id });
			expect([missing.status, missing.json]).toEqual([404, { error: "file_missing" }]);
			expect((await post({ action: "open", id: "/etc/passwd" })).json).toEqual({ error: "link_missing" });
			expect((await post({ action: "open", path: join(root, "plan.pdf") })).status).toBe(400);
			fail = true;
			const failed = await post({ action: "open", id: file.id });
			expect([failed.status, failed.json]).toEqual([503, { error: "file_open_failed" }]);
			expect(opened).toHaveLength(2);
		} finally {
			await server.close();
		}
	});

	it("lets a paired remote device add web links but never add or open a file", async () => {
		const root = tempDir("links-remote");
		writeFileSync(join(root, "plan.pdf"), "pdf");
		const devices = new DeviceAccess(root, "https://fixture.example");
		const links = new LinksState(join(root, "links.json"), undefined, root);
		const local = links.add("Plan", join(root, "plan.pdf"));
		const opened: string[] = [];
		const server = await startPortalServer({
			installToken: "f".repeat(43),
			port: 0,
			version: "test",
			remote: true,
			devices,
			links,
			openFile: async (path) => {
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
			const headers = { Host: "fixture.example", Origin: devices.origin, "Content-Type": "application/json" };
			const code = devices.pair("Phone").url.split("#pair=")[1]!;
			const pair = await rawRequest(server.port, {
				path: "/v1/session/pair",
				method: "POST",
				headers,
				body: JSON.stringify({ code }),
			});
			const auth = {
				...headers,
				Cookie: String(pair.headers["set-cookie"]).split(";")[0]!,
				Authorization: `Bearer ${(pair.json as { token: string }).token}`,
			};
			const post = (body: unknown) =>
				rawRequest(server.port, {
					method: "POST",
					path: "/v1/links/action",
					headers: auth,
					body: JSON.stringify(body),
				});
			expect((await post({ action: "add", title: "Web", url: "https://example.com/" })).status).toBe(200);
			const folder = await post({ action: "addFolder", name: "Phone", parentId: null });
			expect(folder.status).toBe(200);
			const inFolder = await post({
				action: "add",
				title: "",
				url: join(root, "plan.pdf"),
				parentId: (folder.json as { folder: { id: string } }).folder.id,
			});
			expect([inFolder.status, inFolder.json]).toEqual([403, { error: "local_only" }]);
			for (const url of [join(root, "plan.pdf"), "~/plan.pdf", "file:///etc/hosts", " FILE:///etc/hosts"]) {
				const refused = await post({ action: "add", title: "", url });
				expect([url, refused.status, refused.json]).toEqual([url, 403, { error: "local_only" }]);
			}
			const open = await post({ action: "open", id: local.id });
			expect([open.status, open.json]).toEqual([403, { error: "local_only" }]);
			expect(opened).toEqual([]);
			expect(links.read().links.map((link) => link.title)).toEqual(["Plan", "Web"]);
		} finally {
			await server.close();
		}
	});
});
