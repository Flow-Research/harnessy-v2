import assert from "node:assert/strict";
import test from "node:test";

import { harnessyReleaseParts, selectedHarnessyReleaseParts } from "./harnessy-release-parts.mjs";

test("the release smoke without arguments still runs both installed-consumer parts", () => {
	assert.deepEqual(selectedHarnessyReleaseParts([]), ["installed-local-host", "installed-product"]);
	assert.deepEqual(selectedHarnessyReleaseParts([]), [...harnessyReleaseParts]);
});

test("each --part selects exactly that part", () => {
	assert.deepEqual(selectedHarnessyReleaseParts(["--part=installed-local-host"]), ["installed-local-host"]);
	assert.deepEqual(selectedHarnessyReleaseParts(["--part=installed-product"]), ["installed-product"]);
});

test("unknown, malformed or extra arguments are rejected", () => {
	for (const args of [["--part=bogus"], ["--part="], ["installed-product"], ["--part=installed-product", "--part=installed-local-host"]]) {
		assert.throws(() => selectedHarnessyReleaseParts(args), /^Error: Usage: test-harnessy-release\.mjs/u, JSON.stringify(args));
	}
});
