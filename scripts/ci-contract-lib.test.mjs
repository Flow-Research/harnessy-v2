import assert from "node:assert/strict";
import test from "node:test";

import { validateCiContract } from "./ci-contract-lib.mjs";

const ciSource = `
name: CI
on:
  push: { branches: [main, dev] }
  pull_request: { branches: [main, dev] }
jobs:
  build:
    name: Harnessy build
    steps:
      - run: npm run build
      - run: git diff --exit-code
      - uses: actions/upload-artifact@sha
        with: { name: harnessy-build-run, path: build.tar.gz, overwrite: true }
      - run: npm run check:clean-worktree
  static-checks:
    needs: build
    steps:
      - uses: ./.github/actions/harnessy-ci-setup
        with: { build-artifact: harnessy-build-run }
      - run: |
          npm run verify:v1-compatibility
          npm run check
          npm run qa:check
          npm run test:qa-contract
          git diff --exit-code
          npm run check:clean-worktree
  qa-scenarios:
    needs: build
    steps:
      - uses: ./.github/actions/harnessy-ci-setup
        with: { build-artifact: harnessy-build-run }
      - run: |
          npm run test:qa-scenarios
          npm run test:sdk-fixture
          npm run test:engine-fixture
          npm run test:executor-package-contract
          git diff --exit-code
          npm run check:clean-worktree
  local-host-fixture:
    needs: build
    steps:
      - uses: ./.github/actions/harnessy-ci-setup
        with: { build-artifact: harnessy-build-run }
      - run: |
          npm run test:local-host-fixture
          git diff --exit-code
          npm run check:clean-worktree
  workspace-tests:
    needs: [build]
    steps:
      - uses: ./.github/actions/harnessy-ci-setup
        with: { build-artifact: harnessy-build-run }
      - run: |
          ./test.sh
          npm run test:coverage
          git diff --exit-code
          npm run check:clean-worktree
  release:
    needs: build
    steps:
      - uses: ./.github/actions/harnessy-ci-setup
        with: { build-artifact: harnessy-build-run }
      - run: |
          npm run test:release-artifacts:installed-local-host
          npm run test:release-artifacts:installed-product
          git diff --exit-code
          npm run check:clean-worktree
  build-check-test:
    name: Harnessy build, QA, and packages
    if: \${{ always() }}
    needs: [build, static-checks, qa-scenarios, local-host-fixture, workspace-tests, release]
    steps:
      - env: { NEEDS_JSON: "\${{ toJSON(needs) }}" }
        run: echo "$NEEDS_JSON" | jq -e 'to_entries | all(.value.result == "success")'
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
      - run: node scripts/audit-root.mjs --json
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
				"npm run test:release-artifacts:installed-local-host",
				"npm run test:release-artifacts:installed-product",
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

test("CI contract accepts complete V2 gates without the deprecated V1 behavior job", () => {
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
	assert(result.issues.includes("CI:build-check-test gate jobs must run npm run qa:check"));
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
		"npm run verify:v1-compatibility",
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

test("CI contract rejects a gate job without its own tracked-file check", () => {
	const result = validate({
		ciSource: ciSource.replace(
			"          npm run test:local-host-fixture\n          git diff --exit-code\n",
			"          git diff --exit-code\n          npm run test:local-host-fixture\n",
		),
	});
	assert.equal(result.ok, false);
	assert(result.issues.includes("CI:local-host-fixture must run git diff --exit-code after npm run test:local-host-fixture"));
});

test("CI contract rejects a clean-worktree gate that runs before package generation", () => {
	const result = validate({
		ciSource: ciSource.replace(
			"          npm run test:release-artifacts:installed-product\n          git diff --exit-code\n          npm run check:clean-worktree\n",
			"          npm run check:clean-worktree\n          npm run test:release-artifacts:installed-product\n          git diff --exit-code\n",
		),
	});
	assert.equal(result.ok, false);
	assert(
		result.issues.includes("CI:release must run npm run check:clean-worktree after npm run test:release-artifacts:installed-product"),
	);
});

test("CI contract requires release-part jobs outside the aggregate to check the worktree", () => {
	const result = validate({
		ciSource: `${ciSource}  installed-local-host-acceptance:\n    steps:\n      - run: npm run test:release-artifacts:installed-local-host\n`,
	});
	assert.equal(result.ok, false);
	assert(
		result.issues.includes(
			"CI:installed-local-host-acceptance must run git diff --exit-code after npm run test:release-artifacts:installed-local-host",
		),
	);
});

test("CI contract rejects an aggregate that can pass when a gate job fails, is skipped, or is missing", () => {
	const cases = [
		[ciSource.replace(/^ {4}if: .*always\(\).*\n/mu, ""), "CI:build-check-test must run with always() so failed or skipped gate jobs fail it"],
		[ciSource.replace(` | jq -e 'to_entries | all(.value.result == "success")'`, ""), "CI:build-check-test must fail unless every needed job result is success (jq -e on NEEDS_JSON)"],
		[ciSource.replace(", local-host-fixture, workspace-tests", ", workspace-tests"), "CI:build-check-test gate jobs must run npm run test:local-host-fixture"],
		[ciSource.replace("  release:\n    needs: build\n", "  release:\n"), "CI:release must need the shared build job build"],
		[ciSource.replace("  release:\n    needs: build\n    steps:\n      - uses: ./.github/actions/harnessy-ci-setup\n        with: { build-artifact: harnessy-build-run }\n", "  release:\n    needs: build\n    steps:\n"), "CI:release must restore the shared build outputs"],
	];
	for (const [source, issue] of cases) {
		assert.notEqual(source, ciSource, issue);
		const result = validate({ ciSource: source });
		assert.equal(result.ok, false, issue);
		assert(result.issues.includes(issue), `${issue}: ${JSON.stringify(result.issues)}`);
	}
});

test("CI contract rejects an aggregate verdict that cannot fail the job", () => {
	const verdictLine = `run: echo "$NEEDS_JSON" | jq -e 'to_entries | all(.value.result == "success")'`;
	const unchecked = "CI:build-check-test must fail unless every needed job result is success (jq -e on NEEDS_JSON)";
	const ignored = "CI:build-check-test must not ignore a failed verdict (no ||, no continue-on-error)";
	const cases = [
		[ciSource.replace(verdictLine, verdictLine.replace("jq -e", "jq")), unchecked],
		[ciSource.replace(verdictLine, `run: echo 'all(.value.result == "success")'`), unchecked],
		[ciSource.replace(verdictLine, `${verdictLine} || true`), ignored],
		[ciSource.replace(`      - env: { NEEDS_JSON:`, `      - continue-on-error: true\n        env: { NEEDS_JSON:`), ignored],
		[ciSource.replace("    name: Harnessy build, QA, and packages\n", "    name: Harnessy build, QA, and packages\n    continue-on-error: true\n"), ignored],
	];
	for (const [source, issue] of cases) {
		assert.notEqual(source, ciSource, issue);
		const result = validate({ ciSource: source });
		assert.equal(result.ok, false, issue);
		assert(result.issues.includes(issue), `${issue}: ${JSON.stringify(result.issues)}`);
	}
});

test("CI contract rejects a build artifact that a re-run of failed jobs cannot find", () => {
	const named = validate({
		ciSource: ciSource.replace("{ name: harnessy-build-run,", '{ name: "harnessy-build-run-${{ github.run_attempt }}",'),
	});
	assert.equal(named.ok, false);
	assert(named.issues.includes("CI:build build artifact name must not include github.run_attempt"));
	const kept = validate({ ciSource: ciSource.replace(", overwrite: true", "") });
	assert.equal(kept.ok, false);
	assert(kept.issues.includes("CI:build build artifact upload must set overwrite: true"));
});

test("CI contract rejects a profile clean-worktree gate that runs before package generation", () => {
	const result = validate({
		profile: {
			...profile,
			gates: [
				{
					...profile.gates[0],
					commands: [
						"npm run test:local-host-fixture",
						"npm run test:release-artifacts:installed-local-host",
						"npm run check:clean-worktree",
						"npm run test:release-artifacts:installed-product",
					],
				},
			],
		},
	});
	assert.equal(result.ok, false);
	assert(
		result.issues.includes(
			"CI profile packed consumer gate must run npm run check:clean-worktree after npm run test:release-artifacts:installed-product",
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
