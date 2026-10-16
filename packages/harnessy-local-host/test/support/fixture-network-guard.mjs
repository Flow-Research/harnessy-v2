// Test-process boundary: fixture provider traffic may only reach literal loopback.
// This is intentionally not shipped in the production package.
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const denied = () => Object.assign(new Error("Fixture external network access denied"), { code: "FIXTURE_EGRESS_DENIED" });
const loopback = (host) => host === "127.0.0.1" || host === "::1" || host === "[::1]";
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...input) {
	// Node's net.connect normalizes arguments into an array before calling this method.
	const args = Array.isArray(input[0]) ? input[0] : input;
	const options = args[0];
	if (typeof options === "object" && options !== null) {
		if ((options.port !== undefined || options.path === undefined) && !loopback(options.host ?? options.hostname ?? "127.0.0.1")) throw denied();
	} else if (typeof options === "number" || (typeof options === "string" && /^\d+$/u.test(options))) {
		if (typeof args[1] === "string" && !loopback(args[1])) throw denied();
	} else if (typeof options !== "string") {
		throw denied();
	}
	return Reflect.apply(connect, this, input);
};
syncBuiltinESMExports();

const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = new URL(input instanceof Request ? input.url : input);
	if (!loopback(url.hostname)) return Promise.reject(denied());
	// Forbid redirect escapes even when the original request is loopback.
	return nativeFetch(input, { ...init, redirect: "manual" });
};
