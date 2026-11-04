import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installReleaseLaunchers } from "./install-release.mjs";
import { installPortalLauncher } from "../packages/harnessy-local-host/resources/macos/install-launcher.mjs";

test("native launcher resources are included in the packed package", () => {
	const manifest = JSON.parse(readFileSync(new URL("../packages/harnessy-local-host/package.json", import.meta.url)));
	assert(manifest.files.includes("resources/macos"));
	const packageRoot = new URL("../packages/harnessy-local-host/", import.meta.url);
	const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: packageRoot, encoding: "utf8" }));
	for (const path of ["resources/macos/portal-launcher.applescript", "resources/macos/install-launcher.mjs"])
		assert(packed.files.some((file) => file.path === path), `Missing packed ${path}`);
});

test("compiled launcher preserves literal paths, signs in without opening another page, and refuses replacement", { skip: process.platform !== "darwin" }, (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "hsy-launcher-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const portal = join(root, "owner's $portal");
	writeFileSync(portal, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
	chmodSync(portal, 0o700);
	const target = join(root, "Harnessy.app");
	const stateDir = join(root, "owner's $state");
	assert.equal(installPortalLauncher({ target, portal, stateDir }), target);
	assert(existsSync(join(target, "Contents/Resources/Scripts/main.scpt")));
	const helpers = join(target, "Contents/Resources");
	const request = "a".repeat(43);
	assert.deepEqual(execFileSync(join(helpers, "signin-portal"), [request], { encoding: "utf8", env: { PATH: "/nonexistent" } }).trim().split("\n"),
		["signin", "--request", request, "--port", "8790", "--state-dir", stateDir]);
	assert.deepEqual(execFileSync(join(helpers, "open-portal"), [], { encoding: "utf8" }).trim().split("\n"),
		["open", "--port", "8790", "--state-dir", stateDir]);
	assert.equal(execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0", join(target, "Contents/Info.plist")], { encoding: "utf8" }).trim(), "harnessy");
	assert.throws(() => installPortalLauncher({ target, portal, stateDir }), /new .app/);
	assert.throws(() => installPortalLauncher({ target: join(root, "Invalid.app"), portal, stateDir, port: 0 }), /port/);
	assert(!existsSync(join(root, "Invalid.app")));
});


test("native app helpers use the generated release wrapper and pinned Node without a GUI PATH", { skip: process.platform !== "darwin" }, (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "hsy-native-release-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const installation = join(root, "owner's $release");
	mkdirSync(join(installation, "jarvis-runtime/bin"), { recursive: true });
	writeFileSync(join(installation, "jarvis-runtime/bin/python"), "unused fixture");
	const core = join(installation, "node_modules/@harnessy/core");
	mkdirSync(core, { recursive: true });
	writeFileSync(join(core, "package.json"), JSON.stringify({ bin: {} }));
	const host = join(installation, "service/node_modules/@harnessy/local-host");
	mkdirSync(join(host, "dist"), { recursive: true });
	writeFileSync(join(host, "package.json"), JSON.stringify({ bin: { "harnessy-portal": "dist/portal-cli.js" } }));
	writeFileSync(join(host, "dist/portal-cli.js"), "console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}))");
	const release = installReleaseLaunchers(installation);
	const stateDir = join(root, "private state");
	const target = installPortalLauncher({ target: join(root, "Harnessy.app"), portal: join(release.commands, "harnessy-portal"), stateDir });
	for (const [helper, args, expected] of [
		["open-portal", [], ["open", "--port", "8790", "--state-dir", stateDir]],
		["signin-portal", ["b".repeat(43)], ["signin", "--request", "b".repeat(43), "--port", "8790", "--state-dir", stateDir]],
	]) {
		const output = execFileSync(join(target, "Contents/Resources", helper), args, { encoding: "utf8", env: { PATH: "/nonexistent" } });
		assert.deepEqual(JSON.parse(output), { node: realpathSync(release.node), args: expected });
	}
});
