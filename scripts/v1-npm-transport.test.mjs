import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stageV1Compatibility, verifyV1Compatibility, writeV1NpmTransport, writeV1Provenance } from "./v1-compatibility-lib.mjs";

const original = fileURLToPath(new URL("../packages/capability-harnessy-v1-full", import.meta.url));
const omitted = ["source/.gitignore", "source/jarvis-cli/.gitignore"];

const fixture = async (t) => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-npm-transport-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const input = join(root, "input");
	await cp(original, input, { recursive: true });
	for (const path of omitted) await unlink(join(input, "resources", path));
	return { input, output: join(root, "output") };
};

test("packed-source reconstruction retains the exact original provenance and does not mutate its input", async (t) => {
	const { input, output } = await fixture(t);
	assert.equal((await verifyV1Compatibility(input)).ok, false);
	const expected = await verifyV1Compatibility(original);
	const result = await stageV1Compatibility(input, output);
	assert.equal(result.ok, true);
	assert.equal(result.source.digest, expected.source.digest);
	assert.equal(result.source.fileCount, expected.source.fileCount);
	for (const path of omitted) {
		assert.deepEqual(await readFile(join(output, "resources", path)), await readFile(join(original, "resources", path)));
		await assert.rejects(readFile(join(input, "resources", path)), { code: "ENOENT" });
	}
	await assert.rejects(stageV1Compatibility(input, output), { code: "EEXIST" });
});

test("transport metadata is generated from canonical source bytes and supports an unpacked source too", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-npm-transport-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const input = join(root, "input");
	await cp(original, input, { recursive: true });
	await writeV1NpmTransport(input);
	assert.deepEqual(await readFile(join(input, "resources/npm-transport.json")), await readFile(join(original, "resources/npm-transport.json")));
	assert.equal((await stageV1Compatibility(input, join(root, "output"))).ok, true);
});

test("altered transport bytes cannot weaken the source digest", async (t) => {
	const { input, output } = await fixture(t);
	const path = join(input, "resources/npm-transport.json");
	const data = JSON.parse(await readFile(path, "utf8"));
	data[".gitignore"] = Buffer.from("tampered\n").toString("base64");
	await writeFile(path, JSON.stringify(data));
	await assert.rejects(stageV1Compatibility(input, output), /provenance failed/);
});

test("unknown transport paths and malformed bytes are rejected before staging", async (t) => {
	const { input, output } = await fixture(t);
	const path = join(input, "resources/npm-transport.json");
	const data = JSON.parse(await readFile(path, "utf8"));
	await writeFile(path, JSON.stringify({ ...data, "../../escaped": "" }));
	await assert.rejects(stageV1Compatibility(input, output), /inventory/);
	await writeFile(path, JSON.stringify({ ...data, ".gitignore": "not base64!" }));
	await assert.rejects(stageV1Compatibility(input, output), /transport bytes/);
	await mkdir(output); // Neither rejection created it.
});

test("staging rejects source symlinks and overlapping output", async (t) => {
	const { input, output } = await fixture(t);
	await assert.rejects(stageV1Compatibility(input, join(input, "nested")), /disjoint/);
	await symlink("README.md", join(input, "resources/source/linked.md"));
	await assert.rejects(stageV1Compatibility(input, output), /Symlinks/);
	await mkdir(output);
});

test("single-source artifacts reject duplicate resources before staging", async (t) => {
	const { input, output } = await fixture(t);
	await mkdir(join(input, "resources/jarvis-cli"));
	const result = await verifyV1Compatibility(input);
	assert(result.issues.includes("unexpected-resource: jarvis-cli"));
	await assert.rejects(stageV1Compatibility(input, output), /unexpected-resource/);
	await mkdir(output);
});

test("unknown provenance schemas fail before staging", async (t) => {
	const { input, output } = await fixture(t);
	const path = join(input, "resources/SOURCE.json");
	const data = JSON.parse(await readFile(path, "utf8"));
	await writeFile(path, JSON.stringify({ ...data, schemaVersion: 99 }));
	await assert.rejects(stageV1Compatibility(input, output), /Unsupported V1 provenance schema/);
	await mkdir(output);
});

