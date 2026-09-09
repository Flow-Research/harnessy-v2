#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const target = process.argv[2];
if (target === undefined || process.argv.length !== 3 || !/^(?:major|minor|patch|\d+\.\d+\.\d+)$/.test(target)) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

const run = (command, args, options = {}) => {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `${command} ${args.join(" ")} failed:\n${output}` : `${command} ${args.join(" ")} failed`);
	}
	return result.stdout ?? "";
};

const status = run("git", ["status", "--porcelain"], { capture: true });
if (status.trim() !== "") {
	throw new Error("Release preparation requires a clean worktree; commit the reviewed canonicalization changes first.");
}

console.log("Preparing a Harnessy release without committing, tagging, pushing, or publishing.\n");
run(process.execPath, ["scripts/version-harnessy.mjs", target]);
run(process.execPath, ["scripts/version-pi.mjs", "patch"]);
run("npm", ["install", "--package-lock-only", "--ignore-scripts"]);
run("npm", ["run", "shrinkwrap:coding-agent"]);
run("npm", ["run", "install-lock:coding-agent"]);
run("npm", ["run", "clean"]);
run("npm", ["run", "build"]);
run("npm", ["run", "test:supply-chain"]);
run("npm", ["run", "supply-chain:generate"]);
run("npm", ["run", "supply-chain:strict"]);
run("npm", ["run", "check"]);
run("npm", ["run", "qa:check"]);
run("npm", ["run", "test:qa-contract"]);
run("npm", ["run", "test:qa-scenarios"]);
run("npm", ["run", "test:sdk-fixture"]);
const localHostDiffBefore = run("git", ["diff", "--binary"], { capture: true });
const localHostStatusBefore = run("git", ["status", "--porcelain=v1"], { capture: true });
run("npm", ["run", "test:local-host-fixture"]);
const localHostDiffAfter = run("git", ["diff", "--binary"], { capture: true });
const localHostStatusAfter = run("git", ["status", "--porcelain=v1"], { capture: true });
if (localHostDiffAfter !== localHostDiffBefore || localHostStatusAfter !== localHostStatusBefore) {
	throw new Error("The packed local-host fixture changed release-candidate files.");
}
run("npm", ["run", "security:check"]);
run("npm", ["run", "test:executor-package-contract"]);
run("./test.sh", []);
run("npm", ["run", "test:coverage"]);
run("npm", ["run", "test:engine-fixture"]);
run("npm", ["run", "verify:v1-compatibility"]);
run("npm", ["run", "test:executor"]);
run("npm", ["run", "test:release-artifacts"]);
run(process.execPath, ["scripts/publish.mjs", "--dry-run"]);

const version = run(process.execPath, ["-p", "require('./package.json').version"], { capture: true }).trim();
console.log(`\nHarnessy v${version} is prepared and locally verified.`);
console.log("Review the version and lockfile diff, commit it through the normal review path, then create the tag from the protected canonical branch.");
console.log("This command intentionally did not commit, tag, push, or publish anything.");
