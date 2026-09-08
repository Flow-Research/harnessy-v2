import assert from "node:assert/strict";
import test from "node:test";

import { validateCiContract } from "./ci-contract-lib.mjs";

const ciSource = `
name: CI
on:
  push: { branches: [main, dev] }
  pull_request: { branches: [main, dev] }
jobs:
  build-check-test:
    name: Harnessy build, QA, and packages
    steps:
      - run: |
          npm run build
          npm run check
          git diff --exit-code
          npm run qa:check
          npm run test:qa-contract
          npm run test:qa-scenarios
          npm run test:sdk-fixture
          npm run test:local-host-fixture
          git diff --exit-code
          ./test.sh
          npm run test:coverage
          npm run test:engine-fixture
          npm run test:executor-package-contract
          npm run test:release-artifacts
          npm run check:clean-worktree
  executor:
    name: Executor source
    steps: [{ run: bun run ci }]
  supply-chain:
    name: Supply-chain evidence
    steps:
      - run: |
          npm run test:supply-chain
          npm run supply-chain:generate
          npm run supply-chain:verify
          npm run supply-chain:reproducibility
      - uses: actions/upload-artifact@sha
        with: { name: supply-chain-run, path: .supply-chain-evidence/ }
  packaged-executor:
    name: Packaged Executor (\${{ matrix.os }})
    strategy: { matrix: { os: [ubuntu-latest, macos-14, windows-latest] } }
    steps:
      - run: node --test scripts/harnessy-executor-package-lib.test.mjs
      - run: npm run test:executor-package-integration
  v1-compatibility:
    name: V1 compatibility
    steps: [{ run: ./scripts/test-v1-compatibility.sh }]
`;

const securitySource = `
name: Security Gates
on:
  push: { branches: [main, dev] }
  pull_request: { branches: [main, dev] }
jobs:
  root-dependencies-and-invariants:
    name: Root dependencies and invariants
    steps:
      - run: npm audit --audit-level=moderate
      - run: node scripts/check-security-invariants.mjs
  executor-dependencies:
    name: Executor dependencies
    steps: [{ run: node scripts/audit-executor.mjs --json }]
`;

const releaseSource = `
name: Build Binaries
jobs:
  release-preflight:
    steps:
      - run: npm run release:preflight
      - uses: actions/upload-artifact@sha
        with: { name: release-supply-chain-tag, path: .supply-chain-evidence/ }
  stage-github-release:
    needs: [build, release-preflight]
    steps: [{ run: gh release create v1 --draft }]
  publish-npm:
    needs: stage-github-release
    steps:
      - run: npm run supply-chain:generate
      - run: npm run supply-chain:verify
      - run: npm run supply-chain:reproducibility
      - uses: actions/upload-artifact@sha
        with: { name: publication-supply-chain-run, path: .supply-chain-evidence/ }
      - run: node scripts/publish.mjs
`;

const requiredCheckNames = [
	"CI / Harnessy build, QA, and packages",
	"CI / Executor source",
	"CI / Supply-chain evidence",
	"CI / Packaged Executor (ubuntu-latest)",
	"CI / Packaged Executor (macos-14)",
	"CI / Packaged Executor (windows-latest)",
	"Security Gates / Root dependencies and invariants",
	"Security Gates / Executor dependencies",
];

const profile = {
	gates: [
		{
			name: "packed consumers and release contracts",
			commands: [
				"npm run test:local-host-fixture",
				"npm run test:release-artifacts",
				"npm run check:clean-worktree",
			],
		},
	],
	remote: { requiredCheckNames },
};

const validate = (overrides = {}) =>
	validateCiContract({
		ciSource,
		securitySource,
		releaseSource,
		profile,
		...overrides,
	});

test("CI contract accepts complete local, hosted, security, and release-preflight wiring", () => {
	const result = validate();
	assert.equal(result.ok, true);
	assert.deepEqual(result.expectedChecks, requiredCheckNames);
});

