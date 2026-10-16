#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentExecutorPlatformTag, executorReleasePackages } from "./harnessy-release-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Build, npm, and the installed wrapper are Node scripts. Avoid Windows command
// shims and shell quoting; the production Core launcher uses this same boundary.
export const runNodeScript = (script, args, options = {}) => {
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`${process.execPath} ${script} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
	}
	return result.stdout ?? "";
};

export const requireNpmCliPath = (npmExecPath = process.env.npm_execpath) => {
	if (
		typeof npmExecPath !== "string" ||
		!isAbsolute(npmExecPath) ||
		basename(npmExecPath) !== "npm-cli.js" ||
		!statSync(npmExecPath, { throwIfNoEntry: false })?.isFile()
	) {
		throw new Error("Run npm run test:executor-package-integration; npm_execpath must identify npm's CLI script");
	}
	return npmExecPath;
};

const fileSpecifier = (fromDirectory, file) => {
	const path = relative(fromDirectory, file).replaceAll("\\", "/");
	return `file:${path.startsWith(".") ? path : `./${path}`}`;
};

const pack = (npmCli, descriptor, destination) => {
	const output = runNodeScript(npmCli, ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
		capture: true,
		cwd: join(repoRoot, descriptor.directory),
	});
	const packed = JSON.parse(output)[0];
	const paths = new Set(packed.files.map((file) => file.path));
	for (const requiredFile of descriptor.requiredFiles) {
		if (!paths.has(requiredFile)) throw new Error(`${descriptor.key ?? descriptor.name} is missing ${requiredFile}`);
	}
	return join(destination, packed.filename);
};

const main = () => {
	const npmCli = requireNpmCliPath();
	const temporaryRoot = mkdtempSync(join(tmpdir(), "harnessy-executor-package-"));
	try {
		runNodeScript(join(repoRoot, "scripts", "build-harnessy-executor.mjs"), []);

		const tag = currentExecutorPlatformTag();
		const descriptors = executorReleasePackages([tag]);
		const variant = descriptors.find((descriptor) => descriptor.executorPlatformTag === tag);
		const wrapper = descriptors.find((descriptor) => descriptor.executorPlatformTag === undefined);
		if (variant === undefined || wrapper === undefined) throw new Error(`Release contract is incomplete for ${tag}`);

		const tarballDirectory = join(temporaryRoot, "tarballs");
		const installDirectory = join(temporaryRoot, "consumer");
		mkdirSync(tarballDirectory, { recursive: true });
		mkdirSync(installDirectory, { recursive: true });
		const variantTarball = pack(npmCli, variant, tarballDirectory);
		const wrapperTarball = pack(npmCli, wrapper, tarballDirectory);
		const dependencies = {
			[wrapper.name]: fileSpecifier(installDirectory, wrapperTarball),
			[variant.installName]: fileSpecifier(installDirectory, variantTarball),
		};
		writeFileSync(
			join(installDirectory, "package.json"),
			`${JSON.stringify({ private: true, dependencies, overrides: dependencies }, null, 2)}\n`,
		);
		runNodeScript(npmCli, ["install", "--omit=dev", "--ignore-scripts"], { cwd: installDirectory });
		runNodeScript(npmCli, ["audit", "--omit=dev", "--audit-level=moderate"], { cwd: installDirectory });

		const wrapperDirectory = join(installDirectory, "node_modules", "@harnessy", "executor");
		const wrapperManifest = JSON.parse(readFileSync(join(wrapperDirectory, "package.json"), "utf8"));
		if (wrapperManifest.name !== "@harnessy/executor") throw new Error("Installed wrapper identity is not scoped to Harnessy");
		if (wrapperManifest.bin?.["harnessy-executor"] !== "bin/harnessy-executor") {
			throw new Error("Installed wrapper is missing the Harnessy Executor bin mapping");
		}
		const binary = join(wrapperDirectory, "bin", "harnessy-executor");
		if (!statSync(binary).isFile()) throw new Error("Installed wrapper bin is not a file");
		const versionOutput = runNodeScript(binary, ["--version"], { capture: true, cwd: installDirectory });
		if (!/executor v\d+\.\d+\.\d+/.test(versionOutput)) {
			throw new Error(`Packaged Harnessy Executor returned an unexpected version: ${versionOutput.trim()}`);
		}
		console.log(`Harnessy Executor package integration passed on ${tag}: ${versionOutput.trim()}`);
	} finally {
		rmSync(temporaryRoot, { force: true, recursive: true });
	}
};

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
