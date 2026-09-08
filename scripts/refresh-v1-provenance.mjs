#!/usr/bin/env node

import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readV1Provenance, writeV1NpmTransport, writeV1Provenance } from "./v1-compatibility-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "packages/capability-harnessy-v1-full");
const resources = join(packageRoot, "resources");
const source = join(resources, "source");
const previous = await readV1Provenance(packageRoot);

for (const [from, to] of [
	[join(source, "tools/flow-install"), join(resources, "flow-install")],
	[join(source, ".jarvis/context"), join(resources, "context-vault")],
	[join(source, "jarvis-cli"), join(resources, "jarvis-cli")],
]) {
	if (!to.startsWith(`${resources}${sep}`)) throw new Error(`Unsafe projection destination: ${to}`);
	await rm(to, { recursive: true, force: true });
	await cp(from, to, { recursive: true, preserveTimestamps: false });
}
for (const [from, to] of [
	["install.sh", "install.sh"],
	["README.md", "README.v1.md"],
	["AGENTS.md", "AGENTS.v1.md"],
])
	await cp(join(source, from), join(resources, to));

const provenance = await writeV1Provenance(packageRoot, previous.source, {
	schemaVersion: previous.schemaVersion,
});
await writeV1NpmTransport(packageRoot);
process.stdout.write(`${JSON.stringify({ ok: true, tree: provenance.tree }, null, 2)}\n`);
