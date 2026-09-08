import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";

import {
	EVIDENCE_MARKER,
	assertEvidenceInventoriesMatch,
	assertSafeEvidenceOutput,
	buildEvidenceIndex,
	buildPackedConsumerEvidence,
	bunLockToCycloneDx,
	canonicalJson,
	classifyArtifactLicense,
	collectRepositoryInputPaths,
	licensesMarkdown,
	makeLicenseReport,
	npmLockToCycloneDx,
	normalizeCycloneDx,
	parseBunLock,
	parseNpmLock,
	readSafeEvidence,
	reconcileNpmCycloneDxWithLock,
	releaseToolchainIssues,
	resolveLicenseDeclaration,
	sha256,
	strictLicenseIssues,
	validateComponentEvidence,
	validateCycloneDxReferences,
	validateLicenseTextReferences,
	validateReleaseLedger,
	verifyEvidenceIndex,
	verifyReleaseArtifactFiles,
	verifyReleaseSourceInputs,
} from "./supply-chain-evidence-lib.mjs";
import {
	executorPlatformTags,
	executorReleasePackages,
	packedReleasePackages,
	sourceReleasePackages,
} from "./harnessy-release-contract.mjs";

const temporaryRoots = [];
const temporaryRoot = () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-supply-test-"));
	temporaryRoots.push(root);
	return root;
};
afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const graph = (components = []) => ({
	bomFormat: "CycloneDX",
	specVersion: "1.5",
	version: 1,
	metadata: { timestamp: "2026-09-04T12:34:56Z" },
	components,
	dependencies: components.map((component) => ({ ref: component["bom-ref"], dependsOn: [] })),
});

const LOCKED_LIBSQL_NATIVE_MATRIX = {
	"@libsql/darwin-arm64": "0.5.29",
	"@libsql/darwin-x64": "0.5.29",
	"@libsql/linux-arm-gnueabihf": "0.5.29",
	"@libsql/linux-arm-musleabihf": "0.5.29",
	"@libsql/linux-arm64-gnu": "0.5.29",
	"@libsql/linux-arm64-musl": "0.5.29",
	"@libsql/linux-x64-gnu": "0.5.29",
	"@libsql/linux-x64-musl": "0.5.29",
	"@libsql/win32-x64-msvc": "0.5.29",
};

const windowsArm64LibsqlTruthIssues = ({ lock, descriptor }) => {
	const issues = [];
	const libsqlEntry = lock.packages?.libsql;
	if (!Array.isArray(libsqlEntry) || typeof libsqlEntry[0] !== "string" || !libsqlEntry[0].startsWith("libsql@")) {
		return ["Executor lock has no exact libsql package entry"];
	}
	const libsqlVersion = libsqlEntry[0].slice("libsql@".length);
	const metadata = libsqlEntry[2];
	const optionalDependencies =
		metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) &&
		metadata.optionalDependencies !== null && typeof metadata.optionalDependencies === "object" &&
		!Array.isArray(metadata.optionalDependencies)
			? metadata.optionalDependencies
			: {};
	const nativePackage = "@libsql/win32-arm64-msvc";
	if (canonicalJson(optionalDependencies) !== canonicalJson(LOCKED_LIBSQL_NATIVE_MATRIX)) {
		issues.push("Executor libsql optional dependency matrix differs from the reviewed lock contract");
	}
	for (const [reviewedNativePackage, reviewedVersion] of Object.entries(LOCKED_LIBSQL_NATIVE_MATRIX)) {
		const declaredReviewedVersion = optionalDependencies[reviewedNativePackage];
		if (declaredReviewedVersion !== reviewedVersion) {
			issues.push(
				`${reviewedNativePackage} optional dependency ${String(declaredReviewedVersion)} does not match reviewed ${reviewedVersion}`,
			);
		}
		const reviewedEntry = lock.packages?.[reviewedNativePackage];
		if (reviewedEntry === undefined) {
			issues.push(`${reviewedNativePackage} reviewed libsql declaration has no locked package`);
			continue;
		}
		if (
			!Array.isArray(reviewedEntry) ||
			typeof reviewedEntry[0] !== "string" ||
			!reviewedEntry[0].startsWith(`${reviewedNativePackage}@`)
		) {
			issues.push(`${reviewedNativePackage} has a malformed locked package entry`);
			continue;
		}
		const lockedReviewedVersion = reviewedEntry[0].slice(`${reviewedNativePackage}@`.length);
		if (lockedReviewedVersion !== declaredReviewedVersion) {
			issues.push(
				`${reviewedNativePackage} locked package ${lockedReviewedVersion} does not match optional dependency ${String(declaredReviewedVersion)}`,
			);
		}
		if (lockedReviewedVersion !== libsqlVersion) {
			issues.push(`${reviewedNativePackage} locked package ${lockedReviewedVersion} does not match libsql ${libsqlVersion}`);
		}
	}
	const declaredNativeVersion = optionalDependencies[nativePackage];
	const nativeEntry = lock.packages?.[nativePackage];
	const lockedNativeVersion =
		Array.isArray(nativeEntry) && typeof nativeEntry[0] === "string" && nativeEntry[0].startsWith(`${nativePackage}@`)
			? nativeEntry[0].slice(`${nativePackage}@`.length)
			: null;
	if (nativeEntry !== undefined && lockedNativeVersion === null) {
		issues.push(`${nativePackage} has a malformed locked package entry`);
	}
	if ((declaredNativeVersion === undefined) !== (nativeEntry === undefined)) {
		issues.push(
			declaredNativeVersion === undefined
				? `${nativePackage} is locked but not declared by libsql`
				: `${nativePackage} is declared by libsql but has no locked package`,
		);
	}
	if (declaredNativeVersion !== undefined && declaredNativeVersion !== libsqlVersion) {
		issues.push(`${nativePackage} optional dependency ${String(declaredNativeVersion)} does not match libsql ${libsqlVersion}`);
	}
	if (lockedNativeVersion !== null && lockedNativeVersion !== libsqlVersion) {
		issues.push(`${nativePackage} locked package ${lockedNativeVersion} does not match libsql ${libsqlVersion}`);
	}
	if (!(descriptor.requiredFiles ?? []).includes("bin/libsql.node")) {
		issues.push("Windows arm64 release descriptor does not require bin/libsql.node");
	}
	const releaseBlockers = (descriptor.releaseBlockers ?? []).join("\n");
	if (
		!/compatible libSQL native sidecar or a proven alternative/u.test(releaseBlockers) ||
		!/real packed Windows arm64 wrapper passes --version and local SQLite\/health smoke testing/u.test(releaseBlockers)
	) {
		issues.push("Windows arm64 release descriptor has no complete explicit blocker");
	}
	return issues;
};

