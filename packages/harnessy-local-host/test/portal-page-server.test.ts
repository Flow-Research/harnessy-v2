/**
 * The portal page over a real loopback server: headers and CSP on every page
 * file, the page-file loader, and one end-to-end run. In that run the server
 * reads a seeded temporary home, the page scripts are the exact bytes the
 * server sent, and they run in a child Node process with a recording document
 * and a fetch that talks to the server over HTTP. Only the DOM is a stand-in.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LaunchdProbe } from "@harnessy/core/read-model";
import { afterEach, describe, expect, it } from "vitest";

import { TOKEN_KEY } from "../src/portal/page/app.ts";
import { CONNECT_GOOGLE_NOTE } from "../src/portal/page/view-model.ts";
import {
	loadPortalPageAssets,
	PORTAL_INDEX_HTML,
	PORTAL_PAGE_SCRIPTS,
	type PortalPageAssets,
} from "../src/portal/page-assets.ts";
import { PORTAL_CSP, type PortalServer, startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import {
	buildPortalHome,
	CANARY,
	cleanupPortalFixtures,
	FIXTURE_NOW,
	MEETING_OWNER,
	tempDir,
} from "./support/portal-fixture.ts";
import { installProof, type RawResponse, rawRequest } from "./support/portal-http.ts";

const shim = fileURLToPath(new URL("./support/portal-browser-shim.mjs", import.meta.url));
const servers: PortalServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	cleanupPortalFixtures();
});

const PAGE_FILES = ["/", "/app.css", ...PORTAL_PAGE_SCRIPTS.map((name) => `/${name}.js`)];
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	"/": "text/html; charset=utf-8",
	"/app.css": "text/css; charset=utf-8",
};

const RUNNING = "gui/501/org.harnessy.portal = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n";
const probe: LaunchdProbe = (label) =>
	label === "org.harnessy.portal"
		? { status: 0, stdout: RUNNING, stderr: "" }
		: { status: 113, stdout: "", stderr: "Could not find service" };

const start = async (home: string, page: PortalPageAssets | null = loadPortalPageAssets()) => {
	const installToken = newPortalSecret();
	const server = await startPortalServer({
		installToken,
		sources: createPortalSources({ homeRoot: home, env: {}, probe, timeoutMs: 250, clock: () => FIXTURE_NOW }),
		version: "0.0.3",
		port: 0,
		clock: () => FIXTURE_NOW.getTime(),
		...(page === null ? {} : { page }),
	});
	servers.push(server);
	return { server, port: server.port, installToken };
};

const mintCode = async (port: number, installToken: string): Promise<string> => {
	const minted = await rawRequest(port, {
		method: "POST",
		path: "/v1/session/code",
		headers: await installProof(port, installToken, "POST", "/v1/session/code"),
	});
	expect(minted.status).toBe(200);
	return (minted.json as { code: string }).code;
};

const expectPageHeaders = (path: string, response: RawResponse) => {
	expect([path, response.status]).toEqual([path, 200]);
	expect(response.headers["content-security-policy"]).toBe(PORTAL_CSP);
	expect(response.headers["content-type"]).toBe(CONTENT_TYPES[path] ?? "text/javascript; charset=utf-8");
	expect(response.headers["cache-control"]).toBe("no-store");
	expect(response.headers["x-content-type-options"]).toBe("nosniff");
	expect(response.headers["referrer-policy"]).toBe("no-referrer");
	expect(response.headers["x-frame-options"]).toBe("DENY");
	expect(response.headers["set-cookie"]).toBeUndefined();
	expect(Object.keys(response.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
};

describe("portal page files", () => {
	it("serves the page and its scripts with the exact CSP and security headers, and no secret", async () => {
		const { port, installToken } = await start(tempDir("page-home"));
		const code = await mintCode(port, installToken);
		const exchanged = await rawRequest(port, {
			method: "POST",
			path: "/v1/session/exchange",
			headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: JSON.stringify({ code: await mintCode(port, installToken) }),
		});
		const pageToken = (exchanged.json as { token: string }).token;
		for (const path of PAGE_FILES) {
			const response = await rawRequest(port, {
				path,
				headers: {
					"Sec-Fetch-Site": path === "/" ? "none" : "same-origin",
					// A review cookie from another loopback service is neither needed nor echoed.
					Cookie: `harnessy_review=${CANARY}`,
				},
			});
			expectPageHeaders(path, response);
			for (const secret of [installToken, pageToken, code, CANARY]) expect(response.text).not.toContain(secret);
			if (path.endsWith(".js"))
				for (const match of response.text.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/gu))
					expect(PAGE_FILES).toContain(match[1]!.replace(/^\.\//u, "/"));
		}
		const html = await rawRequest(port, { path: "/" });
		expect(html.text).toBe(PORTAL_INDEX_HTML);
		expect(html.text).not.toMatch(/[A-Za-z0-9_-]{43}/u);
		expect(html.text).toContain('id="main"');
		expect(html.text).toContain('id="page-title"');
		// A query string does not change the file; the API routes still need their credential.
		expect((await rawRequest(port, { path: "/?from=bookmark" })).text).toBe(PORTAL_INDEX_HTML);
		expect((await rawRequest(port, { path: "/v1/today" })).status).toBe(401);
	});

	it("applies the API's request checks to page files and serves nothing else", async () => {
		const { port } = await start(tempDir("page-checks"));
		const post = await rawRequest(port, { method: "POST", path: "/", body: "{}" });
		expect([post.status, post.headers.allow]).toEqual([405, "GET"]);
		expect((await rawRequest(port, { method: "HEAD", path: "/app.js" })).status).toBe(405);
		expect((await rawRequest(port, { method: "OPTIONS", path: "/" })).status).toBe(405);
		expect((await rawRequest(port, { path: "/", host: false, headers: { Host: "evil.example" } })).status).toBe(400);
		expect((await rawRequest(port, { path: "/", host: false, headers: { Host: `localhost:${port}` } })).status).toBe(
			400,
		);
		for (const site of ["cross-site", "same-site"])
			expect((await rawRequest(port, { path: "/app.js", headers: { "Sec-Fetch-Site": site } })).status).toBe(403);
		expect((await rawRequest(port, { path: "/app.js", headers: { Origin: "http://127.0.0.1:8770" } })).status).toBe(
			403,
		);
		for (const path of ["/index.html", "/app.ts", "/page/app.js", "/..%2fapp.ts", "/portal.token", "/favicon.ico"])
			expect([path, (await rawRequest(port, { path })).status]).toEqual([path, 404]);
	});

	it("serves only the API when it is started without page files", async () => {
		const { port } = await start(tempDir("api-only"), null);
		expect((await rawRequest(port, { path: "/" })).status).toBe(404);
		expect((await rawRequest(port, { path: "/app.js" })).status).toBe(404);
		expect((await rawRequest(port, { path: "/v1/healthz" })).status).toBe(200);
	});
});

describe("portal page loader", () => {
	it("serves compiled scripts as they are, and type-strips source scripts with browser import paths", () => {
		const compiled = tempDir("compiled");
		for (const name of PORTAL_PAGE_SCRIPTS)
			writeFileSync(
				join(compiled, `${name}.js`),
				`import { x } from "./mount.js";\nexport const ${name.replace("-", "")} = x;\n`,
			);
		const fromBuild = loadPortalPageAssets(compiled);
		expect(fromBuild.get("/view-model.js")!.body.toString()).toBe(
			'import { x } from "./mount.js";\nexport const viewmodel = x;\n',
		);
		const fromSource = loadPortalPageAssets();
		const app = fromSource.get("/app.js")!.body.toString();
		expect(app).toMatch(/from "\.\/mount\.js"/u);
		expect(app).toMatch(/from "\.\/view-model\.js"/u);
		expect(app).not.toMatch(/\.ts["']/u);
		expect(app).not.toMatch(/\binterface\s+PortalPageEnvironment\b/u);
		expect([...fromSource.keys()].sort()).toEqual([...PAGE_FILES].sort());
	});

	it("refuses a script that imports anything but another page script, and a missing script", () => {
		const bare = tempDir("bare-import");
		for (const name of PORTAL_PAGE_SCRIPTS) writeFileSync(join(bare, `${name}.js`), "export {};\n");
		writeFileSync(join(bare, "mount.js"), 'import { readFileSync } from "node:fs";\nexport { readFileSync };\n');
		expect(() => loadPortalPageAssets(bare)).toThrow("portal_page_import_refused: mount");
		const remote = tempDir("remote-import");
		for (const name of PORTAL_PAGE_SCRIPTS) writeFileSync(join(remote, `${name}.js`), "export {};\n");
		writeFileSync(join(remote, "app.js"), 'import "https://cdn.example/x.js";\n');
		expect(() => loadPortalPageAssets(remote)).toThrow("portal_page_import_refused: app");
		expect(() => loadPortalPageAssets(tempDir("empty"))).toThrow(/ENOENT/u);
	});
});

interface PageSnapshot {
	readonly title: string;
	readonly text: string;
	readonly outline: string;
	readonly links: ReadonlyArray<string | null>;
	readonly attributes: ReadonlyArray<string>;
}

interface BrowserRun {
	readonly pages: Readonly<Record<"today" | "health" | "connections", PageSnapshot>>;
	readonly requests: ReadonlyArray<{ method: string; path: string; credentials: string; headers: string[] }>;
	readonly hashAfterSignIn: string;
	readonly stored: ReadonlyArray<string>;
}

/** Download the page scripts from the server and run them in a child Node process with the browser shim. */
const runPage = async (port: number, hash: string): Promise<BrowserRun> => {
	const dir = join(tempDir("served-page"), "page");
	mkdirSync(dir);
	writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
	for (const name of PORTAL_PAGE_SCRIPTS) {
		const served = await rawRequest(port, { path: `/${name}.js`, headers: { "Sec-Fetch-Site": "same-origin" } });
		expect(served.status).toBe(200);
		writeFileSync(join(dir, `${name}.js`), served.text);
	}
	const home = tempDir("browser-home");
	const child = spawn(process.execPath, ["--no-warnings", "--import", shim, join(dir, "app.js")], {
		env: { HOME: home, PATH: process.env.PATH, PORTAL_ORIGIN: `http://127.0.0.1:${port}`, PORTAL_HASH: hash },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += String(chunk);
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += String(chunk);
	});
	const status = await new Promise<number | null>((exited) => child.on("exit", exited));
	expect([status, stderr]).toEqual([0, ""]);
	return JSON.parse(stdout) as BrowserRun;
};

