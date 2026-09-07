import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const coreRoot = join(repoRoot, "packages", "harnessy-core");
const executorRoot = join(repoRoot, "executor", "apps", "cli", "dist", "harnessy-executor");
const fixtureRoot = mkdtempSync(join(tmpdir(), "harnessy-sdk-fixture-"));
const tarballRoot = join(fixtureRoot, "tarballs");
const installRoot = join(fixtureRoot, "consumer");
mkdirSync(tarballRoot, { recursive: true });
mkdirSync(installRoot, { recursive: true });

const npmInvocation = (args) =>
	process.env.npm_execpath === undefined
		? { command: process.platform === "win32" ? "npm.cmd" : "npm", args }
		: { command: process.execPath, args: [process.env.npm_execpath, ...args] };

const run = (command, args, cwd) => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, npm_config_update_notifier: "false" },
	});
	if (result.status !== 0) {
		throw new Error(
			[`Command failed in ${cwd}: ${command} ${args.join(" ")}`, result.error?.message, result.stdout, result.stderr]
				.filter(Boolean)
				.join("\n"),
		);
	}
	return result.stdout;
};

const runForFailure = (command, args, cwd) =>
	spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, npm_config_update_notifier: "false" },
	});

const pack = (root) => {
	const npm = npmInvocation(["pack", "--ignore-scripts", "--json", "--pack-destination", tarballRoot]);
	const [packed] = JSON.parse(
		run(npm.command, npm.args, root),
	);
	if (packed === undefined) throw new Error(`npm pack returned no artifact for ${root}`);
	return { ...packed, tarball: join(tarballRoot, packed.filename) };
};

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const distInventory = () =>
	Object.fromEntries(
		readdirSync(join(packageRoot, "dist"), { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => [entry.name, sha256(join(packageRoot, "dist", entry.name))])
			.sort(([left], [right]) => left.localeCompare(right)),
	);

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

try {
	const distBeforeAudit = distInventory();
	const auditOutput = run(process.execPath, [join(packageRoot, "scripts", "audit-bundles.mjs")], packageRoot);
	assert(
		JSON.stringify(distInventory()) === JSON.stringify(distBeforeAudit),
		"Harnessy SDK bundle audit modified generated artifacts",
	);

	const sdkPack = pack(packageRoot);
	const corePack = pack(coreRoot);
	const executorPack = pack(executorRoot);

	const sdkPaths = sdkPack.files.map((file) => file.path).sort();
	const corePaths = corePack.files.map((file) => file.path).sort();
	const coreTestAuthorityPrefix = "dist/jarvis/meeting-publication/authority-test-fixture.";
	assert(
		!corePaths.some((path) => path.startsWith(coreTestAuthorityPrefix)),
		`Packed Core leaked its test authority fixture: ${JSON.stringify(corePaths.filter((path) => path.startsWith(coreTestAuthorityPrefix)))}`,
	);
	assert(
		corePaths.includes("dist/jarvis/meeting-publication/authority-grant-registry.js"),
		"Packed Core omitted its runtime grant registry",
	);
	const distPaths = readdirSync(join(packageRoot, "dist"))
		.map((file) => `dist/${file}`)
		.sort();
	const expectedSdkPaths = ["CHANGELOG.md", "LICENSE", "README.md", "package.json", ...distPaths].sort();
	assert(
		JSON.stringify(sdkPaths) === JSON.stringify(expectedSdkPaths),
		`Packed SDK contents differ from the audited artifact: ${JSON.stringify(sdkPaths)}`,
	);
	assert(!sdkPaths.some((path) => /(?:^|\/)(?:src|test|scripts)(?:\/|$)/.test(path)), "Packed SDK leaked source files");
	assert(
		!sdkPaths.some((path) => path.endsWith(".map") || (path.endsWith(".ts") && !path.endsWith(".d.ts"))),
		"Packed SDK leaked TypeScript source or source maps",
	);

	writeFileSync(
		join(installRoot, "package.json"),
		`${JSON.stringify({ name: "harnessy-sdk-isolated-consumer", private: true, type: "module" }, undefined, 2)}\n`,
	);
	const npmInstall = npmInvocation([
			"install",
			"--ignore-scripts",
			"--prefer-offline",
			"--no-audit",
			"--no-fund",
			"--save-exact",
			sdkPack.tarball,
			corePack.tarball,
			executorPack.tarball,
			"@typescript/native-preview@7.0.0-dev.20260120.1",
	]);
	const installOutput = run(npmInstall.command, npmInstall.args, installRoot);

	const installedSdkRoot = join(installRoot, "node_modules", "@harnessy", "sdk");
	const installedCoreRoot = join(installRoot, "node_modules", "@harnessy", "core");
	const installedExecutorRoot = join(installRoot, "node_modules", "@harnessy", "executor");
	for (const root of [installedSdkRoot, installedCoreRoot, installedExecutorRoot]) {
		assert(lstatSync(root).isDirectory(), `Packed dependency was not installed: ${root}`);
		assert(!lstatSync(root).isSymbolicLink(), `Packed dependency was linked instead of installed: ${root}`);
		assert(realpathSync(root).startsWith(`${realpathSync(installRoot)}/`), `Packed dependency escaped the consumer: ${root}`);
	}
	for (const suffix of ["js", "js.map", "d.ts", "d.ts.map"]) {
		assert(
			!existsSync(join(installedCoreRoot, `${coreTestAuthorityPrefix}${suffix}`)),
			`Installed Core leaked authority-test-fixture.${suffix}`,
		);
	}
	assert(
		existsSync(join(installedCoreRoot, "dist", "jarvis", "meeting-publication", "authority-grant-registry.js")),
		"Installed Core omitted its runtime grant registry",
	);
	const privateCoreSubpaths = [
		"@harnessy/core/jarvis/meeting-publication/authority-test-fixture",
		"@harnessy/core/jarvis/meeting-publication/authority-grant-registry",
		"@harnessy/core/jarvis/meeting-publication/operational-input",
		"@harnessy/core/jarvis/meeting-publication/operational-runtime",
	];
	for (const [index, specifier] of privateCoreSubpaths.entries()) {
		const importPath = join(installRoot, `core-private-import-${index}.mjs`);
		writeFileSync(importPath, `import ${JSON.stringify(specifier)};\n`);
		const privateImport = runForFailure(process.execPath, [importPath], installRoot);
		const privateImportDiagnostics = `${privateImport.stdout}${privateImport.stderr}`;
		const packageSubpath = `.${specifier.slice("@harnessy/core".length)}`;
		assert(privateImport.status !== 0, `Core private ESM subpath unexpectedly imported: ${specifier}`);
		assert(
			privateImportDiagnostics.includes("ERR_PACKAGE_PATH_NOT_EXPORTED") &&
				privateImportDiagnostics.includes(packageSubpath),
			`Unexpected Core private-subpath diagnostic for ${specifier}: ${privateImportDiagnostics}`,
		);
	}

	const lockfile = JSON.parse(readFileSync(join(installRoot, "package-lock.json"), "utf8"));
	for (const name of ["@harnessy/sdk", "@harnessy/core", "@harnessy/executor"]) {
		const resolved = lockfile.packages[`node_modules/${name}`]?.resolved;
		assert(
			typeof resolved === "string" && resolved.includes("/tarballs/") && resolved.endsWith(".tgz"),
			`${name} did not resolve from a tarball: ${String(resolved)}`,
		);
	}

	const installedManifest = JSON.parse(readFileSync(join(installedSdkRoot, "package.json"), "utf8"));
	assert(installedManifest.private === true, "Packed SDK must remain private");
	assert(installedManifest.exports["."].import === "./dist/index.js", "Stable SDK export is not built JavaScript");
	assert(installedManifest.exports["./node"].import === "./dist/node.js", "Node SDK export is not built JavaScript");
	assert(installedManifest.engines.node === "^22.22.2 || >=24.15.0", "Packed SDK Node engine constraint drifted");

	const consumerTypes = `import { Effect } from "effect";
import { KnowledgeSpaces } from "@harnessy/core/connectors/knowledge";
import {
  engineKnowledgeLayer,
  engineToolAddress,
  type EngineConnectionCreateInput,
  type HarnessyEngineHandle,
} from "@harnessy/sdk";
import { makeHarnessyEngine, type HarnessyEngineConfig } from "@harnessy/sdk/node";

const config: HarnessyEngineConfig = {
  tenant: "fixture",
  onElicitation: "accept-all",
  credentialDirectory: "/tmp/fixture-only",
};
const connection: EngineConnectionCreateInput = {
  owner: "org",
  integration: "anytype",
  name: "main",
  template: "anytype",
  values: { apiKey: "consumer-owned", baseUrl: "http://127.0.0.1:31009", allowRemote: "false" },
};
// @ts-expect-error Engine owners are deliberately limited to the Harnessy contract.
const invalidOwner: EngineConnectionCreateInput = { ...connection, owner: "workspace" };
// @ts-expect-error Credential values must remain opaque strings supplied by the host.
const invalidValues: EngineConnectionCreateInput = { ...connection, values: { apiKey: 42 } };
// @ts-expect-error Hosts must select an explicit credential-state directory.
const invalidConfig: HarnessyEngineConfig = { tenant: "fixture", onElicitation: "accept-all" };
const address: string = engineToolAddress({ ...connection, connection: connection.name, tool: "spaces_list" });
const program = Effect.scoped(Effect.gen(function* () {
  const handle: HarnessyEngineHandle = yield* makeHarnessyEngine(config);
  yield* handle.connections.create(connection);
  return yield* Effect.gen(function* () {
    return yield* (yield* KnowledgeSpaces).list();
  }).pipe(Effect.provide(engineKnowledgeLayer(handle, {
    integration: connection.integration,
    owner: connection.owner,
    connection: connection.name,
  })));
}));
void [address, program, invalidOwner, invalidValues, invalidConfig];
`;
	writeFileSync(join(installRoot, "consumer.ts"), consumerTypes);
	const installedEffectRoot = join(installRoot, "node_modules", "effect");
	const installedEffectManifest = JSON.parse(readFileSync(join(installedEffectRoot, "package.json"), "utf8"));
	const effectSchemaDeclaration = readFileSync(
		join(installedEffectRoot, "dist", "internal", "schema", "schema.d.ts"),
		"utf8",
	);
	assert(installedEffectManifest.version === "4.0.0-beta.85", "Fixture dependency cohort no longer uses Effect beta.85");
	assert(
		effectSchemaDeclaration.includes("readonly [SchemaErrorTypeId]: typeof SchemaErrorTypeId") &&
			!effectSchemaDeclaration.includes("declare const SchemaErrorTypeId"),
		"Pinned Effect declaration defect was fixed; remove the fixture's skipLibCheck exception",
	);
	const consumerCompiler = join(
		installRoot,
		"node_modules",
		"@typescript",
		"native-preview",
		"bin",
		"tsgo.js",
	);
	const compilerVersion = run(process.execPath, [consumerCompiler, "--version"], installRoot).trim();
	const typecheckArgs = [
		consumerCompiler,
		"--noEmit",
		"--strict",
		"--skipLibCheck",
		"--target",
		"ES2022",
		"--module",
		"NodeNext",
		"--moduleResolution",
		"NodeNext",
	];
	// Effect beta.85's published schema declaration references an omitted
	// SchemaErrorTypeId. The exact defect is asserted above; skipLibCheck is
	// limited to this installed-consumer run while consumer contract errors are
	// still proven by the used @ts-expect-error directives.
	run(
		process.execPath,
		[...typecheckArgs, join(installRoot, "consumer.ts")],
		installRoot,
	);
	writeFileSync(
		join(installRoot, "internal-import.ts"),
		'import { adaptExecutorEngine } from "@harnessy/sdk/engine/adapter";\nvoid adaptExecutorEngine;\n',
	);
	const privateImport = runForFailure(
		process.execPath,
		[...typecheckArgs, join(installRoot, "internal-import.ts")],
		installRoot,
	);
	const privateImportDiagnostics = `${privateImport.stdout}${privateImport.stderr}`;
	assert(privateImport.status !== 0, "TypeScript unexpectedly resolved an internal SDK subpath");
	assert(
		privateImportDiagnostics.includes("TS2307") &&
			privateImportDiagnostics.includes('@harnessy/sdk/engine/adapter'),
		`Unexpected private-subpath diagnostic: ${privateImportDiagnostics}`,
	);

	const consumerRuntime = `import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { Effect } from "effect";
import { KnowledgeSpaces } from "@harnessy/core/connectors/knowledge";
import * as HarnessySdk from "@harnessy/sdk";
import { engineKnowledgeLayer, engineToolAddress } from "@harnessy/sdk";
import * as HarnessyNodeSdk from "@harnessy/sdk/node";
import { makeHarnessyEngine } from "@harnessy/sdk/node";

assert.deepEqual(Object.keys(HarnessySdk).sort(), [
  "EngineConnection",
  "EngineHealth",
  "EngineIntegration",
  "EngineOwner",
  "EnginePolicyDecision",
  "EngineTool",
  "engineKnowledgeLayer",
  "engineToolAddress",
  "mapEngineExecuteErrorWire",
  "mapUnknownEngineError",
]);
assert.deepEqual(Object.keys(HarnessyNodeSdk).sort(), [
  "engineMeetingPublicationDiscordLayer",
  "engineMeetingPublicationGoogleLayer",
  "localMeetingPublicationNotifierLayer",
  "makeHarnessyEngine",
]);

const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
  response.setHeader("content-type", "application/json");
  if (request.method !== "GET" || request.url !== "/v1/spaces") {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
    return;
  }
  if (request.headers.authorization !== "Bearer fixture-secret") {
    response.statusCode = 401;
    response.end(JSON.stringify({ message: "unauthorized" }));
    return;
  }
  response.statusCode = 200;
  response.end(JSON.stringify({ data: [{ id: "space-1", name: "Harnessy" }], pagination: { has_more: false } }));
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
assert(address && typeof address === "object");
const baseUrl = \`http://127.0.0.1:\${address.port}\`;
const credentialDirectory = join(process.cwd(), "credential-state");
const binding = (connection) => ({ integration: "anytype", owner: "org", connection });
const listSpaces = (handle, connection) => Effect.gen(function* () {
  return yield* (yield* KnowledgeSpaces).list();
}).pipe(Effect.provide(engineKnowledgeLayer(handle, binding(connection))));

let result;
try {
  const construction = makeHarnessyEngine({
    tenant: "packed-consumer",
    onElicitation: "accept-all",
    credentialDirectory,
  });
  assert.equal(Effect.isEffect(construction), true, "SDK Node adapter did not return the consumer Effect type");
  result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const handle = yield* construction;
    const good = yield* handle.connections.create({
      owner: "org",
      integration: "anytype",
      name: "main",
      template: "anytype",
      values: { apiKey: "fixture-secret", baseUrl, allowRemote: "false" },
    });
    const bad = yield* handle.connections.create({
      owner: "org",
      integration: "anytype",
      name: "badAuth",
      template: "anytype",
      values: { apiKey: "wrong-secret", baseUrl, allowRemote: "false" },
    });
    assert.equal(Effect.isEffect(handle.connections.list()), true);
    assert.equal(engineToolAddress({ ...binding(good.name), tool: "spaces_list" }), "tools.anytype.org.main.spaces_list");
    const spaces = yield* listSpaces(handle, good.name);
    const failure = yield* listSpaces(handle, bad.name).pipe(Effect.flip);
    assert.equal(failure._tag, "ConnectorAuthError");
    assert.equal(failure.status, 401);
    return { spaces, negative: { tag: failure._tag, status: failure.status } };
  })));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

assert.deepEqual(result.spaces.map(({ backend, id, name }) => ({ backend, id, name })), [
  { backend: "anytype", id: "space-1", name: "Harnessy" },
]);
assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
  { method: "GET", url: "/v1/spaces" },
  { method: "GET", url: "/v1/spaces" },
]);
assert.equal(requests[0].authorization, "Bearer fixture-secret");
assert.equal(requests[1].authorization, "Bearer wrong-secret");
rmSync(credentialDirectory, { recursive: true, force: true });
assert.equal(existsSync(credentialDirectory), false, "Temporary credential state remained after scoped cleanup");

const packageRootFor = (resolved) => {
  let current = dirname(fileURLToPath(resolved));
  while (true) {
    const candidate = join(current, "package.json");
    try {
      return JSON.parse(readFileSync(candidate, "utf8")).name ? current : undefined;
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(\`No package root for \${resolved}\`);
      current = parent;
    }
  }
};
const sdkRoot = packageRootFor(import.meta.resolve("@harnessy/sdk"));
const coreRoot = packageRootFor(import.meta.resolve("@harnessy/core/connectors/knowledge"));
const consumerRequire = createRequire(import.meta.url);
const sdkRequire = createRequire(join(sdkRoot, "package.json"));
const coreRequire = createRequire(join(coreRoot, "package.json"));
const effectResolutions = [consumerRequire.resolve("effect"), sdkRequire.resolve("effect"), coreRequire.resolve("effect")];
assert.equal(new Set(effectResolutions).size, 1, \`Effect resolved more than once: \${effectResolutions.join(", ")}\`);

console.log(JSON.stringify({
  ...result,
  requests: requests.map(({ method, url, authorization }) => ({ method, url, authorized: authorization === "Bearer fixture-secret" })),
  effectResolution: effectResolutions[0],
  temporaryCredentialStateRemoved: !existsSync(credentialDirectory),
}));
`;
	writeFileSync(join(installRoot, "consumer.mjs"), consumerRuntime);
	const consumer = JSON.parse(run(process.execPath, [join(installRoot, "consumer.mjs")], installRoot));

	const effectTree = run("npm", ["ls", "effect", "--all"], installRoot).trim();
	const effectLocations = run("npm", ["ls", "effect", "--all", "--parseable"], installRoot)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => basename(line) === "effect")
		.map((line) => realpathSync(line));
	assert(new Set(effectLocations).size === 1, `Expected one physical Effect install, got ${effectLocations.join(", ")}`);

	const installedNodeBundle = readFileSync(join(installedSdkRoot, "dist", "node.js"), "utf8");
	assert(!installedNodeBundle.includes("4.0.0-beta.59"), "Node bundle contains the vendored Executor Effect beta");

	console.log(
		JSON.stringify(
			{
				status: "passed",
				packs: {
					sdk: { files: sdkPack.files.length, bytes: sdkPack.size, integrity: sdkPack.integrity },
					core: { files: corePack.files.length, bytes: corePack.size, integrity: corePack.integrity },
					executor: { files: executorPack.files.length, bytes: executorPack.size, integrity: executorPack.integrity },
				},
				install: installOutput.trim(),
				compiler: {
					package: `@typescript/native-preview@${JSON.parse(readFileSync(join(installRoot, "node_modules", "@typescript", "native-preview", "package.json"), "utf8")).version}`,
					binary: "node_modules/@typescript/native-preview/bin/tsgo.js",
					version: compilerVersion,
					skipLibCheckException: "effect@4.0.0-beta.85 omits SchemaErrorTypeId from dist/internal/schema/schema.d.ts",
					privateSubpathDiagnostic: privateImportDiagnostics.trim(),
				},
				privateCoreSubpaths,
				audit: JSON.parse(auditOutput),
				effect: { physicalLocations: [...new Set(effectLocations)], npmLs: effectTree },
				consumer,
			},
			undefined,
			2,
		),
	);
} finally {
	rmSync(fixtureRoot, { recursive: true, force: true });
}
