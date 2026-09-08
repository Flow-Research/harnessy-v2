import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(new URL("..", import.meta.url).pathname);
const fixtureSource = join(packageRoot, "test/fixtures/cloudflare-worker");
const allowedRuntimeExternal = /^(?:node:|cloudflare:)/;
const staticImportSpecifier = /^\s*(?:import|export)\s+(?:[^"']*?\s+from\s*)?(["'])([^"']+)\1/gm;
const temporaryRoot = await mkdtemp(join(tmpdir(), "harnessy-engine-fixture-"));
const fixtureRoot = join(temporaryRoot, "consumer");
const artifactRoot = join(temporaryRoot, "artifacts");

const run = (cwd, command, args, capture = false) =>
  new Promise((resolveRun, reject) => {
    const output = [];
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: process.env,
    });
    child.stdout?.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun(Buffer.concat(output).toString("utf8"));
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });

try {
  await cp(fixtureSource, fixtureRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  const packOutput = await run(
    packageRoot,
    "npm",
    ["pack", "--ignore-scripts", "--pack-destination", artifactRoot, "--json"],
    true,
  );
  const [{ filename }] = JSON.parse(packOutput);
  if (typeof filename !== "string" || !filename.endsWith(".tgz")) {
    throw new Error(`npm pack did not produce a tarball: ${packOutput}`);
  }

  const manifestPath = join(fixtureRoot, "package.json");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(
    manifestPath,
    manifest.replace("file:HARNESSY_ENGINE_TARBALL", `file:../artifacts/${filename}`),
  );

  await run(fixtureRoot, "npm", ["install", "--ignore-scripts"]);
  await run(fixtureRoot, "npm", ["audit", "--audit-level=moderate"]);
  const installedPackageRoot = await realpath(join(fixtureRoot, "node_modules/@harnessy/engine"));
  if (installedPackageRoot.startsWith(packageRoot)) {
    throw new Error(`Fixture resolved @harnessy/engine to monorepo source: ${installedPackageRoot}`);
  }
  await run(fixtureRoot, "npm", ["run", "typecheck"]);
  await run(fixtureRoot, "npm", ["run", "dry-run"]);

  const outputRoot = join(fixtureRoot, ".wrangler-output");
  const outputFiles = await readdir(outputRoot, { recursive: true });
  for (const file of outputFiles) {
    const path = join(outputRoot, file);
    if (!file.endsWith(".js")) continue;
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(staticImportSpecifier)) {
      const specifier = match[2];
      if (!allowedRuntimeExternal.test(specifier)) {
        throw new Error(`Wrangler output ${file} leaked bare runtime import ${specifier}`);
      }
    }
  }
  console.log(
    `Harnessy engine packed-artifact fixture passed (${outputFiles.length} dry-run files; ${installedPackageRoot}).`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
