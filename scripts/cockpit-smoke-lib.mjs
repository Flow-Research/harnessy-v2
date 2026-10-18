import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The sign-in target behind the argument the CLI handed the browser opener.
 * The argument must be a `file:` URL of an owner-only page inside
 * `server-control/` and must itself carry no secret; the page redirects to the
 * cockpit with the one-time code.
 */
export const signInTargetFromOpenerArg = (arg, controlDir, secrets = []) => {
	if (arg.includes("_code") || arg.includes("_token")) {
		throw new Error("Harnessy passed a sign-in credential in the browser opener's argv.");
	}
	assertNoSecretsInOutput(arg, secrets, "Harnessy passed a secret in the browser opener's argv.");
	const url = new URL(arg);
	if (url.protocol !== "file:") throw new Error("Harnessy did not open the cockpit through a sign-in page.");
	const page = fileURLToPath(url);
	if (canonicalFilesystemPath(dirname(page)) !== canonicalFilesystemPath(controlDir)) {
		throw new Error("The sign-in page is outside the owner-only server-control directory.");
	}
	if (process.platform !== "win32" && (statSync(page).mode & 0o777) !== 0o600) {
		throw new Error("The sign-in page is not owner-only (0600).");
	}
	const match = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(readFileSync(page, "utf8"));
	if (match === null) throw new Error("The sign-in page has no redirect.");
	return match[1].replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
};
