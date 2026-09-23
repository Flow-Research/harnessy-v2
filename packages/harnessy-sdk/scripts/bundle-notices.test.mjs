import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundleNotices } from "./bundle-notices.mjs";

test("a real SDK bundle emits notices into a previously absent output directory", (t) => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-sdk-clean-build-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const output = join(root, "dist");
	assert.equal(existsSync(output), false);
	const packageRoot = fileURLToPath(new URL("../", import.meta.url));
	const result = spawnSync(process.execPath, [join(packageRoot, "../../node_modules/tsup/dist/cli-default.js"), "--out-dir", output, "--no-dts"], {
		cwd: packageRoot, encoding: "utf8", timeout: 60_000,
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	assert(existsSync(join(output, "index.js")));
	assert(existsSync(join(output, "node.js")));
	const notices = readFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), "utf8");
	assert.match(notices, /Executor \(vendored\)/u);
	assert.match(notices, /Copyright/iu);
});

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "harnessy-notices-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkg = join(root, "packages/harnessy-sdk");
	mkdirSync(pkg, { recursive: true });
	const put = (path, text) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	const meta = (inputs) => ({ outputs: { "dist/node.js": { inputs } } });
	return { root, pkg, put, meta };
}

test("collects contributing dependencies, British licence names and nested vendor notices deterministically", (t) => {
	const { pkg, put, meta } = fixture(t);
	put("packages/harnessy-sdk/src/node.ts", "export {};");
	put("node_modules/dependency/package.json", JSON.stringify({ name: "dependency", version: "1.2.3" }));
	put("node_modules/dependency/index.js", "export {};");
	put("node_modules/dependency/LICENCE.md", "Copyright Dependency\nPermission text\n");
	put("executor/LICENSE", "Copyright Executor\nPermission text\n");
	put("executor/src/vendor/compiler/LICENSE", "Copyright Compiler\nPermission text\n");
	put("executor/src/vendor/compiler/index.ts", "export {};");
	const entries = [
		["src/node.ts", { bytesInOutput: 3 }],
		["../../node_modules/dependency/index.js", { bytesInOutput: 4 }],
		["../../executor/src/vendor/compiler/index.ts", { bytesInOutput: 5 }],
		["missing-tree-shaken.ts", { bytesInOutput: 0 }],
	];
	const result = bundleNotices(meta(Object.fromEntries(entries)), pkg);
	assert.equal(result, bundleNotices(meta(Object.fromEntries(entries.reverse())), pkg));
	for (const text of ["dependency@1.2.3", "Copyright Dependency", "Copyright Executor", "Copyright Compiler"])
		assert(result.includes(text));
	assert(!result.includes(pkg));
});

test("fails for missing or empty third-party notices", (t) => {
	const { pkg, put, meta } = fixture(t);
	put("node_modules/a/package.json", JSON.stringify({ name: "a", version: "1.0.0", license: "MIT" }));
	put("node_modules/a/index.js", "export {};");
	const input = meta({ "../../node_modules/a/index.js": { bytesInOutput: 1 } });
	assert.throws(() => bundleNotices(input, pkg), /lacks notice text/);
	put("node_modules/a/LICENSE", "\n");
	assert.throws(() => bundleNotices(input, pkg), /lacks notice text/);
});

test("uses the recovered notice only for the exact pinned component", (t) => {
	const { pkg, put, meta } = fixture(t);
	put("node_modules/@cfworker/json-schema/package.json", JSON.stringify({ name: "@cfworker/json-schema", version: "4.1.1" }));
	put("node_modules/@cfworker/json-schema/index.js", "export {};");
	put("packages/harnessy-sdk/THIRD_PARTY_LICENSES/cfworker-json-schema.txt", "Pinned upstream provenance and copyright\n");
	const input = meta({ "../../node_modules/@cfworker/json-schema/index.js": { bytesInOutput: 1 } });
	assert(bundleNotices(input, pkg).includes("Pinned upstream provenance and copyright"));
	put("node_modules/@cfworker/json-schema/package.json", JSON.stringify({ name: "@cfworker/json-schema", version: "4.2.0" }));
	assert.throws(() => bundleNotices(input, pkg), /lacks notice text/);
});

test("rejects empty inventory and unclassified local source", (t) => {
	const { pkg, put, meta } = fixture(t);
	assert.throws(() => bundleNotices(meta({}), pkg), /no attributed inputs/);
	put("other/source.js", "export {};");
	assert.throws(() => bundleNotices(meta({ "../../other/source.js": { bytesInOutput: 1 } }), pkg), /Unclassified/);
});

test("rejects escaped inputs and missing package identity", (t) => {
	const { pkg, put, meta } = fixture(t);
	const outside = mkdtempSync(join(tmpdir(), "harnessy-notice-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	writeFileSync(join(outside, "input.js"), "export {};");
	assert.throws(() => bundleNotices(meta({ [join(outside, "input.js")]: { bytesInOutput: 1 } }), pkg), /escapes repository/);
	put("node_modules/a/package.json", "{}");
	put("node_modules/a/index.js", "export {};");
	assert.throws(() => bundleNotices(meta({ "../../node_modules/a/index.js": { bytesInOutput: 1 } }), pkg), /no name\/version/);
});

test("deduplicates matching package copies and rejects conflicting notices", (t) => {
	const { pkg, put, meta } = fixture(t);
	const roots = ["node_modules/a", "node_modules/parent/node_modules/a"];
	for (const root of roots) {
		put(`${root}/package.json`, JSON.stringify({ name: "a", version: "1.0.0" }));
		put(`${root}/index.js`, "export {};");
		put(`${root}/LICENSE`, "Same original notice\n");
	}
	const input = meta(Object.fromEntries(roots.map((root) => [`../../${root}/index.js`, { bytesInOutput: 1 }])));
	assert.equal(bundleNotices(input, pkg).split("## a@1.0.0").length, 2);
	put(`${roots[1]}/LICENSE`, "Unexpected changed notice\n");
	assert.throws(() => bundleNotices(input, pkg), /Conflicting bundled notices/);
});
