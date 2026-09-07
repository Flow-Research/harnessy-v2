#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validateCiContract } from "./ci-contract-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(repositoryRoot, path), "utf8");
const result = validateCiContract({
	ciSource: read(".github/workflows/ci.yml"),
	securitySource: read(".github/workflows/qa-security-sweep.yml"),
	releaseSource: read(".github/workflows/build-binaries.yml"),
	profile: JSON.parse(read(".jarvis/context/profiles/ci.json")),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
