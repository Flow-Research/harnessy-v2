import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	assertHarnessyExecutorRuntimeFiles,
	harnessyExecutorAlias,
	harnessyExecutorRuntimeContract,
	harnessyExecutorVariantManifest,
	harnessyExecutorWrapperManifest,
} from "./harnessy-executor-package-lib.mjs";
import { requireNpmCliPath, runNodeScript } from "./test-harnessy-executor-package.mjs";

const require = createRequire(import.meta.url);
const { resolveHarnessyExecutorPlatform } = require("../packages/harnessy-executor/bin/platform.cjs");

describe("Harnessy Executor packaging contract", () => {
	it("maps every recognized ABI to a scoped optional dependency", () => {
		assert.equal(harnessyExecutorAlias("darwin-arm64"), "@harnessy/executor-darwin-arm64");
		assert.equal(harnessyExecutorAlias("linux-x64-musl"), "@harnessy/executor-linux-x64-musl");
		assert.throws(() => harnessyExecutorAlias("freebsd-x64"), /Invalid Harnessy Executor platform tag/);
	});

	it("fails closed instead of treating unknown machines as x64", () => {
		assert.deepEqual(resolveHarnessyExecutorPlatform("darwin", "arm64"), {
			arch: "arm64",
			binary: "executor",
			platform: "darwin",
		});
		assert.deepEqual(resolveHarnessyExecutorPlatform("win32", "x64"), {
			arch: "x64",
			binary: "executor.exe",
			platform: "windows",
		});
		assert.throws(() => resolveHarnessyExecutorPlatform("freebsd", "x64"), /unsupported platform/);
		assert.throws(() => resolveHarnessyExecutorPlatform("linux", "ppc64"), /unsupported platform/);
	});

	it("rewrites a compiled variant without losing its platform restrictions", () => {
		assert.deepEqual(
			harnessyExecutorVariantManifest({
				upstream: { name: "executor", version: "0.0.3-linux-x64", os: ["linux"], cpu: ["x64"] },
				version: "0.0.3",
				tag: "linux-x64",
			}),
			{
				name: "@harnessy/executor",
				version: "0.0.3-linux-x64",
				os: ["linux"],
				cpu: ["x64"],
				license: "MIT",
			},
		);
		assert.throws(
			() =>
				harnessyExecutorVariantManifest({
					upstream: { version: "1.5.33-linux-x64" },
					version: "0.0.3",
					tag: "linux-x64",
				}),
			/version/,
		);
	});

	it("generates deterministic publication aliases", () => {
		const manifest = harnessyExecutorWrapperManifest({
			source: { name: "@harnessy/executor", version: "0.0.3", license: "MIT" },
			tags: ["linux-x64", "darwin-arm64"],
		});
		assert.deepEqual(manifest.optionalDependencies, {
			"@harnessy/executor-darwin-arm64": "npm:@harnessy/executor@0.0.3-darwin-arm64",
			"@harnessy/executor-linux-x64": "npm:@harnessy/executor@0.0.3-linux-x64",
		});
	});

	it("fails closed when a compiled variant omits required runtime sidecars", () => {
		const linux = harnessyExecutorRuntimeContract("linux-x64");
		assert(linux.requiredFiles.includes("bin/libsql.node"));
		assert(linux.requiredFiles.includes("bin/onepassword-core_bg.wasm"));
		assert(linux.requiredFiles.includes("bin/worker-bundler/dist/index.bundled.js"));
		assert(linux.requiredFiles.includes("bin/workerd"));
		assert.throws(
			() =>
				assertHarnessyExecutorRuntimeFiles({
					tag: "linux-x64",
					files: linux.requiredFiles.filter((path) => path !== "bin/libsql.node"),
				}),
			/missing required runtime files: bin\/libsql\.node/u,
		);
		assert.doesNotThrow(() => assertHarnessyExecutorRuntimeFiles({ tag: "linux-x64", files: linux.requiredFiles }));
	});

	it("keeps Windows arm64 intentional but blocked until native SQLite is viable", () => {
		const windowsArm64 = harnessyExecutorRuntimeContract("windows-arm64");
		assert(windowsArm64.requiredFiles.includes("bin/libsql.node"));
		assert.equal(windowsArm64.requiredFiles.includes("bin/workerd.exe"), false);
		assert.match(windowsArm64.runtimeLimitations.join("\n"), /workerd-backed custom app execution is unavailable/u);
		assert.match(windowsArm64.releaseBlockers.join("\n"), /compatible libSQL native sidecar/u);
		assert.match(
			windowsArm64.releaseBlockers.join("\n"),
			/real packed Windows arm64 wrapper passes --version and local SQLite\/health smoke testing/u,
		);
		assert.throws(
			() => assertHarnessyExecutorRuntimeFiles({ tag: "windows-arm64", files: windowsArm64.requiredFiles }),
			/Windows arm64 publication is blocked/u,
		);
	});
});

describe("Harnessy Executor package gate process boundary", () => {
	it("runs Node scripts with literal paths and arguments without command shims or a shell", (t) => {
		const directory = mkdtempSync(join(tmpdir(), "harnessy package & argv-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const script = join(directory, "capture & args.cjs");
		writeFileSync(script, "console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n");
		const args = ["--version", "space in argument", 'literal "quotes"', "& echo unwanted", "$(echo unwanted)", "%PATH%", ""];
		const output = JSON.parse(runNodeScript(script, args, { cwd: directory, capture: true }));
		assert.deepEqual(output.args, args);
		// macOS can canonicalize /var to /private/var in the child process.
		assert.equal(realpathSync(output.cwd), realpathSync(directory));
	});

	it("reports child failure and launch errors instead of accepting empty output", (t) => {
		const directory = mkdtempSync(join(tmpdir(), "harnessy-package-failure-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const script = join(directory, "failure.cjs");
		writeFileSync(script, 'console.error("deliberate child failure"); process.exit(7);\n');
		assert.throws(() => runNodeScript(script, [], { capture: true }), /deliberate child failure/u);
		assert.throws(
			() => runNodeScript(script, [], { capture: true, cwd: join(directory, "missing-directory") }),
			/ENOENT/u,
		);
	});

	it("requires an existing npm CLI script, not a command shim or another package manager", (t) => {
		const directory = mkdtempSync(join(tmpdir(), "harnessy npm & path-"));
		t.after(() => rmSync(directory, { recursive: true, force: true }));
		const cliPath = join(directory, "npm-cli.js");
		writeFileSync(cliPath, "// npm CLI path validation fixture\n");
		assert.equal(requireNpmCliPath(cliPath), cliPath);
		for (const invalid of [
			null,
			"",
			"npm-cli.js",
			join(directory, "missing", "npm-cli.js"),
			join(directory, "npm.cmd"),
			join(directory, "yarn.js"),
		]) {
			assert.throws(() => requireNpmCliPath(invalid), /npm run test:executor-package-integration/u);
		}
		const directoryPath = join(directory, "directory", "npm-cli.js");
		mkdirSync(directoryPath, { recursive: true });
		assert.throws(() => requireNpmCliPath(directoryPath), /npm run test:executor-package-integration/u);
	});

	it("rejects direct CLI invocation without npm before building or packing", () => {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL("./test-harnessy-executor-package.mjs", import.meta.url))], {
			encoding: "utf8",
			env: { ...process.env, npm_execpath: "" },
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /npm run test:executor-package-integration/u);
	});
});
