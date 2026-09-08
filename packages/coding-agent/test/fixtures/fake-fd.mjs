#!/usr/bin/env node

import { join } from "node:path";

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
const pattern = args[separatorIndex + 1];
const searchRoot = args[separatorIndex + 2];
const pathPattern = pattern?.includes("/") ?? false;
const expectedPrefix = [
	"--glob",
	"--color=never",
	"--hidden",
	"--no-require-git",
	"--max-results",
	"1000",
	...(pathPattern ? ["--full-path"] : []),
	"--",
];

if (
	separatorIndex !== expectedPrefix.length - 1 ||
	JSON.stringify(args.slice(0, separatorIndex + 1)) !== JSON.stringify(expectedPrefix) ||
	!pattern ||
	!searchRoot ||
	args.length !== separatorIndex + 3
) {
	process.stderr.write(`unexpected fd argv: ${JSON.stringify(args)}\n`);
	process.exit(64);
}

const outputs = new Map([
	["*.spec.ts", ["some/parent/child/test.spec.ts", "src/foo/bar/example.spec.ts"]],
	["**/some/parent/child/**", ["some/parent/child/file.ext", "some/parent/child/test.spec.ts"]],
	["**/parent/child/*", ["some/parent/child/file.ext", "some/parent/child/test.spec.ts"]],
	["**/src/**/*.spec.ts", ["src/foo/bar/example.spec.ts"]],
	["__fail-with-output__", ["some/parent/child/file.ext"]],
]);

if (pattern === "__fail-empty__") {
	process.stderr.write("fixture fd failure without output\n");
	process.exit(7);
}

const matches = outputs.get(pattern);
if (!matches) {
	process.stderr.write(`unexpected fd pattern: ${pattern}\n`);
	process.exit(65);
}

process.stdout.write(`${matches.map((entry) => join(searchRoot, entry)).join("\n")}\n`);
if (pattern === "__fail-with-output__") {
	process.stderr.write("fixture fd partial-result warning\n");
	process.exitCode = 7;
}
