import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment } from "../../harnessy-local-host/test/support/fixture-environment.mjs";

// Standalone acceptance of current built bytes. No build, installation hooks,
// registry access, source aliases, or edits to a shared packed-fixture runner.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-life-installed-")));
const consumer = join(scratch, "consumer");
const tarballs = join(scratch, "tarballs");
for (const path of [consumer, tarballs]) mkdirSync(path, { mode: 0o700 });
const npmConfig = join(scratch, "empty-npmrc");
writeFileSync(npmConfig, "", { mode: 0o600 });
const npmGlobalConfig = join(scratch, "empty-global-npmrc");
writeFileSync(npmGlobalConfig, "", { mode: 0o600 });
const npmCli = resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
assert(existsSync(npmCli), "Run with the installed pinned Node/npm distribution");
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const run = (args, cwd = repo) => {
	const child = spawnSync(process.execPath, args, { cwd, env: fixtureEnvironment(), encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
	assert.equal(child.status, 0, child.stderr || child.error?.message);
	return child.stdout;
};
const inventory = (root) => {
	const files = [];
	const walk = (path) => {
		const stat = lstatSync(path);
		assert(!stat.isSymbolicLink(), "Installed consumer must not contain workspace links");
		if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
		else { assert(stat.isFile(), "Installed consumer contains special file"); files.push({ path: relative(root, path), sha256: digest(readFileSync(path)) }); }
	};
	walk(root);
	return files;
};
const packs = [];
for (const name of ["harnessy-core", "ai", "capability-harnessy-v1-full"]) {
	const source = join(repo, "packages", name);
	const [packed] = JSON.parse(run([npmCli, "pack", "--ignore-scripts", "--offline", "--json", "--userconfig", npmConfig, "--globalconfig", npmGlobalConfig, "--pack-destination", tarballs, "--cache", join(scratch, "npm-cache")], source));
	const tarball = join(tarballs, packed.filename);
	assert.equal(packed.integrity, `sha512-${digest(readFileSync(tarball), "sha512", "base64")}`);
	// Deliberately use a valid nested dependency layout, not a sibling-directory
	// coincidence that can hide incorrect package resolution.
	const target = join(consumer, "node_modules",
		...(name === "capability-harnessy-v1-full" ? ["@harnessy", "core", "node_modules"] : []),
		...packed.name.split("/"));
	mkdirSync(target, { recursive: true, mode: 0o700 });
	const extracted = spawnSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", target], { env: fixtureEnvironment(), encoding: "utf8", timeout: 30_000 });
	assert.equal(extracted.status, 0, extracted.stderr);
	const files = inventory(target);
	assert.deepEqual(files.map((file) => file.path).sort(), packed.files.map((file) => file.path).sort());
	for (const file of files) assert.equal(file.sha256, digest(readFileSync(join(source, file.path))), `Packed byte drift: ${packed.name}/${file.path}`);
	packs.push({ name: packed.name, version: packed.version, integrity: packed.integrity, tarballSha256: digest(readFileSync(tarball)), target, files });
}
// Reuse existing installed external dependencies only. Core and pi themselves
// always come from verified tarballs above, never copied workspace links.
const copied = new Set();
const copyDependency = (name) => {
	if (copied.has(name)) return;
	copied.add(name);
	assert(!name.startsWith("@harnessy/") && !name.startsWith("@earendil-works/"));
	const source = realpathSync(join(repo, "node_modules", ...name.split("/")));
	const target = join(consumer, "node_modules", ...name.split("/"));
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	cpSync(source, target, { recursive: true, dereference: true });
	const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	for (const dependency of Object.keys(manifest.dependencies ?? {})) copyDependency(dependency);
};
for (const name of ["effect", "marked", "typebox", "partial-json", "@effect/platform-node"]) copyDependency(name);
const installedBefore = inventory(join(consumer, "node_modules"));
cpSync(new URL("./support/packed-life-codex-entry.mjs", import.meta.url), join(consumer, "entry.mjs"));
assert(process.argv[2], "Supply a staged Python interpreter path");
const compatibilityPackage = join(consumer, "node_modules/@harnessy/core/node_modules/@harnessy/capability-harnessy-v1-full");
const coreManifest = JSON.parse(readFileSync(join(consumer, "node_modules/@harnessy/core/package.json"), "utf8"));
const compatibilityManifest = JSON.parse(readFileSync(join(compatibilityPackage, "package.json"), "utf8"));
assert.equal(coreManifest.dependencies[compatibilityManifest.name], compatibilityManifest.version,
	"Core must declare the exact compatibility dependency used by ordinary Life commands");
const result = JSON.parse(run([join(consumer, "entry.mjs"), consumer, compatibilityPackage, resolve(process.argv[2])], consumer));
assert.deepEqual(inventory(join(consumer, "node_modules")), installedBefore, "Acceptance changed installed package bytes");
const evidence = { kind: "harnessy.life.installed-acceptance.v1", node: process.version, scratch, packs, dependencies: [...copied].sort(), result };
writeFileSync(join(scratch, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ passed: true, scratch, evidence: join(scratch, "evidence.json"), packages: packs.map(({ name, version, files, tarballSha256 }) => ({ name, version, files: files.length, tarballSha256 })), result }));
