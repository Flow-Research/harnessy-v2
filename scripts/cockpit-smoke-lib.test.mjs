import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

import {
	assertIsolatedRuntimeScope,
	assertNoSecretsInOutput,
	assertStrictCockpitCsp,
	canonicalFilesystemPath,
	signInCodeFromBrowserUrl,
	signInTargetFromOpenerArg,
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

	it("accepts only a fragment sign-in code on the cockpit's exchange page", () => {
		assert.equal(signInCodeFromBrowserUrl(`${origin}/auth/sign-in#_code=${code}`, origin), code);
		for (const url of [
			`${origin}/auth/sign-in?_token=${code}`,
			`${origin}/auth/sign-in?_code=${code}`,
			`${origin}/auth/sign-in#_code=short`,
			`${origin}/auth/sign-in#_code=${code}&_token=x`,
			`http://127.0.0.1:9/auth/sign-in#_code=${code}`,
			`${origin}/#_code=${code}`,
			`${origin}/other#_code=${code}`,
		]) {
			assert.throws(() => signInCodeFromBrowserUrl(url, origin), /one-time sign-in code/, url);
		}
	});

	it("requires a strict script policy", () => {
		const strict =
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
		assert.doesNotThrow(() => assertStrictCockpitCsp(strict));
		assert.throws(() => assertStrictCockpitCsp(null), /no Content-Security-Policy/);
		assert.throws(() => assertStrictCockpitCsp(strict.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")), /script-src/);
		assert.throws(() => assertStrictCockpitCsp(strict.replace("frame-ancestors 'none'", "")), /frame-ancestors/);
		assert.throws(() => assertStrictCockpitCsp(`${strict}; worker-src 'self' 'wasm-unsafe-eval'`), /eval/);
		assert.throws(() => assertStrictCockpitCsp(strict.replace("connect-src 'self'", "connect-src 'self' http: https:")), /connect-src/);
		assert.throws(() => assertStrictCockpitCsp(strict.replace("img-src 'self' data: blob:", "img-src 'self' data: blob: https:")), /img-src/);
	});
});

describe("cockpit smoke sign-in page guard", () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-cockpit-page-"));
	const control = join(root, "server-control");
	mkdirSync(control);
	const target = `http://localhost:4788/auth/sign-in#_code=${"c".repeat(43)}`;
	const page = join(control, `sign-in-${"a".repeat(32)}.html`);
	const pageHtml = `<script>location.replace(${JSON.stringify(target)});</script>\n<noscript><meta http-equiv="refresh" content="0;url=${target}"></noscript>\n`;
	writeFileSync(page, pageHtml, { mode: 0o600 });
	chmodSync(page, 0o600);

	after(() => rmSync(root, { recursive: true, force: true }));

	it("reads the redirect target from an owner-only page in server-control", () => {
		assert.equal(signInTargetFromOpenerArg(pathToFileURL(page).href, control, ["tok"]), target);
	});

	it("rejects a page that pushes a history entry with a bare meta refresh", () => {
		writeFileSync(page, `<meta http-equiv="refresh" content="0;url=${target}">`);
		assert.throws(() => signInTargetFromOpenerArg(pathToFileURL(page).href, control), /location\.replace/);
		writeFileSync(page, `<meta http-equiv="refresh" content="0;url=${target}">\n<script>location.replace(${JSON.stringify(target)});</script>`);
		assert.throws(() => signInTargetFromOpenerArg(pathToFileURL(page).href, control), /bare meta refresh/);
		writeFileSync(page, pageHtml);
	});

	it("rejects a credential in argv, a page elsewhere, or a readable page", () => {
		assert.throws(() => signInTargetFromOpenerArg(target, control), /argv/);
		assert.throws(() => signInTargetFromOpenerArg("http://localhost:4788/?_token=x", control), /argv/);
		assert.throws(() => signInTargetFromOpenerArg(`${pathToFileURL(page).href}?tok`, control, ["tok"]), /secret/);
		assert.throws(() => signInTargetFromOpenerArg("http://localhost:4788/", control), /sign-in page/);
		assert.throws(() => signInTargetFromOpenerArg(pathToFileURL(page).href, root), /outside/);
		if (process.platform !== "win32") {
			chmodSync(page, 0o644);
			assert.throws(() => signInTargetFromOpenerArg(pathToFileURL(page).href, control), /0600/);
			chmodSync(page, 0o600);
		}
	});
});
