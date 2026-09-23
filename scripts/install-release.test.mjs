import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convergeRelease, inspectReleaseBundle, installRelease, installReleaseLaunchers, rollbackRelease } from "./install-release.mjs";
import { prepareReleaseInstaller } from "./prepare-release-installer.mjs";

const fixture = (t) => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-bundle-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "artifacts"));
	const names = ["@harnessy/core", "@harnessy/sdk", "@harnessy/local-host", "@harnessy/capability-harnessy-v1-full"];
	const packages = names.map(name => {
		const file = `artifacts/${name.split("/")[1]}.tgz`;
		writeFileSync(join(root, file), name);
		return { name, file, sha256: createHash("sha256").update(name).digest("hex") };
	});
	const manifest = { version: 1, platform: process.platform, arch: process.arch, node: `=${process.versions.node}`, packages };
	const save = () => writeFileSync(join(root, "release.json"), JSON.stringify(manifest));
	save();
	return { root, manifest, save };
};

const fakeStage = async ({ target, inspected }) => {
	mkdirSync(join(target, "bin"), { recursive: true });
	for (const command of ["harnessy", "hsy", "jarvis"]) {
		writeFileSync(join(target, "bin", command), inspected.manifestSha256);
	}
	return {
		installation: target,
		commands: join(target, "bin"),
		node: join(target, "bin", "node"),
		service: join(target, "service"),
		python: join(target, "jarvis-runtime", "bin", "python"),
		activated: false,
	};
};

const changeRelease = (root, manifest, save) => {
	const pkg = manifest.packages[0];
	const contents = `${pkg.name}:next`;
	writeFileSync(join(root, pkg.file), contents);
	pkg.sha256 = createHash("sha256").update(contents).digest("hex");
	save();
};

test("bundle preflight verifies every local artifact and required operational package", t => {
	const { root, manifest, save } = fixture(t);
	assert.equal(Object.keys(inspectReleaseBundle(root).dependencies).length, 4);
	manifest.packages.pop(); save();
	assert.throws(() => inspectReleaseBundle(root), /missing/);
});

test("bundle rejects tampering, escaping paths, duplicates and wrong platforms", t => {
	const { root, manifest, save } = fixture(t);
	const original = structuredClone(manifest);
	for (const mutate of [
		() => { manifest.packages[0].sha256 = "wrong"; },
		() => { manifest.packages[0].file = "../outside.tgz"; },
		() => { manifest.packages.push(manifest.packages[0]); },
		() => { manifest.platform = "unsupported"; },
	]) {
		Object.assign(manifest, structuredClone(original)); mutate(); save();
		assert.throws(() => inspectReleaseBundle(root));
	}
});

test("bundle rejects artifact symlinks", t => {
	const { root, manifest } = fixture(t);
	const artifact = join(root, manifest.packages[0].file);
	rmSync(artifact); symlinkSync(join(root, manifest.packages[1].file), artifact);
	assert.throws(() => inspectReleaseBundle(root), /Unsafe/);
});

test("unsupported or missing Node engine rejects before creating an installation", async t => {
	const { root, manifest, save } = fixture(t);
	const target = join(root, "not-created");
	for (const range of ["<1", "invalid", undefined]) {
		manifest.node = range; save();
		await assert.rejects(installRelease(root, target), /Unsupported Node runtime/);
		assert.equal(existsSync(target), false);
	}
});

test("installer refuses relative and existing targets before dependency execution", async t => {
	const { root } = fixture(t);
	await assert.rejects(installRelease(root, "relative"), /absolute/);
	const existing = join(root, "existing"); mkdirSync(existing);
	writeFileSync(join(existing, "owner.txt"), "preserved");
	await assert.rejects(installRelease(root, existing), /EEXIST/);
	assert.equal(readFileSync(join(existing, "owner.txt"), "utf8"), "preserved");
});

