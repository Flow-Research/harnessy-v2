import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const supportRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(supportRoot, "../../../..");
const installationRootInput = process.argv[2];
const privateRootInput = process.argv[3];
if (installationRootInput === undefined || privateRootInput === undefined) {
	throw new Error("Expected installation root and private fixture root arguments.");
}
const installationRoot = resolve(installationRootInput);
const privateRoot = resolve(privateRootInput);
if (
	!isAbsolute(installationRootInput) ||
	!isAbsolute(privateRootInput) ||
	installationRoot === parse(installationRoot).root ||
	privateRoot === parse(privateRoot).root
) {
	throw new Error("Packed runtime fixture roots must be absolute, bounded paths.");
}
const smokeOutputPath = join(installationRoot, "packed-meeting-runtime-smoke.mjs");
const workerOutputPath = join(installationRoot, "packed-meeting-worker.mjs");
const fullReviewOutputPath = join(installationRoot, "packed-meeting-full-review.mjs");
const installedCoreRuntime = join(
	installationRoot,
	"node_modules",
	"@harnessy",
	"core",
	"dist",
	"jarvis",
	"meeting-publication",
	"operational-runtime.js",
);
const installedHostSmokeCommand = join(
	installationRoot,
	"node_modules",
	"@harnessy",
	"local-host",
	"dist",
	"meeting-smoke-command.js",
);
const installedHostWorkerCommand = join(
	installationRoot,
	"node_modules",
	"@harnessy",
	"local-host",
	"dist",
	"meeting-worker-command.js",
);
const installedHostFullReviewCommand = join(
	installationRoot,
	"node_modules",
	"@harnessy",
	"local-host",
	"dist",
	"meeting-full-review-command.js",
);

const executorSource = (path) => join(repoRoot, "executor", path);
const executorAliases = {
	"@executor-js/fumadb/adapters/drizzle": executorSource("packages/core/fumadb/src/adapters/drizzle/index.ts"),
	"@executor-js/fumadb/adapters/memory": executorSource("packages/core/fumadb/src/adapters/memory/index.ts"),
	"@executor-js/fumadb/query": executorSource("packages/core/fumadb/src/query/index.ts"),
	"@executor-js/fumadb/schema": executorSource("packages/core/fumadb/src/schema/index.ts"),
	"@executor-js/fumadb": executorSource("packages/core/fumadb/src/index.ts"),
	"@executor-js/plugin-file-secrets": executorSource("packages/plugins/file-secrets/src/index.ts"),
	"@executor-js/plugin-mcp": executorSource("packages/plugins/mcp/src/sdk/index.ts"),
	"@executor-js/plugin-openapi": executorSource("packages/plugins/openapi/src/sdk/index.ts"),
	"@executor-js/sdk/http-auth": executorSource("packages/core/sdk/src/http-auth/index.ts"),
	"@executor-js/sdk/host-internal": executorSource("packages/core/sdk/src/host-internal.ts"),
	"@executor-js/sdk/shared": executorSource("packages/core/sdk/src/shared.ts"),
	"@executor-js/sdk/core": executorSource("packages/core/sdk/src/index.ts"),
	"@executor-js/sdk": executorSource("packages/core/sdk/src/index.ts"),
};

const fixtureAliases = {
	"@packed/core-operational-runtime": pathToFileURL(installedCoreRuntime).href,
	"@packed/local-host-smoke-command": pathToFileURL(installedHostSmokeCommand).href,
	"@packed/local-host-worker-command": pathToFileURL(installedHostWorkerCommand).href,
	"@packed/local-host-full-review-command": pathToFileURL(installedHostFullReviewCommand).href,
};

mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const buildFixture = (entryPoint, outputPath) =>
	build({
		entryPoints: [entryPoint],
		outfile: outputPath,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		sourcemap: false,
		logLevel: "silent",
		external: ["effect", "effect/*", "@libsql/client", "@libsql/client/*", "drizzle-orm", "drizzle-orm/*"],
		plugins: [
			{
				name: "packed-runtime-fixture-aliases",
				setup(buildApi) {
					buildApi.onResolve({ filter: /^@packed\// }, ({ path }) => ({
						path: fixtureAliases[path],
						external: true,
					}));
					buildApi.onResolve({ filter: /^@executor-js\// }, ({ path }) => ({
						path: executorAliases[path],
					}));
				},
			},
		],
	});

await Promise.all([
	buildFixture(
		join(repoRoot, "packages", "harnessy-sdk", "test", "support", "packed-meeting-runtime-entry.ts"),
		smokeOutputPath,
	),
	buildFixture(
		join(repoRoot, "packages", "harnessy-local-host", "test", "support", "packed-meeting-worker-entry.mjs"),
		workerOutputPath,
	),
	buildFixture(
		join(repoRoot, "packages", "harnessy-local-host", "test", "support", "packed-meeting-full-review-entry.mjs"),
		fullReviewOutputPath,
	),
]);

const runFixture = (path, label) => {
	const result = spawnSync(process.execPath, [path, installationRoot, privateRoot], {
		cwd: installationRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NODE_NO_WARNINGS: "1" },
	});
	if (result.status !== 0) {
		throw new Error([`Packed meeting ${label} failed.`, result.stdout, result.stderr].filter(Boolean).join("\n"));
	}
	if (result.stderr !== "") throw new Error(`Packed meeting ${label} emitted stderr.`);
	const lines = result.stdout.trim().split("\n");
	if (lines.length !== 1) throw new Error(`Packed meeting ${label} did not emit exactly one result line.`);
	return JSON.parse(lines[0]);
};

const smoke = runFixture(smokeOutputPath, "runtime smoke");
const worker = runFixture(workerOutputPath, "worker");
const fullReview = runFixture(fullReviewOutputPath, "full review");
process.stdout.write(`${JSON.stringify({ ...smoke, worker, fullReview })}\n`);