test("schema 3 requires the selected and dirty input evidence", async (t) => {
	const { input } = await fixture(t);
	const path = join(input, "resources/SOURCE.json");
	const data = JSON.parse(await readFile(path, "utf8"));
	assert.equal(data.schemaVersion, 3);
	delete data.source.selectedInputs;
	delete data.source.dirtyInput;
	await writeFile(path, JSON.stringify(data));
	const result = await verifyV1Compatibility(input);
	assert(result.issues.includes("selected-inputs-missing"));
	assert(result.issues.includes("dirty-input-missing"));
});

test("provenance writes reject incomplete evidence without replacing prior metadata", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-provenance-write-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await cp(original, join(root, "pack"), { recursive: true });
	const path = join(root, "pack/resources/SOURCE.json");
	const before = await readFile(path);
	for (const field of ["selectedInputs", "dirtyInput"]) {
		const data = JSON.parse(before.toString("utf8"));
		delete data.source[field];
		await assert.rejects(writeV1Provenance(join(root, "pack"), data.source), /Invalid V1 provenance/);
		assert.deepEqual(await readFile(path), before);
	}
});

test("refresh cannot report a schema 1 upgrade without the required source evidence", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-provenance-refresh-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const pack = join(root, "packages/capability-harnessy-v1-full");
	await cp(original, pack, { recursive: true });
	const path = join(pack, "resources/SOURCE.json");
	const data = JSON.parse(await readFile(path, "utf8"));
	data.schemaVersion = 1;
	delete data.source.selectedInputs;
	delete data.source.dirtyInput;
	await writeFile(path, JSON.stringify(data));
	const before = await readFile(path);
	const transportBefore = await readFile(join(pack, "resources/npm-transport.json"));
	await mkdir(join(root, "scripts"));
	for (const name of ["refresh-v1-provenance.mjs", "v1-compatibility-lib.mjs"])
		await cp(new URL(name, import.meta.url), join(root, "scripts", name));
	const result = spawnSync(process.execPath, [join(root, "scripts/refresh-v1-provenance.mjs")], { encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /selected-inputs-missing/);
	assert.match(result.stderr, /dirty-input-missing/);
	assert.equal(result.stdout, "");
	assert.deepEqual(await readFile(path), before);
	assert.deepEqual(await readFile(join(pack, "resources/npm-transport.json")), transportBefore);
});

for (const schemaVersion of [1, 2]) {
	test(`legacy schema ${schemaVersion} retains projected-file reconstruction`, async (t) => {
		const root = await mkdtemp(join(tmpdir(), "harnessy-legacy-transport-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const input = join(root, "input");
		await cp(original, input, { recursive: true });
		const resources = join(input, "resources");
		for (const [source, target] of [
			["tools/flow-install", "flow-install"], [".jarvis/context", "context-vault"],
			["jarvis-cli", "jarvis-cli"], ["install.sh", "install.sh"],
			["README.md", "README.v1.md"], ["AGENTS.md", "AGENTS.v1.md"],
		]) await cp(join(resources, "source", source), join(resources, target), { recursive: true });
		const path = join(resources, "SOURCE.json");
		const data = JSON.parse(await readFile(path, "utf8"));
		await writeFile(path, JSON.stringify({ ...data, schemaVersion }));
		assert.equal((await verifyV1Compatibility(input)).ok, true);
		for (const omittedPath of [...omitted, "jarvis-cli/.gitignore"]) await unlink(join(resources, omittedPath));
		const output = join(root, "output");
		assert.equal((await stageV1Compatibility(input, output)).ok, true);
		assert.deepEqual(await readFile(join(output, "resources/jarvis-cli/.gitignore")),
			await readFile(join(original, "resources/source/jarvis-cli/.gitignore")));
		if (schemaVersion === 2) {
			const stagedPath = join(output, "resources/SOURCE.json");
			delete data.source.selectedInputs;
			delete data.source.dirtyInput;
			await writeFile(stagedPath, JSON.stringify({ ...data, schemaVersion }));
			const invalid = await verifyV1Compatibility(output);
			assert(invalid.issues.includes("selected-inputs-missing"));
			assert(invalid.issues.includes("dirty-input-missing"));
		}
	});
}
