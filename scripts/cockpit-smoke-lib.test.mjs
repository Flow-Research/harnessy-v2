import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	assertIsolatedRuntimeScope,
	assertNoSecretsInOutput,
	assertStrictCockpitCsp,
	canonicalFilesystemPath,
	signInCodeFromBrowserUrl,
} from "./cockpit-smoke-lib.mjs";

describe("cockpit smoke isolation guard", () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-cockpit-guard-"));
	const dataDir = join(root, "data");
	const scopeDir = join(root, "scope");
	const dataAlias = join(root, "data-alias");
	const scopeAlias = join(root, "scope-alias");
	mkdirSync(dataDir);
	mkdirSync(scopeDir);
	symlinkSync(dataDir, dataAlias, "dir");
	symlinkSync(scopeDir, scopeAlias, "dir");

	after(() => rmSync(root, { recursive: true, force: true }));

	it("treats lexical aliases of the same filesystem paths as identical", () => {
		assert.equal(canonicalFilesystemPath(dataAlias), canonicalFilesystemPath(dataDir));
		assert.doesNotThrow(() =>
			assertIsolatedRuntimeScope({
				manifest: { dataDir: dataAlias, scopeDir: scopeAlias },
				expectedDataDir: dataDir,
				expectedScopeDir: scopeDir,
				message: "unexpected scope",
			}),
		);
	});

	it("still rejects a daemon outside the expected isolation boundary", () => {
		assert.throws(
			() =>
				assertIsolatedRuntimeScope({
					manifest: { dataDir, scopeDir: root },
					expectedDataDir: dataDir,
					expectedScopeDir: scopeDir,
					message: "refusing cleanup",
				}),
			/refusing cleanup/,
		);
	});
});

describe("cockpit smoke secret and header guards", () => {
	const origin = "http://localhost:4788";
	const code = "c".repeat(43);

	it("rejects output that contains a secret and accepts clean output", () => {
		assert.throws(
			() => assertNoSecretsInOutput(`Opening ${origin}/?_token=secret-token\n`, ["secret-token"], "token leaked"),
			/token leaked/,
		);
		assert.doesNotThrow(() => assertNoSecretsInOutput(`Opening ${origin}/\n`, ["secret-token", ""], "token leaked"));
	});

	it("accepts only a fragment sign-in code on the cockpit origin", () => {
		assert.equal(signInCodeFromBrowserUrl(`${origin}/#_code=${code}`, origin), code);
		for (const url of [
			`${origin}/?_token=${code}`,
			`${origin}/?_code=${code}`,
			`${origin}/#_code=short`,
			`${origin}/#_code=${code}&_token=x`,
			`http://127.0.0.1:9/#_code=${code}`,
			`${origin}/other#_code=${code}`,
		]) {
			assert.throws(() => signInCodeFromBrowserUrl(url, origin), /one-time sign-in code/, url);
		}
	});

	it("requires a strict script policy", () => {
		const strict =
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
		assert.doesNotThrow(() => assertStrictCockpitCsp(strict));
		assert.throws(() => assertStrictCockpitCsp(null), /no Content-Security-Policy/);
		assert.throws(() => assertStrictCockpitCsp(strict.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")), /script-src/);
		assert.throws(() => assertStrictCockpitCsp(strict.replace("frame-ancestors 'none'", "")), /frame-ancestors/);
		assert.throws(() => assertStrictCockpitCsp(`${strict}; worker-src 'self' 'wasm-unsafe-eval'`), /eval/);
	});
});
