import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { correctJarvisSyncSource, installLocalJarvisRuntime } from "./install-local-jarvis-runtime.mjs";

test("candidate installation rejects relative paths before invoking uv", () => {
	assert.throws(() => installLocalJarvisRuntime("relative", join(tmpdir(), "unused")), /must be absolute/u);
	assert.throws(() => installLocalJarvisRuntime(tmpdir(), "relative"), /must be absolute/u);
});

test("candidate installation preserves an existing environment instead of upgrading it", () => {
	const root = mkdtempSync(join(tmpdir(), "jarvis-install-refusal-"));
	try {
		const sentinel = join(root, "existing");
		writeFileSync(sentinel, "preserved runtime");
		assert.throws(() => installLocalJarvisRuntime(join(root, "source"), root), /already exists/u);
		assert.equal(readFileSync(sentinel, "utf8"), "preserved runtime");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown planner source rejects before installation and leaves the original unchanged", () => {
	const root = mkdtempSync(join(tmpdir(), "jarvis-install-source-check-"));
	try {
		const source = join(root, "source");
		const services = join(source, "src/jarvis/services");
		mkdirSync(services, { recursive: true });
		const planner = join(services, "planning_service.py");
		writeFileSync(planner, "unknown source");
		const environment = join(root, "environment");
		assert.throws(() => installLocalJarvisRuntime(source, environment), /Unknown Jarvis planning source/u);
		assert.equal(readFileSync(planner, "utf8"), "unknown source");
		assert.equal(existsSync(environment), false);
		assert.deepEqual(readdirSync(root), ["source"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown sync source rejects before dependency installation and preserves the source", () => {
	const root = mkdtempSync(join(tmpdir(), "jarvis-sync-source-check-"));
	try {
		const source = join(root, "source");
		for (const path of ["services/planning_service.py", "anytype_client.py", "community_briefing/collector.py", "sync/cli.py"]) {
			const target = join(source, "src/jarvis", path);
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, path === "sync/cli.py" ? "unknown sync source" : readFileSync(
				new URL(`../packages/capability-harnessy-v1-full/resources/source/jarvis-cli/src/jarvis/${path}`, import.meta.url)));
		}
		const environment = join(root, "environment");
		assert.throws(() => installLocalJarvisRuntime(source, environment), /Unknown Jarvis sync source/u);
		assert.equal(readFileSync(join(source, "src/jarvis/sync/cli.py"), "utf8"), "unknown sync source");
		assert.equal(existsSync(environment), false);
		assert.deepEqual(readdirSync(root), ["source"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});


test("reviewed neutral sync help accepts only current source and retains failure corrections", () => {
	const source = readFileSync(new URL("../packages/capability-harnessy-v1-full/resources/source/jarvis-cli/src/jarvis/sync/cli.py", import.meta.url), "utf8");
	const corrected = correctJarvisSyncSource(source);
	assert.match(corrected, /Sync local folders\/files to a knowledge-tool collection/u);
	assert.match(corrected, /if adapter is None:\n            raise SystemExit\(1\)/u);
	assert.match(corrected, /adapter, destination\n        \):\n            raise SystemExit\(1\)/u);
	assert.match(corrected, /if not dry_run and result.state is not None:\n        save_state/u);
	assert.match(corrected, /Partial state saved; errors require reconciliation before retry\./u);
	assert.throws(() => correctJarvisSyncSource(`${source}\n# unreviewed change`), /Unknown Jarvis sync source/u);
	assert.throws(() => correctJarvisSyncSource(corrected), /Unknown Jarvis sync source/u);
});

test("installer sends corrected current source to the locked dependency installer without changing preserved bytes", { skip: process.platform === "win32" }, () => {
	const root = mkdtempSync(join(tmpdir(), "jarvis-current-source-"));
	const previousPath = process.env.PATH;
	try {
		const source = join(root, "source");
		for (const path of ["services/planning_service.py", "anytype_client.py", "community_briefing/collector.py", "sync/cli.py"]) {
			const target = join(source, "src/jarvis", path);
			mkdirSync(join(target, ".."), { recursive: true });
			cpSync(new URL(`../packages/capability-harnessy-v1-full/resources/source/jarvis-cli/src/jarvis/${path}`, import.meta.url), target);
		}
		const syncFile = join(source, "src/jarvis/sync/cli.py");
		const before = readFileSync(syncFile, "utf8");
		const environment = join(root, "environment");
		// The test installer captures input; it performs no package or network operations.
		const uv = join(root, "uv");
		writeFileSync(uv, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const args = process.argv.slice(2);
assert.deepEqual(args.filter((arg, index) => index !== 2), ['sync', '--project', '--frozen', '--no-dev', '--no-editable', '--python', '3.11', '--no-python-downloads']);
fs.mkdirSync(path.join(process.env.UV_PROJECT_ENVIRONMENT, 'bin'), {recursive:true});
fs.copyFileSync(path.join(args[2], 'src/jarvis/sync/cli.py'), path.join(process.env.UV_PROJECT_ENVIRONMENT, 'installed-sync.py'));
fs.writeFileSync(path.join(process.env.UV_PROJECT_ENVIRONMENT, 'bin/python'), 'fixture');
`);
		chmodSync(uv, 0o700);
		process.env.PATH = root;
		assert.equal(installLocalJarvisRuntime(source, environment), join(environment, "bin/python"));
		assert.equal(readFileSync(syncFile, "utf8"), before);
		assert.equal(readFileSync(join(environment, "installed-sync.py"), "utf8"), correctJarvisSyncSource(before));
		assert.deepEqual(readdirSync(root).sort(), ["environment", "source", "uv"]);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		rmSync(root, { recursive: true, force: true });
	}
});
