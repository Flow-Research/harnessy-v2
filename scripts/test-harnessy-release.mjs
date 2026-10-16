#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentExecutorPlatformTag, localReleasePackages } from "./harnessy-release-contract.mjs";
import { prepareReleaseInstaller } from "./prepare-release-installer.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "harnessy-release-"));
const artifactRoot = join(temporaryRoot, "artifacts");
const consumerRoot = join(temporaryRoot, "consumer");
const projectRoot = join(temporaryRoot, "project");
const platformTag = currentExecutorPlatformTag();
const packages = localReleasePackages([platformTag]);

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

const assertJsonOk = (label, output) => {
	const payload = JSON.parse(output);
	if (payload.ok !== true) throw new Error(`${label} did not return ok=true: ${output}`);
};

try {
	run(process.execPath, ["--test", join(repoRoot, "scripts/v1-npm-transport.test.mjs"), join(repoRoot, "scripts/install-local-jarvis-runtime.test.mjs"), join(repoRoot, "scripts/stage-local-service-runtime.test.mjs"), join(repoRoot, "scripts/install-release.test.mjs")]);
	mkdirSync(artifactRoot, { recursive: true });
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

	prepareReleaseInstaller(temporaryRoot, packages, tarballs);
	run(process.execPath, [join(temporaryRoot, "install.mjs"), "--check"], { cwd: projectRoot });
	run(process.execPath, [join(temporaryRoot, "install.mjs"), "--target", consumerRoot], { cwd: projectRoot });
	run(process.execPath, [join(repoRoot, "packages/harnessy-local-host/scripts/test-fixture.mjs"), join(consumerRoot, "node_modules")]);

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
	const commandRoot = process.platform === "win32" ? binRoot : join(consumerRoot, "bin");
	for (const name of ["harnessy-meeting-setup", "harnessy-meeting-full-review", "harnessy-meeting-review-open", "harnessy-community-publication"]) {
		if (!existsSync(join(commandRoot, process.platform === "win32" ? `${name}.cmd` : name))) {
			throw new Error(`Local operational candidate did not install ${name}`);
		}
	}
	const harnessyBin = join(commandRoot, process.platform === "win32" ? "harnessy.cmd" : "harnessy");
	const hsyBin = join(commandRoot, process.platform === "win32" ? "hsy.cmd" : "hsy");
	if (!existsSync(harnessyBin) || !existsSync(hsyBin)) {
		throw new Error("Packed @harnessy/core did not install the harnessy and hsy binaries");
	}
	const commandEnv = process.platform === "win32" ? process.env : { ...process.env, PATH: "/nonexistent" };
	const harnessyHelp = run(harnessyBin, ["--help"], { capture: true, cwd: projectRoot, env: commandEnv });
	if (!harnessyHelp.includes("Harnessy")) throw new Error("Packed harnessy --help did not identify Harnessy");
	const hsyHelp = run(hsyBin, ["--help"], { capture: true, cwd: projectRoot, env: commandEnv });
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
	const jarvisPython = join(consumerRoot, "jarvis-runtime", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	if (process.platform !== "win32") {
		const jarvisHelp = run(join(commandRoot, "jarvis"), ["--help"], { capture: true, cwd: projectRoot, env: commandEnv });
		for (const name of ["task", "journal", "reading-list", "wiki", "meeting", "community"])
			if (!jarvisHelp.includes(name)) throw new Error(`Installed Jarvis launcher omitted ${name}`);
	}
	run(process.execPath, [join(repoRoot, "scripts/test-workspace-consumer.mjs"), join(installedCoreRoot, "dist", "cli.js"), jarvisPython]);
	const jarvisSitePackages = run(jarvisPython, ["-I", "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], { capture: true }).trim();
	const receiverPlanAcceptance = String.raw`
import shlex
import subprocess
import sys
from pathlib import Path

from jarvis.meetings.automation import build_fathom_automation_plan
from jarvis.whatsapp.automation import build_whatsapp_automation_plan

unrelated = Path(sys.argv[1]).resolve()
plans = [
    build_fathom_automation_plan(
        session_name="packed-fathom",
        cwd=unrelated,
        layout="windows",
        account="synthetic",
        port=8765,
        auto_ingest=False,
        destinations=["private-context"],
        wiki_domain=None,
        backend=None,
        journal_space_id=None,
        project="",
        tags=[],
        auto_route=False,
        verify_signatures=True,
        tolerance_seconds=300,
    ),
    build_whatsapp_automation_plan(
        session_name="packed-whatsapp",
        cwd=unrelated,
        layout="windows",
        account="synthetic",
        port=8787,
        auto_ingest=False,
        destinations=["team-inbox"],
        backend=None,
        verify_signatures=True,
    ),
]
for plan in plans:
    command = shlex.split(plan.webhook_command)
    assert command[:5] == [sys.executable, "-I", "-B", "-m", "jarvis"], command
    for _ in range(2):
        subprocess.run([*command, "--help"], cwd=unrelated, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
`;
	run(jarvisPython, ["-I", "-B", "-c", receiverPlanAcceptance, projectRoot], {
		cwd: projectRoot,
		env: { ...process.env, HOME: projectRoot, PYTHONDONTWRITEBYTECODE: "1" },
	});
	run(jarvisPython, ["-I", "-B", join(repoRoot, "scripts/test-jarvis-consumer.py"), jarvisSitePackages]);
	run(jarvisPython, ["-I", "-B", join(repoRoot, "scripts/test-community-draft-adapter.py")], {
		env: {
			...process.env,
			HARNESSY_COMMUNITY_TEST_ADAPTER: join(installedCoreRoot, "resources/community-draft-adapter.py"),
		},
	});
	if (process.platform === "darwin") {
		run(process.execPath, [join(repoRoot, "scripts/test-installed-skills.mjs"), join(installedCoreRoot, "dist", "cli.js"),
			join(consumerRoot, "reused-source/resources/flow-install/skills/qa-runtime/scripts/qa"), jarvisPython]);
		run(process.execPath, [
			join(repoRoot, "packages/harnessy-core/test/local-life-cli-acceptance.mjs"),
			join(installedCoreRoot, "dist", "cli.js"),
			jarvisPython,
		]);
	} else {
		console.log("Life draft and installed skill CLI acceptance not assessed: their isolation requires macOS sandbox-exec.");
	}
	run(process.execPath, [join(repoRoot, "node_modules/vitest/dist/cli.js"), "--run", "test/community-draft-cli.test.ts"], {
		cwd: join(repoRoot, "packages/harnessy-core"),
		env: {
			...process.env,
			HARNESSY_TEST_JARVIS_PYTHON: jarvisPython,
			HARNESSY_COMMUNITY_TEST_CLI: join(installedCoreRoot, "dist", "cli.js"),
		},
	});
	run(process.execPath, [join(repoRoot, "node_modules/vitest/dist/cli.js"), "--run", "test/fathom-cli.test.ts"], {
		cwd: join(repoRoot, "packages/harnessy-core"),
		env: {
			...process.env,
			HARNESSY_FATHOM_TEST_CLI: join(installedCoreRoot, "dist", "cli.js"),
		},
	});
	const installedExecutorRoot = installedRoots.get("@harnessy/executor");
	run(process.execPath, [join(repoRoot, "node_modules/vitest/dist/cli.js"), "--run", "test/calendar-plan.test.ts", "test/calendar-apply.test.ts", "--testNamePattern", "real .*CLI"], {
		cwd: join(repoRoot, "packages/harnessy-core"),
		env: {
			...process.env,
			HARNESSY_CALENDAR_TEST_CLI: join(installedCoreRoot, "dist", "cli.js"),
		},
	});
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
