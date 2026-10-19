#!/usr/bin/env node
/**
 * Real-browser end-to-end check of the Executor cockpit sign-in (CI only).
 *
 * Starts the vendored Executor daemon on an ephemeral loopback port with a
 * temporary HOME and data directory, runs `executor open` with a recording
 * opener stub, and drives headless Chromium (throwaway profile, mock keychain)
 * over the DevTools protocol through:
 *
 * 1. the CLI's `file:` redirect page -> the daemon's exchange page
 *    (`/auth/sign-in#_code=...`) -> the cockpit, signed in;
 * 2. the loopback-URL fallback (`/auth/sign-in#_code=...` opened directly) in
 *    a fresh browser context.
 *
 * It fails on any Content-Security-Policy violation during sign-in, on a
 * cockpit or exchange page served without the strict policy, on a session
 * history entry that still holds the code or the file page, on a code that
 * can be spent twice, and if the browser does not end up signed in. It also
 * proves the policy is enforced: an injected inline script must not run and a
 * remote image must be blocked by `img-src`.
 *
 * It refuses to run outside CI unless HARNESSY_BROWSER_SMOKE=1 is set, so it
 * never opens a browser on a developer machine by accident. The daemon runs
 * with PI_AUTH_ENCRYPTION=off and HSY_AUTH_ENCRYPTION=off, so no keychain,
 * live service or real state is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { assertStrictCockpitCsp, signInTargetFromOpenerArg } from "./cockpit-smoke-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executorCli = join(repoRoot, "executor/apps/cli/src/main.ts");
const TIMEOUT_MS = 30_000;

if (process.env.CI !== "true" && process.env.HARNESSY_BROWSER_SMOKE !== "1") {
	process.stdout.write("Skipping the Executor cockpit browser check: it runs in CI, or with HARNESSY_BROWSER_SMOKE=1.\n");
	process.exit(0);
}
if (!existsSync(join(repoRoot, "executor/apps/local/dist/index.html"))) {
	throw new Error("Build the cockpit first: the check serves executor/apps/local/dist.");
}

const findChrome = () => {
	const configured = process.env.CHROME_PATH?.trim();
	if (configured) return configured;
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
		const found = spawnSync("which", [name], { encoding: "utf8" });
		if (found.status === 0 && found.stdout.trim() !== "") return found.stdout.trim();
	}
	throw new Error("No Chrome or Chromium found; set CHROME_PATH.");
};

const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const until = async (label, check, timeoutMs = TIMEOUT_MS) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await wait(100);
	}
};

const freePort = () =>
	new Promise((done, failed) => {
		const server = createServer();
		server.once("error", failed);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => done(port));
		});
	});

const root = await mkdtemp(join(tmpdir(), "executor-cockpit-browser-"));
const home = join(root, "home");
const dataDir = join(home, ".executor");
const scopeDir = join(root, "scope");
const stubDir = join(root, "bin");
const openerLog = join(root, "opener.txt");
const profile = join(root, "chrome-profile");
const children = [];
const failures = [];

const childEnv = {
	HOME: home,
	PATH: `${stubDir}${delimiter}${process.env.PATH ?? ""}`,
	EXECUTOR_DATA_DIR: dataDir,
	EXECUTOR_SCOPE_DIR: scopeDir,
	EXECUTOR_DISABLE_UPDATE_CHECK: "1",
	EXECUTOR_SIGN_IN: "file",
	// Never reach an OS keychain from the check.
	PI_AUTH_ENCRYPTION: "off",
	HSY_AUTH_ENCRYPTION: "off",
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_DATA_HOME: join(home, ".local/share"),
	XDG_STATE_HOME: join(home, ".local/state"),
};

const killGroup = (child) => {
	if (child.pid === undefined || child.exitCode !== null) return;
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill("SIGTERM");
	}
};

try {
	await mkdir(home, { recursive: true });
	await mkdir(scopeDir, { recursive: true });
	await mkdir(stubDir, { recursive: true });
	const stub = `#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nprintf '%s\\n' "$last" >> '${openerLog}'\nexit 0\n`;
	await writeFile(join(stubDir, "xdg-open"), stub, { mode: 0o755 });
	await writeFile(join(stubDir, "open"), stub, { mode: 0o755 });

	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const daemon = spawn("bun", ["run", executorCli, "daemon", "run", "--port", String(port), "--hostname", "127.0.0.1"], {
		cwd: scopeDir,
		env: childEnv,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(daemon);
	let daemonOutput = "";
	daemon.stdout.on("data", (chunk) => {
		daemonOutput += String(chunk);
	});
	daemon.stderr.on("data", (chunk) => {
		daemonOutput += String(chunk);
	});
	const manifest = await until("the daemon manifest", async () => {
		const raw = await readFile(join(dataDir, "server-control", "server.json"), "utf8").catch(() => "");
		if (raw === "") return undefined;
		const parsed = JSON.parse(raw);
		const health = await fetch(`${origin}/api/health`).catch(() => undefined);
		return health?.ok ? parsed : undefined;
	}, 60_000).catch((error) => {
		throw new Error(`${error.message}\n${daemonOutput.slice(-4000)}`);
	});
	const token = manifest.connection.auth.token;

	const opened = spawnSync("bun", ["run", executorCli, "open"], { cwd: scopeDir, env: childEnv, encoding: "utf8", timeout: 60_000 });
	if (opened.status !== 0) throw new Error(`executor open failed: ${opened.stdout}\n${opened.stderr}`);
	if (`${opened.stdout}${opened.stderr}`.includes(token)) throw new Error("executor open printed the bearer.");
	const openerArg = (await readFile(openerLog, "utf8")).trim().split("\n").at(-1);
	const fileTarget = signInTargetFromOpenerArg(openerArg, join(dataDir, "server-control"), [token]);
	const fileCode = new URLSearchParams(new URL(fileTarget).hash.slice(1)).get("_code");

	const chrome = spawn(
		findChrome(),
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--use-mock-keychain",
			"--password-store=basic",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"--disable-extensions",
			"--disable-background-networking",
			"--disable-sync",
			// The file: redirect page must be allowed to navigate to the daemon.
			"--allow-file-access-from-files",
			...(process.platform === "linux" ? ["--no-sandbox"] : []),
			"about:blank",
		],
		{ env: { HOME: join(root, "chrome-home"), PATH: process.env.PATH ?? "" }, stdio: ["ignore", "ignore", "pipe"], detached: true },
	);
	children.push(chrome);
	const [debugPort, browserPath] = await until("Chrome", async () => {
		const text = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
		const lines = text.split("\n").filter((line) => line !== "");
		return lines.length >= 2 ? lines : undefined;
	});

	const socket = new WebSocket(`ws://127.0.0.1:${debugPort}${browserPath}`);
	await new Promise((ready, failed) => {
		socket.addEventListener("open", ready, { once: true });
		socket.addEventListener("error", failed, { once: true });
	});
	let nextId = 1;
	const pending = new Map();
	const events = [];
	socket.addEventListener("message", (message) => {
		const data = JSON.parse(String(message.data));
		if (data.id !== undefined && pending.has(data.id)) {
			const { done, failed } = pending.get(data.id);
			pending.delete(data.id);
			if (data.error) failed(new Error(data.error.message));
			else done(data.result);
		} else if (data.method !== undefined) events.push(data);
	});
	const send = (method, params = {}, sessionId) =>
		new Promise((done, failed) => {
			const id = nextId++;
			pending.set(id, { done, failed });
			socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
		});

	/** A fresh page in its own browser context, with CSP violations reported over CDP across navigations. */
	const openPage = async () => {
		const { browserContextId } = await send("Target.createBrowserContext");
		const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
		const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
		const page = (method, params) => send(method, params, sessionId);
		await page("Page.enable");
		await page("Runtime.enable");
		await page("Network.enable");
		await page("Runtime.addBinding", { name: "__reportCsp" });
		await page("Page.addScriptToEvaluateOnNewDocument", {
			source:
				"document.addEventListener('securitypolicyviolation', (e) => globalThis.__reportCsp(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));",
		});
		const evaluate = async (expression) => {
			const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(`evaluate failed: ${expression}`);
			return result.result.value;
		};
		const ofSession = (method) => events.filter((event) => event.sessionId === sessionId && event.method === method);
		const violations = () => ofSession("Runtime.bindingCalled").map((event) => event.params.payload);
		const responses = () => ofSession("Network.responseReceived").map((event) => event.params.response);
		return { page, evaluate, violations, responses };
	};

	const header = (response, name) =>
		Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1] ?? null;

	const signedIn = async ({ page, evaluate, responses }, label) => {
		await until(`${label}: signed-in cockpit`, async () => {
			const state = await evaluate(
				"({ href: location.href, token: localStorage.getItem('executor.authToken'), rendered: (document.getElementById('root')?.children.length ?? 0) > 0, gate: document.body?.innerText.includes('Authentication required') ?? false })",
			).catch(() => undefined);
			const apiOk = responses().some((response) => {
				const url = new URL(response.url);
				return url.origin === origin && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/local-auth/") && response.status === 200;
			});
			const landed = state !== undefined && state.href.startsWith(`${origin}/`) && !state.href.includes("#") && !state.href.includes("/auth/sign-in");
			return landed && state.token === token && state.rendered && !state.gate && apiOk ? state : undefined;
		});
		const unauthorized = responses().filter((response) => response.url.startsWith(`${origin}/api/`) && response.status === 401);
		if (unauthorized.length > 0) failures.push(`${label}: API answered 401 after sign-in (${unauthorized.map((r) => new URL(r.url).pathname).join(", ")})`);
		for (const path of ["/", "/auth/sign-in"]) {
			const response = responses().find((candidate) => candidate.url.split("#")[0] === `${origin}${path}`);
			if (response === undefined) {
				failures.push(`${label}: the browser never loaded ${path}`);
				continue;
			}
			try {
				assertStrictCockpitCsp(header(response, "content-security-policy"));
			} catch (error) {
				failures.push(`${label}: ${path}: ${error.message}`);
			}
		}
		const { entries } = await page("Page.getNavigationHistory");
		for (const entry of entries) {
			if (entry.url.includes("_code")) failures.push(`${label}: session history kept the sign-in code (${entry.url.replace(/_code=[^&]+/, "_code=[redacted]")})`);
			if (entry.url.startsWith("file:")) failures.push(`${label}: session history kept the file: sign-in page`);
		}
	};

	// 1. The CLI's file: page -> exchange page -> cockpit.
	const first = await openPage();
	await first.page("Page.navigate", { url: openerArg });
	await signedIn(first, "file page");
	if (first.violations().length > 0) failures.push(`file page: CSP violations during sign-in: ${first.violations().join("; ")}`);
	const replay = await fetch(`${origin}/api/local-auth/exchange`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: fileCode }),
	});
	if (replay.status !== 401) failures.push(`the browser's spent code was accepted again (HTTP ${replay.status})`);
	if (existsSync(fileURLToPath(openerArg))) failures.push("the file: sign-in page was not deleted after its code was spent");

	// The policy is enforced, not just sent: inline script and remote images are blocked.
	const before = first.violations().length;
	const enforced = await first.evaluate(`(async () => {
		const script = document.createElement("script");
		script.textContent = "window.__inlineRan = true";
		document.body.appendChild(script);
		const img = new Image();
		const loaded = new Promise((done) => { img.onload = () => done("loaded"); img.onerror = () => done("blocked"); });
		img.src = "https://example.com/pixel.png?" + Date.now();
		return { inlineRan: window.__inlineRan === true, image: await loaded };
	})()`);
	if (enforced.inlineRan) failures.push("CSP did not block an injected inline script");
	if (enforced.image !== "blocked") failures.push("CSP did not block a remote image (img-src)");
	await until("CSP violation reports", () => first.violations().length >= before + 2, 5_000).catch(() => undefined);
	const reported = first.violations().slice(before);
	if (!reported.some((line) => line.startsWith("script-src"))) failures.push(`no script-src violation was reported (${reported.join("; ")})`);
	if (!reported.some((line) => line.startsWith("img-src"))) failures.push(`no img-src violation was reported (${reported.join("; ")})`);

	// 2. The loopback-URL fallback, in a fresh context (empty storage).
	const minted = await fetch(`${origin}/api/local-auth/code`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
	const { code } = await minted.json();
	const second = await openPage();
	await second.page("Page.navigate", { url: `${origin}/auth/sign-in#_code=${code}` });
	await signedIn(second, "loopback URL");
	if (second.violations().length > 0) failures.push(`loopback URL: CSP violations during sign-in: ${second.violations().join("; ")}`);

	await send("Browser.close").catch(() => undefined);
	socket.close();

	if (failures.length > 0) {
		throw new Error(`Executor cockpit browser check failed:\n- ${failures.join("\n- ")}`);
	}
	process.stdout.write("Executor cockpit browser check passed (CSP enforced, redirect page and code exchange signed in, no code in session history).\n");
} finally {
	for (const child of children.reverse()) killGroup(child);
	await wait(500);
	await rm(root, { recursive: true, force: true });
}