test("CI contract rejects missing dev triggers and required executable gates", () => {
	const result = validate({
		ciSource: ciSource.replace("[main, dev]", "[main]").replace("npm run qa:check", "npm run omitted"),
	});
	assert.equal(result.ok, false);
	assert(result.issues.some((issue) => issue.includes("CI push must include dev")));
	assert(result.issues.some((issue) => issue.includes("must run npm run qa:check")));
});

test("CI contract requires npm to provide the packaged Executor gate's CLI path", () => {
	const result = validate({
		ciSource: ciSource.replace("npm run test:executor-package-integration", "node scripts/test-harnessy-executor-package.mjs"),
	});
	assert.equal(result.ok, false);
	assert(result.issues.includes("CI:packaged-executor must run npm run test:executor-package-integration"));
});

test("CI contract rejects omission of the full package contracts or matrix launcher regressions", () => {
	for (const command of [
		"npm run test:executor-package-contract",
		"node --test scripts/harnessy-executor-package-lib.test.mjs",
	]) {
		const result = validate({ ciSource: ciSource.replace(command, "node --version") });
		assert.equal(result.ok, false, command);
		assert(result.issues.some((issue) => issue.includes(`must run ${command}`)));
	}
});

test("CI contract does not count comments or echo output as packaged matrix gates", () => {
	for (const command of [
		"node --test scripts/harnessy-executor-package-lib.test.mjs",
		"npm run test:executor-package-integration",
	]) {
		for (const replacement of [`# ${command}`, `echo ${command}`]) {
			const result = validate({ ciSource: ciSource.replace(`run: ${command}`, `run: |\n          ${replacement}`) });
			assert.equal(result.ok, false, replacement);
			assert(result.issues.includes(`CI:packaged-executor must run ${command}`));
		}
	}
});

test("CI contract rejects a release mutation that is not gated by preflight", () => {
	const result = validate({ releaseSource: releaseSource.replace("needs: [build, release-preflight]", "needs: build") });
	assert.equal(result.ok, false);
	assert(result.issues.includes("Build Binaries:stage-github-release must need release-preflight"));
});

test("CI contract rejects a generated-output diff check that only runs before QA", () => {
	const result = validate({
		ciSource: ciSource.replace("          git diff --exit-code\n          ./test.sh", "          ./test.sh"),
	});
	assert.equal(result.ok, false);
	assert(result.issues.some((issue) => issue.includes("git diff --exit-code after npm run test:local-host-fixture")));
});

test("CI contract rejects a clean-worktree gate that runs before package generation", () => {
	const result = validate({
		ciSource: ciSource
			.replace("          npm run check:clean-worktree\n", "")
			.replace("          npm run build\n", "          npm run build\n          npm run check:clean-worktree\n"),
	});
	assert.equal(result.ok, false);
	assert(result.issues.some((issue) => issue.includes("npm run check:clean-worktree after npm run test:release-artifacts")));
});

test("CI contract rejects a profile clean-worktree gate that runs before package generation", () => {
	const result = validate({
		profile: {
			...profile,
			gates: [
				{
					...profile.gates[0],
					commands: [
						"npm run check:clean-worktree",
						"npm run test:local-host-fixture",
						"npm run test:release-artifacts",
					],
				},
			],
		},
	});
	assert.equal(result.ok, false);
	assert(
		result.issues.some((issue) =>
			issue.includes("CI profile packed consumer gate must run npm run check:clean-worktree after npm run test:release-artifacts"),
		),
	);
});

test("CI contract rejects drift between workflow job names and branch-protection guidance", () => {
	const result = validate({ profile: { remote: { requiredCheckNames: requiredCheckNames.slice(0, -1) } } });
	assert.equal(result.ok, false);
	assert(result.issues.some((issue) => issue.includes("Security Gates / Executor dependencies")));
});

test("CI contract rejects publication without retaining the exact verified evidence", () => {
	const result = validate({
		releaseSource: releaseSource.replace(
			"      - uses: actions/upload-artifact@sha\n        with: { name: publication-supply-chain-run, path: .supply-chain-evidence/ }\n",
			"",
		),
	});
	assert.equal(result.ok, false);
	assert(result.issues.some((issue) => issue.includes("publish-npm must upload .supply-chain-evidence")));
});
