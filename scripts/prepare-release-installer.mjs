import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

/** Ship existing installation logic with the tarballs, without a repository dependency. */
export function prepareReleaseInstaller(directory, packages, tarballs) {
	const core = JSON.parse(readFileSync(new URL("../packages/harnessy-core/package.json", import.meta.url), "utf8"));
	const manifest = { version: 1, platform: process.platform, arch: process.arch, node: core.engines.node, packages: packages.map(pkg => {
		const path = tarballs.get(pkg.key ?? pkg.name);
		return { name: pkg.installName ?? pkg.name, file: relative(directory, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
	}) };
	buildSync({ entryPoints: [fileURLToPath(new URL("./install-release.mjs", import.meta.url))], outfile: join(directory, "install.mjs"),
		bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
	writeFileSync(join(directory, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
