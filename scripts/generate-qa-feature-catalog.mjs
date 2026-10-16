#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAllSpecs } from "../packages/capability-harnessy-v1-full/resources/flow-install/skills/qa-runtime/scripts/qa-runtime-lib.mjs";
import { buildFeatureCatalog, serializeFeatureCatalog } from "./qa-feature-catalog-lib.mjs";
import { assertQaRuntimeIdentity } from "./qa-runtime-bridge.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = ".jarvis/context/profiles/qa.json";
const absoluteProfilePath = resolve(repositoryRoot, profilePath);
const profile = JSON.parse(readFileSync(absoluteProfilePath, "utf8"));
const outputPath = resolve(repositoryRoot, profile.output?.featureCatalog ?? "qa/features.generated.yaml");
const check = process.argv.includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unknownArguments.length > 0) {
	throw new Error("Usage: node scripts/generate-qa-feature-catalog.mjs [--check]");
}

assertQaRuntimeIdentity();
const parsed = parseAllSpecs({ cwd: repositoryRoot, profilePath });
if (parsed.errors.length > 0) {
	throw new Error(`Cannot generate feature catalog with ${parsed.errors.length} spec parse error(s)`);
}
const expected = serializeFeatureCatalog(buildFeatureCatalog({ records: parsed.records, profile }));

if (check) {
	const actual = readFileSync(outputPath, "utf8");
	if (actual !== expected) {
		throw new Error(`${profile.output.featureCatalog} is stale; run npm run qa:catalog`);
	}
	process.stdout.write(`QA feature catalog is current: ${profile.output.featureCatalog}\n`);
} else {
	writeFileSync(outputPath, expected, "utf8");
	process.stdout.write(`Wrote QA feature catalog: ${profile.output.featureCatalog}\n`);
}
