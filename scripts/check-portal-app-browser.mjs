#!/usr/bin/env node
/**
 * Headless browser smoke for the Harnessy app (CI only).
 *
 * Starts the built `harnessy-portal serve` against a temporary fixture home,
 * signs in through `open --print`, and drives headless Chrome over the DevTools
 * protocol. Before any page script runs, a `securitypolicyviolation` listener is
 * installed; the smoke fails on any CSP violation (which is how an injected
 * `<style>` element or inline script would show), any uncaught exception, any
 * console error at all (a 404 for `/favicon.ico` included), any failed or 4xx/5xx
 * request, and any `<style>` element in the document. At 390 px (phone width) it
 * also fails on any horizontal overflow on every screen, page or element, on a
 * table where stacked cards belong, on a title squeezed narrower than 200 px, on
 * a command chip's copy button wrapped onto more than one line, and on two inbox
 * items for one Fathom account.
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
	await writeFile(
		join(home, ".agents", "life", "reminders.md"),
		[
			"## Current Follow-Ups",
			"",
			"- [ ] A reminder",
			"- [ ] Team lead deep dive on the onboarding plan with the research group before the quarterly review",
			"",
		].join("\n"),
	);
	// One Fathom account that has never polled: the poll checkpoint and Connections both report it. The
	// checkpoint file exists without an entry for the account; without the file Fathom reads as not set up.
	await mkdir(join(home, ".jarvis"), { recursive: true });
	await writeFile(join(home, ".jarvis", "config.yaml"), "fathom:\n  default_account: aa\n  accounts:\n    aa: {}\n");
	const fathomState = join(home, ".harnessy", "jarvis", "state", "fathom");
	await mkdir(fathomState, { recursive: true, mode: 0o700 });
	await writeFile(join(fathomState, "poll-state-v2.json"), '{"version":1,"accounts":{}}\n', { mode: 0o600 });

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
	await page("Network.enable");
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
	/** Phone-width layout: nothing overflows sideways, no table, no squeezed title, no wrapped copy button. */
	const checkPhone = async (label) => {
		const report = await evaluate(`(() => {
			const describe = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
			const overflowing = [];
			// What a scroll container holds may scroll inside it (a command, a code block); the container itself may not
			// stick out of the page, and a sheet, detail pane or list may not scroll sideways at all.
			const clips = (el) => getComputedStyle(el).overflowX !== 'visible';
			const insideScroller = (el) => {
				for (let node = el.parentElement; node !== null; node = node.parentElement) if (clips(node)) return true;
				return false;
			};
			for (const el of document.querySelectorAll('.app *')) {
				const style = getComputedStyle(el);
				if (style.display === 'none' || style.display === 'inline' || style.display === 'contents') continue;
				// The skip link waits off screen until it has the focus.
				if (el.closest('.skip-link') !== null || insideScroller(el)) continue;
				const rect = el.getBoundingClientRect();
				if (rect.width === 0) continue;
				const sideways = !clips(el) || el.matches('.sheet, .detail, .list');
				if ((sideways && el.scrollWidth > el.clientWidth + 1) || rect.right > window.innerWidth + 1 || rect.left < -1)
					overflowing.push(describe(el) + ' ' + Math.round(rect.left) + '..' + Math.round(rect.right) + ' scroll ' + el.scrollWidth + '/' + el.clientWidth);
			}
			return {
				overflowing: overflowing.slice(0, 5),
				tables: document.querySelectorAll('.screen table').length,
				narrowTitles: [...document.querySelectorAll('.stack-card-title')]
					.filter((el) => el.getBoundingClientRect().width < 200)
					.map((el) => el.textContent.slice(0, 40)),
				wrappedButtons: [...document.querySelectorAll('.command-row > .icon-button')]
					.filter((el) => el.getBoundingClientRect().height > 40 || el.scrollWidth > el.clientWidth + 1)
					.map((el) => el.textContent + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)),
			};
		})()`);
		if (report.overflowing.length > 0) failures.push(`${label}: horizontal overflow ${JSON.stringify(report.overflowing)}`);
		if (report.tables > 0) failures.push(`${label}: ${report.tables} table(s) at phone width; stacked cards belong here`);
		if (report.narrowTitles.length > 0) failures.push(`${label}: titles squeezed below 200 px ${JSON.stringify(report.narrowTitles)}`);
		if (report.wrappedButtons.length > 0) failures.push(`${label}: copy button wrapped ${JSON.stringify(report.wrappedButtons)}`);
		return report;
	};

	for (const [width, height, mobile] of [
		[1280, 860, false],
		[390, 844, true],
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
			if (mobile) await checkPhone(`${screen} at ${width}px`);
		}
		// One inbox item per Fathom account problem, in plain words.
		await evaluate("location.hash = '#/inbox'");
		await until(`the inbox at ${width}px`, () => evaluate("document.querySelector('.row-title') !== null"));
		const fathomItems = await evaluate("[...document.querySelectorAll('.row-title')].map((el) => el.textContent)");
		const aa = fathomItems.filter((title) => /\baa\b/u.test(title));
		if (aa.length !== 1) failures.push(`inbox at ${width}px: ${aa.length} items for Fathom account aa ${JSON.stringify(aa)}`);
		if (await evaluate("document.body.innerText.includes('never_polled')"))
			failures.push(`inbox at ${width}px: shows the raw code never_polled`);
		// Each long command sits in a chip beside its copy button: the Fathom poll in the inbox detail and a task's source.
		await evaluate(`location.hash = '#/inbox/${encodeURIComponent("fathom:aa:stale")}'`);
		await until(`the Fathom detail at ${width}px`, () => evaluate("document.querySelector('.detail .command-row') !== null"));
		await wait(300);
		await check(`inbox detail at ${width}px`);
		if (mobile) await checkPhone(`inbox detail at ${width}px`);
		const buttons = await evaluate(
			"[...document.querySelectorAll('.detail .command-row > .icon-button')].map((el) => [el.textContent, Math.round(el.getBoundingClientRect().height)])",
		);
		if (buttons.length === 0 || buttons.some(([, height]) => height > 40))
			failures.push(`inbox detail at ${width}px: copy buttons ${JSON.stringify(buttons)}`);
		await evaluate("location.hash = '#/tasks/mine'");
		await until(`tasks at ${width}px`, () => evaluate("document.body.innerText.includes('Team lead deep dive')"));
		await evaluate("[...document.querySelectorAll('button.link-button')].find((el) => el.textContent.startsWith('Team lead deep dive')).click()");
		await until(`the task detail at ${width}px`, () => evaluate("document.querySelector('.screen .command-row') !== null"));
		await wait(300);
		await check(`task detail at ${width}px`);
		if (mobile) await checkPhone(`task detail at ${width}px`);

		if (mobile) {
			const bar = await evaluate("getComputedStyle(document.querySelector('.bottom-bar')).display");
			if (bar === "none") failures.push("phone width: the bottom bar is hidden");
			const rail = await evaluate("getComputedStyle(document.querySelector('.rail')).display");
			if (rail !== "none") failures.push("phone width: the rail is still shown");
		}
	}
	const fonts = await evaluate("document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))");
	if (!fonts.some((family) => family.includes("IBM Plex Sans"))) failures.push(`self-hosted fonts did not load: ${JSON.stringify(fonts)}`);
	// The hostile brief text renders on Today, as text.
	await evaluate("location.hash = '#/today'");
	await until("the brief", () => evaluate("document.body.innerText.includes('Settle the plan')"));
	const hostile = await evaluate(
		"document.body.innerText.includes('<script>alert(1)</script>') && document.querySelectorAll('main img, main script, main style').length === 0 && document.querySelector('a[href^=\"javascript:\"]') === null",
	);
	if (!hostile) failures.push("hostile brief text was not shown as text");

	for (const event of events) {
		if (event.method === "Runtime.exceptionThrown")
			failures.push(`uncaught exception: ${event.params.exceptionDetails?.exception?.description ?? event.params.exceptionDetails?.text}`);
		if (event.method === "Log.entryAdded" && event.params.entry.level === "error")
			failures.push(`console error: ${event.params.entry.text} ${event.params.entry.url ?? ""}`);
		if (event.method === "Network.responseReceived" && event.params.response.status >= 400)
			failures.push(`request failed: ${event.params.response.status} ${event.params.response.url}`);
		if (event.method === "Network.loadingFailed" && !event.params.canceled)
			failures.push(`request failed: ${event.params.errorText} (${event.params.type})`);
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
process.stdout.write(
	"Harnessy app browser smoke passed: no CSP violation, console error or failed request, no <style> element, no overflow at 390 px.\n",
);