test("CycloneDX normalization is byte deterministic and rejects incomplete graphs", () => {
	const source = graph([
		{ "bom-ref": "b", type: "library", name: "b", version: "2", purl: "pkg:npm/b@2" },
		{ "bom-ref": "a", type: "library", name: "a", version: "1", purl: "pkg:npm/a@1" },
	]);
	const first = canonicalJson(normalizeCycloneDx(source, "fixture"));
	const second = canonicalJson(normalizeCycloneDx(structuredClone(source), "fixture"));
	assert.equal(first, second);
	assert.match(first, /1970-01-01T00:00:00\.000Z/u);
	assert.throws(() => normalizeCycloneDx({ bomFormat: "CycloneDX", components: [] }, "broken"), /complete/u);
});

test("reproducibility rejects canonical evidence that differs from matching reruns", () => {
	const matching = [{ path: "result.json", sha256: "a".repeat(64) }];
	assert.doesNotThrow(() =>
		assertEvidenceInventoriesMatch([
			{ label: "canonical", files: matching },
			{ label: "run-a", files: structuredClone(matching) },
			{ label: "run-b", files: structuredClone(matching) },
		]),
	);
	assert.throws(
		() =>
			assertEvidenceInventoriesMatch([
				{ label: "canonical", files: [{ path: "result.json", sha256: "b".repeat(64) }] },
				{ label: "run-a", files: matching },
				{ label: "run-b", files: structuredClone(matching) },
			]),
		/canonical != run-a, run-b/u,
	);
});

test("Bun and npm lock parsers fail closed on malformed and unsupported input", () => {
	assert.throws(() => parseBunLock("{ not json"), /Malformed Bun/u);
	assert.throws(() => parseBunLock('{"lockfileVersion": 0, "packages": {}}'), /Unsupported Bun/u);
	assert.throws(() => parseNpmLock("{"), /Malformed npm/u);
	assert.throws(() => parseNpmLock('{"lockfileVersion":2,"packages":{}}'), /not a supported npm/u);
	const lock = parseBunLock(`{
		// safe JSONC
		"lockfileVersion": 1,
		"workspaces": { "": { "name": "executor-workspace", "dependencies": { "a": "1" } } },
		"packages": { "a": ["a@1.0.0", "", {}, "sha512-x"], },
	}`);
	const bom = bunLockToCycloneDx(lock, new Map([["a@1.0.0", "MIT"]]), new Map([["executor-workspace", "1.0.0"]]));
	assert.equal(bom.components[0].licenses[0].license.name, "MIT");
});

test("Bun graph preserves lock identity, workspace versions, exact nesting, root edges, and scoped purls", () => {
	const lock = parseBunLock(`{
		"lockfileVersion": 1,
		"workspaces": {
			"": { "name": "executor-workspace", "dependencies": { "@scope/app": "workspace:*", "x": "1" } },
			"packages/app": { "name": "@scope/app", "version": "2.0.0", "dependencies": { "x": "2" } }
		},
		"packages": {
			"@scope/app": ["@scope/app@workspace:packages/app"],
			"x": ["x@1.0.0", "", {}],
			"@scope/app/x": ["x@2.0.0", "", {}]
		}
	}`);
	const bom = bunLockToCycloneDx(lock, new Map(), new Map([["executor-workspace", "1.0.0"]]));
	assert.equal(new Set(bom.components.map((component) => component["bom-ref"])).size, bom.components.length);
	const app = bom.components.find((component) => component.name === "@scope/app");
	assert.equal(app.version, "2.0.0");
	assert.equal(app.purl, "pkg:npm/%40scope/app@2.0.0");
	assert.deepEqual(bom.dependencies.find((row) => row.ref === app["bom-ref"]).dependsOn, ["bun-lock:%40scope%2Fapp%2Fx"]);
	assert.deepEqual(bom.dependencies.find((row) => row.ref === "bun-workspace:.").dependsOn, ["bun-lock:x", app["bom-ref"]]);
});

test("real Executor Bun graph has one component per lock identity and no dependency fan-out", () => {
	const lock = parseBunLock(readFileSync(new URL("../executor/bun.lock", import.meta.url), "utf8"));
	const versions = new Map();
	for (const [workspacePath, metadata] of Object.entries(lock.workspaces)) {
		const manifestPath = new URL(`../executor/${workspacePath ? `${workspacePath}/` : ""}package.json`, import.meta.url);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		versions.set(metadata.name, manifest.version);
	}
	const bom = bunLockToCycloneDx(lock, new Map(), versions);
	const proxyCount = Object.values(lock.packages).filter((entry) => String(entry[0]).includes("@workspace:")).length;
	assert.equal(bom.components.length, Object.keys(lock.packages).length - proxyCount + Object.keys(lock.workspaces).length - 1);
	assert.equal(new Set(bom.components.map((component) => component["bom-ref"])).size, bom.components.length);
	assert.equal(new Set(bom.dependencies.map((row) => row.ref)).size, bom.dependencies.length);
	assert(bom.dependencies.some((row) => row.ref === "bun-workspace:."));
	const babelCore = bom.components.find((component) =>
		component.properties?.some((property) => property.name === "harnessy:bun:lock-key" && property.value === "@babel/core"),
	);
	const babelTypes = bom.components.find((component) =>
		component.properties?.some(
			(property) => property.name === "harnessy:bun:lock-key" && property.value === "@babel/core/@babel/types",
		),
	);
	const coreDependencies = bom.dependencies.find((row) => row.ref === babelCore["bom-ref"]).dependsOn;
	assert(coreDependencies.includes(babelTypes["bom-ref"]));
	assert.equal(
		coreDependencies.filter((ref) => bom.components.find((component) => component["bom-ref"] === ref)?.name === "@babel/types").length,
		1,
	);
});

