import { builtinModules } from "node:module";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = new URL("..", import.meta.url);
const dist = new URL("../dist/", import.meta.url);
const allowedRuntimeExternal = /^(?:\.?\.?\/|node:|cloudflare:)/;
const staticImportSpecifier = /^\s*(?:import|export)\s+(?:[^"']*?\s+from\s*)?(["'])([^"']+)\1/gm;
const importCallSpecifier = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const requireCallSpecifier = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const typeReferenceSpecifier = /^\s*\/\/\/\s*<reference\s+types=(["'])([^"']+)\1/gm;

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const declaredDependencies = new Set(Object.keys(manifest.dependencies ?? {}));
for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Harnessy engine dependency ${dependency} must use an exact version, got ${version}`);
  }
}

const importSpecifiers = (source, includeDeclarationSyntax = false) => {
  const patterns = [staticImportSpecifier, importCallSpecifier];
  if (includeDeclarationSyntax) patterns.push(requireCallSpecifier, typeReferenceSpecifier);
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[2]));
};

const dependencyName = (specifier) => {
  if (!specifier.startsWith("@")) return specifier.split("/", 1)[0];
  return specifier.split("/", 2).join("/");
};

const files = await readdir(dist);
for (const required of ["index.js", "index.d.ts", "cloudflare.js", "cloudflare.d.ts"]) {
  if (!files.includes(required)) throw new Error(`Harnessy engine bundle is missing ${required}`);
}

const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
for (const file of files.filter((name) => name.endsWith(".js"))) {
  const path = new URL(file, dist);
  const source = await readFile(path, "utf8");
  const normalized = source
    .replace(
      /^(\s*import\s+[^"']*?\s+from\s+)(["'])([^"']+)\2/gm,
      (statement, prefix, quote, specifier) =>
        nodeBuiltins.has(specifier)
          ? `${prefix}${quote}node:${specifier}${quote}`
          : statement,
    )
    .replace(
      /\b(import|require)(\s*\(\s*)(["'])([^"']+)\3(\s*\))/g,
      (statement, keyword, open, quote, specifier, close) =>
        nodeBuiltins.has(specifier)
          ? `${keyword}${open}${quote}node:${specifier}${quote}${close}`
          : statement,
    );
  if (normalized !== source) await writeFile(path, normalized);
}

const audited = files.filter((file) => file.endsWith(".js") || file.endsWith(".d.ts"));
for (const file of audited) {
  const source = await readFile(new URL(file, dist), "utf8");
  const specifiers = importSpecifiers(source, file.endsWith(".d.ts"));
  if (file.endsWith(".js")) {
    for (const specifier of specifiers) {
      if (!allowedRuntimeExternal.test(specifier)) {
        throw new Error(`Harnessy engine bundle ${file} retains bare import ${specifier}`);
      }
    }
  }
  if (file.endsWith(".d.ts")) {
    for (const specifier of specifiers) {
      if (allowedRuntimeExternal.test(specifier)) continue;
      const dependency = dependencyName(specifier);
      if (!declaredDependencies.has(dependency)) {
        throw new Error(
          `Harnessy engine declaration ${file} imports undeclared dependency ${specifier}`,
        );
      }
    }
  }
}

const rootBundle = await readFile(new URL("index.js", dist), "utf8");
if (rootBundle.includes("node_modules/agents/") || rootBundle.includes("cloudflare:")) {
  throw new Error("Harnessy engine root bundle includes Cloudflare Agents or platform imports");
}

const metafile = JSON.parse(await readFile("/tmp/harnessy-engine-metafile.json", "utf8"));
const inputs = Object.keys(metafile.inputs);
if (!inputs.some((input) => input.includes("/node_modules/effect/dist/"))) {
  throw new Error("Harnessy engine metafile does not contain the root Effect runtime");
}
if (inputs.some((input) => input.includes("/executor/node_modules") && input.includes("/effect/"))) {
  throw new Error("Harnessy engine metafile contains Executor's Effect runtime");
}
if (!inputs.some((input) => input.includes("/executor/packages/"))) {
  throw new Error("Harnessy engine metafile does not contain vendored Executor source");
}
for (const [output, details] of Object.entries(metafile.outputs ?? {})) {
  for (const entry of details.imports ?? []) {
    if (
      entry.external &&
      !allowedRuntimeExternal.test(entry.path) &&
      !nodeBuiltins.has(entry.path)
    ) {
      throw new Error(`Harnessy engine metafile output ${output} retains bare import ${entry.path}`);
    }
  }
}

const sizes = {};
for (const file of files.filter((name) => /\.(?:js|d\.ts)$/.test(name))) {
  sizes[file] = (await stat(join(packageRoot.pathname, "dist", file))).size;
}
const mcpInputs = inputs.filter((input) => input.includes("@modelcontextprotocol/sdk")).length;
const agentsInputs = inputs.filter((input) => input.includes("/agents/")).length;
console.log(
  JSON.stringify(
    {
      files: sizes,
      declarationDependencies: [...declaredDependencies].sort(),
      externalImports: audited.flatMap((file) => {
        const source = metafile.outputs?.[`dist/${file}`]?.imports ?? [];
        return source
          .filter((entry) => entry.external)
          .map((entry) => (nodeBuiltins.has(entry.path) ? `node:${entry.path}` : entry.path));
      }),
      vendoredInputs: inputs.filter((input) => input.includes("/executor/packages/")).length,
      rootEffectInputs: inputs.filter((input) => input.includes("/node_modules/effect/dist/")).length,
      mcpSdkInputs: mcpInputs,
      agentsInputs,
    },
    null,
    2,
  ),
);
