import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	assertLockstepReleaseVersions,
	assertPublishedArtifactIntegrity,
	assertPublicationMatchesEvidence,
	currentExecutorPlatformTag,
	executorPlatformTags,
	executorReleasePackages,
	intentionallyUnpublishedPackages,
	packedReleasePackages,
	validateReleaseManifest,
} from "./harnessy-release-contract.mjs";

test("canonical packed release includes Harnessy packages and a platform runtime", () => {
	const packages = packedReleasePackages(["linux-x64"]);
	assert.deepEqual(
		packages.map((pkg) => pkg.key ?? pkg.name),
		[
			"@earendil-works/pi-ai",
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-tui",
			"@earendil-works/pi-coding-agent",
			"@harnessy/executor#linux-x64",
			"@harnessy/executor",
			"@harnessy/core",
			"@harnessy/engine",
			"@harnessy/capability-harnessy-v1-full",
			"@harnessy/capability-org-knowledge",
		],
	);
});

test("publication retains every declared Executor target and orders variants before the wrapper", () => {
	const tags = executorPlatformTags();
	assert.equal(tags.length, 8);
	const packages = executorReleasePackages(tags);
	assert.deepEqual(packages.slice(0, -1).map((pkg) => pkg.distTag), tags);
	assert.equal(packages.at(-1)?.name, "@harnessy/executor");
	const windowsArm64 = packages.find((pkg) => pkg.executorPlatformTag === "windows-arm64");
	assert(windowsArm64?.requiredFiles.includes("bin/libsql.node"));
	assert.match(windowsArm64?.releaseBlockers.join("\n") ?? "", /compatible libSQL native sidecar/u);
	assert.match(windowsArm64?.releaseBlockers.join("\n") ?? "", /real packed Windows arm64 wrapper passes --version/u);
});

test("platform normalization is explicit and rejects unrecognized targets", () => {
	assert.equal(currentExecutorPlatformTag({ platform: "win32", arch: "arm64" }), "windows-arm64");
	assert.equal(currentExecutorPlatformTag({ platform: "darwin", arch: "x64" }), "darwin-x64");
	assert.throws(() => currentExecutorPlatformTag({ platform: "freebsd", arch: "x64" }), /Unsupported/);
});

test("publication validation fails closed for missing Harnessy license evidence", () => {
	const [core] = packedReleasePackages(["linux-x64"]).filter((pkg) => pkg.name === "@harnessy/core");
	assert.deepEqual(
		validateReleaseManifest({
			descriptor: core,
			manifest: { name: "@harnessy/core", version: "0.0.3", license: "AGPL-3.0-or-later" },
			packedPaths: core.requiredFiles,
		}),
		["Harnessy package tarball does not contain LICENSE"],
	);
});

test("publication validation rejects a false-green tarball and bad variant version", () => {
	const [variant] = executorReleasePackages(["linux-x64"]);
	const issues = validateReleaseManifest({
		descriptor: variant,
		manifest: { name: "@harnessy/executor", version: "0.0.3", license: "MIT" },
		packedPaths: ["LICENSE"],
	});
	assert.match(issues.join("\n"), /version must end with -linux-x64/);
	assert.match(issues.join("\n"), /tarball is missing bin\/executor/);
	assert.match(issues.join("\n"), /tarball is missing bin\/libsql\.node/);
});

test("Windows arm64 cannot pass publication validation without resolving its explicit native blocker", () => {
	const [variant] = executorReleasePackages(["windows-arm64"]);
	const issues = validateReleaseManifest({
		descriptor: variant,
		manifest: { name: "@harnessy/executor", version: "0.0.3-windows-arm64", license: "MIT" },
		packedPaths: variant.requiredFiles,
	});
	assert.match(issues.join("\n"), /release blocker: Windows arm64 publication is blocked/u);
	assert.match(variant.runtimeLimitations.join("\n"), /workerd-backed custom app execution is unavailable/u);
});

