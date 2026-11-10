import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";

import { generateCloudflareTypes } from "../tools/cloudflare-types.mjs";

const prepare = async (context) => {
  const root = await mkdtemp(join(tmpdir(), "harnessy-cloudflare-types-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "worker.d.ts"),
    [
      "// Runtime types generated with workerd@1.20261006.0 2026-07-01 nodejs_compat",
      "declare var onmessage: never;",
      "interface Crypto { readonly subtle: unknown }",
      "declare const crypto: Crypto;",
      "declare class Blob {}",
      "declare class File extends Blob {}",
      'declare namespace Cloudflare { interface Env { service: import("./src/worker").Service } }',
    ].join("\n"),
  );
  return { root, options: { projectRoot: root, input: "worker.d.ts", output: ".engine-types" } };
};

test("generation is repeatable, inventories its type closure, and preserves source bytes", async (context) => {
  const { root, options } = await prepare(context);
  const before = await readFile(join(root, "worker.d.ts"));
  const first = await generateCloudflareTypes(options);
  const second = await generateCloudflareTypes(options);
  assert.deepEqual(first, second);
  assert.deepEqual(await readFile(join(root, "worker.d.ts")), before);
  assert.ok(first.files.some((file) => file.path === "node/LICENSE"));
  assert.ok(first.files.some((file) => file.path === "node/node_modules/undici-types/LICENSE"));
  const runtime = await readFile(join(root, ".engine-types/runtime.d.ts"), "utf8");
  assert.match(runtime, /declare var crypto: Crypto/);
  assert.match(runtime, /import\("\.\.\/src\/worker"\)/);
  assert.doesNotMatch(runtime, /declare (var|const|class) FileList/);
  for (const file of first.files.filter((entry) => entry.path.endsWith(".d.ts"))) {
    const source = await readFile(join(root, ".engine-types", file.path), "utf8");
    const ast = ts.createSourceFile(file.path, source, ts.ScriptTarget.Latest, true);
    assert.equal(ast.parseDiagnostics.length, 0, `Invalid generated declaration: ${file.path}`);
  }
});

test("edited output and extra files survive a refused regeneration", async (context) => {
  const { root, options } = await prepare(context);
  await generateCloudflareTypes(options);
  const edited = join(root, ".engine-types/node/index.d.ts");
  await writeFile(edited, "// user edit must survive\n");
  await assert.rejects(generateCloudflareTypes(options), /Generated output was edited/);
  assert.equal(await readFile(edited, "utf8"), "// user edit must survive\n");
  await writeFile(join(root, ".engine-types/notes.txt"), "retained note");
  await assert.rejects(generateCloudflareTypes(options), /unowned files/);
  assert.equal(await readFile(join(root, ".engine-types/notes.txt"), "utf8"), "retained note");
});

test("unowned directories and paths outside the project are refused", async (context) => {
  const { root, options } = await prepare(context);
  await mkdir(join(root, ".engine-types"));
  await writeFile(join(root, ".engine-types/notes.txt"), "keep me");
  await assert.rejects(generateCloudflareTypes(options));
  assert.equal(await readFile(join(root, ".engine-types/notes.txt"), "utf8"), "keep me");
  await assert.rejects(
    generateCloudflareTypes({ ...options, output: "../outside" }),
    /bounded project paths/,
  );
  await assert.rejects(
    generateCloudflareTypes({ ...options, output: "." }),
    /bounded project paths/,
  );
});

test("an output parent symlink cannot redirect writes", async (context) => {
  const { root, options } = await prepare(context);
  const outside = await mkdtemp(join(tmpdir(), "harnessy-cloudflare-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "redirect"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    generateCloudflareTypes({ ...options, output: "redirect/generated" }),
    /Output parent/,
  );
});