describe("portal page end to end", () => {
	it("signs in with a one-time code and renders seeded Today, Health and Connections data", async () => {
		const fixture = await buildPortalHome("page-e2e");
		const { port, installToken } = await start(fixture.home);
		const code = await mintCode(port, installToken);
		const run = await runPage(port, `#code=${code}`);

		expect(run.hashAfterSignIn).toBe("#/today");
		expect(run.stored).toEqual([TOKEN_KEY]);
		expect(run.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
			"POST /v1/session/exchange",
			"GET /v1/today",
			"GET /v1/health",
			"GET /v1/connections",
		]);
		for (const request of run.requests) {
			expect(request.credentials).toBe("omit");
			expect(request.headers).not.toContain("Cookie");
		}

		const { today, health, connections } = run.pages;
		expect(today.title).toBe("Today");
		for (const expected of [
			`Read at ${FIXTURE_NOW.toISOString()}`,
			"Meetings to review2",
			"Community briefings to review1",
			"Fathom recordings in the inbox1",
			"Weekly plans drafted, not reconciled1",
			"Brief for 2026-10-17",
			"Not journaled yet",
			"Available3",
			"Total3",
			"2026-W42drafted",
			"2026-10-16-bbbb.md",
		])
			expect([expected, today.text.includes(expected)]).toEqual([expected, true]);

		expect(health.title).toBe("Health");
		expect(health.text).toContain("org.harnessy.portalrunningpid 4242, last exit 0");
		expect(health.text).toContain("org.harnessy.meeting-publication");

		expect(connections.title).toBe("Connections");
		for (const expected of [
			CONNECT_GOOGLE_NOTE,
			"Meeting publication: GoogleNeeds attentionowner: meeting-publication, authentication",
			"Open http://127.0.0.1:8770/If it says session, run harnessy-meeting-review-open, then Reconnect Google under Provider health.",
			"Google Workspace CLI: flow",
			"Run: gws-login flowCheck with gws-status flow.",
			"Google Workspace CLI: personal",
			"Fathom: personal",
			"Fathom: research",
			"Run: codex login",
			"Run: harnessy web",
		])
			expect([expected, connections.text.includes(expected)]).toEqual([expected, true]);
		expect(connections.links).toContain("http://127.0.0.1:8770/");
		expect(connections.links).toContain("http://127.0.0.1:8872/");

		for (const page of [today, health, connections]) {
			expect(page.text).not.toContain(CANARY);
			expect(page.text).not.toContain(MEETING_OWNER);
			expect(page.text).not.toContain(installToken);
			expect(page.text).not.toContain(code);
			for (const attribute of page.attributes) expect(["class", "href", "rel"]).toContain(attribute);
			for (const link of page.links) expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
		}
	});

	it("shows the sign-in instructions when the code was already spent", async () => {
		const fixture = await buildPortalHome("page-spent");
		const { port, installToken } = await start(fixture.home);
		const code = await mintCode(port, installToken);
		await rawRequest(port, {
			method: "POST",
			path: "/v1/session/exchange",
			headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		});
		const run = await runPage(port, `#code=${code}`);
		expect(run.hashAfterSignIn).toBe("#/today");
		expect(run.stored).toEqual([]);
		expect(run.requests.map((request) => request.path)).toEqual(["/v1/session/exchange"]);
		for (const page of Object.values(run.pages)) expect(page.text).toContain("harnessy-portal open");
	});
});
