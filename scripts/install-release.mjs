import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";
import { stageV1Compatibility } from "./v1-compatibility-lib.mjs";
import { installLocalJarvisRuntime } from "./install-local-jarvis-runtime.mjs";
import { stageLocalServiceRuntime } from "./stage-local-service-runtime.mjs";

const INSTALL_MANIFEST = ".harnessy-install.json";
const ROLLBACK_MANIFEST = ".harnessy-rollback.json";
const INSTALL_KIND = "harnessy.managed-installation";
const ROLLBACK_KIND = "harnessy.managed-rollback";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function writeManagedManifest(target, inspected) {
	const manifest = {
		version: 1,
		kind: INSTALL_KIND,
		installation: target,
		releaseManifestSha256: inspected.manifestSha256,
		platform: process.platform,
		arch: process.arch,
	};
	writeFileSync(join(target, INSTALL_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	return manifest;
}

function readManagedManifest(target) {
	const file = join(target, INSTALL_MANIFEST);
	if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) {
		throw new Error("Installation target is not managed by the Harnessy release installer");
	}
	const bytes = readFileSync(file);
	let manifest;
	try {
		manifest = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("Managed installation manifest is invalid");
	}
	if (manifest.version !== 1 || manifest.kind !== INSTALL_KIND || manifest.installation !== target ||
		manifest.platform !== process.platform || manifest.arch !== process.arch ||
		typeof manifest.releaseManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.releaseManifestSha256)) {
		throw new Error("Managed installation manifest does not match this installation");
	}
	return { bytes, manifest };
}

function resolveBinding(binding) {
	if (!isAbsolute(binding)) throw new Error("Installation binding must be absolute");
	const parent = realpathSync(dirname(binding));
	const path = join(parent, basename(binding));
	const bindingStat = lstatSync(path, { throwIfNoEntry: false });
	if (bindingStat === undefined) return { parent, path };
	if (!bindingStat.isSymbolicLink()) throw new Error("Installation binding must be a managed symbolic link");
	const link = readlinkSync(path);
	const target = realpathSync(resolve(parent, link));
	if (dirname(target) !== parent || !lstatSync(target).isDirectory()) {
		throw new Error("Managed installation must be a sibling of its binding");
	}
	return { parent, path, link, target };
}

function replaceBinding(binding, link, beforeSwap) {
	if (binding.link === undefined) {
		beforeSwap?.();
		symlinkSync(link, binding.path, process.platform === "win32" ? "dir" : undefined);
		return;
	}
	const temporary = join(binding.parent, `.${basename(binding.path)}.binding-${randomUUID()}`);
	try {
		symlinkSync(link, temporary, process.platform === "win32" ? "dir" : undefined);
		beforeSwap?.();
		const current = lstatSync(binding.path, { throwIfNoEntry: false });
		if (current === undefined || !current.isSymbolicLink() || readlinkSync(binding.path) !== binding.link) {
			throw new Error("Installation binding changed during convergence");
		}
		renameSync(temporary, binding.path);
	} finally {
		if (lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) rmSync(temporary);
	}
}

/** Pin the installing interpreter; never overwrite existing commands. */
export function installReleaseLaunchers(target) {
	const python = join(target, "jarvis-runtime", "bin/python");
	if (process.platform !== "win32" && !existsSync(python)) throw new Error("Installed Jarvis Python is missing");
	const bin = join(target, "bin");
	mkdirSync(bin, { mode: 0o700 });
	const node = join(bin, process.platform === "win32" ? "node.exe" : "node");
	copyFileSync(process.execPath, node, constants.COPYFILE_EXCL);
	chmodSync(node, 0o700);
	if (process.platform === "win32") {
		// Explicit interpreter invocation remains available; npm's Windows shims
		// are unchanged until their pinned-launcher behavior has platform evidence.
		return { commands: join(target, "node_modules", ".bin"), node };
	}
	const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
	for (const packageName of ["@harnessy/core", "@harnessy/local-host"]) {
		const packageRoot = resolve(target, packageName === "@harnessy/local-host" ? "service/node_modules" : "node_modules", packageName);
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		for (const [name, entry] of Object.entries(manifest.bin)) {
			if (!/^[a-z0-9-]+$/.test(name) || typeof entry !== "string") throw new Error("Invalid release command");
			const script = resolve(packageRoot, entry);
			if (!script.startsWith(`${packageRoot}${sep}`) || !lstatSync(script).isFile()) throw new Error("Unsafe release command path");
			writeFileSync(join(bin, name), `#!/bin/sh\nexec ${quote(node)} ${quote(script)} "$@"\n`,
				{ flag: "wx", mode: 0o700 });
		}
	}
	// Keep the reused planner, but never bypass V2 approval/receipt safeguards
	// when the ordinary Jarvis command applies or reconciles a calendar plan.
	writeFileSync(join(bin, "jarvis"), `#!/bin/sh\ncase "$1:$2" in\n  calendar:inspect|calendar:apply|calendar:reconcile|calendar:recovery-inspect|calendar:recovery-resolve|calendar:legacy-recovery-inspect|calendar:legacy-recovery-retire) exec ${quote(join(bin, "harnessy"))} jarvis "$@" ;;\nesac\nexec ${quote(python)} -I -B -m jarvis "$@"\n`,
		{ flag: "wx", mode: 0o700 });
	return { commands: bin, node };
}

