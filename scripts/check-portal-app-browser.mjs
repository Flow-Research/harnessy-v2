#!/usr/bin/env node
/**
 * Headless browser smoke for the Harnessy app (CI only).
 *
 * Starts the built `harnessy-portal serve` against a temporary fixture home,
 * signs in through `open --print`, and drives headless Chrome over the DevTools
 * protocol. Before any page script runs, a `securitypolicyviolation` listener is
 * installed; the smoke fails on any CSP violation (which is how an injected
 * `<style>` element or inline script would show), any uncaught exception or
 * console error, any `<style>` element in the document, and any horizontal page
 * scroll at phone width.
 *
 * It refuses to run outside CI unless HARNESSY_BROWSER_SMOKE=1 is set, so it
 * never opens a browser on a developer machine by accident. The browser runs
 * headless with a throwaway profile; the portal runs with a temporary HOME and
 * PI_AUTH_ENCRYPTION=off, so no keychain, live service or real state is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portalCli = join(repoRoot, "packages/harnessy-local-host/dist/portal-cli.js");
const SCREENS = ["inbox", "today", "tasks", "jobs", "reviews", "learning", "connections"];
const TIMEOUT_MS = 20_000;

if (process.env.CI !== "true" && process.env.HARNESSY_BROWSER_SMOKE !== "1") {
	process.stdout.write("Skipping the browser smoke: it runs in CI, or with HARNESSY_BROWSER_SMOKE=1.\n");
	process.exit(0);
}
if (!existsSync(portalCli) || !existsSync(join(repoRoot, "packages/harnessy-local-host/dist/portal-app/asset-manifest.json")))
	throw new Error("Build the workspace first: the smoke serves the built app.");

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
const until = async (label, check) => {
	const deadline = Date.now() + TIMEOUT_MS;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
		await wait(100);
	}
};

const root = await mkdtemp(join(tmpdir(), "harnessy-app-smoke-"));
const home = join(root, "home");
const stateDir = join(root, "state");
const profile = join(root, "chrome-profile");
const children = [];
const failures = [];

const childEnv = {
	HOME: home,
	PATH: process.env.PATH,
	USER: "owner",
	// Never reach an OS keychain from the smoke.
	PI_AUTH_ENCRYPTION: "off",
};

try {
	// A fixture home with hostile text in the brief, so rendering is exercised under the CSP.
	const lagos = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
	const part = (type) => lagos.find((entry) => entry.type === type).value;
	const month = new Date().toLocaleString("en-US", { month: "short", timeZone: "Africa/Lagos" });
	const briefDir = join(home, ".agents", "life", part("year"), month);
	await mkdir(briefDir, { recursive: true });
	await writeFile(
		join(briefDir, `${part("day")}-daily-brief.md`),
		[
			"## Decisions and Actions for You",
			"",
			"1. **Settle the plan.** <script>alert(1)</script> <style>body{display:none}</style>",
			"",
			"## Delegated or Waiting",
			"",
			"- **Ada — vendor contract.** [link](javascript:alert(1)) <img src=x onerror=alert(1)>",
			"",
		].join("\n"),
	);
	await writeFile(join(home, ".agents", "life", "reminders.md"), "## Current Follow-Ups\n\n- [ ] A reminder\n");

	const server = spawn(process.execPath, [portalCli, "serve", "--port", "0", "--state-dir", stateDir, "--home-root", home], {
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(server);
	let serverOutput = "";
	server.stdout.on("data", (chunk) => {
		serverOutput += String(chunk);
	});
	server.stderr.on("data", (chunk) => {
		serverOutput += String(chunk);
	});
	const port = await until("the portal", () => /\{"kind":"ready","port":(\d+)\}/u.exec(serverOutput)?.[1]);
	const opened = spawnSync(process.execPath, [portalCli, "open", "--port", port, "--state-dir", stateDir, "--route", "inbox", "--print"], {
		env: childEnv,
		encoding: "utf8",
	});
	if (opened.status !== 0) throw new Error(`open --print failed: ${opened.stderr}`);
	const signInUrl = opened.stdout.trim();

	const chrome = spawn(
		findChrome(),
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"--disable-extensions",
			"--disable-background-networking",
			...(process.platform === "linux" ? ["--no-sandbox"] : []),
			"about:blank",
		],
		{ env: { ...childEnv, HOME: join(root, "chrome-home") }, stdio: ["ignore", "ignore", "pipe"] },
	);
	children.push(chrome);
	const portFile = join(profile, "DevToolsActivePort");
	const [debugPort, browserPath] = await until("Chrome", async () => {
		const text = await readFile(portFile, "utf8").catch(() => "");
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
			const { resolve: done, reject } = pending.get(data.id);
			pending.delete(data.id);
			if (data.error) reject(new Error(`${data.error.message}`));
			else done(data.result);
		} else if (data.method !== undefined) events.push(data);
	});
	const send = (method, params = {}, sessionId) =>
		new Promise((done, reject) => {
			const id = nextId++;
			pending.set(id, { resolve: done, reject });
			socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
		});

	const { targetId } = await send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
	const page = (method, params) => send(method, params, sessionId);
	await page("Page.enable");
	await page("Runtime.enable");
	await page("Log.enable");
	await page("Page.addScriptToEvaluateOnNewDocument", {
		source:
			"window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));",
	});
	const evaluate = async (expression) => {
		const result = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(`evaluate failed: ${expression}`);
		return result.result.value;
	};
	const check = async (label) => {
		const report = await evaluate(`({
			csp: window.__csp,
			styles: document.querySelectorAll('style').length,
			inlineStyled: [...document.querySelectorAll('[style]')].length,
			scripts: [...document.scripts].map((s) => s.src),
			overflow: document.documentElement.scrollWidth - window.innerWidth,
			text: document.body.innerText.slice(0, 200),
		})`);
		if (report.csp.length > 0) failures.push(`${label}: CSP violations ${JSON.stringify(report.csp)}`);
		if (report.styles > 0) failures.push(`${label}: ${report.styles} <style> element(s) in the document`);
		if (report.scripts.some((src) => !src.startsWith(`http://127.0.0.1:${port}/assets/`)))
			failures.push(`${label}: unexpected script ${JSON.stringify(report.scripts)}`);
		if (report.overflow > 0) failures.push(`${label}: horizontal page scroll of ${report.overflow}px`);
		return report;
	};

	for (const [width, height, mobile] of [
		[1280, 860, false],
		[375, 812, true],
	]) {
		await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
		await page("Page.navigate", { url: width === 1280 ? signInUrl : `http://127.0.0.1:${port}/#/inbox` });
		await until("the app shell", () => evaluate("document.querySelector('.app') !== null"));
		if (await evaluate("location.hash.includes('code=')")) failures.push("the sign-in code stayed in the address bar");
		for (const screen of SCREENS) {
			await evaluate(`location.hash = '#/${screen}'`);
			await until(`${screen} at ${width}px`, () => evaluate("document.querySelector('.screen') !== null && !document.body.innerText.includes('Loading')"));
			await wait(300);
			await check(`${screen} at ${width}px`);
		}
		if (mobile) {
			const bar = await evaluate("getComputedStyle(document.querySelector('.bottom-bar')).display");
			if (bar === "none") failures.push("phone width: the bottom bar is hidden");
			const rail = await evaluate("getComputedStyle(document.querySelector('.rail')).display");
			if (rail !== "none") failures.push("phone width: the rail is still shown");
		}
	}
	const fonts = await evaluate("document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))");
	if (!fonts.some((family) => family.includes("IBM Plex Sans"))) failures.push(`self-hosted fonts did not load: ${JSON.stringify(fonts)}`);
	const hostile = await evaluate("document.body.innerText.includes('<script>alert(1)</script>') && document.querySelectorAll('img').length === 0");
	if (!hostile) failures.push("hostile brief text was not shown as text");

	for (const event of events) {
		if (event.method === "Runtime.exceptionThrown")
			failures.push(`uncaught exception: ${event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text}`);
		if (event.method === "Log.entryAdded" && event.params.entry.level === "error" && !/favicon\.ico/u.test(event.params.entry.url ?? ""))
			failures.push(`console error: ${event.params.entry.text}`);
		if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
			failures.push(`console.error: ${JSON.stringify(event.params.args.map((arg) => arg.value ?? arg.description))}`);
	}
	socket.close();
} finally {
	for (const child of children) child.kill("SIGKILL");
	await wait(200);
	await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
	process.stderr.write(`Harnessy app browser smoke failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
	process.exit(1);
}
process.stdout.write("Harnessy app browser smoke passed: no CSP violation, no <style> element, no page overflow at 375 px.\n");
