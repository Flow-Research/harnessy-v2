#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HARNESSY_PACKAGE_NAMES, nextHarnessyVersion, updateHarnessyManifest } from "./harnessy-version-lib.mjs";

const target = process.argv[2];
if (target === undefined || process.argv.length !== 3) {
	console.error("Usage: node scripts/version-harnessy.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

const rootPath = join(process.cwd(), "package.json");
const rootManifest = JSON.parse(readFileSync(rootPath, "utf8"));
if (rootManifest.name !== "harnessy-v2") throw new Error("Run this command from the Harnessy V2 repository root");

const manifestPaths = [
	rootPath,
	...readdirSync(join(process.cwd(), "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(process.cwd(), "packages", entry.name, "package.json"))
		.filter((path) => {
			try {
				readFileSync(path);
				return true;
			} catch {
				return false;
			}
		}),
];
const manifests = manifestPaths.map((path) => ({ path, value: JSON.parse(readFileSync(path, "utf8")) }));
const harnessyVersions = new Set(
	manifests.filter(({ value }) => HARNESSY_PACKAGE_NAMES.has(value.name)).map(({ value }) => value.version),
);
if (harnessyVersions.size !== 1 || !harnessyVersions.has(rootManifest.version)) {
	throw new Error(`Harnessy source packages are not lockstep with root ${rootManifest.version}: ${[...harnessyVersions].join(", ")}`);
}

const version = nextHarnessyVersion(rootManifest.version, target);
for (const { path, value } of manifests) {
	const updated = updateHarnessyManifest(value, version);
	if (JSON.stringify(updated) !== JSON.stringify(value)) writeFileSync(path, `${JSON.stringify(updated, null, "\t")}\n`);
}
console.log(`Prepared Harnessy ${rootManifest.version} -> ${version}; inherited Pi package versions were not changed.`);
