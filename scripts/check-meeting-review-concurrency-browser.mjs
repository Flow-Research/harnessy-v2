/** Native review submission while the fixture holds another publication in a fake provider.
 * Only the isolated fixture origin is allowed. No credentials or external writes.
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
	let mainFrameNavigations = 0;
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
					// Exercise submission over a slow connection, rather than accepting the old inbox.
					if (request.method === "POST") await wait(250);
					if (request.method === "POST")
						posts.push({
							path: url.pathname,
							origin: request.headers.Origin ?? request.headers.origin,
						});
					await send("Fetch.continueRequest", { requestId }, event.sessionId);

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
		if (event.method === "Page.frameNavigated" && !event.params.frame.parentId)
			mainFrameNavigations++;
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
	await until("inbox", () => evaluate(`!!document.querySelector('h1') && location.pathname === '/'`));
	const itemId = process.argv[3], action = process.argv[4];
	if (!/^[a-f0-9]{24}$/.test(itemId ?? "") || !["approve", "reject", "archive", "generate-google-doc"].includes(action)) throw Error("Invalid fixture action");
	if (process.argv[5] !== "inbox") await page("Page.navigate", { url: `${origin}/item/${itemId}` });
	else {
		if (!(await evaluate(`!!document.querySelector('details.quick-accept:not([open]) form[action="/approve/${itemId}"]')`))) throw Error("Inbox approval must require expanded confirmation");
		if (action === "approve") await evaluate(`document.querySelector('details.quick-accept summary').click()`);
		if (action === "reject") await evaluate(`document.querySelector('details.quick-reject summary').click()`);
	}
	await until("review form", () => evaluate(`!!document.querySelector('form[action="/${action}/${itemId}"]')`));
	const beforeSubmission = mainFrameNavigations;
	await evaluate(`document.querySelector('form[action="/${action}/${itemId}"] button').click()`);
	await until("decision recorded", async () => {
		if (failures.length) throw Error(failures.join(", "));
		if (posts.length !== 1 || mainFrameNavigations <= beforeSubmission) return false;
		return action === "generate-google-doc"
			? evaluate(`document.querySelector('h1')?.textContent === 'Google Doc ready' && !!document.querySelector('a[target="_blank"][rel="noopener noreferrer"]')`)
			: evaluate(`location.pathname === '/' && !!document.querySelector('#google-connection-title')`);
	});
	if (posts.length !== 1 || posts[0].origin !== origin || failures.length) throw Error("Native review submission failed");
	console.log("Browser concurrent review passed");
} finally {
	socket?.close();
	browser.kill("SIGKILL");
	await new Promise((resolve) => browser.exitCode !== null ? resolve() : browser.once("exit", resolve));
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
