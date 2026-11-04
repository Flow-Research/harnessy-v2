/** Real browser form regression. Called only by the isolated reconnect test.
 * All network requests are intercepted: only the fixture origin is allowed.
 * Google consent is a synthetic cross-site document, never a real account.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.HARNESSY_RECONNECT_BROWSER !== "1")
	throw Error("Run through the isolated reconnect test");
const target = new URL(process.argv[2]);
if (target.hostname !== "127.0.0.1" || target.pathname !== "/exchange")
	throw Error("Expected a loopback fixture");
const origin = target.origin;
const restarting = process.argv[3] === "restart";
const action = restarting ? "restart" : "start";
let chromePath = process.env.CHROME_PATH;
if (!chromePath && process.platform === "darwin")
	chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!chromePath)
	for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
		const found = spawnSync("which", [name], { encoding: "utf8" });
		if (found.status === 0) {
			chromePath = found.stdout.trim();
			break;
		}
	}
if (!chromePath || !existsSync(chromePath))
	throw Error("Chrome is required; set CHROME_PATH. This gate cannot skip.");
const root = await mkdtemp(join(tmpdir(), "meeting-reconnect-browser-"));
const browser = spawn(
	chromePath,
	[
		"--headless=new",
		"--remote-debugging-port=0",
		`--user-data-dir=${root}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-background-networking",
		"--use-mock-keychain",
		...(process.platform === "linux" ? ["--no-sandbox"] : []),
		"about:blank",
	],
	{ stdio: "ignore" },
);
let socket;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (label, check) => {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await wait(50);
	}
	throw Error(`Timed out: ${label}`);
};
try {
	const portFile = join(root, "DevToolsActivePort");
	await until("browser start", () => existsSync(portFile));
	const [port, path] = (await readFile(portFile, "utf8")).trim().split("\n");
	socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	let id = 0;
	const pending = new Map();
	const failures = [];
	const posts = [];
	let intercepted = 0;
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const key = ++id;
			pending.set(key, { resolve, reject });
			socket.send(
				JSON.stringify({
					id: key,
					method,
					params,
					...(sessionId ? { sessionId } : {}),
				}),
			);
		});
	socket.addEventListener("message", (message) => {
		const event = JSON.parse(String(message.data));
		if (event.id) {
			const task = pending.get(event.id);
			if (task) {
				pending.delete(event.id);
				event.error
					? task.reject(Error(event.error.message))
					: task.resolve(event.result);
			}
			return;
		}
		if (event.method === "Fetch.requestPaused") {
			const { request, requestId } = event.params;
			const url = new URL(request.url);
			const handle = async () => {
				if (url.origin === origin) {
					if (request.method === "POST")
						posts.push({
							path: url.pathname,
							origin: request.headers.Origin ?? request.headers.origin,
						});
					await send("Fetch.continueRequest", { requestId }, event.sessionId);
				} else if (
					url.origin === "https://accounts.google.com" &&
					url.pathname === "/favicon.ico"
				) {
					await send(
						"Fetch.fulfillRequest",
						{ requestId, responseCode: 204 },
						event.sessionId,
					);
				} else if (
					url.origin === "https://accounts.google.com" &&
					url.pathname === "/o/oauth2/v2/auth"
				) {
					intercepted++;
					const callback = `${origin}/google-reconnect/callback?state=fixture_reconnect_state_${restarting ? 2 : 1}&code=BROWSER_FIXTURE_CODE`;
					await send(
						"Fetch.fulfillRequest",
						{
							requestId,
							responseCode: 200,
							responseHeaders: [{ name: "Content-Type", value: "text/html" }],
							body: Buffer.from(
								`<html><body><a id="consent" href="${callback}">Allow fixture account</a></body></html>`,
							).toString("base64"),
						},
						event.sessionId,
					);
				} else {
					failures.push("Unexpected external request");
					await send(
						"Fetch.failRequest",
						{ requestId, errorReason: "BlockedByClient" },
						event.sessionId,
					);
				}
			};
			void handle().catch((e) => failures.push(e.message));
		}
		if (
			event.method === "Network.responseReceived" &&
			event.params.response.status >= 400 &&
			event.params.response.url !== origin + "/favicon.ico"
		)
			failures.push(
				`HTTP ${event.params.response.status} ${new URL(event.params.response.url).pathname}`,
			);
		if (event.method === "Runtime.exceptionThrown")
			failures.push("Browser JavaScript exception");
	});
	const { targetId } = await send("Target.createTarget", {
		url: "about:blank",
	});
	const { sessionId } = await send("Target.attachToTarget", {
		targetId,
		flatten: true,
	});
	const page = (method, params = {}) => send(method, params, sessionId);
	await page("Page.enable");
	await page("Runtime.enable");
	await page("Network.enable");
	await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
	const evaluate = async (expression) => {
		const value = await page("Runtime.evaluate", {
			expression,
			returnByValue: true,
		});
		if (value.exceptionDetails) throw Error("Browser evaluation failed");
		return value.result.value;
	};
	await page("Page.navigate", { url: target.href });
	await until("reconnect form", () =>
		evaluate(
			`!!document.querySelector('form[action="/google-reconnect/${action}"]')`,
		),
	);
	await evaluate(
		`document.querySelector('form[action="/google-reconnect/${action}"] button').click()`,
	);
	await until("Google consent (not Forbidden)", async () => {
		if (failures.length) throw Error(failures.join(", "));
		return evaluate(`!!document.querySelector('#consent')`);
	});
	await evaluate("document.querySelector('#consent').click()");
	await until("verification form", () =>
		evaluate(
			`!!document.querySelector('form[action="/google-reconnect/complete"]')`,
		),
	);
	await evaluate(
		`document.querySelector('form[action="/google-reconnect/complete"] button').click()`,
	);
	await until("verified result", () =>
		evaluate(
			`document.querySelector('h1')?.textContent === 'Google connected'`,
		),
	);
	await evaluate(`document.querySelector('a[href="/"]').click()`);
	await until("review inbox", () => evaluate(`!!document.querySelector('#google-connection-title')`));
	for (const width of [1440, 390, 320]) {
		await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
		const layout = await evaluate(`(() => {
			const status = document.querySelector('#google-connection-title').closest('section');
			const queue = document.querySelector('.queue-card, .empty-card');
			const a = status.getBoundingClientRect(), b = queue.getBoundingClientRect();
			return { aligned: Math.abs(a.x-b.x) < 1 && Math.abs(a.width-b.width) < 1,
				padded: parseFloat(getComputedStyle(status).paddingLeft) >= 16,
				fits: document.documentElement.scrollWidth <= innerWidth };
		})()`);
		if (!layout.aligned || !layout.padded || !layout.fits) throw Error(`Review layout at ${width}: ${JSON.stringify(layout)}`);
	}
	const itemId = process.argv[4];
	if (!/^[a-f0-9]{24}$/.test(itemId ?? "")) throw Error("Expected fixture item ID");
	await page("Page.navigate", { url: `${origin}/item/${itemId}` });
	await until("meeting note", () => evaluate(`!!document.querySelector('.canonical-markdown')`));
	for (const width of [1440, 390, 320]) {
		await page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
		if (!await evaluate(`document.documentElement.scrollWidth <= innerWidth`)) throw Error(`Meeting note overflows at ${width}`);
	}
	await evaluate(`document.querySelector('.back-link').click()`);
	await until("return to inbox", () => evaluate(`!!document.querySelector('#google-connection-title')`));
	if (
		intercepted !== 1 ||
		posts.length !== 2 ||
		posts.some((post) => post.origin !== origin) ||
		failures.length
	)
		throw Error(
			`Browser contract failed: ${JSON.stringify({ intercepted, posts, failures })}`,
		);
	console.log(
		"Browser reconnect passed: real start and verification forms, cross-site callback, exact Origin; no real Google request.",
	);
} finally {
	socket?.close();
	browser.kill("SIGKILL");
	await new Promise((resolve) =>
		browser.exitCode !== null ? resolve() : browser.once("exit", resolve),
	);
	await rm(root, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	});
}
