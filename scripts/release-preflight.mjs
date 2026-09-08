#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const commandForPlatform = (command) => (process.platform === "win32" && command === "npm" ? "npm.cmd" : command);

const requirePinnedToolchain = () => {
	const expectedNode = "22.22.2";
	if (process.versions.node !== expectedNode) {
		throw new Error(`Release preflight requires Node ${expectedNode}; found ${process.versions.node}`);
	}
	const bun = spawnSync(commandForPlatform("bun"), ["--version"], { encoding: "utf8" });
	const version = bun.status === 0 ? bun.stdout.trim() : "unavailable";
	if (version !== "1.4.0") {
		throw new Error(`Release preflight requires Bun 1.4.0; found ${version}`);
	}
};

const run = (command, args) => {
	process.stdout.write(`$ ${[command, ...args].join(" ")}\n`);
	const result = spawnSync(commandForPlatform(command), args, { encoding: "utf8", stdio: "inherit" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
};

requirePinnedToolchain();
run("npm", ["run", "test:supply-chain"]);
run("npm", ["run", "build"]);
run("npm", ["run", "supply-chain:generate"]);
run("npm", ["run", "supply-chain:reproducibility"]);
run("npm", ["run", "supply-chain:strict"]);
run("npm", ["run", "check"]);
run("git", ["diff", "--exit-code"]);
run("npm", ["run", "qa:check"]);
run("npm", ["run", "test:qa-contract"]);
run("npm", ["run", "test:qa-scenarios"]);
run("npm", ["run", "test:sdk-fixture"]);
run("./test.sh", []);
run("npm", ["run", "test:coverage"]);
run("npm", ["run", "test:compatibility"]);
run("npm", ["run", "test:executor"]);
run("npm", ["run", "test:release-artifacts"]);
run("npm", ["run", "security:check"]);
run("git", ["diff", "--exit-code"]);
run(process.execPath, ["scripts/publish.mjs", "--dry-run"]);
