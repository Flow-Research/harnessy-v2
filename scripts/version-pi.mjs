#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nextHarnessyVersion, PI_PACKAGE_NAMES, updatePiManifest } from "./harnessy-version-lib.mjs";

const target = process.argv[2];
if (target === undefined || process.argv.length !== 3) {
	console.error("Usage: node scripts/version-pi.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

const packagesRoot = join(process.cwd(), "packages");
const manifestPaths = readdirSync(packagesRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(packagesRoot, entry.name, "package.json"))
	.filter((path) => {
		try {
			readFileSync(path);
			return true;
		} catch {
			return false;
		}
	});
const manifests = manifestPaths.map((path) => ({ path, value: JSON.parse(readFileSync(path, "utf8")) }));
const piVersions = new Set(manifests.filter(({ value }) => PI_PACKAGE_NAMES.has(value.name)).map(({ value }) => value.version));
if (piVersions.size !== 1) throw new Error(`Inherited Pi source packages are not lockstep: ${[...piVersions].join(", ")}`);
const current = [...piVersions][0];
if (current === undefined) throw new Error("No inherited Pi source packages were found");
const version = nextHarnessyVersion(current, target);

for (const { path, value } of manifests) {
	const updated = updatePiManifest(value, version);
	if (JSON.stringify(updated) !== JSON.stringify(value)) writeFileSync(path, `${JSON.stringify(updated, null, "\t")}\n`);
}
console.log(`Prepared inherited Pi ${current} -> ${version}; Harnessy package versions were not changed.`);
