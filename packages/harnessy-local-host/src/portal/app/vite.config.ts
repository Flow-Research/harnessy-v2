/**
 * Builds the Harnessy app into `dist/portal-app/`.
 *
 * The output must run under the portal's unchanged CSP (`default-src 'self';
 * script-src 'self'; style-src 'self'`): no inline script (the module-preload
 * polyfill is off), no inline asset as a `data:` URL, one extracted stylesheet
 * and no source maps. After the bundle is written, `asset-manifest.json` lists
 * every emitted file with its byte length and SHA-256; the portal serves only
 * those files and only when every digest matches.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
const outDir = fileURLToPath(new URL("../../../dist/portal-app/", import.meta.url));
const require = createRequire(import.meta.url);
const packageDir = (name: string) => dirname(require.resolve(`${name}/package.json`));

/** Bundled third-party code and fonts, with the license each ships. */
const NOTICE_PACKAGES = [
	["react", "LICENSE"],
	["react-dom", "LICENSE"],
	["scheduler", "LICENSE"],
	["lucide-react", "LICENSE"],
	["@fontsource/ibm-plex-sans", "LICENSE"],
	["@fontsource/space-grotesk", "LICENSE"],
	["@fontsource/jetbrains-mono", "LICENSE"],
] as const;

const listFiles = (directory: string): string[] =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)],
	);

/** Write `THIRD_PARTY_NOTICES.txt` and `asset-manifest.json` once the bundle is on disk. */
const assetManifest = (): Plugin => ({
	name: "harnessy-asset-manifest",
	apply: "build",
	closeBundle(error?: Error) {
		// A failed build reports its own error; there is no bundle to list.
		if (error !== undefined || !existsSync(join(outDir, "index.html"))) return;
		const notices = NOTICE_PACKAGES.map(([name, file]) => {
			const root = packageDir(name);
			const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
				version: string;
				license: string;
			};
			return `${name}@${manifest.version} (${manifest.license})\n\n${readFileSync(join(root, file), "utf8").trim()}\n`;
		});
		writeFileSync(
			join(outDir, "THIRD_PARTY_NOTICES.txt"),
			`Third-party software and fonts bundled in the Harnessy app.\n\n${notices.join(`\n${"-".repeat(72)}\n\n`)}`,
		);
		const files: Record<string, { sha256: string; bytes: number }> = {};
		for (const path of listFiles(outDir).sort()) {
			const name = relative(outDir, path).split("\\").join("/");
			if (name === "asset-manifest.json") continue;
			const body = readFileSync(path);
			files[name] = { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.byteLength };
		}
		writeFileSync(
			join(outDir, "asset-manifest.json"),
			`${JSON.stringify({ schema: "harnessy.portal.asset-manifest.v1", files }, null, "\t")}\n`,
		);
	},
});

export default defineConfig({
	root: appRoot,
	base: "/",
	logLevel: "warn",
	publicDir: false,
	resolve: {
		alias: {
			"@fonts/plex": join(packageDir("@fontsource/ibm-plex-sans"), "files"),
			"@fonts/grotesk": join(packageDir("@fontsource/space-grotesk"), "files"),
			"@fonts/mono": join(packageDir("@fontsource/jetbrains-mono"), "files"),
		},
	},
	oxc: { jsx: { runtime: "automatic", importSource: "react" } },
	build: {
		outDir,
		emptyOutDir: true,
		sourcemap: false,
		// A `data:` URL would need `font-src`/`img-src data:`; every asset stays a same-origin file.
		assetsInlineLimit: 0,
		cssCodeSplit: false,
		// esbuild ships a native binary for every CI platform in the lockfile; lightningcss's are not installed.
		cssMinify: "esbuild",
		// The polyfill is an inline script, which `script-src 'self'` blocks.
		modulePreload: { polyfill: false },
		target: "es2022",
		reportCompressedSize: false,
		rolldownOptions: {
			output: {
				entryFileNames: "assets/[name]-[hash].js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name]-[hash][extname]",
			},
		},
	},
	plugins: [assetManifest()],
});
