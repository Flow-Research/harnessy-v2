import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { convergeRelease, rollbackRelease } from "./install-release.mjs";
import { stageV1Compatibility, writeV1Provenance } from "./v1-compatibility-lib.mjs";

const packageRoot = fileURLToPath(new URL("../packages/capability-harnessy-v1-full", import.meta.url));

test("packed compatibility source has one resource tree and reconstructs exact source", async () => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-single-source-"));
	try {
		const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: packageRoot, encoding: "utf8" }));
		const paths = new Set(packed.files.map((file) => file.path));
		for (const path of paths) {
			if (path.startsWith("resources/")) assert.ok(path.startsWith("resources/source/") || ["resources/SOURCE.json", "resources/npm-transport.json"].includes(path), path);
		}
		for (const path of ["LICENSE", "resources/source/jarvis-cli/uv.lock", "resources/source/tools/flow-install/index.mjs"]) assert.ok(paths.has(path), path);
		execFileSync("tar", ["-xzf", join(root, packed.filename), "-C", root]);
		const manifest = JSON.parse(await readFile(join(root, "package/harnessy.capability.json"), "utf8"));
		assert.deepEqual(manifest.resources.map((resource) => resource.path), ["resources/source", "resources/SOURCE.json", "resources/npm-transport.json"]);
		for (const path of [...manifest.context, ...manifest.checks.map((check) => check.path)]) assert.ok(paths.has(path), path);
		const staged = await stageV1Compatibility(join(root, "package"), join(root, "staged"));
		const expected = JSON.parse(await readFile(join(packageRoot, "resources/SOURCE.json"), "utf8"));
		assert.equal(staged.ok, true);
		assert.equal(staged.provenance.schemaVersion, 3);
		assert.equal(staged.source.digest, expected.tree.digest);
		assert.equal(staged.source.fileCount, expected.tree.fileCount);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("managed source upgrade stages packed schema 2 and 3 artifacts and restores the exact prior binding", async () => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-source-upgrade-"));
	try {
		const legacy = join(root, "legacy");
		await cp(packageRoot, legacy, { recursive: true });
		for (const [source, projection] of [["tools/flow-install", "flow-install"], [".jarvis/context", "context-vault"], ["jarvis-cli", "jarvis-cli"], ["install.sh", "install.sh"], ["README.md", "README.v1.md"], ["AGENTS.md", "AGENTS.v1.md"]]) {
			await cp(join(legacy, "resources/source", source), join(legacy, "resources", projection), { recursive: true });
		}
		const provenance = JSON.parse(await readFile(join(legacy, "resources/SOURCE.json"), "utf8"));
		await writeV1Provenance(legacy, provenance.source, { schemaVersion: 2 });
		const binding = join(root, "current");
		let priorMarker;
		for (const [name, source, schema] of [["old", legacy, 2], ["new", packageRoot, 3]]) {
			const bundle = join(root, `bundle-${name}`);
			await mkdir(bundle);
			const [packed] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", bundle], { cwd: source, encoding: "utf8" }));
			const hash = createHash("sha256").update(await readFile(join(bundle, packed.filename))).digest("hex");
			// Other package records satisfy bundle admission only; this test covers source staging, not runtime installation.
			const packages = [];
			await mkdir(join(bundle, "artifacts"));
			for (const name of ["@harnessy/core", "@harnessy/sdk", "@harnessy/local-host", "@harnessy/capability-harnessy-v1-full"]) {
				const file = `artifacts/${name.split("/")[1]}.tgz`;
				await cp(join(bundle, packed.filename), join(bundle, file));
				packages.push({ name, file, sha256: hash });
			}
			await writeFile(join(bundle, "release.json"), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, node: `=${process.versions.node}`, packages }));
			const stage = async ({ target }) => {
				await mkdir(target);
				execFileSync("tar", ["-xzf", join(bundle, packed.filename), "-C", target]);
				const result = await stageV1Compatibility(join(target, "package"), join(target, "reused-source"));
				assert.equal(result.provenance.schemaVersion, schema);
				assert.equal(result.source.digest, provenance.tree.digest);
				for (const entry of ["tools/flow-install/index.mjs", "jarvis-cli/src/jarvis/cli.py"]) assert.ok((await readFile(join(target, "reused-source/resources/source", entry))).length > 0);
				return { installation: target, activated: false };
			};
			await convergeRelease(bundle, binding, { stage, candidateName: () => `release-${name}` });
			assert.equal(await readlink(binding), `release-${name}`);
			if (schema === 2) priorMarker = await readFile(join(binding, ".harnessy-install.json"));
		}
		assert.equal(rollbackRelease(binding).rolledBack, true);
		assert.equal(await readlink(binding), "release-old");
		assert.deepEqual(await readFile(join(binding, ".harnessy-install.json")), priorMarker);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
