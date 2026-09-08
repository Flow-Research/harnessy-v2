import assert from "node:assert/strict";
import test from "node:test";

import { buildFeatureCatalog, serializeFeatureCatalog } from "./qa-feature-catalog-lib.mjs";
import { assertQaRuntimeIdentity, QA_RUNTIME_SHA256, qaRuntimeSha256 } from "./qa-runtime-bridge.mjs";

const records = [
	{ id: "SDK-002", app: "harnessy-v2", layer: "api", file: "qa/api/scripts/canonical-cutover.md" },
	{ id: "SDK-001", app: "harnessy-v2", layer: "api", file: "qa/api/scripts/canonical-cutover.md" },
	{ id: "SEC-001", app: "harnessy-v2", layer: "security", file: "qa/security/scripts/security-invariants.md" },
];

const profile = {
	catalog: {
		features: [
			{ prefix: "SEC", slug: "security-invariants", name: "Security invariants" },
			{ prefix: "SDK", slug: "private-sdk-consumer", name: "Private SDK consumer" },
		],
	},
};

test("the repo-owned QA bridge is pinned to the preserved generic runtime", () => {
	assert.equal(assertQaRuntimeIdentity(), QA_RUNTIME_SHA256);
	assert.notEqual(qaRuntimeSha256("tampered"), QA_RUNTIME_SHA256);
	assert.throws(() => assertQaRuntimeIdentity("tampered"), /Preserved QA runtime digest changed/);
});

test("the feature catalog is semantic, deterministic, and sorted", () => {
	const catalog = buildFeatureCatalog({ records, profile });
	assert.deepEqual(
		catalog.features.map((feature) => [feature.id_prefix, feature.slug, feature.scenario_count]),
		[
			["SDK", "private-sdk-consumer", 2],
			["SEC", "security-invariants", 1],
		],
	);
	assert.equal(serializeFeatureCatalog(catalog), serializeFeatureCatalog(buildFeatureCatalog({ records, profile })));
});

test("the feature catalog rejects missing, orphaned, duplicate, and invalid semantic metadata", () => {
	assert.throws(
		() => buildFeatureCatalog({ records, profile: { catalog: { features: profile.catalog.features.slice(0, 1) } } }),
		/Missing catalog metadata/,
	);
	assert.throws(
		() =>
			buildFeatureCatalog({
				records: records.slice(0, 2),
				profile,
			}),
		/Catalog metadata has no spec scenarios/,
	);
	assert.throws(
		() =>
			buildFeatureCatalog({
				records,
				profile: { catalog: { features: [...profile.catalog.features, profile.catalog.features[0]] } },
			}),
		/Duplicate catalog prefix/,
	);
	assert.throws(
		() =>
			buildFeatureCatalog({
				records,
				profile: {
					catalog: {
						features: profile.catalog.features.map((feature) =>
							feature.prefix === "SDK" ? { ...feature, slug: "Not Portable" } : feature,
						),
					},
				},
			}),
		/Invalid catalog slug/,
	);
});
