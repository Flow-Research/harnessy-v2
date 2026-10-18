import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const canonicalFilesystemPath = (path) => {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return resolve(path);
		throw error;
	}
};

export const assertIsolatedRuntimeScope = ({ manifest, expectedDataDir, expectedScopeDir, message }) => {
	if (
		canonicalFilesystemPath(manifest.dataDir) !== canonicalFilesystemPath(expectedDataDir) ||
		canonicalFilesystemPath(manifest.scopeDir) !== canonicalFilesystemPath(expectedScopeDir)
	) {
		throw new Error(message);
	}
};

/** Fail when any secret appears in captured command output (stdout, stderr or logs). */
export const assertNoSecretsInOutput = (output, secrets, message) => {
	for (const secret of secrets) {
		if (typeof secret === "string" && secret !== "" && output.includes(secret)) throw new Error(message);
	}
};

/**
 * The single-use sign-in code from the URL the CLI handed the browser opener.
 * It must be the cockpit origin with the code in the fragment, which browsers
 * never send to a server, and no `_token` anywhere.
 */
export const signInCodeFromBrowserUrl = (url, origin) => {
	const parsed = new URL(url);
	const code = new URLSearchParams(parsed.hash.slice(1)).get("_code");
	if (
		parsed.origin !== origin ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		url.includes("_token") ||
		code === null ||
		!/^[A-Za-z0-9_-]{43}$/.test(code)
	) {
		throw new Error("Harnessy did not open the cockpit with a one-time sign-in code.");
	}
	return code;
};

const REQUIRED_CSP = {
	"default-src": ["'self'"],
	"script-src": ["'self'"],
	"connect-src": ["'self'"],
	"object-src": ["'none'"],
	"base-uri": ["'none'"],
	"frame-ancestors": ["'none'"],
};

/** Require the strict cockpit Content-Security-Policy: no inline or eval script. */
export const assertStrictCockpitCsp = (policy) => {
	if (typeof policy !== "string" || policy === "") throw new Error("Cockpit HTML has no Content-Security-Policy.");
	const directives = new Map(
		policy
			.split(";")
			.map((directive) => directive.trim().split(/\s+/))
			.filter(([name]) => name !== "")
			.map(([name, ...values]) => [name, values]),
	);
	for (const [name, expected] of Object.entries(REQUIRED_CSP)) {
		const actual = directives.get(name);
		if (actual === undefined || actual.join(" ") !== expected.join(" ")) {
			throw new Error(`Cockpit Content-Security-Policy ${name} must be ${expected.join(" ")}.`);
		}
	}
	if (/'unsafe-eval'|'wasm-unsafe-eval'/.test(policy)) {
		throw new Error("Cockpit Content-Security-Policy must not allow eval.");
	}
};
