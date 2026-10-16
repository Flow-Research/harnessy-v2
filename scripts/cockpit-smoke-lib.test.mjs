import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { assertIsolatedRuntimeScope, canonicalFilesystemPath } from "./cockpit-smoke-lib.mjs";

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