test("Pi and Harnessy release cohorts must each stay lockstep versioned", () => {
	assert.doesNotThrow(() =>
		assertLockstepReleaseVersions([
			{ name: "@earendil-works/pi-ai", version: "0.80.3" },
			{ name: "@earendil-works/pi-tui", version: "0.80.3" },
			{ name: "@harnessy/executor", version: "0.0.3-linux-x64" },
			{ name: "@harnessy/core", version: "0.0.3" },
		]),
	);
	assert.throws(
		() =>
			assertLockstepReleaseVersions([
				{ name: "@harnessy/core", version: "0.0.3" },
				{ name: "@harnessy/engine", version: "0.0.4" },
			]),
		/Harnessy packages are not lockstep/,
	);
});

test("non-canonical workspaces are excluded intentionally", () => {
	assert.deepEqual(
		intentionallyUnpublishedPackages.map((pkg) => pkg.name),
		["@earendil-works/pi-orchestrator", "@harnessy/sdk", "@harnessy/local-host"],
	);
	const sdk = intentionallyUnpublishedPackages.find((pkg) => pkg.name === "@harnessy/sdk");
	assert.match(sdk?.reason ?? "", /isolated packed consumer/);
	assert.match(sdk?.reason ?? "", /explicit approval/);
	assert.match(sdk?.reason ?? "", /authoritative license\/artifact evidence/);
	assert.equal(packedReleasePackages(["linux-x64"]).some((pkg) => pkg.name === "@harnessy/sdk"), false);
	const localHost = intentionallyUnpublishedPackages.find((pkg) => pkg.name === "@harnessy/local-host");
	assert.match(localHost?.reason ?? "", /local-only migration scaffold/);
	assert.match(localHost?.reason ?? "", /inactive/);
	assert.equal(packedReleasePackages(["linux-x64"]).some((pkg) => pkg.name === "@harnessy/local-host"), false);
});

test("release preparation tests the post-build local-host candidate without rewriting it", () => {
	const source = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
	const build = source.indexOf('run("npm", ["run", "build"]);');
	const sdkFixture = source.indexOf('run("npm", ["run", "test:sdk-fixture"]);');
	const localHostFixture = source.indexOf('run("npm", ["run", "test:local-host-fixture"]);');
	const engineFixture = source.indexOf('run("npm", ["run", "test:engine-fixture"]);');
	assert(build >= 0 && sdkFixture > build && localHostFixture > sdkFixture && engineFixture > localHostFixture);
	assert.equal(localHostFixture, source.lastIndexOf('run("npm", ["run", "test:local-host-fixture"]);'));
	assert.match(source, /localHostDiffBefore = run\("git", \["diff", "--binary"\]/u);
	assert.match(source, /localHostDiffAfter = run\("git", \["diff", "--binary"\]/u);
	assert.match(source, /localHostStatusBefore = run\("git", \["status", "--porcelain=v1"\]/u);
	assert.match(source, /localHostStatusAfter = run\("git", \["status", "--porcelain=v1"\]/u);
});

test("an existing version cannot hide changed local package contents", () => {
	assert.doesNotThrow(() =>
		assertPublishedArtifactIntegrity([
			{ name: "@harnessy/core", version: "0.0.3", published: true, localIntegrity: "sha512-a", registryIntegrity: "sha512-a" },
			{ name: "@harnessy/engine", version: "0.0.3", published: false, localIntegrity: "sha512-b" },
		]),
	);
	assert.throws(
		() =>
			assertPublishedArtifactIntegrity([
				{ name: "@harnessy/core", version: "0.0.3", published: true, localIntegrity: "sha512-new", registryIntegrity: "sha512-old" },
			]),
		/bump their cohort/,
	);
});

test("publication uses only artifacts whose packed integrity matches the strict evidence ledger", () => {
	const state = {
		key: "pkg",
		localIntegrity: "sha512-local",
		manifest: { name: "pkg", version: "1.0.0" },
	};
	const artifact = { key: "pkg", integrity: "sha512-local", name: "pkg", version: "1.0.0" };
	assert.doesNotThrow(() => assertPublicationMatchesEvidence([state], [artifact]));
	assert.throws(
		() => assertPublicationMatchesEvidence([state], [{ ...artifact, integrity: "sha512-different" }]),
		/differs from the strictly verified/u,
	);
	assert.throws(() => assertPublicationMatchesEvidence([state], []), /omitted publication artifact/u);
});