test("real Executor lock retains the deferred Windows arm64 native-runtime evidence", () => {
	const lock = parseBunLock(readFileSync(new URL("../executor/bun.lock", import.meta.url), "utf8"));
	const descriptor = {
		requiredFiles: ["bin/libsql.node"],
		releaseBlockers: [
			"Windows arm64 publication is deferred until a compatible libSQL native sidecar or a proven alternative is available and a real packed Windows arm64 wrapper passes --version and local SQLite/health smoke testing",
		],
	};
	assert.deepEqual(windowsArm64LibsqlTruthIssues({ lock, descriptor }), []);
	assert.equal(lock.packages.libsql[0], "libsql@0.5.29");
	assert.equal(lock.packages.libsql[2].optionalDependencies["@libsql/win32-x64-msvc"], "0.5.29");
	assert.equal(lock.packages.libsql[2].optionalDependencies["@libsql/win32-arm64-msvc"], undefined);
	assert.equal(lock.packages["@libsql/win32-arm64-msvc"], undefined);
	for (const reviewedNativePackage of Object.keys(LOCKED_LIBSQL_NATIVE_MATRIX)) {
		const missingReviewedPackage = structuredClone(lock);
		delete missingReviewedPackage.packages[reviewedNativePackage];
		assert(
			windowsArm64LibsqlTruthIssues({ lock: missingReviewedPackage, descriptor }).includes(
				`${reviewedNativePackage} reviewed libsql declaration has no locked package`,
			),
			`${reviewedNativePackage} deletion must fail closed`,
		);
	}

	const malformedReviewedPackage = structuredClone(lock);
	malformedReviewedPackage.packages["@libsql/win32-x64-msvc"] = ["not-libsql"];
	assert.match(
		windowsArm64LibsqlTruthIssues({ lock: malformedReviewedPackage, descriptor }).join("\n"),
		/@libsql\/win32-x64-msvc has a malformed locked package entry/u,
	);

	const mismatchedReviewedPackage = structuredClone(lock);
	mismatchedReviewedPackage.packages["@libsql/win32-x64-msvc"][0] = "@libsql/win32-x64-msvc@0.5.30";
	assert.match(
		windowsArm64LibsqlTruthIssues({ lock: mismatchedReviewedPackage, descriptor }).join("\n"),
		/@libsql\/win32-x64-msvc locked package 0\.5\.30 does not match optional dependency 0\.5\.29/u,
	);

	assert.match(
		windowsArm64LibsqlTruthIssues({
			lock,
			descriptor: { ...descriptor, requiredFiles: descriptor.requiredFiles.filter((path) => path !== "bin/libsql.node") },
		}).join("\n"),
		/does not require bin\/libsql\.node/u,
	);
	assert.match(
		windowsArm64LibsqlTruthIssues({ lock, descriptor: { ...descriptor, releaseBlockers: [] } }).join("\n"),
		/has no complete explicit blocker/u,
	);
	assert.match(
		windowsArm64LibsqlTruthIssues({
			lock,
			descriptor: { ...descriptor, releaseBlockers: ["unrelated blocker"] },
		}).join("\n"),
		/has no complete explicit blocker/u,
	);

	const danglingOptional = structuredClone(lock);
	danglingOptional.packages.libsql[2].optionalDependencies["@libsql/win32-arm64-msvc"] = "0.5.29";
	assert.match(windowsArm64LibsqlTruthIssues({ lock: danglingOptional, descriptor }).join("\n"), /has no locked package/u);

	const orphanPackage = structuredClone(lock);
	orphanPackage.packages["@libsql/win32-arm64-msvc"] = [
		"@libsql/win32-arm64-msvc@0.5.29",
		"",
		{ os: "win32", cpu: "arm64" },
		"sha512-fixture",
	];
	assert.match(windowsArm64LibsqlTruthIssues({ lock: orphanPackage, descriptor }).join("\n"), /not declared by libsql/u);

	const mismatchedPackage = structuredClone(danglingOptional);
	mismatchedPackage.packages.libsql[2].optionalDependencies["@libsql/win32-arm64-msvc"] = "0.5.30";
	mismatchedPackage.packages["@libsql/win32-arm64-msvc"] = [
		"@libsql/win32-arm64-msvc@0.5.30",
		"",
		{ os: "win32", cpu: "arm64" },
		"sha512-fixture",
	];
	assert.match(windowsArm64LibsqlTruthIssues({ lock: mismatchedPackage, descriptor }).join("\n"), /does not match libsql/u);

	const apparentlyCompletePackage = structuredClone(danglingOptional);
	apparentlyCompletePackage.packages["@libsql/win32-arm64-msvc"] = [
		"@libsql/win32-arm64-msvc@0.5.29",
		"",
		{ os: "win32", cpu: "arm64" },
		"sha512-fixture",
	];
	assert.match(
		windowsArm64LibsqlTruthIssues({ lock: apparentlyCompletePackage, descriptor }).join("\n"),
		/optional dependency matrix differs/u,
	);
});

