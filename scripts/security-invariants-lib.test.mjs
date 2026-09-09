import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkDependencyResolutionContract,
	checkSecurityContract,
	scanEntries,
	scanWorkflow,
} from "./security-invariants-lib.mjs";

const entry = (path, text) => ({ path, content: Buffer.from(text) });

describe("security invariant scanner", () => {
	it("detects credential-shaped values without returning their contents", () => {
		const githubToken = ["gh", "p_", "abcdefghijklmnopqrstuvwxyzABCDEFGH"].join("");
		const openAiToken = ["sk", "-proj-", "abcdefghijklmnopqrstuvwx"].join("");
		const privateKey = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
		const awsKey = ["AK", "IA", "ABCDEFGHIJKLMNOP"].join("");
		const slackToken = ["xo", "xb-", "1234567890-abcdefghij"].join("");
		const findings = scanEntries([
			entry("config.txt", `${githubToken}\n${openAiToken}`),
			entry("key.pem", privateKey),
			entry("aws.txt", awsKey),
			entry("slack.txt", slackToken),
		]);
		assert.deepEqual(
			new Set(findings.map((finding) => finding.rule)),
			new Set(["github-token", "openai-token", "private-key", "aws-access-key", "slack-token"]),
		);
		assert.equal(JSON.stringify(findings).includes("ghp_"), false);
	});

	it("allows documented placeholders and environment templates", () => {
		assert.deepEqual(
			scanEntries([
				entry(".env.example", "OPENAI_API_KEY=your-key-here"),
				entry("docs/setup.md", "Use sk-... or ghp_... as placeholders"),
			]),
			[],
		);
	});

	it("rejects tracked runtime environment files", () => {
		assert.deepEqual(scanEntries([entry("service/.env.production", "PORT=3000")]), [
			{ rule: "tracked-environment-secret", path: "service/.env.production", line: 1 },
		]);
	});

	it("rejects floating actions and swallowed security failures", () => {
		const findings = scanWorkflow(
			".github/workflows/security.yml",
			"uses: actions/checkout@v4\nrun: npm audit || true\nif-no-files-found: ignore",
			{ canonicalSecurityWorkflow: true },
		);
		assert.deepEqual(
			findings.map((finding) => finding.rule),
			["unpinned-action", "ignored-security-failure", "optional-security-artifact", "checkout-persists-credentials"],
		);
	});

	it("requires every canonical security gate", () => {
		const files = new Map([
			[".npmrc", "ignore-scripts=true\n"],
			[".github/workflows/ci.yml", ""],
			[".github/workflows/npm-audit.yml", ""],
			[".github/workflows/qa-security-sweep.yml", ""],
		]);
		assert.equal(checkSecurityContract(files).filter((finding) => finding.rule === "missing-security-gate").length, 3);
	});

	it("scans auxiliary workflows for moving action references", () => {
		const files = new Map([
			[".npmrc", "ignore-scripts=true\n"],
			[".github/workflows/ci.yml", ""],
			[".github/workflows/npm-audit.yml", ""],
			[
				".github/workflows/qa-security-sweep.yml",
				"npm audit --audit-level=moderate\nnode scripts/audit-executor.mjs --json\nif-no-files-found: error\n",
			],
			[".github/workflows/issue-gate.yml", "steps:\n  - uses: actions/github-script@v7\n"],
		]);
		assert.deepEqual(
			checkSecurityContract(files).filter((finding) => finding.path === ".github/workflows/issue-gate.yml"),
			[{ rule: "unpinned-action", path: ".github/workflows/issue-gate.yml", line: 2 }],
		);
	});
});

