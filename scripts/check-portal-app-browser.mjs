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
 * items for one Fathom account. At 1280 px it fails unless inbox rows are 40 px,
 * and 32 px after the density toggle.
 *
 * It refuses to run outside CI unless HARNESSY_BROWSER_SMOKE=1 is set, so it
 * never opens a browser on a developer machine by accident. The browser runs
 * headless with a throwaway profile; the portal runs with a temporary HOME and
 * PI_AUTH_ENCRYPTION=off and HSY_AUTH_ENCRYPTION=off, so no keychain, live service or real state is touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const portalCli = join(repoRoot, "packages/harnessy-local-host/dist/portal-cli.js");
const SCREENS = ["inbox", "today", "tasks", "jobs", "reviews", "learning", "connections", "links"];
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
let reviewFixture;

const childEnv = {
	HOME: home,
	PATH: process.env.PATH,
	USER: "owner",
	// Never reach an OS keychain from the smoke.
	PI_AUTH_ENCRYPTION: "off", HSY_AUTH_ENCRYPTION: "off",
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
	await writeFile(join(home, ".jarvis", "config.yaml"), "fathom:\n  default_account: aa\n  poll_accounts: [aa]\n  accounts:\n    aa: {}\n");
	const fathomState = join(home, ".harnessy", "jarvis", "state", "fathom");
	await mkdir(fathomState, { recursive: true, mode: 0o700 });
	await writeFile(join(fathomState, "poll-state-v2.json"), '{"version":1,"accounts":{}}\n', { mode: 0o600 });
	const weeklyDirectories = new Map();
	const failedDirectory = join(home, ".harnessy/jarvis/life/reviews", `weekly-2026-W44-${"c".repeat(64)}`);
	await mkdir(failedDirectory, {recursive:true});
	await writeFile(join(failedDirectory,"outcome.json"),JSON.stringify({status:"failed",phase:"generation",errors:["Codex login could not be renewed safely."],rawDraftPreserved:false,recordedAt:"2026-10-25T17:49:52Z"}));
	for (const [period, hash] of [["2026-W39", "a".repeat(64)], ["2026-W40", "b".repeat(64)]]) {
		const directory = join(home, ".harnessy/jarvis/life/reviews", `weekly-${period}-${hash}`);
		await mkdir(directory, {recursive:true});
		await writeFile(join(directory, "draft.md"), `# ${period}\n\nSynthetic weekly plan.\n`);
		weeklyDirectories.set(period, directory);
	}

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
			"--use-mock-keychain",
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
			for (const el of document.querySelectorAll('.app *, .quick-actions-panel, .quick-actions-panel *')) {
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
					.filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
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
		await page("Emulation.setTouchEmulationEnabled", { enabled: mobile });
		await page("Page.navigate", { url: width === 1280 ? signInUrl : `http://127.0.0.1:${port}/#/inbox` });
		await until("the app shell", () => evaluate("document.querySelector('.app') !== null"));
		if (mobile && !await evaluate("matchMedia('(pointer: coarse)').matches")) failures.push("phone emulation has no coarse pointer");
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
		if (!mobile) {
			// Inbox rows are 40 px, or 32 px in compact density (spec §2.5); the toggle is in the top bar.
			const rowHeights = () => evaluate("[...document.querySelectorAll('.list .row')].map((el) => Math.round(el.getBoundingClientRect().height))");
			const comfortable = await rowHeights();
			if (comfortable.length === 0 || comfortable.some((height) => height !== 40))
				failures.push(`inbox rows at ${width}px are not 40 px: ${JSON.stringify(comfortable)}`);
			await evaluate(`document.querySelector('button[aria-label="Compact rows"]').click()`);
			await wait(100);
			const compact = await rowHeights();
			if (compact.length === 0 || compact.some((height) => height !== 32))
				failures.push(`compact inbox rows at ${width}px are not 32 px: ${JSON.stringify(compact)}`);
			await evaluate(`document.querySelector('button[aria-label="Compact rows"]').click()`);
		}
		// Each long command sits in a chip beside its copy button: the Fathom poll in the inbox detail and a task's source.
		await evaluate(`location.hash = '#/inbox/${encodeURIComponent("fathom:aa:stale")}'`);
		await until(`the Fathom detail at ${width}px`, () => evaluate("document.querySelector('.detail .command-row') !== null"));
		await wait(300);
		await check(`inbox detail at ${width}px`);
		if (mobile) await checkPhone(`inbox detail at ${width}px`);
		await evaluate("[...document.querySelectorAll('.detail button')].find(el => el.textContent.trim() === 'Ask an agent').click()");
		await until("Inbox agent context", () => evaluate("document.querySelector('.quick-actions-panel')?.textContent.includes('fathom:aa:stale')"));
		if (!await evaluate("[...document.querySelectorAll('.quick-actions-panel select')].some(el => !el.required && el.selectedOptions[0]?.textContent.includes('Workspace task'))")) failures.push("workspace launch requires project");
		await check(`Inbox agent drawer at ${width}px`);
		if (mobile) {
			await checkPhone("Inbox agent drawer");
			const smallControls = await evaluate("[...document.querySelectorAll('.quick-actions-panel button, .quick-actions-panel input, .quick-actions-panel select, .quick-actions-panel textarea')].filter(el => { const r=el.getBoundingClientRect(); return r.width > 0 && (r.width < 44 || r.height < 44); }).map(el => el.outerHTML.slice(0,120))");
			if (smallControls.length) failures.push(`drawer controls below 44px: ${JSON.stringify(smallControls)}`);
		}
		await evaluate("document.querySelector('.quick-actions-panel button[aria-label^=Close]').click()");
		// Organise alerts through the browser. No source decisions or real provider writes.
		await evaluate("location.hash = '#/inbox'");
		await wait(100);
		await evaluate("document.querySelector('.inbox-row-menu summary').click()");
		await check(`Inbox row menu at ${width}px`);
		if (mobile) await checkPhone("Inbox row menu");
		if (!await evaluate("[...document.querySelectorAll('.inbox-row-menu[open] button')].every(el => { const r=el.getBoundingClientRect(); const x=r.x+r.width/2,y=r.y+r.height/2; return y>innerHeight || y<0 || document.elementFromPoint(x,y)?.closest('button')===el; })")) failures.push("Inbox menu control is covered by another view");
		await evaluate("document.querySelector('.inbox-row-menu').open = false; document.querySelector('input[aria-label=\"Select all visible items\"]').click()");
		await evaluate("[...document.querySelectorAll('.inbox-toolbar button')].find(el => el.textContent === 'Archive selected').click()");
		await until("archive saved", () => evaluate("!document.querySelector('.inbox-list-item') && document.querySelector('.copy-notice')?.textContent.includes('archived')"));
		await evaluate("[...document.querySelectorAll('.inbox-toolbar button')].find(el => el.textContent === 'Archived').click()");
		await until("archived alerts", () => evaluate("document.querySelectorAll('.inbox-list-item').length > 0"));
		await evaluate("document.querySelector('input[aria-label=\"Select all visible items\"]').click()");
		await evaluate("[...document.querySelectorAll('.inbox-toolbar button')].find(el => el.textContent === 'Move selected to Inbox').click()");
		await until("restore saved", () => evaluate("!document.querySelector('.inbox-list-item') && document.querySelector('.copy-notice')?.textContent.includes('moved to Inbox')"));
		await evaluate("[...document.querySelectorAll('.inbox-toolbar button')].find(el => el.textContent === 'Inbox').click()");
		await until("restored alerts", () => evaluate("document.querySelectorAll('.inbox-list-item').length > 0"));
		await evaluate(`location.hash = '#/inbox/${encodeURIComponent("fathom:aa:stale")}'`);
		await until("restored detail", () => evaluate("document.querySelector('.detail .command-row') !== null"));
		const buttons = await evaluate(
			"[...document.querySelectorAll('.detail .command-row > .icon-button')].map((el) => [el.textContent, Math.round(el.getBoundingClientRect().height)])",
		);
		if (buttons.length === 0 || buttons.some(([, height]) => mobile ? height < 44 : height > 40))
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
	// Exercise the real Links API and disk store through the rendered explorer.
	// All mutations stay in this script's disposable state directory.
	for (const width of [1280, 390]) {
		await page("Emulation.setDeviceMetricsOverride", {width, height:844, deviceScaleFactor:1, mobile:width===390});
		await evaluate("location.hash = '#/links'");
		await until("Links explorer", () => evaluate("document.querySelector('button[aria-label=\"New link or folder\"]') !== null"));
		const clickLabel = (label) => evaluate(`[...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === ${JSON.stringify(label)} || el.textContent.trim() === ${JSON.stringify(label)}).click()`);
		const fill = async (selector, value) => {
			await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
			await page("Input.insertText", {text:value});
		};
		const submitLinkDialog = () => evaluate("document.querySelector('.link-dialog form').requestSubmit()");
		const folder = `Browser folder ${width}`;
		const renamed = `Renamed folder ${width}`;
		const title = `Browser link ${width}`;
		await clickLabel("New link or folder");
		await clickLabel("Folder…");
		await fill("#link-name", folder);
		await check(`Links folder dialog at ${width}px`);
		if (width === 390) await checkPhone("Links folder dialog");
		await submitLinkDialog();
		await until("saved folder", () => evaluate(`document.body.innerText.includes(${JSON.stringify(folder)}) && !document.querySelector('.link-dialog')`));
		await evaluate(`[...document.querySelectorAll('.link-folder-name')].find(el => el.textContent === ${JSON.stringify(folder)}).closest('button').click()`);
		await clickLabel("New link or folder");
		await clickLabel("Link…");
		await fill("#link-url", "https://example.test/fixture");
		await fill("#link-title", title);
		await submitLinkDialog();
		await until("saved link", () => evaluate(`document.body.innerText.includes(${JSON.stringify(title)}) && !document.querySelector('.link-dialog')`));
		const safe = await evaluate(`(() => {const a=[...document.querySelectorAll('a.link-title')].find(el=>el.textContent.includes(${JSON.stringify(title)}));return a?.target === '_blank' && a.rel === 'noopener noreferrer';})()`);
		if (!safe) failures.push(`Links at ${width}px lost safe external navigation`);
		await clickLabel(`Actions for ${folder}`);
		await clickLabel("Rename");
		await evaluate("document.querySelector('#link-name').select()");
		await page("Input.insertText", {text:renamed});
		await submitLinkDialog();
		await until("renamed folder", () => evaluate(`document.body.innerText.includes(${JSON.stringify(renamed)}) && !document.querySelector('.link-dialog')`));
		await page("Page.reload");
		await until("Links survives reload", () => evaluate(`[...document.querySelectorAll('.link-folder-name')].some(el => el.textContent === ${JSON.stringify(renamed)}) && [...document.querySelectorAll('a.link-title')].some(el => el.textContent.includes(${JSON.stringify(title)}))`));
		await check(`Links saved tree at ${width}px`);
		if (width === 390) await checkPhone("Links saved tree");
		const saved = JSON.parse(await readFile(join(stateDir,"links.json"),"utf8"));
		const savedFolder = saved.folders.find(entry => entry.name === renamed);
		if (saved.version !== 2 || !savedFolder || !saved.links.some(entry => entry.title === title && entry.parentId === savedFolder.id)) failures.push("Links tree not saved as version 2");
		await clickLabel(`Actions for ${renamed}`);
		await clickLabel("Remove");
		await evaluate("document.querySelector('.link-row .button-danger').click()");
		await until("folder and contents removed", () => evaluate(`![...document.querySelectorAll('.link-folder-name')].some(el => el.textContent === ${JSON.stringify(renamed)}) && ![...document.querySelectorAll('a.link-title')].some(el => el.textContent.includes(${JSON.stringify(title)}))`));
	}
	const fonts = await evaluate("document.fonts.ready.then(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))");
	await evaluate(`location.hash = '#/today/draft/${"c".repeat(64)}'`);
	await until("failed run actions", () => evaluate("document.body.textContent.includes('Close failed attempt')"));
	await until("failure explanation", () => evaluate("document.body.textContent.includes('could not renew its sign-in')"));
	await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Investigate with an agent').click()");
	await until("agent context", () => evaluate("document.querySelector('[role=dialog]')?.textContent.includes('Codex login could not be renewed safely.')"));
	await evaluate("document.querySelector('[role=dialog] button[aria-label^=Close]').click()");
	await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent==='Close failed attempt').click()");
	await until("failure close reason", () => evaluate("document.activeElement?.id === 'weekly-close-reason'"));
	await page("Input.insertText", {text:"Past week; no longer needed."});
	await checkPhone("failed weekly actions");
	await evaluate("document.querySelector('.weekly-review button[type=submit]').click()");
	await until("failed attempt closed", () => evaluate("document.querySelector('.weekly-review output') !== null"));
	const closedFailure=JSON.parse(await readFile(join(failedDirectory,"reconciliation.json"),"utf8"));
	if(closedFailure.decision!=="abandoned") failures.push("failed run was not abandoned");
	if(!existsSync(join(failedDirectory,"outcome.json"))) failures.push("failure evidence deleted");
	// Real browser actions: Inbox -> draft -> cancel -> reason -> confirmation -> cleared Inbox.
	for (const [width, period] of [[1280, "2026-W39"], [390, "2026-W40"]]) {
		await page("Emulation.setDeviceMetricsOverride", {width, height:844, deviceScaleFactor:1, mobile:width===390});
		await page("Emulation.setTouchEmulationEnabled", {enabled:width===390});
		await evaluate(`location.hash = '#/inbox/${encodeURIComponent(`life-weekly:${period}:draft`)}'`);
		await until("weekly review action", () => evaluate("[...document.querySelectorAll('.detail button, .detail a')].some(el => el.textContent.trim()==='Review draft')"));
		await evaluate("[...document.querySelectorAll('.detail button, .detail a')].find(el => el.textContent.trim()==='Review draft').click()");
		await until("weekly draft", () => evaluate("document.querySelector('.weekly-review button:not(:disabled)') !== null"));
		await evaluate("document.querySelector('.weekly-review button').click()");
		await until("close form", () => evaluate("document.querySelector('#weekly-close-reason') !== null"));
		if (!await evaluate("document.querySelector('.weekly-review button[type=submit]').disabled")) failures.push("empty reason enabled close");
		await evaluate("[...document.querySelectorAll('.weekly-review button')].find(el=>el.textContent==='Cancel').click()");
		if (existsSync(join(weeklyDirectories.get(period), "reconciliation.json"))) failures.push("Cancel wrote a decision");
		await evaluate("document.querySelector('.weekly-review button').click()");
		await until("reason focus", () => evaluate("document.activeElement?.id === 'weekly-close-reason'"));
		await page("Input.insertText", {text:"The week has passed."});
		await check(`weekly close at ${width}px`);
		if(width===390) await checkPhone("weekly close phone");
		await evaluate("document.querySelector('.weekly-review button[type=submit]').click()");
		await until("draft closed", () => evaluate("document.querySelector('.weekly-review output')?.textContent.includes('draft is closed')"));
		const record = JSON.parse(await readFile(join(weeklyDirectories.get(period), "reconciliation.json"), "utf8"));
		if(record.decision!=="superseded" || record.reason!=="The week has passed.") failures.push("wrong weekly decision");
		if(!existsSync(join(weeklyDirectories.get(period), "draft.md"))) failures.push("draft deleted");
		await evaluate("document.querySelector('.weekly-review .back-link').click()");
		await until("return to Inbox", () => evaluate("location.hash === '#/inbox'"));
		await until("closed draft removed from Inbox", () => evaluate(`document.querySelector('.list') !== null && !document.querySelector('.list').textContent.includes(${JSON.stringify(period)})`));
	}
	if (!fonts.some((family) => family.includes("IBM Plex Sans"))) failures.push(`self-hosted fonts did not load: ${JSON.stringify(fonts)}`);
	// The hostile brief text renders on Today, as text.
	await evaluate("location.hash = '#/today'");
	await until("the brief", () => evaluate("document.body.innerText.includes('Settle the plan')"));
	const hostile = await evaluate(
		"document.body.innerText.includes('<script>alert(1)</script>') && document.querySelectorAll('main img, main script, main style').length === 0 && document.querySelector('a[href^=\"javascript:\"]') === null",
	);
	if (!hostile) failures.push("hostile brief text was not shown as text");

	// Exercise the real app's handoff button and browser history. Only the opener
	// response and review service are fixtures; no installed service or provider runs.
	const portalOrigin = `http://127.0.0.1:${port}`;
	let redeemed = false;
	let exchangeCount = 0;
	reviewFixture = createServer((request, response) => {
		if (request.url === "/favicon.ico") { response.writeHead(204).end(); return; }
		if (request.url.startsWith("/exchange?")) {
			exchangeCount++;
			if (redeemed) { response.writeHead(403).end("Code already consumed"); return; }
			redeemed = true;
			response.writeHead(200, {"Content-Type":"text/html", "Cache-Control":"no-store"});
			response.end('<!doctype html><meta http-equiv="refresh" content="0;url=/"><title>Signing in</title>');
			return;
		}
		response.writeHead(redeemed ? 200 : 401, {"Content-Type":"text/html"});
		response.end(`<!doctype html><title>Meeting review fixture</title><main><h1>Meeting review fixture</h1><a id="cockpit-breadcrumb" href="${portalOrigin}/#/reviews/meetings">Harnessy cockpit</a></main>`);
	});
	await new Promise(resolve => reviewFixture.listen(0, "127.0.0.1", resolve));
	const reviewOrigin = `http://127.0.0.1:${reviewFixture.address().port}`;
	const intercept = async (message) => {
		const event = JSON.parse(String(message.data));
		if (event.method !== "Fetch.requestPaused" || event.sessionId !== sessionId) return;
		try {
			const {requestId, request} = event.params;
			const opener = request.url.endsWith("/v1/open/meeting-review");
			if (opener && (request.method !== "POST" || request.headers.Origin !== portalOrigin))
				failures.push("meeting handoff did not use a same-origin browser POST");
			const body = opener ? {opened:true, url:`${reviewOrigin}/exchange?code=${"a".repeat(43)}&portal=${encodeURIComponent(portalOrigin)}`} :
				{tiles:{config:{state:"ok",data:{reviewHost:"127.0.0.1",reviewPort:reviewFixture.address().port}}}};
			await page("Fetch.fulfillRequest", {requestId,responseCode:200,responseHeaders:[{name:"Content-Type",value:"application/json"}],body:Buffer.from(JSON.stringify(body)).toString("base64")});
		} catch (error) { failures.push(`meeting handoff fixture: ${error.message}`); }
	};
	socket.addEventListener("message", intercept);
	await page("Fetch.enable", {patterns:[{urlPattern:`${portalOrigin}/v1/open/meeting-review`},{urlPattern:`${portalOrigin}/v1/meetings/summary`}]});
	for (const width of [1280, 390]) {
		redeemed = false;
		const exchangesBefore = exchangeCount;
		await page("Emulation.setDeviceMetricsOverride", {width,height:844,deviceScaleFactor:1,mobile:width===390});
		await page("Page.navigate", {url:`${portalOrigin}/#/reviews/meetings`});
		await until("meeting handoff button", () => evaluate("[...document.querySelectorAll('button')].some(el=>el.textContent.startsWith('Open meeting review'))"));
		const targetsBefore = (await send("Target.getTargets")).targetInfos.filter(target=>target.type==='page').length;
		const point = await evaluate("(() => {const el=[...document.querySelectorAll('button')].find(el=>el.textContent.startsWith('Open meeting review'));el.scrollIntoView();const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
		await page("Input.dispatchMouseEvent", {type:"mousePressed",...point,button:"left",clickCount:1});
		await page("Input.dispatchMouseEvent", {type:"mouseReleased",...point,button:"left",clickCount:1});
		await until("same-tab review", () => evaluate(`location.origin===${JSON.stringify(reviewOrigin)} && location.pathname==='/' && !!document.querySelector('#cockpit-breadcrumb')`));
		await evaluate("history.back()");
		await until("Back from review to cockpit", () => evaluate(`location.origin===${JSON.stringify(portalOrigin)} && location.hash==='#/reviews/meetings' && !!document.querySelector('.app')`));
		await evaluate("history.forward()");
		await until("Forward to review without code replay", () => evaluate(`location.origin===${JSON.stringify(reviewOrigin)} && location.pathname==='/' && !!document.querySelector('#cockpit-breadcrumb')`));
		await evaluate("document.querySelector('#cockpit-breadcrumb').click()");
		await until("cockpit breadcrumb return", () => evaluate(`location.origin===${JSON.stringify(portalOrigin)} && location.hash==='#/reviews/meetings' && !!document.querySelector('.app')`));
		await evaluate("history.back()");
		await until("Back to review", () => evaluate(`location.origin===${JSON.stringify(reviewOrigin)} && location.pathname==='/' && !!document.querySelector('#cockpit-breadcrumb')`));
		await evaluate("history.forward()");
		await until("Forward to cockpit", () => evaluate(`location.origin===${JSON.stringify(portalOrigin)} && !!document.querySelector('.app')`));
		const targetsAfter = (await send("Target.getTargets")).targetInfos.filter(target=>target.type==='page').length;
		if(targetsAfter!==targetsBefore) failures.push(`meeting handoff at ${width}px opened a new tab`);
		if(exchangeCount!==exchangesBefore+1) failures.push(`meeting handoff at ${width}px replayed a consumed code`);
	}
	await page("Fetch.disable");
	socket.removeEventListener("message", intercept);

	// A saved task can be read even when its process can no longer be attached.
	// Replace only the terminal HTTP boundary; never start a real shell or agent.
	await evaluate(`(() => {
		const original = window.fetch.bind(window);
		window.__recovery = { state: 'interrupted', actions: [], resumed: false };
		window.fetch = async (path, init) => {
			const fixture = window.__recovery;
			const json = (body, status=200) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json'}});
			if (path === '/v1/terminal/sessions') return json({cwd:'/fixture', persistent:true, sessions:[{id:'saved-task',title:'Saved interrupted task',state:fixture.state}]});
			if (String(path).startsWith('/v1/terminal/output/')) return json({data:'',cursor:0,endCursor:0,truncated:false,state:fixture.state});
			if (path === '/v1/terminal/action') {
				const body = JSON.parse(init.body); fixture.actions.push(body);
				if (body.action === 'resume') {fixture.state='running';fixture.resumed=true;return json({id:'saved-task'});}
				if (body.action === 'attach' || body.action === 'takeover') return fixture.resumed ? json({controlling:true}) : json({error:'terminal_backend_failed'},409);
				return json({ok:true});
			}
			return original(path,init);
		};
	})()`);
	await evaluate("location.hash='#/terminal/saved-task'");
	await until("saved task attachment refusal", () => evaluate("document.querySelector('.terminal-screen [role=alert]') !== null"));
	const recovery = await evaluate("({status:document.querySelector('.terminal-status')?.textContent, resume:[...document.querySelectorAll('button')].some(el=>el.textContent==='Resume saved conversation')})");
	if (!recovery.resume || !recovery.status.includes('interrupted')) failures.push(`saved task recovery missing after refused attachment: ${JSON.stringify(recovery)}`);
	else {
		const point = await evaluate("(() => {const el=[...document.querySelectorAll('button')].find(el=>el.textContent==='Resume saved conversation');el.scrollIntoView();const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
		await page("Input.dispatchMouseEvent", {type:"mousePressed",...point,button:"left",clickCount:1});
		await page("Input.dispatchMouseEvent", {type:"mouseReleased",...point,button:"left",clickCount:1});
		await until("saved task resumed and attached", () => evaluate("document.querySelector('.terminal-status')?.textContent.includes('runningThis view controls input.')"));
		const actions = await evaluate("window.__recovery.actions.map(body=>body.action)");
		if (actions.filter(action=>action==='resume').length!==1 || actions.some(action=>['input','create','close'].includes(action))) failures.push(`unexpected recovery actions: ${JSON.stringify(actions)}`);
	}

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
	reviewFixture?.closeAllConnections();
	reviewFixture?.close();
	for (const child of children) child.kill("SIGKILL");
	await wait(200);
	await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
	process.stderr.write(`Harnessy app browser smoke failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`);
	process.exit(1);
}
process.stdout.write(
	"Harnessy app browser smoke passed: no CSP violation, console error or failed request, no <style> element, no overflow at 390 px, same-tab meeting review and browser history passed.\n",
);
