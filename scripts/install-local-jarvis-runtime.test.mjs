import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installLocalJarvisRuntime } from "./install-local-jarvis-runtime.mjs";

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
				new URL(`../packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/${path}`, import.meta.url)));
		}
		const environment = join(root, "environment");
		assert.throws(() => installLocalJarvisRuntime(source, environment), /Unknown Jarvis sync source/u);
		assert.equal(readFileSync(join(source, "src/jarvis/sync/cli.py"), "utf8"), "unknown sync source");
		assert.equal(existsSync(environment), false);
		assert.deepEqual(readdirSync(root), ["source"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
