import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { stageV1Compatibility, verifyV1Compatibility, writeV1NpmTransport } from "./v1-compatibility-lib.mjs";

const original = fileURLToPath(new URL("../packages/capability-harnessy-v1-full", import.meta.url));
const omitted = ["source/.gitignore", "source/jarvis-cli/.gitignore", "jarvis-cli/.gitignore"];

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
