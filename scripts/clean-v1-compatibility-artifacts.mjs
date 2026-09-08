#!/usr/bin/env node

import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(repositoryRoot, "packages/capability-harnessy-v1-full/resources/source");
const removableDirectories = new Set([
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".venv",
	"__pycache__",
	"htmlcov",
	"node_modules",
]);
const removableFiles = new Set([".coverage", "coverage.xml"]);
const removed = [];

const clean = async (directory) => {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		if (entry.isDirectory() && removableDirectories.has(entry.name)) {
			await rm(absolute, { recursive: true, force: true });
			removed.push(absolute.slice(sourceRoot.length + 1));
		} else if (entry.isDirectory()) await clean(absolute);
		else if (entry.isFile() && (removableFiles.has(entry.name) || entry.name.endsWith(".pyc"))) {
			await rm(absolute);
			removed.push(absolute.slice(sourceRoot.length + 1));
		}
	}
};

await clean(sourceRoot);
process.stdout.write(`${JSON.stringify({ ok: true, removed: removed.sort() }, null, 2)}\n`);