/** Validate a trusted release bundle before creating an installation directory. */
export function inspectReleaseBundle(directory) {
	const root = realpathSync(directory);
	const manifestBytes = readFileSync(join(root, "release.json"));
	const manifest = JSON.parse(manifestBytes.toString("utf8"));
	if (manifest.version !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) {
		throw new Error("Release bundle format or platform does not match this machine");
	}
	if (typeof manifest.node !== "string" || !satisfies(process.versions.node, manifest.node)) {
		throw new Error(`Unsupported Node runtime ${process.versions.node}; use the release's declared Node engine`);
	}
	if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error("Empty release bundle");
	const dependencies = {};
	for (const pkg of manifest.packages) {
		if (!pkg || typeof pkg.name !== "string" || !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(pkg.name) ||
			typeof pkg.file !== "string" || !/^(?:artifacts|tarballs)\/[a-z0-9._-]+\.tgz$/.test(pkg.file) ||
			Object.hasOwn(dependencies, pkg.name)) throw new Error("Invalid or duplicate release package");
		const artifact = join(root, pkg.file);
		if (!lstatSync(artifact).isFile() || realpathSync(artifact) !== artifact) throw new Error("Unsafe release package path");
		if (createHash("sha256").update(readFileSync(artifact)).digest("hex") !== pkg.sha256) {
			throw new Error(`Release package integrity mismatch: ${pkg.name}`);
		}
		dependencies[pkg.name] = `file:${artifact}`;
	}
	for (const required of ["@harnessy/core", "@harnessy/sdk", "@harnessy/local-host", "@harnessy/capability-harnessy-v1-full"]) {
		if (!Object.hasOwn(dependencies, required)) throw new Error(`Release is missing ${required}`);
	}
	return { root, dependencies, manifestSha256: sha256(manifestBytes) };
}

async function stageRelease(inspected, destination) {
	const { dependencies } = inspected;
	if (!isAbsolute(destination)) throw new Error("Installation target must be absolute");
	const target = join(realpathSync(dirname(destination)), basename(destination));
	// Never adopt, delete or overwrite an existing directory, even on failure.
	mkdirSync(target, { mode: 0o700 });
	writeFileSync(join(target, "package.json"), JSON.stringify({ private: true, dependencies, overrides: dependencies }, null, 2));
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	for (const args of [["install", "--omit=dev", "--ignore-scripts"], ["audit", "--omit=dev", "--audit-level=moderate"]]) {
		const result = spawnSync(npm, args, { cwd: target, stdio: "inherit", shell: process.platform === "win32" });
		if (result.error || result.status !== 0) throw new Error("Release installation failed; incomplete directory preserved for inspection");
	}
	const modules = join(target, "node_modules");
	const service = stageLocalServiceRuntime(modules, join(target, "service"));
	await stageV1Compatibility(join(modules, "@harnessy/capability-harnessy-v1-full"), join(target, "reused-source"));
	const python = installLocalJarvisRuntime(join(target, "reused-source/resources/jarvis-cli"), join(target, "jarvis-runtime"));
	const launchers = installReleaseLaunchers(target);
	return { installation: target, ...launchers, service: service.root, python, activated: false };
}

export async function installRelease(directory, destination) {
	const inspected = inspectReleaseBundle(directory);
	const installed = await stageRelease(inspected, destination);
	writeManagedManifest(installed.installation, inspected);
	return installed;
}

/**
 * Install or upgrade one stable binding without changing services, state, or
 * credentials. The release is complete and marked in a fresh sibling before
 * the binding is replaced with one atomic rename.
 */