test("packed-consumer graph is derived offline from attested tarballs and the root lock", () => {
	const rootGraph = normalizeCycloneDx(
		{
			bomFormat: "CycloneDX",
			specVersion: "1.5",
			version: 1,
			metadata: {
				timestamp: "2026-09-04T12:34:56Z",
				component: { "bom-ref": "root-app", type: "application", name: "root-app", version: "1.0.0" },
			},
			components: [
				{
					"bom-ref": "dep@1",
					type: "library",
					name: "dep",
					version: "1.0.0",
					purl: "pkg:npm/dep@1.0.0",
					licenses: [{ license: { id: "MIT" } }],
				},
				{ "bom-ref": "child@2", type: "library", name: "child", version: "2.0.0", purl: "pkg:npm/child@2.0.0" },
				{
					"bom-ref": "unrelated@3",
					type: "library",
					name: "unrelated",
					version: "3.0.0",
					purl: "pkg:npm/unrelated@3.0.0",
				},
			],
			dependencies: [
				{ ref: "root-app", dependsOn: ["dep@1", "unrelated@3"] },
				{ ref: "dep@1", dependsOn: ["child@2"] },
				{ ref: "child@2", dependsOn: [] },
				{ ref: "unrelated@3", dependsOn: [] },
			],
		},
		"root",
	);
	const artifact = {
		key: "pkg",
		version: "1.0.0",
		sha256: "a".repeat(64),
		evidenceTarball: "release-tarballs/pkg.tgz",
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
		license: { declaredLicense: "AGPL-3.0-only" },
		manifestDependencies: { dep: "1.0.0" },
	};
	const unselectedArtifact = {
		...artifact,
		key: "pkg-linux-x64",
		sha256: "c".repeat(64),
		manifestDependencies: {},
	};
	const descriptor = { key: "pkg", name: "@scope/pkg" };
	const unselectedDescriptor = { key: "pkg-linux-x64", name: "@scope/pkg-linux-x64" };
	const first = buildPackedConsumerEvidence({
		rootGraph,
		artifacts: [artifact, unselectedArtifact],
		descriptors: [descriptor, unselectedDescriptor],
		consumerDescriptorKeys: ["pkg"],
		rootLockSha256: "b".repeat(64),
	});
	assert.equal(first.lock.resolution, "offline-root-lock-and-local-tarballs");
	assert.equal(first.graph.components.find((component) => component.name === "@scope/pkg").purl, "pkg:npm/%40scope/pkg@1.0.0");
	assert.deepEqual(validateCycloneDxReferences(first.graph, "packed-consumer"), []);
	assert.deepEqual(
		first.graph.components.map((component) => component["bom-ref"]).sort(),
		["child@2", "dep@1", "packed-artifact:pkg"],
	);
	assert.equal(first.graph.dependencies.some((row) => row.ref === "root-app"), false);
	assert.equal(first.graph.components.some((component) => component.name === "unrelated"), false);
	assert.equal(first.graph.components.some((component) => component.name === "@scope/pkg-linux-x64"), false);
	assert.deepEqual(first.lock.consumerDescriptorKeys, ["pkg"]);
	assert.deepEqual(first.lock.artifacts.map((entry) => entry.key), ["pkg"]);
	const second = buildPackedConsumerEvidence({
		rootGraph,
		artifacts: [artifact, unselectedArtifact],
		descriptors: [descriptor, unselectedDescriptor],
		consumerDescriptorKeys: ["pkg"],
		rootLockSha256: "c".repeat(64),
	});
	assert.notEqual(canonicalJson(first.lock), canonicalJson(second.lock));
	assert.throws(
		() =>
			buildPackedConsumerEvidence({
				rootGraph,
				artifacts: [{ ...artifact, manifestDependencies: { missing: "1.0.0" } }],
				descriptors: [descriptor, unselectedDescriptor],
				consumerDescriptorKeys: ["pkg"],
				rootLockSha256: "b".repeat(64),
			}),
		/0 root-lock candidates/u,
	);
});

