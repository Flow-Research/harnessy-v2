/**
 * The manifest-pinned app bundle: only listed files are served, every digest is
 * checked at start, a tampered, unsafe or unlisted file stops the portal, and
 * index.html can load nothing the CSP would block or the manifest does not list.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	assertPortalIndexHtml,
	defaultPortalAppDir,
	loadPortalPageAssets,
	MAX_ASSET_BYTES,
	PORTAL_ASSET_MANIFEST,
	PORTAL_ASSET_MANIFEST_SCHEMA,
	PORTAL_FALLBACK_HTML,
	PORTAL_IMMUTABLE,
	PORTAL_NO_STORE,
	PortalAssetError,
} from "../src/portal/page-assets.ts";
import { PORTAL_CSP, type PortalServer, startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import { cleanupPortalFixtures, FIXTURE_NOW, tempDir } from "./support/portal-fixture.ts";
import { rawRequest } from "./support/portal-http.ts";

const servers: PortalServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	cleanupPortalFixtures();
});

const INDEX = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Harnessy</title>
<script type="module" crossorigin src="/assets/index-AbCd1234.js"></script>
<link rel="stylesheet" crossorigin href="/assets/style-EfGh5678.css">
</head><body><div id="root"></div></body></html>
`;

const FILES: Readonly<Record<string, string>> = {
	"index.html": INDEX,
	"assets/index-AbCd1234.js": "console.log('app');\n",
	"assets/style-EfGh5678.css": "body{color:red}\n",
	"THIRD_PARTY_NOTICES.txt": "notices\n",
};

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Write a bundle and its manifest. `manifest` edits the manifest before it is written. */
const bundle = (
	files: Readonly<Record<string, string>> = FILES,
	manifest: (value: { schema: string; files: Record<string, { sha256: string; bytes: number }> }) => unknown = (v) =>
		v,
): string => {
	const dir = tempDir("app");
	const listed: Record<string, { sha256: string; bytes: number }> = {};
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), body);
		listed[path] = { sha256: sha256(body), bytes: Buffer.byteLength(body) };
	}
	writeFileSync(
		join(dir, PORTAL_ASSET_MANIFEST),
		JSON.stringify(manifest({ schema: PORTAL_ASSET_MANIFEST_SCHEMA, files: listed })),
	);
	return dir;
};

const code = (run: () => unknown): string => {
	try {
		run();
	} catch (error) {
		return error instanceof PortalAssetError ? error.code : `unexpected: ${String(error)}`;
	}
	return "loaded";
};

