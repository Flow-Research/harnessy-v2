#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(import.meta.dir, "..");
const fumaDbRoot = resolve(repositoryRoot, "packages/core/fumadb");
const manifestPath = require.resolve("better-sqlite3/package.json", {
  paths: [fumaDbRoot],
});
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  readonly name?: string;
  readonly version?: string;
  readonly scripts?: { readonly install?: string };
};

if (
  manifest.name !== "better-sqlite3" ||
  manifest.version !== "12.10.0" ||
  manifest.scripts?.install !== "prebuild-install || node-gyp rebuild --release"
) {
  throw new Error(
    `Refusing to execute an unreviewed native install script: ${manifest.name ?? "unknown"}@${manifest.version ?? "unknown"}`,
  );
}

const build = Bun.spawnSync(["bun", "run", "install"], {
  cwd: dirname(manifestPath),
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) {
  throw new Error(`better-sqlite3 native build failed with exit code ${build.exitCode}`);
}

const smoke = Bun.spawnSync(
  [
    "node",
    "-e",
    "const Database=require('better-sqlite3');const db=new Database(':memory:');db.exec('select 1');db.close();",
  ],
  { cwd: fumaDbRoot, stdout: "inherit", stderr: "inherit" },
);
if (smoke.exitCode !== 0) {
  throw new Error(`better-sqlite3 Node smoke test failed with exit code ${smoke.exitCode}`);
}

console.log(`Trusted native dependency ready: better-sqlite3@${manifest.version}.`);
