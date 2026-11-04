import { builtinModules, createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

import {
  effectCompat,
  effectContextCompat,
  effectDist,
  executorSourceAliases,
} from "./build/source-aliases";

const require = createRequire(import.meta.url);
const nodeBuiltins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const bundledPackage = /^(?:agents|@modelcontextprotocol\/sdk)(?:\/.*)?$/;

const sourceAliasPlugin: Plugin = {
  name: "harnessy-engine-source-aliases",
  setup(build) {
    build.onResolve({ filter: /^effect(?:\/.+)?$/ }, (args) => {
      if (args.path === "effect") return { path: effectCompat };
      if (args.path === "effect/Context") return { path: effectContextCompat };
      const subpath = args.path.slice("effect/".length);
      const suffix = subpath.startsWith("unstable/") ? "/index.js" : ".js";
      return { path: resolve(effectDist, `${subpath}${suffix}`) };
    });
    build.onResolve({ filter: /^@executor-js\// }, (args) => {
      const replacement = executorSourceAliases[args.path as keyof typeof executorSourceAliases];
      return replacement ? { path: replacement } : undefined;
    });
    build.onResolve({ filter: /^(?:agents|@modelcontextprotocol\/sdk)(?:\/.*)?$/ }, (args) => {
      if (!bundledPackage.test(args.path)) return undefined;
      return { path: require.resolve(args.path) };
    });
    build.onResolve({ filter: /^cloudflare:/ }, (args) => ({
      path: args.path,
      external: true,
    }));
    build.onResolve({ filter: /^(?:node:)?[a-zA-Z0-9_/-]+$/ }, (args) => {
      const bare = args.path.replace(/^node:/, "");
      if (!nodeBuiltins.has(bare)) return undefined;
      return { path: `node:${bare}`, external: true };
    });
    build.onEnd((result) => {
      if (result.metafile) {
        writeFileSync(
          "/tmp/harnessy-engine-metafile.json",
          `${JSON.stringify(result.metafile, null, 2)}\n`,
        );
      }
    });
  },
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cloudflare: "src/cloudflare.ts",
  },
  format: ["esm"],
  target: "es2022",
  platform: "neutral",
  dts: true,
  splitting: false,
  clean: true,
  sourcemap: false,
  minify: false,
  external: [/^node:/, /^cloudflare:/],
  noExternal: [/.*/],
  esbuildPlugins: [sourceAliasPlugin],
  esbuildOptions(options) {
    options.metafile = true;
    options.conditions = ["worker", "browser", "import", "default"];
    options.alias = Object.fromEntries(
      [...nodeBuiltins].map((name) => [name, `node:${name}`]),
    );
  },
});
