#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentExecutorPlatformTag, packedReleasePackages } from "./harnessy-release-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "harnessy-release-"));
const artifactRoot = join(temporaryRoot, "artifacts");
const consumerRoot = join(temporaryRoot, "consumer");
const projectRoot = join(temporaryRoot, "project");
const platformTag = currentExecutorPlatformTag();
const executorVariantAlias = `@harnessy/executor-${platformTag}`;
const packages = packedReleasePackages([platformTag]);

const commandForPlatform = (command) => (process.platform === "win32" ? `${command}.cmd` : command);

const run = (command, args, options = {}) => {
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		env: options.env ?? process.env,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
	}
	return result.stdout ?? "";
};

const fileSpecifier = (fromDirectory, path) => {
	const relativePath = relative(fromDirectory, path).replaceAll("\\", "/");
	return `file:${relativePath.startsWith(".") ? relativePath : `./${relativePath}`}`;
};

const assertJsonOk = (label, output) => {
	const payload = JSON.parse(output);
	if (payload.ok !== true) throw new Error(`${label} did not return ok=true: ${output}`);
};

try {
	mkdirSync(artifactRoot, { recursive: true });
	mkdirSync(consumerRoot, { recursive: true });
	mkdirSync(projectRoot, { recursive: true });
	run(process.execPath, [join(repoRoot, "scripts/build-harnessy-executor.mjs")]);

	const tarballs = new Map();
	for (const pkg of packages) {
		const packageRoot = join(repoRoot, pkg.directory);
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		if (manifest.name !== pkg.name) {
			throw new Error(`${pkg.directory} is ${String(manifest.name)}, expected ${pkg.name}`);
		}
		for (const [path, expected] of Object.entries(pkg.requiredText ?? {})) {
			const content = readFileSync(join(packageRoot, path), "utf8");
			if (!content.includes(expected)) throw new Error(`${pkg.name} build output ${path} is stale or missing ${expected}`);
		}

		const output = run(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", artifactRoot, "--json"],
			{ capture: true, cwd: packageRoot },
		);
		const [packed] = JSON.parse(output);
		const packedPaths = new Set(packed.files.map((file) => file.path));
		for (const requiredFile of pkg.requiredFiles) {
			if (!packedPaths.has(requiredFile)) {
				throw new Error(`${pkg.name} tarball is missing ${requiredFile}`);
			}
		}
		tarballs.set(pkg.key ?? pkg.name, join(artifactRoot, packed.filename));
	}

	const dependencies = Object.fromEntries(
		packages.map((pkg) => [pkg.installName ?? pkg.name, fileSpecifier(consumerRoot, tarballs.get(pkg.key ?? pkg.name))]),
	);
	writeFileSync(
		join(consumerRoot, "package.json"),
		`${JSON.stringify({ name: "harnessy-release-consumer", private: true, dependencies, overrides: dependencies }, undefined, "\t")}\n`,
	);

	run("npm", ["install", "--omit=dev", "--ignore-scripts"], { cwd: consumerRoot });
	run("npm", ["audit", "--omit=dev", "--audit-level=moderate"], { cwd: consumerRoot });

	const installedRoots = new Map();
	for (const pkg of packages.filter((candidate) => candidate.name.startsWith("@harnessy/"))) {
		const installName = pkg.installName ?? pkg.name;
		const installedRoot = realpathSync(join(consumerRoot, "node_modules", ...installName.split("/")));
		if (installedRoot.startsWith(repoRoot)) {
			throw new Error(`${installName} resolved to monorepo source instead of its tarball: ${installedRoot}`);
		}
		installedRoots.set(installName, installedRoot);
	}

	const binRoot = join(consumerRoot, "node_modules", ".bin");
	const harnessyBin = join(binRoot, process.platform === "win32" ? "harnessy.cmd" : "harnessy");
	const hsyBin = join(binRoot, process.platform === "win32" ? "hsy.cmd" : "hsy");
	if (!existsSync(harnessyBin) || !existsSync(hsyBin)) {
		throw new Error("Packed @harnessy/core did not install the harnessy and hsy binaries");
	}
	const harnessyHelp = run(harnessyBin, ["--help"], { capture: true, cwd: projectRoot });
	if (!harnessyHelp.includes("Harnessy")) throw new Error("Packed harnessy --help did not identify Harnessy");
	const hsyHelp = run(hsyBin, ["--help"], { capture: true, cwd: projectRoot });
	if (!hsyHelp.includes("Harnessy agent-first context engine")) {
		throw new Error("Packed hsy --help did not identify the Harnessy agent runtime");
	}
	run(harnessyBin, ["init", "--target", projectRoot], { cwd: projectRoot });

	for (const packageName of [
		"@harnessy/capability-harnessy-v1-full",
		"@harnessy/capability-org-knowledge",
	]) {
		const capabilityRoot = realpathSync(join(consumerRoot, "node_modules", ...packageName.split("/")));
		run(harnessyBin, ["capability", "add", capabilityRoot, "--target", projectRoot], { cwd: projectRoot });
	}
	assertJsonOk(
		"capability materialization",
		run(harnessyBin, ["capability", "materialize", "--refresh", "--target", projectRoot, "--json"], {
			capture: true,
			cwd: projectRoot,
		}),
	);
	assertJsonOk(
		"project verification",
		run(harnessyBin, ["verify", "--target", projectRoot, "--json"], { capture: true, cwd: projectRoot }),
	);

	const installedCoreRoot = installedRoots.get("@harnessy/core");
	if (installedCoreRoot === undefined) throw new Error("Packed @harnessy/core was not installed");
	const installedExecutorRoot = installedRoots.get("@harnessy/executor");
	if (installedExecutorRoot === undefined) throw new Error("Packed @harnessy/executor was not installed");
	run(process.execPath, [join(repoRoot, "scripts/check-harnessy-cockpit.mjs")], {
		cwd: projectRoot,
		env: {
			...process.env,
			HARNESSY_COCKPIT_CLI_JS: join(installedCoreRoot, "dist", "cli.js"),
			HARNESSY_COCKPIT_EXECUTOR_JS: join(installedExecutorRoot, "bin", "harnessy-executor"),
			HARNESSY_COCKPIT_LABEL: "packed",
			HARNESSY_COCKPIT_SCOPE: projectRoot,
		},
	});

	console.log(
		`Harnessy release smoke passed: ${packages.length} packed packages, audited isolated install, two CLI binaries, two materialized capabilities, and a live packed cockpit (${basename(temporaryRoot)}).`,
	);
} finally {
	if (process.env.HARNESSY_KEEP_RELEASE_TEMP === "1") {
		console.error(`Preserved release fixture for diagnosis: ${temporaryRoot}`);
	} else {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
}