test("real packed source packages resolve from the npm production lock without npm SBOM omissions", () => {
	const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
	const lock = parseNpmLock(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
	const rootGraph = npmLockToCycloneDx(lock);
	assert.deepEqual(validateCycloneDxReferences(rootGraph, "npm-production-lock"), []);
	const sourceDescriptors = sourceReleasePackages();
	const descriptors = packedReleasePackages(executorPlatformTags());
	const artifacts = sourceDescriptors.map((descriptor) => {
		const manifest = JSON.parse(readFileSync(join(repoRoot, descriptor.directory, "package.json"), "utf8"));
		return {
			key: descriptor.key ?? descriptor.name,
			version: manifest.version,
			sha256: "a".repeat(64),
			integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
			license: { declaredLicense: manifest.license ?? "NOASSERTION" },
			manifestDependencies: manifest.dependencies ?? {},
			manifestOptionalDependencies: manifest.optionalDependencies ?? {},
		};
	});
	const executorWrapper = JSON.parse(readFileSync(join(repoRoot, "packages/harnessy-executor/package.json"), "utf8"));
	artifacts.push({
		key: "@harnessy/executor",
		version: executorWrapper.version,
		sha256: "b".repeat(64),
		integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
		license: { declaredLicense: executorWrapper.license },
		manifestDependencies: executorWrapper.dependencies ?? {},
		manifestOptionalDependencies: executorWrapper.optionalDependencies ?? {},
	});
	const packed = buildPackedConsumerEvidence({
		rootGraph,
		artifacts,
		descriptors,
		consumerDescriptorKeys: artifacts.map((artifact) => artifact.key),
		rootLockSha256: sha256(readFileSync(join(repoRoot, "package-lock.json"))),
	});
	assert.deepEqual(validateCycloneDxReferences(packed.graph, "packed-consumer"), []);
	for (const name of ["@opentelemetry/api", "yaml", "chalk", "semver", "effect", "zod"]) {
		assert(packed.graph.components.some((component) => component.name === name), `${name} must be in the packed closure`);
	}
});

test("npm CycloneDX reconciliation retains npm provenance and supplements omitted lock components", () => {
	const lock = parseNpmLock(`{
		"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{
			"":{"name":"fixture","version":"1.0.0","dependencies":{"present":"1.0.0","omitted":"2.0.0"}},
			"node_modules/present":{"version":"1.0.0","license":"MIT"},
			"node_modules/omitted":{"version":"2.0.0","license":"Apache-2.0"}
		}
	}`);
	const lockGraph = npmLockToCycloneDx(lock);
	const npmGraph = {
		...graph([{ "bom-ref": "present@1.0.0", type: "library", name: "present", version: "1.0.0" }]),
		metadata: {
			timestamp: "2026-09-04T12:34:56Z",
			tools: [{ vendor: "npm", name: "cli", version: "11.6.0" }],
			component: { "bom-ref": "fixture@1.0.0", type: "application", name: "fixture", version: "1.0.0" },
		},
		dependencies: [
			{ ref: "fixture@1.0.0", dependsOn: ["present@1.0.0"] },
			{ ref: "present@1.0.0", dependsOn: [] },
		],
	};
	const reconciled = reconcileNpmCycloneDxWithLock(npmGraph, lockGraph);
	assert.deepEqual(validateCycloneDxReferences(reconciled, "root-production"), []);
	assert.equal(reconciled.metadata.tools[0].vendor, "npm");
	assert(reconciled.components.some((component) => component.name === "omitted"));
	assert.equal(reconciled.components.length, lockGraph.components.length);
});

test("safe evidence reads reject traversal, symlinks, and oversized files", () => {
	const root = temporaryRoot();
	writeFileSync(join(root, "ok.txt"), "ok");
	writeFileSync(join(root, "large.txt"), "1234");
	symlinkSync(join(root, "ok.txt"), join(root, "link.txt"));
	assert.equal(readSafeEvidence(root, "ok.txt").toString(), "ok");
	assert.throws(() => readSafeEvidence(root, "../ok.txt"), /Unsafe evidence path/u);
	assert.throws(() => readSafeEvidence(root, "link.txt"), /symlink/u);
	assert.throws(() => readSafeEvidence(root, "large.txt", 2), /oversized/u);
});

test("generation output is restricted and marked before replacement", () => {
	const repoRoot = temporaryRoot();
	const canonical = join(repoRoot, ".supply-chain-evidence");
	assert.doesNotThrow(() => assertSafeEvidenceOutput({ repoRoot, outputRoot: canonical, generating: true }));
	mkdirSync(canonical);
	assert.throws(() => assertSafeEvidenceOutput({ repoRoot, outputRoot: canonical, generating: true }), /unmarked/u);
	writeFileSync(join(canonical, EVIDENCE_MARKER), "schema=1\n");
	assert.doesNotThrow(() => assertSafeEvidenceOutput({ repoRoot, outputRoot: canonical, generating: true }));
	assert.throws(() => assertSafeEvidenceOutput({ repoRoot, outputRoot: join(repoRoot, "docs"), generating: true }), /must be/u);
	const target = join(repoRoot, "target");
	mkdirSync(target);
	rmSync(canonical, { recursive: true });
	symlinkSync(target, canonical);
	assert.throws(() => assertSafeEvidenceOutput({ repoRoot, outputRoot: canonical, generating: true }), /symlink/u);
});

test("SEE LICENSE declarations require a safe existing target and become strict issues when missing", () => {
	const root = temporaryRoot();
	writeFileSync(join(root, "NOTICE.txt"), "terms");
	assert.equal(resolveLicenseDeclaration({ packageRoot: root, declaration: "SEE LICENSE IN NOTICE.txt" }).text, "terms");
	assert.throws(() => resolveLicenseDeclaration({ packageRoot: root, declaration: "SEE LICENSE IN missing.txt" }));
	const fixtureGraph = graph([{ "bom-ref": "a", name: "a", version: "1", purl: "pkg:npm/a@1" }]);
	const evidence = new Map([["a@1", { declaredLicense: "SEE LICENSE IN missing.txt", requiredLicenseFile: "missing.txt", evidence: null }]]);
	assert.match(validateComponentEvidence({ graph: fixtureGraph, scope: "root", evidenceByPackage: evidence })[0], /target is missing/u);
});

test("missing component metadata and licenses are explicit strict blockers", () => {
	const fixtureGraph = graph([{ "bom-ref": "a", name: "a", version: "1", purl: "pkg:npm/a@1", licenses: [{ license: { name: "NOASSERTION" } }] }]);
	const componentIssues = validateComponentEvidence({ graph: fixtureGraph, scope: "root", evidenceByPackage: new Map() });
	const report = makeLicenseReport({
		graphs: { root: fixtureGraph },
		artifacts: [{ key: "harnessy", license: { decisionRequired: true, issues: [] } }],
		licenseTexts: [],
		componentIssues,
	});
	assert.match(strictLicenseIssues(report).join("\n"), /no installed package metadata evidence/u);
	assert.match(strictLicenseIssues(report).join("\n"), /NOASSERTION/u);
	assert.match(strictLicenseIssues(report).join("\n"), /approved V2D-002 license policy/u);
});

test("approved Harnessy license metadata and package evidence do not require a pending legal decision", () => {
	const result = classifyArtifactLicense({
		descriptor: { name: "@harnessy/core", provenance: "harnessy-authored" },
		manifest: { license: "AGPL-3.0-only" },
		packedPaths: ["package.json", "LICENSE", "CLAUDE_BRIDGE_VENDOR.md", "THIRD_PARTY_LICENSES/pi-claude-bridge.txt"],
		packageRootLicense: Buffer.from("AGPL"),
		harnessyLicense: Buffer.from("AGPL"),
		piLicense: mit,
		executorLicense: Buffer.from("Executor"),
		claudeBridgeNotice: Buffer.from("notice"),
		claudeBridgeLicense: Buffer.from("license"),
	});
	assert.equal(result.decisionRequired, false);
	assert.deepEqual(result.issues, []);
	const report = makeLicenseReport({ graphs: {}, artifacts: [{ key: "core", license: result }], licenseTexts: [] });
	assert.deepEqual(strictLicenseIssues(report), []);
	const mismatch = classifyArtifactLicense({
		descriptor: { name: "@harnessy/engine", provenance: "harnessy-authored" },
		manifest: { license: "AGPL-3.0-only" },
		packedPaths: ["package.json", "LICENSE"],
		packageRootLicense: Buffer.from("AGPL"),
		harnessyLicense: Buffer.from("canonical AGPL"),
		piLicense: mit,
		executorLicense: Buffer.from("Executor"),
		claudeBridgeNotice: null,
		claudeBridgeLicense: null,
	});
	assert.match(mismatch.issues.join("\n"), /canonical AGPL/u);
});

test("strict release tooling rejects npm versions other than the release pin", () => {
	const pinned = {
		node: "v22.22.2",
		nodeReleasePin: "22.22.2",
		npm: "11.6.0",
		npmReleasePin: "11.6.0",
		bun: "1.4.0",
		bunReleasePin: "1.4.0",
		python: "Python 3.11.14",
		pythonReleaseSeries: "3.11.",
	};
	assert.deepEqual(releaseToolchainIssues(pinned), []);
	for (const [key, value] of [
		["node", "v24.8.0"],
		["npm", "11.16.0"],
		["bun", "1.3.5"],
		["python", "Python 3.12.0"],
	]) {
		assert.match(releaseToolchainIssues({ ...pinned, [key]: value })[0], /does not match/u);
	}
});

const mit = Buffer.from("MIT notice\n");
const artifactFixture = (overrides = {}) =>
	classifyArtifactLicense({
		descriptor: { name: "pi", provenance: "inherited-pi" },
		manifest: { license: "MIT" },
		packedPaths: ["package.json", "LICENSE"],
		packageRootLicense: mit,
		piLicense: mit,
		executorLicense: Buffer.from("Executor"),
		claudeBridgeNotice: null,
		claudeBridgeLicense: null,
		...overrides,
	});

test("inherited Pi and Executor packages require the matching package-root license", () => {
	assert.deepEqual(artifactFixture().issues, []);
	assert.match(artifactFixture({ packageRootLicense: Buffer.from("MIT notice") }).issues[0], /differs/u);
	assert.match(artifactFixture({ packageRootLicense: Buffer.from("wrong") }).issues[0], /differs/u);
	const executor = artifactFixture({
		descriptor: { name: "executor", provenance: "inherited-executor" },
		packageRootLicense: Buffer.from("Pi"),
		piLicense: Buffer.from("Pi"),
		executorLicense: Buffer.from("Executor"),
	});
	assert.match(executor.issues[0], /differs/u);
	const nestedOnly = artifactFixture({ packedPaths: ["package.json", "resources/source/LICENSE"], packageRootLicense: null });
	assert.match(nestedOnly.issues[0], /package-root/u);
});

test("Claude bridge notice and license are mandatory in the core artifact", () => {
	const result = artifactFixture({
		descriptor: { name: "@harnessy/core", provenance: "harnessy-authored" },
		manifest: { license: "AGPL-3.0-only" },
		packedPaths: ["package.json"],
		packageRootLicense: null,
	});
	assert.match(result.issues.join("\n"), /Claude bridge/u);
});

test("release ledger enforces descriptor, integrity, file, and source-input contracts", () => {
	const descriptor = { key: "pkg", name: "pkg", directory: "packages/pkg", requiredFiles: ["LICENSE"] };
	const files = ["LICENSE", "package.json"];
	const artifact = {
		key: "pkg",
		name: "pkg",
		version: "1.0.0",
		directory: "packages/pkg",
		integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
		sha256: "a".repeat(64),
		evidenceTarball: "release-tarballs/pkg.tgz",
		manifestSha256: "b".repeat(64),
		files,
		sourceInputs: files.map((path) => ({ path: `packages/pkg/${path}`, sha256: "c".repeat(64), bytes: 1 })),
	};
	assert.deepEqual(validateReleaseLedger([artifact], [descriptor]), []);
	assert.match(validateReleaseLedger([], [descriptor])[0], /omitted pkg/u);
	assert.match(validateReleaseLedger([{ ...artifact, name: "wrong" }], [descriptor]).join("\n"), /package name/u);
	assert.match(validateReleaseLedger([{ ...artifact, files: ["package.json"] }], [descriptor]).join("\n"), /required file/u);
});

test("evidence verification detects stale outputs, omitted descriptors, and stale release sources", () => {
	const repoRoot = temporaryRoot();
	const outputRoot = join(repoRoot, "out");
	mkdirSync(outputRoot);
	writeFileSync(join(repoRoot, "input.txt"), "input");
	writeFileSync(join(outputRoot, "result.json"), "result");
	const index = buildEvidenceIndex({
		files: [{ path: "result.json", sha256: sha256("result"), bytes: 6 }],
		inputs: [{ path: "input.txt", sha256: sha256("input") }],
		releaseDescriptorKeys: ["a"],
	});
	assert.deepEqual(
		verifyEvidenceIndex({
			outputRoot,
			repoRoot,
			index,
			expectedFiles: ["result.json"],
			expectedDescriptorKeys: ["a"],
			expectedInputs: ["input.txt"],
		}),
		[],
	);
	assert.match(
		verifyEvidenceIndex({
			outputRoot,
			repoRoot,
			index,
			expectedFiles: ["result.json"],
			expectedDescriptorKeys: ["a"],
			expectedInputs: ["input.txt", "scripts/generator.mjs"],
		}).join("\n"),
		/omitted required input scripts\/generator\.mjs/u,
	);
	writeFileSync(join(outputRoot, "result.json"), "changed");
	writeFileSync(join(outputRoot, "unindexed.txt"), "unexpected");
	assert.match(verifyEvidenceIndex({ outputRoot, repoRoot, index, expectedFiles: ["result.json"], expectedDescriptorKeys: ["a", "b"] }).join("\n"), /stale evidence hash/u);
	assert.match(verifyEvidenceIndex({ outputRoot, repoRoot, index, expectedFiles: ["result.json"], expectedDescriptorKeys: ["a", "b"] }).join("\n"), /inventory differs/u);
	assert.match(verifyEvidenceIndex({ outputRoot, repoRoot, index, expectedFiles: ["result.json"], expectedDescriptorKeys: ["a", "b"] }).join("\n"), /descriptor set/u);
	writeFileSync(join(repoRoot, "source.txt"), "one");
	mkdirSync(join(repoRoot, "pkg"));
	const manifest = canonicalJson({ name: "pkg", version: "1.0.0", dependencies: { a: "1.0.0" } });
	writeFileSync(join(repoRoot, "pkg/package.json"), manifest);
	const artifacts = [
		{
			key: "pkg",
			name: "pkg",
			version: "1.0.0",
			directory: "pkg",
			manifestSha256: sha256(manifest),
			manifestDependencies: { a: "1.0.0" },
			manifestOptionalDependencies: {},
			sourceInputs: [{ path: "source.txt", sha256: sha256("one"), bytes: 3 }],
		},
	];
	assert.deepEqual(verifyReleaseSourceInputs({ repoRoot, artifacts }), []);
	writeFileSync(join(repoRoot, "source.txt"), "two");
	assert.match(verifyReleaseSourceInputs({ repoRoot, artifacts })[0], /stale release input/u);
	artifacts[0].manifestDependencies = { a: "2.0.0" };
	assert.match(verifyReleaseSourceInputs({ repoRoot, artifacts }).join("\n"), /manifest dependencies differ/u);
});

test("license reports cannot omit, mismatch, or stale a referenced text", () => {
	const outputRoot = temporaryRoot();
	mkdirSync(join(outputRoot, "license-texts"));
	const content = "license\n";
	const hash = sha256(content);
	const file = `license-texts/${hash}.txt`;
	writeFileSync(join(outputRoot, file), content);
	const report = {
		components: [{ scope: "root", bomRef: "a", licenseTextFile: file, evidenceSha256: hash }],
		artifacts: [],
		licenseTexts: [{ file, sha256: hash, text: content }],
	};
	assert.deepEqual(validateLicenseTextReferences({ outputRoot, report, indexedPaths: new Set([file]) }), []);
	assert.match(validateLicenseTextReferences({ outputRoot, report, indexedPaths: new Set() })[0], /unindexed/u);
	writeFileSync(join(outputRoot, file), "changed");
	assert.match(validateLicenseTextReferences({ outputRoot, report, indexedPaths: new Set([file]) }).join("\n"), /stale/u);
});

test("release tarballs must be indexed and byte-identical to the ledger", () => {
	const outputRoot = temporaryRoot();
	mkdirSync(join(outputRoot, "release-tarballs"));
	writeFileSync(join(outputRoot, "release-tarballs/pkg.tgz"), "tar");
	const artifact = {
		key: "pkg",
		evidenceTarball: "release-tarballs/pkg.tgz",
		sha256: sha256("tar"),
		bytes: 3,
	};
	assert.deepEqual(
		verifyReleaseArtifactFiles({ outputRoot, indexedPaths: new Set([artifact.evidenceTarball]), artifacts: [artifact] }),
		[],
	);
	assert.match(verifyReleaseArtifactFiles({ outputRoot, indexedPaths: new Set(), artifacts: [artifact] })[0], /not indexed/u);
	writeFileSync(join(outputRoot, artifact.evidenceTarball), "changed");
	assert.match(
		verifyReleaseArtifactFiles({ outputRoot, indexedPaths: new Set([artifact.evidenceTarball]), artifacts: [artifact] })[0],
		/differ/u,
	);
});

test("evidence index policy binds every repo-owned supply-chain semantic input", () => {
	const generator = readFileSync(new URL("./generate-supply-chain-evidence.mjs", import.meta.url), "utf8");
	for (const path of [
		"scripts/generate-supply-chain-evidence.mjs",
		"scripts/supply-chain-evidence-lib.mjs",
		"scripts/inspect-python-distributions.py",
		"scripts/harnessy-release-contract.mjs",
		"scripts/check-supply-chain-reproducibility.mjs",
		"scripts/build-harnessy-executor.mjs",
		"scripts/harnessy-executor-package-lib.mjs",
		"executor/apps/cli/src/build.ts",
		"packages/harnessy-executor/package.json",
		"packages/harnessy-executor/LICENSE",
		"packages/harnessy-executor/README.md",
		"packages/harnessy-executor/bin/harnessy-executor",
		"packages/harnessy-executor/bin/platform.cjs",
	]) {
		assert(generator.includes(`\"${path}\"`), `${path} must be an indexed input`);
	}
});

test("Executor build provenance recursively binds repository inputs and rejects symlinks", () => {
	const repoRoot = temporaryRoot();
	mkdirSync(join(repoRoot, "executor/apps/cli/src"), { recursive: true });
	mkdirSync(join(repoRoot, "executor/apps/cli/dist"), { recursive: true });
	mkdirSync(join(repoRoot, "executor/node_modules/pkg"), { recursive: true });
	writeFileSync(join(repoRoot, "executor/apps/cli/src/main.ts"), "source");
	writeFileSync(join(repoRoot, "executor/apps/cli/dist/executor"), "output");
	writeFileSync(join(repoRoot, "executor/node_modules/pkg/index.js"), "dependency");
	assert.deepEqual(collectRepositoryInputPaths({ repoRoot, relativeRoot: "executor" }), ["executor/apps/cli/src/main.ts"]);
	writeFileSync(join(repoRoot, "outside.ts"), "outside");
	symlinkSync(join(repoRoot, "outside.ts"), join(repoRoot, "executor/apps/cli/src/link.ts"));
	assert.throws(() => collectRepositoryInputPaths({ repoRoot, relativeRoot: "executor" }), /must not be a symlink/u);
});

test("license markdown labels the nested V1 license as non-outer", () => {
	const report = makeLicenseReport({ graphs: {}, artifacts: [], licenseTexts: [] });
	report.nestedV1License = { sourcePath: "resources/source/LICENSE", sha256: "a".repeat(64) };
	assert.match(licensesMarkdown(report), /does \*\*not\*\* license the outer Harnessy package/u);
});

test("Python evidence ignores ambient distributions and rejects malformed uv locks", () => {
	const root = temporaryRoot();
	const project = join(root, "pyproject.toml");
	const lock = join(root, "uv.lock");
	writeFileSync(project, '[project]\nname = "fixture"\nversion = "1.0.0"\nlicense = "AGPL-3.0-only"\n');
	writeFileSync(
		lock,
		'version = 1\n[[package]]\nname = "fixture"\nversion = "1.0.0"\ndependencies = [{ name = "pip" }]\n[[package]]\nname = "pip"\nversion = "1.0.0"\n',
	);
	const script = new URL("./inspect-python-distributions.py", import.meta.url);
	const result = spawnSync("python3", [script.pathname, "--project", project, "--lock", lock], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const ambientFreeGraph = normalizeCycloneDx(JSON.parse(result.stdout), "python-fixture");
	assert.equal(ambientFreeGraph.components[0].licenses[0].license.name, "NOASSERTION");
	assert.equal(ambientFreeGraph.components.some((component) => component["bom-ref"] === "fixture==1.0.0"), false);
	assert.deepEqual(validateCycloneDxReferences(ambientFreeGraph, "python-fixture"), []);
	const distributions = join(root, "site-packages");
	const metadataRoot = join(distributions, "pip-1.0.0.dist-info");
	mkdirSync(metadataRoot, { recursive: true });
	writeFileSync(join(metadataRoot, "METADATA"), "Metadata-Version: 2.4\nName: pip\nVersion: 1.0.0\nLicense-Expression: MIT\n");
	const isolated = spawnSync(
		"python3",
		[script.pathname, "--project", project, "--lock", lock, "--distribution-path", distributions],
		{ encoding: "utf8" },
	);
	assert.equal(isolated.status, 0, isolated.stderr);
	assert.equal(JSON.parse(isolated.stdout).components[0].licenses[0].license.name, "MIT");
	writeFileSync(join(metadataRoot, "METADATA"), "Metadata-Version: 2.4\nName: pip\nVersion: 999.0.0\nLicense-Expression: GPL-3.0-only\n");
	const wrongVersion = spawnSync(
		"python3",
		[script.pathname, "--project", project, "--lock", lock, "--distribution-path", distributions],
		{ encoding: "utf8" },
	);
	assert.equal(wrongVersion.status, 0, wrongVersion.stderr);
	assert.equal(JSON.parse(wrongVersion.stdout).components[0].licenses[0].license.name, "NOASSERTION");
	writeFileSync(join(metadataRoot, "METADATA"), "Metadata-Version: 2.4\nName: pip\nVersion: 1.0.0\nLicense-Expression: MIT\n");
	const duplicateMetadataRoot = join(distributions, "pip-duplicate.dist-info");
	mkdirSync(duplicateMetadataRoot);
	writeFileSync(
		join(duplicateMetadataRoot, "METADATA"),
		"Metadata-Version: 2.4\nName: pip\nVersion: 1.0.0\nLicense-Expression: Apache-2.0\n",
	);
	const duplicate = spawnSync(
		"python3",
		[script.pathname, "--project", project, "--lock", lock, "--distribution-path", distributions],
		{ encoding: "utf8" },
	);
	assert.notEqual(duplicate.status, 0);
	assert.match(duplicate.stderr, /Duplicate pinned distribution metadata for pip==1\.0\.0/u);
	writeFileSync(lock, "not = [valid");
	const malformed = spawnSync("python3", [script.pathname, "--project", project, "--lock", lock], { encoding: "utf8" });
	assert.notEqual(malformed.status, 0);
	assert.match(malformed.stderr, /Malformed Python TOML/u);
});

test("publish cannot reach registry commands when live npm differs from pinned evidence", { skip: process.platform === "win32" }, () => {
	const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
	const runName = `publish-process-${process.pid}`;
	const outputRoot = join(repoRoot, ".supply-chain-repro", runName);
	rmSync(outputRoot, { recursive: true, force: true });
	mkdirSync(outputRoot, { recursive: true });
	temporaryRoots.push(outputRoot);
	const fixtureFiles = new Map([
		[EVIDENCE_MARKER, "schema=1\n"],
		["executor-full.cdx.json", "{}\n"],
		["licenses.json", canonicalJson({ components: [], artifacts: [], issues: [] })],
		["licenses.md", "# fixture\n"],
		["packed-consumer.cdx.json", "{}\n"],
		["packed-consumer-lock.json", "{}\n"],
		["release-artifacts.json", canonicalJson({ artifacts: [] })],
		["root-production.cdx.json", "{}\n"],
		[
			"toolchain.json",
			canonicalJson({
				node: "v22.22.2",
				nodeReleasePin: "22.22.2",
				npm: "11.6.0",
				npmReleasePin: "11.6.0",
				bun: "1.4.0",
				bunReleasePin: "1.4.0",
				python: "Python 3.11.14",
				pythonReleaseSeries: "3.11.",
				releaseGateIssues: [],
			}),
		],
		["v1-python.cdx.json", "{}\n"],
	]);
	for (const [path, content] of fixtureFiles) writeFileSync(join(outputRoot, path), content);
	const files = [...fixtureFiles].map(([path, content]) => ({ path, sha256: sha256(content), bytes: Buffer.byteLength(content) }));
	const descriptorKeys = packedReleasePackages(executorPlatformTags()).map((descriptor) => descriptor.key ?? descriptor.name);
	const requiredInputPaths = [
		".nvmrc",
		"package.json",
		"package-lock.json",
		"executor/package.json",
		"executor/bun.lock",
		"LICENSE",
		"executor/LICENSE",
		"executor/VENDOR.md",
		"packages/harnessy-core/CLAUDE_BRIDGE_VENDOR.md",
		"packages/harnessy-core/THIRD_PARTY_LICENSES/pi-claude-bridge.txt",
		"packages/capability-harnessy-v1-full/resources/source/LICENSE",
		"packages/capability-harnessy-v1-full/resources/jarvis-cli/pyproject.toml",
		"packages/capability-harnessy-v1-full/resources/jarvis-cli/uv.lock",
		"packages/capability-harnessy-v1-full/resources/source/jarvis-cli/uv.lock",
		"scripts/generate-supply-chain-evidence.mjs",
		"scripts/supply-chain-evidence-lib.mjs",
		"scripts/inspect-python-distributions.py",
		"scripts/harnessy-release-contract.mjs",
		"scripts/check-supply-chain-reproducibility.mjs",
		"scripts/build-harnessy-executor.mjs",
		"scripts/harnessy-executor-package-lib.mjs",
		"executor/apps/cli/src/build.ts",
		...collectRepositoryInputPaths({ repoRoot, relativeRoot: "executor" }),
		...packedReleasePackages(executorPlatformTags()).map((descriptor) => `${descriptor.directory}/package.json`),
	];
	const inputs = [...new Set(requiredInputPaths)]
		.sort()
		.filter((path) => existsSync(join(repoRoot, path)))
		.map((path) => ({ path, sha256: sha256(readFileSync(join(repoRoot, path))) }));
	const index = buildEvidenceIndex({ files, inputs, releaseDescriptorKeys: descriptorKeys });
	writeFileSync(join(outputRoot, "evidence-index.json"), canonicalJson(index));
	const sums = [...files, { path: "evidence-index.json", sha256: sha256(readFileSync(join(outputRoot, "evidence-index.json"))) }]
		.sort((left, right) => left.path.localeCompare(right.path))
		.map((entry) => `${entry.sha256}  ${entry.path}`)
		.join("\n");
	writeFileSync(join(outputRoot, "SHA256SUMS"), `${sums}\n`);

	const fakeRoot = temporaryRoot();
	const logPath = join(fakeRoot, "npm.log");
	const fakeNpm = join(fakeRoot, "npm");
	writeFileSync(
		fakeNpm,
		'#!/bin/sh\nprintf "%s\\n" "$*" >> "$HARNESSY_FAKE_NPM_LOG"\nif [ "$1" = "--version" ]; then echo "0.0.0"; exit 0; fi\nexit 97\n',
	);
	chmodSync(fakeNpm, 0o755);
	const result = spawnSync(process.execPath, ["scripts/publish.mjs"], {
		cwd: repoRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${fakeRoot}:${process.env.PATH}`,
			HARNESSY_FAKE_NPM_LOG: logPath,
			HARNESSY_SUPPLY_CHAIN_EVIDENCE_OUTPUT: `.supply-chain-repro/${runName}`,
		},
	});
	assert.notEqual(result.status, 0);
	assert.match(`${result.stdout}\n${result.stderr}`, /npm 0\.0\.0 does not match/u);
	assert.deepEqual(readFileSync(logPath, "utf8").trim().split("\n"), ["--version"]);
});
