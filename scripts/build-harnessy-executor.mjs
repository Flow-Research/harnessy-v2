#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	assertHarnessyExecutorRuntimeFiles,
	harnessyExecutorVariantManifest,
	harnessyExecutorWrapperManifest,
} from "./harnessy-executor-package-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executorRoot = join(repoRoot, "executor");
const executorDist = join(executorRoot, "apps", "cli", "dist");
const wrapperSource = join(repoRoot, "packages", "harnessy-executor");
const wrapperOutput = join(executorDist, "harnessy-executor");
const allPlatforms = process.argv.includes("--all");
const unknownArgs = process.argv.slice(2).filter((argument) => argument !== "--all");
if (unknownArgs.length > 0) throw new Error("Usage: node scripts/build-harnessy-executor.mjs [--all]");

const sourceManifest = JSON.parse(readFileSync(join(wrapperSource, "package.json"), "utf8"));
if (sourceManifest.name !== "@harnessy/executor" || sourceManifest.license !== "MIT") {
	throw new Error("packages/harnessy-executor must declare @harnessy/executor under the inherited MIT license");
}

const result = spawnSync(
	"bun",
	["run", "apps/cli/src/build.ts", "binary", ...(allPlatforms ? [] : ["--single"])],
	{
		cwd: executorRoot,
		encoding: "utf8",
		env: { ...process.env, EXECUTOR_VERSION: sourceManifest.version },
		stdio: "inherit",
	},
);
if (result.status !== 0) throw new Error(`Executor binary build exited with code ${String(result.status)}`);

const tags = [];
for (const entry of readdirSync(executorDist, { withFileTypes: true })) {
	if (!entry.isDirectory() || !entry.name.startsWith("executor-") || entry.name === "executor") continue;
	const tag = entry.name.slice("executor-".length);
	const variantRoot = join(executorDist, entry.name);
	const manifestPath = join(variantRoot, "package.json");
	if (!existsSync(manifestPath)) continue;
	const upstream = JSON.parse(readFileSync(manifestPath, "utf8"));
	const manifest = harnessyExecutorVariantManifest({ upstream, version: sourceManifest.version, tag });
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	cpSync(join(executorRoot, "LICENSE"), join(variantRoot, "LICENSE"));
	const binary = join(variantRoot, "bin", tag.startsWith("windows-") ? "executor.exe" : "executor");
	if (!existsSync(binary)) throw new Error(`Harnessy Executor variant ${tag} is missing ${binary}`);
	const variantFiles = readdirSync(variantRoot, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(variantRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
	assertHarnessyExecutorRuntimeFiles({ tag, files: variantFiles });
	tags.push(tag);
}
if (tags.length === 0) throw new Error("Executor build produced no platform variants");

rmSync(wrapperOutput, { recursive: true, force: true });
mkdirSync(join(wrapperOutput, "bin"), { recursive: true });
for (const path of ["LICENSE", "README.md"]) cpSync(join(wrapperSource, path), join(wrapperOutput, path));
for (const path of ["harnessy-executor", "platform.cjs"]) {
	cpSync(join(wrapperSource, "bin", path), join(wrapperOutput, "bin", path));
}
writeFileSync(
	join(wrapperOutput, "package.json"),
	`${JSON.stringify(harnessyExecutorWrapperManifest({ source: sourceManifest, tags }), null, 2)}\n`,
);

process.stdout.write(
	`${JSON.stringify(
		{
			ok: true,
			version: sourceManifest.version,
			wrapper: wrapperOutput,
			variants: tags.sort().map((tag) => ({ tag, directory: join(executorDist, `executor-${tag}`) })),
		},
		null,
		2,
	)}\n`,
);
