#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readV1Provenance, writeV1NpmTransport, writeV1Provenance } from "./v1-compatibility-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "packages/capability-harnessy-v1-full");
const previous = await readV1Provenance(packageRoot);
const provenance = await writeV1Provenance(packageRoot, previous.source);
await writeV1NpmTransport(packageRoot);
process.stdout.write(`${JSON.stringify({ ok: true, tree: provenance.tree }, null, 2)}\n`);
