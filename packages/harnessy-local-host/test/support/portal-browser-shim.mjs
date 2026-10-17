// A minimal browser window for the portal page end-to-end test.
//
//   node --import ./portal-browser-shim.mjs <dir>/app.js
//
// The page scripts in <dir> are the exact bytes the portal served. This shim
// gives them a recording document, a location hash, history.replaceState,
// sessionStorage and a fetch that talks to the real portal over loopback HTTP
// and adds the Origin and Sec-Fetch-Site headers a browser adds. Cookies are
// never sent. It then walks the three pages and prints one JSON line:
//   {"pages":{"today":…,"health":…,"connections":…},"requests":[…],"hashAfterSignIn":…,"stored":…}
//
// PORTAL_ORIGIN is the portal origin; PORTAL_HASH is the starting hash (for example "#code=…").
import { RecordingDocument } from "./portal-dom.ts";

const origin = process.env.PORTAL_ORIGIN;
if (!origin) throw new Error("PORTAL_ORIGIN is required");
const document = new RecordingDocument();
const main = document.getElementById("main");
const location = { hash: process.env.PORTAL_HASH ?? "" };
const storage = new Map();
const listeners = [];
const requests = [];

globalThis.document = document;
globalThis.location = location;
globalThis.history = {
	replaceState: (_state, _unused, url) => {
		location.hash = new URL(url, origin).hash;
	},
};
globalThis.sessionStorage = {
	getItem: (key) => storage.get(key) ?? null,
	setItem: (key, value) => storage.set(key, String(value)),
	removeItem: (key) => storage.delete(key),
};
const realFetch = globalThis.fetch;
globalThis.fetch = (path, init) => {
	const headers = { ...init.headers, "Sec-Fetch-Site": "same-origin" };
	if (init.method === "POST") headers.Origin = origin;
	requests.push({ method: init.method, path, credentials: init.credentials, headers: Object.keys(headers).sort() });
	return realFetch(new URL(path, origin), { ...init, headers });
};
globalThis.addEventListener = (type, listener) => {
	if (type === "hashchange") listeners.push(listener);
};

const settled = async (count) => {
	const deadline = Date.now() + 10_000;
	while (main.replaced < count) {
		if (Date.now() > deadline) throw new Error(`page did not render ${count} times`);
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
};

const snapshot = () => ({
	title: document.getElementById("page-title").textContent,
	text: main.textContent,
	outline: main.outline(),
	links: main
		.all()
		.filter((element) => element.tag === "a")
		.map((element) => element.attributes.get("href") ?? null),
	attributes: [...new Set(main.all().flatMap((element) => [...element.attributes.keys()]))].sort(),
});

// The page module runs after this shim; wait for its first render, then visit the other pages.
setTimeout(async () => {
	try {
		await settled(1);
		const hashAfterSignIn = location.hash;
		const pages = { today: snapshot() };
		for (const [index, route] of ["health", "connections"].entries()) {
			location.hash = `#/${route}`;
			for (const listener of listeners) listener();
			await settled(index + 2);
			pages[route] = snapshot();
		}
		process.stdout.write(`${JSON.stringify({ pages, requests, hashAfterSignIn, stored: [...storage.keys()] })}\n`);
		process.exit(0);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
		process.exit(1);
	}
}, 0);
