import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "./support/fixture-environment.mjs";

test("fixture environment drops credentials, profile paths and caller preload hooks", () => {
	const env = fixtureEnvironment({ PATH: "/usr/bin:/bin", DISCORD_TOKEN: "canary", GOOGLE_WORKSPACE_CLI_CONFIG_DIR: "/private", NODE_OPTIONS: "--require=untrusted", HOME: "/private/home", HTTPS_PROXY: "http://proxy" });
	assert.deepEqual(Object.keys(env).sort(), ["NODE_NO_WARNINGS", "NODE_OPTIONS", "PATH", "npm_config_offline", "npm_config_update_notifier"].sort());
	assert(!JSON.stringify(env).includes("canary"));
	assert(!JSON.stringify(env).includes("untrusted"));
});

test("child and grandchild deny production fetch and socket calls before I/O while loopback works", () => {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./support/fixture-network-probe.mjs", import.meta.url))], {
		env: fixtureEnvironment(), encoding: "utf8", timeout: 10_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { loopbackRequests: 1, externalDenied: 6, childDenied: true });
});
