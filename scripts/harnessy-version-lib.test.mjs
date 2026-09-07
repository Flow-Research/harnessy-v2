import assert from "node:assert/strict";
import test from "node:test";

import { nextHarnessyVersion, updateHarnessyManifest, updatePiManifest } from "./harnessy-version-lib.mjs";

test("Harnessy versions bump independently from inherited Pi", () => {
	assert.equal(nextHarnessyVersion("0.0.3", "patch"), "0.0.4");
	assert.equal(nextHarnessyVersion("0.9.9", "minor"), "0.10.0");
	assert.equal(nextHarnessyVersion("1.2.3", "major"), "2.0.0");
	assert.equal(nextHarnessyVersion("1.2.3", "1.3.0"), "1.3.0");
	assert.throws(() => nextHarnessyVersion("1.2.3", "1.2.3"), /must be greater/);
});

test("only Harnessy manifests and Harnessy dependency edges are rewritten", () => {
	assert.deepEqual(
		updateHarnessyManifest(
			{
				name: "@harnessy/core",
				version: "0.0.3",
				dependencies: { "@harnessy/executor": "0.0.3", "@earendil-works/pi-ai": "0.80.3" },
			},
			"0.0.4",
		),
		{
			name: "@harnessy/core",
			version: "0.0.4",
			dependencies: { "@harnessy/executor": "0.0.4", "@earendil-works/pi-ai": "0.80.3" },
		},
	);
	assert.deepEqual(
		updateHarnessyManifest(
			{ name: "@harnessy/local-host", version: "0.0.3", private: true, dependencies: { "@harnessy/core": "0.0.3" } },
			"0.0.4",
		),
		{ name: "@harnessy/local-host", version: "0.0.4", private: true, dependencies: { "@harnessy/core": "0.0.4" } },
	);
	assert.deepEqual(
		updateHarnessyManifest({ name: "@earendil-works/pi-ai", version: "0.80.3" }, "0.0.4"),
		{ name: "@earendil-works/pi-ai", version: "0.80.3" },
	);
});

test("the inherited Pi cohort advances independently and preserves dependency range policy", () => {
	assert.deepEqual(
		updatePiManifest(
			{
				name: "@earendil-works/pi-coding-agent",
				version: "0.80.3",
				dependencies: { "@earendil-works/pi-ai": "^0.80.3", "@harnessy/core": "0.0.3" },
			},
			"0.80.4",
		),
		{
			name: "@earendil-works/pi-coding-agent",
			version: "0.80.4",
			dependencies: { "@earendil-works/pi-ai": "^0.80.4", "@harnessy/core": "0.0.3" },
		},
	);
	assert.deepEqual(
		updatePiManifest(
			{ name: "@harnessy/core", version: "0.0.3", dependencies: { "@earendil-works/pi-ai": "0.80.3" } },
			"0.80.4",
		),
		{ name: "@harnessy/core", version: "0.0.3", dependencies: { "@earendil-works/pi-ai": "0.80.4" } },
	);
});
