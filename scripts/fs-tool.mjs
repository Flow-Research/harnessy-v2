#!/usr/bin/env node
// Dependency-free build file operations used by package scripts:
//   rm -rf <path...> | mkdir -p <dir...> | chmod +x <file...> | cp [-r] <source...> <destination>
// A source may use `*` in its final path segment. Unmatched globs fail, as they did with shx.
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const fail = (message) => {
	process.stderr.write(`fs-tool: ${message}\n`);
	process.exit(1);
};

const expand = (pattern) => {
	const name = basename(pattern);
	if (!name.includes("*")) return [pattern];
	const directory = dirname(pattern);
	const expression = new RegExp(`^${name.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
	const matches = readdirSync(directory)
		.filter((entry) => !entry.startsWith(".") && expression.test(entry))
		.sort()
		.map((entry) => join(directory, entry));
	if (matches.length === 0) fail(`no match for ${pattern}`);
	return matches;
};

const [command, ...args] = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith("-"));
const operands = args.filter((arg) => !arg.startsWith("-"));

switch (command) {
	case "rm":
		if (flags.join(" ") !== "-rf" || operands.length === 0) fail("usage: rm -rf <path...>");
		for (const path of operands) rmSync(path, { recursive: true, force: true });
		break;
	case "mkdir":
		if (flags.join(" ") !== "-p" || operands.length === 0) fail("usage: mkdir -p <dir...>");
		for (const path of operands) mkdirSync(path, { recursive: true });
		break;
	case "chmod":
		if (args[0] !== "+x" || args.length < 2) fail("usage: chmod +x <file...>");
		for (const path of args.slice(1)) chmodSync(path, statSync(path).mode | 0o111);
		break;
	case "cp": {
		const recursive = flags.includes("-r");
		if (flags.some((flag) => flag !== "-r") || operands.length < 2) fail("usage: cp [-r] <source...> <destination>");
		const destination = operands.at(-1);
		const sources = operands.slice(0, -1).flatMap(expand);
		const intoDirectory = destination.endsWith("/") || sources.length > 1 || isDirectory(destination);
		for (const source of sources) {
			if (isDirectory(source) && !recursive) fail(`${source} is a directory (use -r)`);
			cpSync(source, intoDirectory ? join(destination, basename(source)) : destination, { recursive });
		}
		break;
	}
	default:
		fail(`unsupported command ${command ?? "(none)"}`);
}

function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}
