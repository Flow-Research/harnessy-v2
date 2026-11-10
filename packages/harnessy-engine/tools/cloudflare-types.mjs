#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import ts from "typescript";

const require = createRequire(import.meta.url);
const owner = "@harnessy/engine/cloudflare-types";
const nodeVersion = "22.19.19";
const undiciVersion = "6.21.0";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (root, path) => {
  const distance = relative(root, path);
  return (
    distance !== "" &&
    distance !== ".." &&
    !distance.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(distance)
  );
};

/** Read the exact installed type-support package; no package code is executed. */
const packageSource = async (name, expectedVersion) => {
  const manifestPath = require.resolve(`${name}/package.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== expectedVersion) throw new Error(`Expected ${name}@${expectedVersion}`);
  return dirname(manifestPath);
};

/** List regular files only. A symlink must not redirect generated type input. */
const filesUnder = async (root, includeDependencies = false) => {
  const result = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" && !includeDependencies) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Type support contains a symlink");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) result.push(path);
    }
  };
  await visit(root);
  return result.sort();
};

/** Hash the unmodified upstream file inventory without recording machine paths. */
const sourceDigest = async (root) => {
  const entries = await Promise.all(
    (await filesUnder(root)).map(async (path) => ({
      path: relative(root, path).replaceAll("\\", "/"),
      sha256: hash(await readFile(path)),
    })),
  );
  return hash(JSON.stringify(entries));
};

const applyEdits = (source, edits) =>
  edits
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);

/**
 * Keep Wrangler's host declarations. Correct four actual global-object bindings
 * and rebase application imports when the generated copy moves directories.
 * A const ambient binding does not appear on typeof globalThis in TypeScript.
 */
const workerDeclarations = (source, input, output) => {
  const ast = ts.createSourceFile(input, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error("Invalid Worker declarations");
  const names = new Set();
  const edits = [];
  const normalized = [];
  for (const statement of ast.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        names.add(declaration.name.text);
        if (
          ["console", "crypto", "performance", "navigator"].includes(declaration.name.text) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
        ) {
          edits.push({
            start: statement.declarationList.getStart(ast),
            end: statement.declarationList.getStart(ast) + 5,
            text: "var",
          });
          normalized.push(declaration.name.text);
        }
      }
    } else if (statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text);
  }
  const visit = (node) => {
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const specifier = node.argument.literal;
      if (specifier.text.startsWith(".")) {
        const rebased = relative(
          dirname(output),
          resolve(dirname(input), specifier.text),
        ).replaceAll("\\", "/");
        edits.push({
          start: specifier.getStart(ast),
          end: specifier.end,
          text: JSON.stringify(rebased.startsWith(".") ? rebased : `./${rebased}`),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  // These are type-only browser inputs in Agents' optional AI declarations.
  // Do not declare browser constructors or imply that Workers supplies a DOM.
  const browserInputs = [
    !names.has("FileList")
      ? "interface FileList { readonly length: number; item(index: number): File | null; readonly [index: number]: File; }"
      : "",
    !names.has("RequestCredentials")
      ? 'type RequestCredentials = "include" | "omit" | "same-origin";'
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    names,
    normalized,
    text: `${applyEdits(source, edits)}\n// Structural browser inputs only; no runtime constructors.\n${browserInputs}\n`,
  };
};

/**
 * Workers owns web globals; Node owns its module and NodeJS declarations.
 * Keep supported performance constructors with their concrete Node module type.
 * BroadcastChannel is absent from the qualified Worker runtime; do not invent it.
 */
const nodeDeclarations = (source, path, hostNames, changes) => {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = (node, global) => {
    if (ts.isModuleDeclaration(node)) {
      if (node.body) visit(node.body, (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0);
      return;
    }
    if (global) {
      const declared = ts.isVariableStatement(node)
        ? node.declarationList.declarations
            .map((item) => item.name)
            .filter(ts.isIdentifier)
            .map((name) => name.text)
        : node.name && ts.isIdentifier(node.name)
          ? [node.name.text]
          : [];
      if (
        declared.length &&
        declared.every((name) => hostNames.has(name) || name === "BroadcastChannel")
      ) {
        edits.push({ start: node.getStart(ast), end: node.end, text: "" });
        changes.push({
          path,
          names: declared,
          action: declared.includes("BroadcastChannel")
            ? "unsupported-worker-global"
            : "host-owns-global",
        });
        return;
      }
      if (ts.isVariableStatement(node))
        for (const declaration of node.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text.startsWith("Performance") &&
            declaration.type &&
            ts.isConditionalTypeNode(declaration.type)
          ) {
            edits.push({
              start: declaration.type.getStart(ast),
              end: declaration.type.end,
              text: declaration.type.falseType.getText(ast),
            });
            changes.push({
              path,
              names: [declaration.name.text],
              action: "node-module-constructor",
            });
          }
        }
    }
    // Only statements directly in the global scope are global declarations.
    // A same-named property inside a conditional type must remain intact.
    const globalStatements = global && (ts.isSourceFile(node) || ts.isModuleBlock(node));
    ts.forEachChild(node, (child) => visit(child, globalStatements));
  };
  visit(ast, !ts.isExternalModule(ast));
  const result = applyEdits(source, edits);
  if (ts.createSourceFile(path, result, ts.ScriptTarget.Latest, true).parseDiagnostics.length) {
    throw new Error(`Invalid generated Node declaration: ${path}`);
  }
  return result;
};