test("managed convergence installs a complete first release before creating one stable binding", async t => {
	const { root } = fixture(t);
	const binding = join(root, "current");
	const state = join(root, "owner-state");
	mkdirSync(state);
	writeFileSync(join(state, "credentials.json"), "credential sentinel", { mode: 0o600 });
	writeFileSync(join(state, "state.db"), "state sentinel", { mode: 0o600 });
	const result = await convergeRelease(root, binding, { stage: fakeStage, candidateName: () => "release-one" });
	assert.equal(result.upgraded, false);
	assert.equal(result.idempotent, false);
	assert.equal(result.activated, false);
	assert.equal(readlinkSync(binding), "release-one");
	assert.equal(realpathSync(binding), realpathSync(join(root, "release-one")));
	const marker = JSON.parse(readFileSync(join(binding, ".harnessy-install.json"), "utf8"));
	assert.equal(marker.installation, realpathSync(join(root, "release-one")));
	assert.match(marker.releaseManifestSha256, /^[a-f0-9]{64}$/);
	for (const command of ["harnessy", "hsy", "jarvis"]) {
		assert.equal(readFileSync(join(binding, "bin", command), "utf8"), marker.releaseManifestSha256);
	}
	assert.equal(readFileSync(join(state, "credentials.json"), "utf8"), "credential sentinel");
	assert.equal(readFileSync(join(state, "state.db"), "utf8"), "state sentinel");
});

test("managed upgrade is idempotent and retains exact rollback metadata", async t => {
	const { root, manifest, save } = fixture(t);
	const binding = join(root, "current");
	await convergeRelease(root, binding, { stage: fakeStage, candidateName: () => "release-one" });
	const priorLink = readlinkSync(binding);
	const priorMarker = readFileSync(join(binding, ".harnessy-install.json"));
	changeRelease(root, manifest, save);
	const upgraded = await convergeRelease(root, binding, { stage: fakeStage, candidateName: () => "release-two" });
	assert.equal(upgraded.upgraded, true);
	assert.equal(readlinkSync(binding), "release-two");
	const rollback = JSON.parse(readFileSync(join(binding, ".harnessy-rollback.json"), "utf8"));
	assert.equal(rollback.previousLink, priorLink);
	assert.deepEqual(Buffer.from(rollback.previousManifestBase64, "base64"), priorMarker);
	const idempotent = await convergeRelease(root, binding, {
		stage: async () => { throw new Error("idempotent convergence staged another release"); },
		candidateName: () => "must-not-exist",
	});
	assert.equal(idempotent.idempotent, true);
	assert.equal(existsSync(join(root, "must-not-exist")), false);
	const restored = rollbackRelease(binding);
	assert.equal(restored.rolledBack, true);
	assert.equal(readlinkSync(binding), priorLink);
	assert.deepEqual(readFileSync(join(binding, ".harnessy-install.json")), priorMarker);
});

test("managed upgrade refuses unknown bindings and changed rollback installations", async t => {
	const { root, manifest, save } = fixture(t);
	const unmanaged = join(root, "unmanaged");
	mkdirSync(unmanaged);
	writeFileSync(join(unmanaged, "owner.txt"), "preserved");
	await assert.rejects(convergeRelease(root, unmanaged, { stage: fakeStage }), /managed symbolic link/);
	const binding = join(root, "current");
	symlinkSync("unmanaged", binding);
	await assert.rejects(convergeRelease(root, binding, { stage: fakeStage }), /not managed/);
	assert.equal(readlinkSync(binding), "unmanaged");
	assert.equal(readFileSync(join(unmanaged, "owner.txt"), "utf8"), "preserved");
	rmSync(binding);
	await convergeRelease(root, binding, { stage: fakeStage, candidateName: () => "release-one" });
	changeRelease(root, manifest, save);
	await convergeRelease(root, binding, { stage: fakeStage, candidateName: () => "release-two" });
	writeFileSync(join(root, "release-one", ".harnessy-install.json"), "{}\n");
	assert.throws(() => rollbackRelease(binding), /manifest does not match|changed after upgrade/);
	assert.equal(readlinkSync(binding), "release-two");
});

test("interrupted convergence preserves the prior binding, state, and credentials", async t => {
	const { root, manifest, save } = fixture(t);
	const binding = join(root, "current");
	await convergeRelease(root, binding, { stage: fakeStage, candidateName: () => "release-one" });
	const state = join(root, "external-state");
	mkdirSync(state);
	writeFileSync(join(state, "credentials"), "credential sentinel");
	writeFileSync(join(state, "receipts"), "state sentinel");
	changeRelease(root, manifest, save);
	await assert.rejects(convergeRelease(root, binding, {
		stage: fakeStage,
		candidateName: () => "release-interrupted",
		beforeSwap: () => { throw new Error("simulated interruption"); },
	}), /simulated interruption/);
	assert.equal(readlinkSync(binding), "release-one");
	assert.equal(existsSync(join(root, "release-interrupted", ".harnessy-install.json")), true);
	assert.equal(readFileSync(join(state, "credentials"), "utf8"), "credential sentinel");
	assert.equal(readFileSync(join(state, "receipts"), "utf8"), "state sentinel");
});