describe("app bundle loader", () => {
	it("serves exactly the manifest's files: index at /, hashed files immutable, the rest no-store", () => {
		const dir = bundle();
		writeFileSync(join(dir, "assets", "unlisted-ZZZZ9999.js"), "alert('not listed')");
		const assets = loadPortalPageAssets(dir);
		expect([...assets.keys()].sort()).toEqual([
			"/",
			"/THIRD_PARTY_NOTICES.txt",
			"/assets/index-AbCd1234.js",
			"/assets/style-EfGh5678.css",
		]);
		expect(assets.get("/")).toMatchObject({ contentType: "text/html; charset=utf-8", cacheControl: PORTAL_NO_STORE });
		expect(assets.get("/assets/index-AbCd1234.js")).toMatchObject({
			contentType: "text/javascript; charset=utf-8",
			cacheControl: PORTAL_IMMUTABLE,
		});
		expect(assets.get("/assets/style-EfGh5678.css")?.cacheControl).toBe(PORTAL_IMMUTABLE);
		expect(assets.get("/THIRD_PARTY_NOTICES.txt")?.cacheControl).toBe(PORTAL_NO_STORE);
		expect(assets.get("/index.html")).toBeUndefined();
	});

	it("serves a script-free page when no bundle is built", () => {
		const assets = loadPortalPageAssets(tempDir("unbuilt"));
		expect([...assets.keys()]).toEqual(["/"]);
		expect(assets.get("/")?.body.toString("utf8")).toBe(PORTAL_FALLBACK_HTML);
		expect(PORTAL_FALLBACK_HTML).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/iu);
	});

	it("refuses to start on a tampered, resized, missing, linked or oversize file", () => {
		const tampered = bundle();
		writeFileSync(join(tampered, "assets", "index-AbCd1234.js"), "console.log('evil');\n");
		expect(code(() => loadPortalPageAssets(tampered))).toBe("portal_asset_digest_mismatch");
		const resized = bundle(FILES, (value) => ({
			...value,
			files: { ...value.files, "THIRD_PARTY_NOTICES.txt": { ...value.files["THIRD_PARTY_NOTICES.txt"]!, bytes: 3 } },
		}));
		expect(code(() => loadPortalPageAssets(resized))).toBe("portal_asset_digest_mismatch");
		const missing = bundle(FILES, (value) => ({
			...value,
			files: { ...value.files, "assets/gone-11112222.js": { sha256: "0".repeat(64), bytes: 1 } },
		}));
		expect(code(() => loadPortalPageAssets(missing))).toBe("portal_asset_missing");
		const linked = bundle();
		const target = join(tempDir("elsewhere"), "x.js");
		writeFileSync(target, FILES["assets/index-AbCd1234.js"]!);
		const script = join(linked, "assets", "index-AbCd1234.js");
		// Replace the listed file with a link to identical bytes: still refused.
		rmSync(script);
		symlinkSync(target, script);
		expect(code(() => loadPortalPageAssets(linked))).toBe("portal_asset_unsafe");
		const directory = bundle();
		rmSync(join(directory, "THIRD_PARTY_NOTICES.txt"));
		mkdirSync(join(directory, "THIRD_PARTY_NOTICES.txt"));
		expect(code(() => loadPortalPageAssets(directory))).toBe("portal_asset_unsafe");
		const large = "x".repeat(MAX_ASSET_BYTES + 1);
		const oversize = bundle(FILES, (value) => value);
		writeFileSync(join(oversize, "THIRD_PARTY_NOTICES.txt"), large);
		expect(code(() => loadPortalPageAssets(oversize))).toBe("portal_asset_oversize");
	});

	it("refuses a manifest that is malformed, escapes the bundle or lists an unknown file type", () => {
		const cases: ReadonlyArray<[string, (value: { schema: string; files: Record<string, unknown> }) => unknown]> = [
			["not json", () => undefined],
			["wrong schema", (value) => ({ ...value, schema: "other" })],
			["extra key", (value) => ({ ...value, extra: 1 })],
			["array files", (value) => ({ ...value, files: [] })],
			["no files", (value) => ({ ...value, files: {} })],
			[
				"traversal",
				(value) => ({ ...value, files: { ...value.files, "../escape.js": { sha256: "0".repeat(64), bytes: 1 } } }),
			],
			[
				"dot file",
				(value) => ({ ...value, files: { ...value.files, ".hidden.js": { sha256: "0".repeat(64), bytes: 1 } } }),
			],
			[
				"deep path",
				(value) => ({ ...value, files: { ...value.files, "a/b/c.js": { sha256: "0".repeat(64), bytes: 1 } } }),
			],
			[
				"unknown type",
				(value) => ({ ...value, files: { ...value.files, "assets/x.php": { sha256: "0".repeat(64), bytes: 1 } } }),
			],
			[
				"bad digest",
				(value) => ({ ...value, files: { ...value.files, "assets/y.js": { sha256: "XYZ", bytes: 1 } } }),
			],
			[
				"negative size",
				(value) => ({ ...value, files: { ...value.files, "assets/y.js": { sha256: "0".repeat(64), bytes: -1 } } }),
			],
			[
				"extra entry key",
				(value) => ({
					...value,
					files: { ...value.files, "assets/y.js": { sha256: "0".repeat(64), bytes: 1, x: 1 } },
				}),
			],
			[
				"no index",
				(value) => ({
					...value,
					files: Object.fromEntries(Object.entries(value.files).filter(([path]) => path !== "index.html")),
				}),
			],
		];
		for (const [name, edit] of cases) {
			const dir = bundle();
			const edited = edit(JSON.parse(readFileSync(join(dir, PORTAL_ASSET_MANIFEST), "utf8")));
			writeFileSync(join(dir, PORTAL_ASSET_MANIFEST), edited === undefined ? "{ not json" : JSON.stringify(edited));
			expect([name, code(() => loadPortalPageAssets(dir))]).toEqual([name, "portal_asset_manifest_invalid"]);
		}
	});

	it("refuses an index.html with inline script, style, handlers or an unlisted reference", () => {
		const listed = new Set(["index.html", "assets/a-12345678.js"]);
		const ok = '<script type="module" src="/assets/a-12345678.js"></script>';
		expect(() => assertPortalIndexHtml(ok, listed)).not.toThrow();
		for (const [html, expected] of [
			["<script>alert(1)</script>", "portal_index_inline_script"],
			['<script src="/assets/a-12345678.js">alert(1)</script>', "portal_index_inline_script"],
			["<style>body{}</style>", "portal_index_inline_style"],
			['<div style="color:red"></div>', "portal_index_inline_style"],
			['<body onload="x()"></body>', "portal_index_event_handler"],
			['<script type="module" src="/assets/other-12345678.js"></script>', "portal_index_reference_unlisted"],
			['<link rel="stylesheet" href="https://cdn.example.test/x.css">', "portal_index_reference_unlisted"],
			['<img src="data:image/png;base64,AAAA">', "portal_index_reference_unlisted"],
		] as const)
			expect([html, code(() => assertPortalIndexHtml(html, listed))]).toEqual([html, expected]);
		const inline = bundle({ ...FILES, "index.html": INDEX.replace("</head>", "<style>body{}</style></head>") });
		expect(code(() => loadPortalPageAssets(inline))).toBe("portal_index_inline_style");
	});

	it("passes its own checks for the real build, which injects no style element and inlines nothing", () => {
		// CI builds the bundle before the tests run; a source checkout that was never built skips this case.
		const dir = defaultPortalAppDir();
		if (!existsSync(join(dir, PORTAL_ASSET_MANIFEST))) return;
		const assets = loadPortalPageAssets(dir);
		const index = assets.get("/")!.body.toString("utf8");
		expect(index).toMatch(
			/<script type="module" crossorigin src="\/assets\/index-[A-Za-z0-9_-]{8,}\.js"><\/script>/u,
		);
		const css = [...assets].filter(([path]) => path.endsWith(".css")).map(([, asset]) => asset.body.toString("utf8"));
		expect(css).toHaveLength(1);
		expect(css[0]).not.toMatch(/url\((?!["']?\/assets\/)/u);
		expect(css[0]).not.toContain("data:");
		const fonts = [...assets.keys()].filter((path) => path.endsWith(".woff2"));
		expect(fonts.length).toBe(7);
		const script = [...assets]
			.filter(([path]) => path.endsWith(".js"))
			.map(([, asset]) => asset.body.toString("utf8"));
		expect(script).toHaveLength(1);
		expect(script[0]).not.toMatch(/\beval\(|new Function\(/u);
		// Every hashed file is cached as immutable; nothing else is.
		for (const [path, asset] of assets)
			expect([path, asset.cacheControl]).toEqual([
				path,
				/-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2)$/u.test(path) ? PORTAL_IMMUTABLE : PORTAL_NO_STORE,
			]);
	});
});

describe("app bundle over HTTP", () => {
	const serve = async (page: ReturnType<typeof loadPortalPageAssets>) => {
		const server = await startPortalServer({
			installToken: newPortalSecret(),
			sources: createPortalSources({
				homeRoot: tempDir("assets-home"),
				env: {},
				probe: () => "unsupported",
				timeoutMs: 250,
				clock: () => FIXTURE_NOW,
				probePort: async () => false,
			}),
			version: "0.0.3",
			port: 0,
			page,
		});
		servers.push(server);
		return server;
	};

	it("sends the unchanged CSP and security headers with every file, and the right cache policy", async () => {
		const server = await serve(loadPortalPageAssets(bundle()));
		for (const [path, cache] of [
			["/", PORTAL_NO_STORE],
			["/assets/index-AbCd1234.js", PORTAL_IMMUTABLE],
			["/assets/style-EfGh5678.css", PORTAL_IMMUTABLE],
			["/THIRD_PARTY_NOTICES.txt", PORTAL_NO_STORE],
		] as const) {
			const response = await rawRequest(server.port, { path });
			expect([path, response.status]).toEqual([path, 200]);
			expect(response.headers["content-security-policy"]).toBe(PORTAL_CSP);
			expect(response.headers["cache-control"]).toBe(cache);
			expect(response.headers["x-content-type-options"]).toBe("nosniff");
			expect(response.headers["x-frame-options"]).toBe("DENY");
			expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
			expect(response.headers["referrer-policy"]).toBe("no-referrer");
			expect(response.headers["set-cookie"]).toBeUndefined();
			expect(Object.keys(response.headers).some((name) => name.startsWith("access-control-"))).toBe(false);
		}
		for (const path of [
			"/index.html",
			"/asset-manifest.json",
			"/assets/unlisted-ZZZZ9999.js",
			"/assets/../index.html",
		]) {
			const response = await rawRequest(server.port, { path });
			expect([path, response.status]).toEqual([path, 404]);
			expect(response.headers["content-security-policy"]).toBe(PORTAL_CSP);
			expect(response.headers["cache-control"]).toBe("no-store");
		}
		const posted = await rawRequest(server.port, { method: "POST", path: "/assets/index-AbCd1234.js", body: "" });
		expect(posted.status).toBe(405);
		expect(posted.headers["content-security-policy"]).toBe(PORTAL_CSP);
		const foreign = await rawRequest(server.port, { path: "/", headers: { "Sec-Fetch-Site": "cross-site" } });
		expect(foreign.status).toBe(403);
		expect(foreign.headers["content-security-policy"]).toBe(PORTAL_CSP);
	});
});
