import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const supportRoot = dirname(fileURLToPath(import.meta.url));
const installationRoot = process.argv[2];
const privateRoot = process.argv[3];
for (const root of [installationRoot, privateRoot]) {
	if (root === undefined || !isAbsolute(root) || resolve(root) !== root || parse(root).root === root) {
		throw new Error("Expected explicit bounded fixture roots.");
	}
}
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const outputPath = join(installationRoot, "packed-meeting-review.mjs");
const installedRuntime = join(installationRoot, "node_modules/@harnessy/core/dist/jarvis/meeting-publication/operational-runtime.js");
await build({
	entryPoints: [join(supportRoot, "packed-meeting-review-entry.mjs")],
	outfile: outputPath,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	logLevel: "silent",
	external: ["effect", "effect/*", "@harnessy/local-host/*"],
	plugins: [{ name: "installed-review-system-reference", setup(api) {
		api.onResolve({filter: /operational-runtime\.ts$/}, () => ({path: pathToFileURL(installedRuntime).href, external: true}));
	}}],
});
const result = spawnSync(process.execPath, [outputPath, installationRoot, privateRoot], {
	cwd: installationRoot, encoding: "utf8", env: {...process.env, NODE_NO_WARNINGS: "1"}, timeout: 120_000,
});
if (result.status !== 0) throw new Error(`Packed review failed: ${result.stdout}\n${result.stderr}`);
process.stdout.write(result.stdout);