test("bundled installer runs preflight without importing repository files", t => {
	const { root, manifest } = fixture(t);
	prepareReleaseInstaller(root, manifest.packages, new Map(manifest.packages.map(pkg => [pkg.name, join(root, pkg.file)])));
	assert.equal(JSON.parse(readFileSync(join(root, "release.json"), "utf8")).node,
		JSON.parse(readFileSync(new URL("../packages/harnessy-core/package.json", import.meta.url), "utf8")).engines.node);
	const result = spawnSync(process.execPath, [join(root, "install.mjs"), "--check"], {
		cwd: root, encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), { ok: true, packages: 4, installed: false });
	const help = spawnSync(process.execPath, [join(root, "install.mjs"), "--help"], {
		cwd: root, encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin" },
	});
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--converge \/absolute\/stable\/link/);
	assert.match(help.stdout, /--rollback \/absolute\/stable\/link/);
});

test("installed launchers pin Node and preserve arguments outside PATH", { skip: process.platform === "win32" }, t => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-launcher-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const target = join(root, "owner's $candidate with spaces");
	assert.throws(() => installReleaseLaunchers(target), /Jarvis Python is missing/);
	assert.equal(existsSync(join(target, "bin")), false);
	const python = join(target, "jarvis-runtime/bin/python");
	mkdirSync(join(python, ".."), { recursive: true });
	const probe = join(root, "python-argv.cjs");
	writeFileSync(probe, "console.log(JSON.stringify(process.argv.slice(2)))");
	writeFileSync(python, `#!/bin/sh\nexec '${process.execPath}' '${probe}' "$@"\n`);
	chmodSync(python, 0o700);
	const commands = [];
	for (const packageName of ["harnessy-core", "harnessy-local-host"]) {
		const manifest = JSON.parse(readFileSync(new URL(`../packages/${packageName}/package.json`, import.meta.url), "utf8"));
		const packageRoot = join(target, packageName === "harnessy-local-host" ? "service/node_modules" : "node_modules", manifest.name);
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ bin: manifest.bin }));
		for (const [name, entry] of Object.entries(manifest.bin)) {
			commands.push(name);
			writeFileSync(join(packageRoot, entry), "console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}))");
		}
	}
	const installed = installReleaseLaunchers(target);
	assert.deepEqual(readFileSync(installed.node), readFileSync(process.execPath));
	const args = ["space value", "'quoted'", "$not_expanded", "--option"];
	assert.equal(commands.length, 11);
	for (const name of commands) {
		const result = spawnSync(join(installed.commands, name), args, {
			cwd: root, env: { PATH: "/nonexistent" }, encoding: "utf8", timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { node: realpathSync(installed.node), args });
	}
	const jarvis = spawnSync(join(installed.commands, "jarvis"), args, {
		cwd: root, env: { PATH: "/nonexistent", PYTHONPATH: "/untrusted" }, encoding: "utf8", timeout: 10_000,
	});
	assert.equal(jarvis.status, 0, jarvis.stderr);
	assert.deepEqual(JSON.parse(jarvis.stdout), ["-I", "-B", "-m", "jarvis", ...args]);
	for (const operation of [
		"inspect",
		"apply",
		"reconcile",
		"recovery-inspect",
		"recovery-resolve",
		"legacy-recovery-inspect",
		"legacy-recovery-retire",
		"plan",
	]) {
		const calendarArgs = ["calendar", operation, ...args];
		const result = spawnSync(join(installed.commands, "jarvis"), calendarArgs, {
			cwd: root, env: { PATH: "/nonexistent" }, encoding: "utf8", timeout: 10_000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), operation === "plan"
			? ["-I", "-B", "-m", "jarvis", ...calendarArgs]
			: { node: realpathSync(installed.node), args: ["jarvis", ...calendarArgs] });
	}
	const before = readFileSync(join(installed.commands, "harnessy"));
	assert.throws(() => installReleaseLaunchers(target), /EEXIST/);
	assert.deepEqual(readFileSync(join(installed.commands, "harnessy")), before);
});