/** Refuse user edits and extra files before replacing a previous owned output. */
const checkOwnedOutput = async (output) => {
  const metadata = await lstat(output).catch((error) =>
    error.code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (!metadata) return false;
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Output is not an owned directory");
  const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
  if (manifest.owner !== owner || manifest.schemaVersion !== 1)
    throw new Error("Output ownership does not match");
  const actual = (await filesUnder(output, true)).map((path) =>
    relative(output, path).replaceAll("\\", "/"),
  );
  const expected = new Set([...manifest.files.map((file) => file.path), "manifest.json"]);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path)))
    throw new Error("Output contains unowned files");
  for (const file of manifest.files) {
    const path = resolve(output, file.path);
    if (!within(output, path) || hash(await readFile(path)) !== file.sha256)
      throw new Error("Generated output was edited");
  }
  return true;
};

/** Generate an auditable, project-local host profile without editing dependencies. */
export const generateCloudflareTypes = async ({ input, output, projectRoot = process.cwd() }) => {
  const root = realpathSync(projectRoot);
  const inputPath = realpathSync(resolve(root, input));
  const outputPath = resolve(root, output);
  if (!within(root, inputPath) || !within(root, outputPath) || within(outputPath, inputPath))
    throw new Error("Type paths must be bounded project paths");
  for (let parent = dirname(outputPath); relative(root, parent) !== ""; parent = dirname(parent)) {
    const metadata = await lstat(parent).catch((error) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink()))
      throw new Error("Output parent must be a project directory");
  }
  const raw = await readFile(inputPath, "utf8");
  if (!raw.includes("Runtime types generated with workerd@"))
    throw new Error("Input must be generated by Wrangler");
  const nodeSource = await packageSource("@types/node", nodeVersion);
  const undiciSource = await packageSource("undici-types", undiciVersion);
  const owned = await checkOwnedOutput(outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  const staging = await mkdtemp(join(dirname(outputPath), ".harnessy-engine-types-"));
  const changes = [];
  try {
    const runtime = workerDeclarations(raw, inputPath, join(outputPath, "runtime.d.ts"));
    await writeFile(join(staging, "runtime.d.ts"), runtime.text);
    await cp(nodeSource, join(staging, "node"), {
      recursive: true,
      filter: (path) => !relative(nodeSource, path).split(/[\\/]/).includes("node_modules"),
    });
    for (const path of await filesUnder(join(staging, "node"))) {
      if (!path.endsWith(".d.ts")) continue;
      const text = await readFile(path, "utf8");
      await writeFile(
        path,
        nodeDeclarations(
          text,
          relative(staging, path).replaceAll("\\", "/"),
          runtime.names,
          changes,
        ),
      );
    }
    await cp(undiciSource, join(staging, "node", "node_modules", "undici-types"), {
      recursive: true,
    });
    // Include the nested, exact Undici type closure in the output inventory.
    const files = await filesUnder(staging, true);
    const inventory = await Promise.all(
      files.sort().map(async (path) => ({
        path: relative(staging, path).replaceAll("\\", "/"),
        sha256: hash(await readFile(path)),
      })),
    );
    const manifest = {
      schemaVersion: 1,
      owner,
      nodeVersion,
      undiciVersion,
      nodeSourceSha256: await sourceDigest(nodeSource),
      undiciSourceSha256: await sourceDigest(undiciSource),
      runtimeInputSha256: hash(raw),
      normalizedRuntimeGlobals: runtime.normalized,
      changes,
      files: inventory,
    };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (owned) {
      // Recheck immediately before replacement; do not erase edits made mid-build.
      await checkOwnedOutput(outputPath);
      const previous = `${staging}.previous`;
      await rename(outputPath, previous);
      try {
        await rename(staging, outputPath);
      } catch (error) {
        await rename(previous, outputPath);
        throw error;
      }
      await rm(previous, { recursive: true });
    } else await rename(staging, outputPath);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { values } = parseArgs({
    options: { input: { type: "string" }, output: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help)
    console.log(
      "harnessy-engine-types --input worker-configuration.d.ts --output .harnessy-engine-types",
    );
  else {
    if (!values.input || !values.output) throw new Error("Both --input and --output are required");
    const manifest = await generateCloudflareTypes({ input: values.input, output: values.output });
    console.log(
      JSON.stringify({
        owner,
        nodeVersion,
        files: manifest.files.length,
        declarationChanges: manifest.changes.length,
      }),
    );
  }
}