const dependencyContractFiles = () =>
	new Map([
		[
			"package.json",
			JSON.stringify({ overrides: { "fast-uri": "3.1.6", qs: "6.16.0", sharp: "0.35.4", toml: "4.3.0" } }),
		],
		[
			"package-lock.json",
			JSON.stringify({
				packages: {
					"node_modules/fast-uri": { version: "3.1.6" },
					"node_modules/qs": { version: "6.16.0" },
					"node_modules/sharp": { version: "0.35.4" },
					"node_modules/toml": { version: "4.3.0" },
				},
			}),
		],
		[
			"executor/package.json",
			JSON.stringify({ overrides: { axios: "1.20.0", "form-data": "4.0.6", sharp: "0.35.4", toml: "4.2.0" } }),
		],
		[
			"executor/packages/core/test-servers/package.json",
			JSON.stringify({ devDependencies: { wrangler: "4.120.1" } }),
		],
		[
			"executor/packages/kernel/runtime-dynamic-worker/package.json",
			JSON.stringify({
				devDependencies: { "@cloudflare/vitest-pool-workers": "0.21.0", wrangler: "4.120.1" },
			}),
		],
		[
			"executor/packages/plugins/apps/package.json",
			JSON.stringify({ devDependencies: { "@cloudflare/vitest-pool-workers": "0.21.0" } }),
		],
		[
			"executor/bun.lock",
			[
				'    "@cloudflare/vitest-pool-workers": ["@cloudflare/vitest-pool-workers@0.21.0", "", { "dependencies": { "miniflare": "5.20260804.0-alpha", "wrangler": "4.120.1" } }],',
				'    "axios": ["axios@1.20.0", "", {}],',
				'    "form-data": ["form-data@4.0.6", "", {}],',
				'    "miniflare": ["miniflare@5.20260804.0-alpha", "", { "dependencies": { "sharp": "0.35.2", "undici": "7.29.0", "ws": "8.21.0" } }],',
				'    "sharp": ["sharp@0.35.4", "", {}],',
				'    "toml": ["toml@4.2.0", "", {}],',
				'    "undici": ["undici@8.10.1", "", {}],',
				'    "miniflare/undici": ["undici@7.29.0", "", {}],',
				'    "wrangler": ["wrangler@4.120.1", "", { "dependencies": { "miniflare": "5.20260804.0-alpha" } }],',
				'    "ws": ["ws@8.21.3", "", {}],',
				'    "miniflare/ws": ["ws@8.21.0", "", {}],',
			].join("\n"),
		],
	]);

describe("dependency resolution security contract", () => {
	it("accepts exact owners whose locks contain no known vulnerable resolution", () => {
		assert.deepEqual(checkDependencyResolutionContract(dependencyContractFiles()), []);
	});

	it("rejects a vulnerable root resolution and a widened Cloudflare owner", () => {
		const files = dependencyContractFiles();
		const rootLock = JSON.parse(files.get("package-lock.json"));
		rootLock.packages["node_modules/toml"].version = "4.1.1";
		files.set("package-lock.json", JSON.stringify(rootLock));
		const dynamicWorker = JSON.parse(files.get("executor/packages/kernel/runtime-dynamic-worker/package.json"));
		dynamicWorker.devDependencies.wrangler = "^4.120.1";
		files.set("executor/packages/kernel/runtime-dynamic-worker/package.json", JSON.stringify(dynamicWorker));
		assert.deepEqual(
			new Set(checkDependencyResolutionContract(files).map((finding) => finding.rule)),
			new Set(["unsafe-root-lock-resolution", "uncontrolled-cloudflare-owner-version"]),
		);
	});

	it("rejects a vulnerable nested Miniflare resolution", () => {
		const files = dependencyContractFiles();
		files.set(
			"executor/bun.lock",
			files
				.get("executor/bun.lock")
				.replace('"undici": "7.29.0"', '"undici": "7.24.8"')
				.replace('["undici@7.29.0"', '["undici@7.24.8"'),
		);
		assert.deepEqual(
			new Set(checkDependencyResolutionContract(files).map((finding) => finding.rule)),
			new Set(["unsafe-executor-lock-resolution", "unsafe-executor-owner-dependency"]),
		);
	});

	it("rejects an incoherent Cloudflare owner lock", () => {
		const files = dependencyContractFiles();
		files.set("executor/bun.lock", files.get("executor/bun.lock").replace("sharp@0.35.4", "sharp@0.35.2"));
		assert.deepEqual(
			new Set(checkDependencyResolutionContract(files).map((finding) => finding.rule)),
			new Set(["unsafe-executor-lock-resolution", "incoherent-cloudflare-owner-lock"]),
		);
	});

	it("rejects mismatched Cloudflare owner versions", () => {
		const files = dependencyContractFiles();
		files.set(
			"executor/bun.lock",
			files
				.get("executor/bun.lock")
				.replace('"miniflare": "5.20260804.0-alpha"', '"miniflare": "5.20260811.0-alpha"'),
		);
		assert.deepEqual(
			new Set(checkDependencyResolutionContract(files).map((finding) => finding.rule)),
			new Set(["incoherent-cloudflare-owner-lock"]),
		);
	});
});