export async function convergeRelease(directory, destination, operations = {}) {
	const inspected = inspectReleaseBundle(directory);
	const binding = resolveBinding(destination);
	let previous;
	if (binding.target !== undefined) {
		previous = readManagedManifest(binding.target);
		if (previous.manifest.releaseManifestSha256 === inspected.manifestSha256) {
			return { installation: binding.target, binding: binding.path, upgraded: false, idempotent: true, activated: false };
		}
	}
	const candidateName = operations.candidateName?.(inspected.manifestSha256) ??
		`${basename(binding.path)}.release-${inspected.manifestSha256.slice(0, 12)}-${randomUUID()}`;
	if (!/^[a-zA-Z0-9._-]+$/.test(candidateName)) throw new Error("Unsafe managed installation name");
	const candidate = join(binding.parent, candidateName);
	const installed = operations.stage === undefined
		? await stageRelease(inspected, candidate)
		: await operations.stage({ directory: inspected.root, target: candidate, inspected });
	if (realpathSync(installed.installation) !== candidate) throw new Error("Staged installation path does not match the managed candidate");
	writeManagedManifest(candidate, inspected);
	if (previous !== undefined) {
		const rollback = {
			version: 1,
			kind: ROLLBACK_KIND,
			binding: binding.path,
			previousLink: binding.link,
			previousManifestBase64: previous.bytes.toString("base64"),
			previousManifestSha256: sha256(previous.bytes),
		};
		writeFileSync(join(candidate, ROLLBACK_MANIFEST), `${JSON.stringify(rollback, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	}
	replaceBinding(binding, basename(candidate), operations.beforeSwap);
	return { ...installed, binding: binding.path, upgraded: previous !== undefined, idempotent: false, activated: false };
}

/** Restore the exact prior managed binding after validating its saved marker. */
export function rollbackRelease(destination, operations = {}) {
	const binding = resolveBinding(destination);
	if (binding.target === undefined) throw new Error("Installation binding does not exist");
	readManagedManifest(binding.target);
	const rollbackFile = join(binding.target, ROLLBACK_MANIFEST);
	if (!existsSync(rollbackFile) || !lstatSync(rollbackFile).isFile() || lstatSync(rollbackFile).isSymbolicLink()) {
		throw new Error("Managed installation has no rollback metadata");
	}
	let rollback;
	try {
		rollback = JSON.parse(readFileSync(rollbackFile, "utf8"));
	} catch {
		throw new Error("Rollback metadata is invalid");
	}
	if (rollback.version !== 1 || rollback.kind !== ROLLBACK_KIND || rollback.binding !== binding.path ||
		typeof rollback.previousLink !== "string" || typeof rollback.previousManifestBase64 !== "string" ||
		typeof rollback.previousManifestSha256 !== "string") throw new Error("Rollback metadata does not match this binding");
	const previousTarget = realpathSync(resolve(binding.parent, rollback.previousLink));
	if (dirname(previousTarget) !== binding.parent) throw new Error("Rollback installation must be a sibling of its binding");
	const previous = readManagedManifest(previousTarget);
	const saved = Buffer.from(rollback.previousManifestBase64, "base64");
	if (sha256(saved) !== rollback.previousManifestSha256 || !saved.equals(previous.bytes)) {
		throw new Error("Prior managed installation changed after upgrade");
	}
	replaceBinding(binding, rollback.previousLink, operations.beforeSwap);
	return { installation: previousTarget, binding: binding.path, rolledBack: true, activated: false };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log("Usage: node install.mjs --check | --target /absolute/new/directory | --converge /absolute/stable/link | --rollback /absolute/stable/link\nRequires a Node version matching release.json, npm, uv and Python 3.11. POSIX command launchers pin a local copy of that Node; Windows npm shims still require supported Node on PATH. --converge installs into a fresh managed sibling before atomically changing the stable link. --rollback restores the exact prior managed link. No command configures credentials, changes PATH or activates services. Keep the bundle for package repair. Hashes detect corruption, not publisher authenticity.");
	} else if (args.length === 1 && args[0] === "--check") {
		const inspected = inspectReleaseBundle(dirname(fileURLToPath(import.meta.url)));
		console.log(JSON.stringify({ ok: true, packages: Object.keys(inspected.dependencies).length, installed: false }));
	} else if (args.length === 2 && args[0] === "--target") {
		console.log(JSON.stringify(await installRelease(dirname(fileURLToPath(import.meta.url)), args[1]), null, 2));
	} else if (args.length === 2 && args[0] === "--converge") {
		console.log(JSON.stringify(await convergeRelease(dirname(fileURLToPath(import.meta.url)), args[1]), null, 2));
	} else if (args.length === 2 && args[0] === "--rollback") {
		console.log(JSON.stringify(rollbackRelease(args[1]), null, 2));
	} else {
		throw new Error("Use --help, --check, --target /absolute/new/directory, --converge /absolute/stable/link, or --rollback /absolute/stable/link");
	}
}
