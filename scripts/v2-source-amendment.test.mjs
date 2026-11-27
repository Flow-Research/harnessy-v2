import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { describeV1Tree, readV1Provenance, verifyV1Compatibility, writeV1Provenance, writeV2SourceAmendment } from "./v1-compatibility-lib.mjs";

const original = new URL("../packages/capability-harnessy-v1-full/", import.meta.url);
const fixture = async (t) => {
	const root = await mkdtemp(join(tmpdir(), "harnessy-v2-amendment-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await cp(original, root, { recursive: true });
	return root;
};

test("the V2 receipt binds exact new bytes and preserves all prior V1 evidence", async (t) => {
	const root = await fixture(t);
	const before = await readV1Provenance(root);
	await writeFile(join(root, "resources/source/amendment-fixture.md"), "reviewed fixture\n");
	const tree = await describeV1Tree(join(root, "resources/source"));
	const { path, ...after } = tree.entries.find((entry) => entry.path === "amendment-fixture.md");
	const receipt = { id: "test-v2-addition", owner: "harnessy-v2", reason: "Synthetic reviewed V2 addition", baseTree: before.tree, changes: [{ path, before: null, after }] };
	const written = await writeV2SourceAmendment(root, receipt);
	const { v2Amendments: _old, ...oldSource } = before.source;
	const { v2Amendments, ...newSource } = written.source;
	assert.deepEqual(newSource, oldSource);
	assert.equal(v2Amendments.length, before.source.v2Amendments.length + 1);
	assert.equal((await verifyV1Compatibility(root)).ok, true);
	const metadataBefore = await readFile(join(root, "resources/SOURCE.json"));
	await writeFile(join(root, "resources/source/unreviewed.md"), "unreviewed\n");
	await assert.rejects(writeV1Provenance(root, written.source), /v2-amendment-base-mismatch/);
	assert.deepEqual(await readFile(join(root, "resources/SOURCE.json")), metadataBefore);
});

test("incorrect prior tree, missing changes, and mismatched hashes cannot amend the artifact", async (t) => {
	const root = await fixture(t);
	const before = await readV1Provenance(root);
	const receipt = { id: "test-v2-invalid", owner: "harnessy-v2", reason: "Synthetic invalid V2 addition", baseTree: before.tree, changes: [] };
	const metadataBefore = await readFile(join(root, "resources/SOURCE.json"));
	await assert.rejects(writeV2SourceAmendment(root, { ...receipt, baseTree: { ...before.tree, digest: "0".repeat(64) } }), /prior source tree/);
	await assert.rejects(writeV2SourceAmendment(root, receipt), /v2-amendment-invalid/);
	const after = { size: 0, executable: false, sha256: "0".repeat(64) };
	await assert.rejects(writeV2SourceAmendment(root, { ...receipt, changes: [{ path: "missing.md", before: null, after }] }), /after-mismatch/);
	await assert.rejects(writeV2SourceAmendment(root, { ...receipt, changes: [{ path: "../escape", before: null, after }] }), /change-invalid/);
	assert.deepEqual(await readFile(join(root, "resources/SOURCE.json")), metadataBefore);
});

test("changing the catalog's retained prior hash breaks the original artifact binding", async (t) => {
	const root = await fixture(t);
	const metadata = await readV1Provenance(root);
	const catalog = metadata.source.v2Amendments[0].changes.find((change) => change.path === ".jarvis/context/skills/_catalog.md");
	catalog.before.sha256 = "0".repeat(64);
	await writeFile(join(root, "resources/SOURCE.json"), JSON.stringify(metadata));
	const result = await verifyV1Compatibility(root);
	assert.equal(result.ok, false);
	assert(result.issues.includes("v2-amendment-base-mismatch: engineering-loop-shared-skill-20261121"));
});
