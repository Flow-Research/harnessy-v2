import { createHash } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FileSystem, Path, Redacted } from "effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";

import { rootCommand } from "../src/commands.ts";
import { HARNESSY_VERSION } from "../src/constants.ts";
import { JarvisConfigReader } from "../src/jarvis/config.ts";
import { JARVIS_CONTEXT_FILES, JarvisContextLoader } from "../src/jarvis/context.ts";
import { JarvisCredentialResolver } from "../src/jarvis/credentials.ts";
import { JarvisDiagnostic } from "../src/jarvis/diagnostic.ts";
import { decodeJarvisEnvironment, JarvisEnvironment } from "../src/jarvis/environment.ts";
import {
	JarvisParityEntry,
	JarvisParityManifest,
	parseJarvisAdapterOracle,
	parseJarvisCommandManifest,
	parseJarvisParityManifest,
	parseJarvisStateFixtureOracle,
	parseJarvisStateManifest,
	summarizeJarvisParity,
	validateJarvisParity,
} from "../src/jarvis/parity.ts";
import { JarvisParityReporter } from "../src/jarvis/parity-report.ts";
import { JarvisPathResolver, JarvisRuntimeRoots } from "../src/jarvis/paths.ts";
import { HarnessProject } from "../src/operations.ts";

const contextLayer = Layer.mergeAll(JarvisPathResolver.layer, JarvisContextLoader.layer);

const pythonTreeSha256 = (root: string) => {
	const digest = createHash("sha256");
	for (const relativePath of globSync("**/*.py", { cwd: root }).sort()) {
		digest.update(relativePath);
		digest.update("\0");
		digest.update(readFileSync(resolve(root, relativePath)));
		digest.update("\0");
	}
	return digest.digest("hex");
};

describe("Jarvis compatibility kernel", () => {
	it.effect("loads the frozen Python command and state inventories", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const commandManifest = yield* parseJarvisCommandManifest(
				yield* fs.readFileString("fixtures/jarvis-v1/command-manifest.json"),
				"command-manifest.json",
			);
			const stateManifest = yield* parseJarvisStateManifest(
				yield* fs.readFileString("fixtures/jarvis-v1/state-manifest.json"),
				"state-manifest.json",
			);
			const parityManifest = yield* parseJarvisParityManifest(
				yield* fs.readFileString("fixtures/jarvis-v1/parity-manifest.json"),
				"parity-manifest.json",
			);
			const adapterOracle = yield* parseJarvisAdapterOracle(
				yield* fs.readFileString("fixtures/jarvis-v1/adapter-oracle.json"),
				"adapter-oracle.json",
			);
			const stateFixtureOracle = yield* parseJarvisStateFixtureOracle(
				yield* fs.readFileString("fixtures/jarvis-v1/state-fixture-oracle.json"),
				"state-fixture-oracle.json",
			);
			yield* validateJarvisParity(parityManifest, commandManifest, stateManifest);
			const summary = yield* summarizeJarvisParity(parityManifest);
			const paths = commandManifest.commands.map((entry) => entry.path.join(" "));

			expect(commandManifest.commands).toHaveLength(156);
			expect(JSON.stringify(commandManifest)).not.toContain("Sentinel.UNSET");
			expect(commandManifest.source.pythonSourceSha256).toMatch(/^[a-f0-9]{64}$/);
			const sourceRoot = resolve("../capability-harnessy-v1-full/resources/jarvis-cli/src");
			expect(commandManifest.source.pythonSourceSha256).toBe(pythonTreeSha256(sourceRoot));
			expect(adapterOracle.source.pythonSourceSha256).toBe(pythonTreeSha256(resolve(sourceRoot, "jarvis/adapters")));
			expect(stateFixtureOracle.pythonSourceSha256).toBe(pythonTreeSha256(resolve(sourceRoot, "jarvis")));
			expect(stateFixtureOracle.stateManifestSha256).toBe(
				createHash("sha256").update(readFileSync("fixtures/jarvis-v1/state-manifest.json")).digest("hex"),
			);
			expect(new Set(paths).size).toBe(paths.length);
			expect(paths).toEqual([...paths].sort());
			expect(paths).toContain("jarvis wiki research");
			expect(paths).toContain("jarvis whatsapp send-template");
			expect(paths).toContain("jarvis sync run");
			expect(stateManifest.stores.map((store) => store.id)).toContain("pending-suggestions-json-v1");
			expect(stateManifest.stores.map((store) => store.id)).toContain("sync-state-json-v1");
			expect(stateManifest.stores.find((store) => store.id === "reading-list-url-cache-v1")?.pathTemplate).toBe(
				"~/.jarvis/cache/reading-list/urls/<sha256>.json",
			);
			expect(stateManifest.stores.find((store) => store.id === "fathom-inbox-json-v1")?.pathTemplate).toContain(
				"meeting-inbox/fathom/<account>/",
			);
			expect(stateManifest.stores.find((store) => store.id === "whatsapp-inbox-json-v1")?.pathTemplate).toContain(
				"whatsapp/<account>/inbox/",
			);
			expect(stateManifest.stores.map((store) => store.id)).toContain("whatsapp-thread-json-v1");
			expect(stateManifest.stores.map((store) => store.id)).toContain("whatsapp-thread-markdown-v1");
			expect(parityManifest.entries).toHaveLength(202);
			expect(summary.counts.total).toBe(202);
			expect(summary.surfaces.find((surface) => surface.surface === "command")?.counts.total).toBe(156);
			expect(summary.surfaces.find((surface) => surface.surface === "state")?.counts.total).toBe(20);
			expect(
				parityManifest.entries
					.filter((entry) => entry.surface === "context")
					.map((entry) => entry.legacyReference)
					.sort(),
			).toEqual([...JARVIS_CONTEXT_FILES].sort());
			expect(parityManifest.entries.find((entry) => entry.legacyReference === "jarvis content")?.status).toBe(
				"missing",
			);
			expect(parityManifest.entries.find((entry) => entry.legacyReference === "jarvis w")?.status).toBe(
				"intentionally-retired",
			);
			expect(adapterOracle.capabilityKeys).toHaveLength(9);
			expect(adapterOracle.missingCapabilityDefault).toBe(false);
			expect(adapterOracle.capabilities.anytype?.custom_properties).toBe(false);
			expect(adapterOracle.capabilities.notion?.custom_properties).toBe(true);
			expect(adapterOracle.errors.map((error) => error.type)).toEqual([
				"JarvisBackendError",
				"ConnectionError",
				"AuthError",
				"RateLimitError",
				"NotFoundError",
				"NotSupportedError",
				"AdapterNotFoundError",
				"ConfigError",
				"ValidationError",
			]);
			expect(adapterOracle.retryPolicy.delayCases.at(-1)).toMatchObject({
				errorType: "RateLimitError",
				retryAfterSeconds: 45,
				delaySeconds: 30,
			});
			expect(adapterOracle.retryPolicy.nonRetryableErrors).toEqual([
				"JarvisBackendError",
				"AuthError",
				"NotFoundError",
				"NotSupportedError",
				"AdapterNotFoundError",
				"ConfigError",
				"ValidationError",
			]);
			expect(adapterOracle.retryPolicy.executionCases).toEqual([
				expect.objectContaining({ case: "transient-then-success", calls: 2, sleeps: [1], terminalError: null }),
				expect.objectContaining({ case: "auth-fail-fast", calls: 1, sleeps: [], terminalError: "AuthError" }),
				expect.objectContaining({
					case: "transient-exhaustion",
					calls: 4,
					sleeps: [1, 2, 2.5],
					terminalError: "ConnectionError",
				}),
			]);

			const expectedFixtureValidations = stateManifest.stores.flatMap((store) => [
				...(store.fixture === undefined ? [] : [`${store.id}:valid:${store.fixture}`]),
				...(store.malformedFixture === undefined ? [] : [`${store.id}:malformed:${store.malformedFixture}`]),
			]);
			expect(
				stateFixtureOracle.validations.map(
					(validation) => `${validation.storeId}:${validation.kind}:${validation.fixture}`,
				),
			).toEqual(expectedFixtureValidations);
			for (const validation of stateFixtureOracle.validations) {
				expect(validation.sha256).toBe(
					createHash("sha256")
						.update(readFileSync(`fixtures/jarvis-v1/${validation.fixture}`))
						.digest("hex"),
				);
			}

			for (const store of stateManifest.stores) {
				if (store.fixture !== undefined) {
					expect(yield* fs.exists(`fixtures/jarvis-v1/${store.fixture}`)).toBe(true);
					const fixture = yield* fs.readFileString(`fixtures/jarvis-v1/${store.fixture}`);
					expect(fixture.length).toBeGreaterThan(0);
					if (store.fixture.endsWith(".json")) JSON.parse(fixture);
				}
				if (store.malformedFixture !== undefined) {
					const malformed = yield* fs.readFileString(`fixtures/jarvis-v1/${store.malformedFixture}`);
					expect(malformed.length).toBeGreaterThan(0);
					if (store.malformedFixture.endsWith(".json")) expect(() => JSON.parse(malformed)).toThrow();
				}
			}
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("resolves canonical and legacy stores without creating them", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const target = path.join(root, "project");
				yield* fs.makeDirectory(home, { recursive: true });
				yield* fs.makeDirectory(target, { recursive: true });

				const result = yield* Effect.gen(function* () {
					const diagnostic = yield* JarvisDiagnostic;
					return yield* diagnostic.inspect(target);
				}).pipe(Effect.provide(JarvisDiagnostic.liveLayer), Effect.provide(JarvisRuntimeRoots.testLayer(home)));

				expect(result.migrationStatus).toBe("empty");
				expect(result.paths.canonicalGlobalRoot).toBe(path.join(home, ".harnessy", "jarvis"));
				expect(result.paths.legacyGlobalRoot).toBe(path.join(home, ".jarvis"));
				expect(result.config.status).toBe("missing");
				expect(yield* fs.exists(result.paths.canonicalGlobalRoot)).toBe(false);
				expect(yield* fs.exists(result.paths.legacyGlobalRoot)).toBe(false);
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("loads the twelve-file legacy context with project override and global expansion", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const target = path.join(root, "project");
				const globalContext = path.join(home, ".jarvis", "context");
				const projectContext = path.join(target, ".jarvis", "context");
				yield* fs.makeDirectory(globalContext, { recursive: true });
				yield* fs.makeDirectory(projectContext, { recursive: true });
				yield* fs.writeFileString(path.join(globalContext, "preferences.md"), "global preference");
				yield* fs.writeFileString(path.join(projectContext, "preferences.md"), "project preference");
				yield* fs.writeFileString(path.join(globalContext, "goals.md"), "global goal");
				yield* fs.writeFileString(path.join(projectContext, "goals.md"), "{{global}}\nproject goal");

				const loaded = yield* Effect.gen(function* () {
					const resolver = yield* JarvisPathResolver;
					const loader = yield* JarvisContextLoader;
					return yield* loader.loadLegacy(yield* resolver.resolve(target));
				}).pipe(Effect.provide(contextLayer), Effect.provide(JarvisRuntimeRoots.testLayer(home)));

				expect(loaded.documents).toHaveLength(12);
				expect(loaded.documents.find((entry) => entry.name === "preferences.md")).toMatchObject({
					source: "project",
					content: "project preference",
				});
				expect(loaded.documents.find((entry) => entry.name === "goals.md")).toMatchObject({
					source: "merged",
					content: "global goal\nproject goal",
				});
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("preserves legacy YAML defaults and rejects invalid nested shapes", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const target = path.join(root, "project");
				const configPath = path.join(home, ".jarvis", "config.yaml");
				yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
				yield* fs.makeDirectory(target, { recursive: true });

				const inspect = (raw: string) =>
					fs.writeFileString(configPath, raw).pipe(
						Effect.andThen(
							Effect.gen(function* () {
								const diagnostic = yield* JarvisDiagnostic;
								return yield* diagnostic.inspect(target);
							}),
						),
						Effect.provide(JarvisDiagnostic.liveLayer),
						Effect.provide(JarvisRuntimeRoots.testLayer(home)),
					);

				for (const raw of [
					"",
					"# comment only\n",
					"[]\n",
					"unknown_root: ignored\ncontent:\n  unknown_nested: ignored\n",
				]) {
					const result = yield* inspect(raw);
					expect(result.config).toMatchObject({
						status: "valid",
						version: 1,
						activeBackend: "anytype",
						configuredBackends: ["anytype"],
					});
				}

				for (const { raw, version } of [
					{ raw: 'version: "1"\nanalytics:\n  enabled: "false"\n', version: 1 },
					{ raw: 'version: " 1 "\nanalytics:\n  enabled: "TrUe"\n', version: 1 },
					{ raw: 'version: "1.0"\nanalytics:\n  enabled: 0\n', version: 1 },
					{ raw: 'version: "1_000"\nanalytics:\n  enabled: 1\n', version: 1000 },
					{ raw: "version: true\nanalytics:\n  enabled: yes\n", version: 1 },
					{ raw: "version: false\nanalytics:\n  enabled: no\n", version: 0 },
				]) {
					const result = yield* inspect(raw);
					expect(result.config.status).toBe("valid");
					expect(result.config.version).toBe(version);
				}

				for (const raw of [
					"version: 1.5\n",
					'version: ""\n',
					'version: "1e3"\n',
					"active_backend: unknown\n",
					"backends:\n  anytype: invalid\n",
					"backends:\n  notion:\n    workspace_id: only-one-field\n",
					"analytics:\n  enabled: 2\n",
					'analytics:\n  enabled: " yes "\n',
					'analytics:\n  enabled: "not-a-bool"\n',
					"- non-empty\n- root-list\n",
				]) {
					const result = yield* inspect(raw);
					expect(result.config.status).toBe("invalid");
					expect(result.config.issues).toEqual(["Legacy Jarvis configuration failed schema validation."]);
				}
				expect(yield* fs.exists(path.join(home, ".harnessy"))).toBe(false);
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("resolves full config defaults and nested environment precedence", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const target = path.join(root, "project");
				yield* fs.makeDirectory(path.join(home, ".jarvis"), { recursive: true });
				yield* fs.makeDirectory(target, { recursive: true });
				yield* fs.writeFileString(
					path.join(home, ".jarvis", "config.yaml"),
					[
						"version: 1",
						"active_backend: anytype",
						"content:",
						"  root_path: ./content",
						"analytics:",
						"  metrics_file: ./metrics.json",
						"fathom:",
						"  accounts:",
						"    work:",
						"      email: fixture@example.com",
						"      api_key_env_var: FATHOM_API_KEY_WORK",
					].join("\n"),
				);

				const configLayer = JarvisConfigReader.layer.pipe(
					Layer.provide(
						JarvisEnvironment.testLayer({
							jarvis_version: "2",
							JARVIS_ACTIVE_BACKEND: "notion",
							JARVIS_NOTION_TOKEN: "ignored-by-config-schema",
							JARVIS_BACKENDS: JSON.stringify({
								notion: {
									workspace_id: "workspace-json",
									journal_database_id: "journal-json",
									property_mappings: { title: "Custom" },
								},
							}),
							JARVIS_BACKENDS__NOTION__WORKSPACE_ID: "workspace-env",
							JARVIS_BACKENDS__NOTION__TASK_DATABASE_ID: "tasks-env",
							JARVIS_ANALYTICS__ENABLED: "true",
							JARVIS_FATHOM__DEFAULT_ACCOUNT: "work",
							JARVIS_FATHOM__ACCOUNTS__WORK__WEBHOOK_SECRET_ENV_VAR: "FATHOM_SECRET_WORK",
							JARVIS_WHATSAPP__DEFAULT_ACCOUNT: "personal",
							JARVIS_WHATSAPP__ACCOUNTS__PERSONAL__PHONE_NUMBER_ID: "phone-env",
						}),
					),
				);
				const resolved = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(target);
					return yield* (yield* JarvisConfigReader).loadResolved(paths);
				}).pipe(
					Effect.provide(Layer.mergeAll(JarvisPathResolver.layer, configLayer)),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);

				expect(resolved.version).toBe(2);
				expect(resolved.activeBackend).toBe("notion");
				expect(resolved.notion).toMatchObject({
					workspaceId: "workspace-env",
					taskDatabaseId: "tasks-env",
					journalDatabaseId: "journal-json",
				});
				expect(resolved.notion?.propertyMappings).toEqual({ title: "Custom" });
				expect(resolved.content).toMatchObject({ rootPath: "./content", anytypeRootCollection: "Content" });
				expect(resolved.analytics).toMatchObject({ enabled: true, metricsFile: "./metrics.json" });
				expect(resolved.fathom.accounts.work).toMatchObject({
					email: "fixture@example.com",
					apiKeyEnvVar: "FATHOM_API_KEY_WORK",
					webhookSecretEnvVar: "FATHOM_SECRET_WORK",
				});
				expect(resolved.whatsapp.accounts.personal).toMatchObject({
					provider: "meta",
					phoneNumberId: "phone-env",
					apiVersion: "v24.0",
				});
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("rejects malformed and non-object JSON for complex Pydantic environment fields", () =>
		Effect.gen(function* () {
			for (const value of ["not-json", "[]"]) {
				const error = yield* decodeJarvisEnvironment([
					["JARVIS_BACKENDS", value],
					["JARVIS_BACKENDS__NOTION__WORKSPACE_ID", "nested-value"],
				]).pipe(Effect.flip);
				expect(error).toBeDefined();
			}
		}),
	);

	it.effect("resolves named credentials from environment and managed files without disclosure", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const target = path.join(root, "project");
				yield* fs.makeDirectory(path.join(home, ".jarvis", "env"), { recursive: true });
				yield* fs.makeDirectory(target, { recursive: true });
				yield* fs.writeFileString(
					path.join(home, ".jarvis", "config.yaml"),
					[
						"fathom:",
						"  default_account: work",
						"  accounts:",
						"    work:",
						"      api_key_env_var: FATHOM_API_KEY_WORK",
						"whatsapp:",
						"  default_account: personal",
						"  accounts:",
						"    personal:",
						"      phone_number_id: phone-config",
						"      access_token_env_var: WA_TOKEN_PERSONAL",
						"    fallback:",
						"      phone_number_id: ''",
					].join("\n"),
				);
				yield* fs.writeFileString(
					path.join(home, ".jarvis", "env", "fathom.zsh"),
					[
						"malformed line containing managed-secret-ignored",
						"export BROKEN",
						"export MALFORMED='unterminated",
						"export FATHOM_API_KEY_WORK='managed fathom secret' # accepted trailing token",
						"export FATHOM_API_KEY_WORK='duplicate-must-not-win'",
						"export JARVIS_SLACK_TOKEN='managed-backend-token-must-not-resolve'",
					].join("\n"),
				);

				const environmentLayer = JarvisEnvironment.testLayer({
					WA_TOKEN_PERSONAL: "environment-wa-secret",
					JARVIS_NOTION_TOKEN: "specific-notion-secret",
					NOTION_TOKEN: "fallback-notion-secret",
					JARVIS_WHATSAPP_PHONE_NUMBER_ID: "phone-from-environment",
				});
				const services = Layer.mergeAll(
					JarvisPathResolver.layer,
					JarvisConfigReader.layer.pipe(Layer.provide(environmentLayer)),
					JarvisCredentialResolver.layer.pipe(Layer.provide(environmentLayer)),
				);
				const result = yield* Effect.gen(function* () {
					const paths = yield* (yield* JarvisPathResolver).resolve(target);
					const config = yield* (yield* JarvisConfigReader).loadResolved(paths);
					const credentials = yield* JarvisCredentialResolver;
					const fathom = yield* credentials.fathomApiKey(config, paths, "");
					const whatsapp = yield* credentials.whatsappAccessToken(config);
					const notion = yield* credentials.backendToken("notion");
					const phoneNumber = yield* credentials.whatsappPhoneNumberId(config);
					const fallbackPhone = yield* credentials.whatsappPhoneNumberId(config, "fallback");
					const missing = yield* credentials.whatsappAppSecret(config).pipe(Effect.flip);
					const managedBackend = yield* credentials.backendToken("slack").pipe(Effect.flip);
					const unknown = yield* credentials.fathomApiKey(config, paths, "unknown").pipe(Effect.flip);
					const presence = yield* credentials.inspectPresence(config, paths);
					return {
						fathom,
						whatsapp,
						notion,
						phoneNumber,
						fallbackPhone,
						missing,
						managedBackend,
						unknown,
						presence,
					};
				}).pipe(Effect.provide(services), Effect.provide(JarvisRuntimeRoots.testLayer(home)));

				expect(result.fathom).toMatchObject({
					account: "work",
					source: "managed-env-file",
					envVar: "FATHOM_API_KEY_WORK",
				});
				expect(Redacted.value(result.fathom.value)).toBe("managed fathom secret");
				expect(result.whatsapp).toMatchObject({
					account: "personal",
					source: "environment",
					envVar: "WA_TOKEN_PERSONAL",
				});
				expect(Redacted.value(result.whatsapp.value)).toBe("environment-wa-secret");
				expect(result.notion).toMatchObject({ source: "environment", envVar: "JARVIS_NOTION_TOKEN" });
				expect(Redacted.value(result.notion.value)).toBe("specific-notion-secret");
				expect(result.phoneNumber).toMatchObject({
					account: "personal",
					source: "config",
					envVar: null,
					value: "phone-config",
				});
				expect(result.fallbackPhone).toMatchObject({
					account: "fallback",
					source: "environment",
					envVar: "JARVIS_WHATSAPP_PHONE_NUMBER_ID",
					value: "phone-from-environment",
				});
				expect(String(result.fathom.value)).toBe("<redacted>");
				expect(JSON.stringify(result.fathom)).not.toContain("managed fathom secret");
				expect(result.missing).toMatchObject({
					_tag: "JarvisCredentialError",
					backend: "whatsapp",
					credential: "app-secret",
					reason: "missing",
				});
				expect(result.managedBackend).toMatchObject({
					_tag: "JarvisCredentialError",
					backend: "slack",
					reason: "missing",
				});
				expect(result.unknown).toMatchObject({
					_tag: "JarvisCredentialError",
					backend: "fathom",
					account: "unknown",
					reason: "unknown-account",
				});
				expect(result.presence).toContainEqual(
					expect.objectContaining({
						backend: "fathom",
						credential: "api-key",
						present: true,
						source: "managed-env-file",
						envVar: "FATHOM_API_KEY_WORK",
					}),
				);
				expect(JSON.stringify(result.presence)).not.toContain("managed fathom secret");
				expect(JSON.stringify(result.presence)).not.toContain("environment-wa-secret");
			}),
		).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live("reports redacted config metadata through the read-only CLI", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const target = path.join(root, "project");
				yield* fs.makeDirectory(path.join(home, ".jarvis"), { recursive: true });
				yield* fs.makeDirectory(target, { recursive: true });
				yield* fs.writeFileString(
					path.join(home, ".jarvis", "config.yaml"),
					[
						"version: 1",
						"active_backend: notion",
						"backends:",
						"  anytype: {}",
						"  notion:",
						"    workspace_id: workspace-1",
						"    task_database_id: tasks-1",
						"    journal_database_id: journal-1",
						"    token: should-not-appear",
					].join("\n"),
				);

				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });
				yield* run(["jarvis", "diagnose", "--json", "--target", target]).pipe(
					Effect.provide(HarnessProject.layer),
					Effect.provide(JarvisDiagnostic.liveLayer),
					Effect.provide(JarvisParityReporter.layer),
					Effect.provide(JarvisRuntimeRoots.testLayer(home)),
				);
				const logs = yield* TestConsole.logLines;
				const jsonLog = logs.find(
					(logged): logged is string =>
						typeof logged === "string" && logged.includes('"command": "jarvis diagnose"'),
				);
				if (jsonLog === undefined) throw new Error("jarvis diagnose --json did not emit structured output");
				const output = JSON.parse(jsonLog) as {
					readonly command: string;
					readonly config: { readonly status: string; readonly activeBackend: string };
				};
				expect(output.command).toBe("jarvis diagnose");
				expect(output.config).toMatchObject({ status: "valid", activeBackend: "notion" });
				expect(jsonLog).not.toContain("should-not-appear");
			}),
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(TestConsole.layer)),
	);

	it.live("reports the validated parity dashboard through the read-only CLI", () =>
		Effect.gen(function* () {
			const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });
			yield* run(["jarvis", "parity", "--json"]).pipe(
				Effect.provide(HarnessProject.layer),
				Effect.provide(JarvisDiagnostic.liveLayer),
				Effect.provide(JarvisParityReporter.layer),
				Effect.provide(JarvisRuntimeRoots.testLayer("/unused-home")),
			);
			const jsonLog = (yield* TestConsole.logLines).find(
				(logged): logged is string => typeof logged === "string" && logged.includes('"command": "jarvis parity"'),
			);
			if (jsonLog === undefined) throw new Error("jarvis parity --json did not emit structured output");
			const output = JSON.parse(jsonLog) as {
				readonly ok: boolean;
				readonly summary: { readonly counts: { readonly total: number; readonly compatible: number } };
			};
			expect(output.ok).toBe(true);
			expect(output.summary.counts.total).toBe(202);
			expect(output.summary.counts.compatible).toBeGreaterThan(0);
		}).pipe(Effect.provide(NodeServices.layer), Effect.provide(TestConsole.layer)),
	);

	it.live("never exposes malformed YAML source lines in JSON or text diagnostics", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const path = yield* Path.Path;
				const root = yield* fs.makeTempDirectoryScoped();
				const home = path.join(root, "home");
				const target = path.join(root, "project");
				yield* fs.makeDirectory(path.join(home, ".jarvis"), { recursive: true });
				yield* fs.makeDirectory(target, { recursive: true });
				yield* fs.writeFileString(path.join(home, ".jarvis", "config.yaml"), "token: should-not-appear: broken\n");

				const run = Command.runWith(rootCommand, { version: HARNESSY_VERSION });
				const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					effect.pipe(
						Effect.provide(HarnessProject.layer),
						Effect.provide(JarvisDiagnostic.liveLayer),
						Effect.provide(JarvisParityReporter.layer),
						Effect.provide(JarvisRuntimeRoots.testLayer(home)),
					);
				yield* provide(run(["jarvis", "diagnose", "--json", "--target", target]));
				yield* provide(run(["jarvis", "diagnose", "--target", target]));

				const output = (yield* TestConsole.logLines).join("\n");
				expect(output).toContain("Invalid YAML syntax in legacy Jarvis configuration.");
				expect(output).not.toContain("should-not-appear");
			}),
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(TestConsole.layer)),
	);

	it.effect("rejects incomplete or duplicate parity ledgers", () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const commands = yield* parseJarvisCommandManifest(
				yield* fs.readFileString("fixtures/jarvis-v1/command-manifest.json"),
				"command-manifest.json",
			);
			const state = yield* parseJarvisStateManifest(
				yield* fs.readFileString("fixtures/jarvis-v1/state-manifest.json"),
				"state-manifest.json",
			);
			const parity = yield* parseJarvisParityManifest(
				yield* fs.readFileString("fixtures/jarvis-v1/parity-manifest.json"),
				"parity-manifest.json",
			);
			const first = parity.entries.find((entry) => entry.surface === "command");
			if (first === undefined) throw new Error("Expected a command parity fixture");
			const duplicateReference = new JarvisParityEntry({
				...first,
				id: `${first.id}:conflict`,
				status: first.status === "missing" ? "partial" : "missing",
			});
			const invalid = new JarvisParityManifest({
				schemaVersion: 1,
				sourceVersion: parity.sourceVersion,
				entries: [first, ...parity.entries.filter((entry) => entry.surface !== "state"), duplicateReference, first],
			});
			const error = yield* validateJarvisParity(invalid, commands, state).pipe(Effect.flip);
			expect(error.issues).toContain(`Duplicate parity id: ${first.id}`);
			expect(error.issues).toContain(`Duplicate ${first.surface} parity reference: ${first.legacyReference}`);
			expect(error.issues).toContain(`Parity id ${duplicateReference.id} must be ${first.id}`);
			expect(error.issues).toContain("Missing state parity entry: legacy-config-yaml-v1");
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("validates the parity manifest contract", () =>
		Effect.gen(function* () {
			const manifest = yield* parseJarvisParityManifest(
				JSON.stringify({
					schemaVersion: 1,
					sourceVersion: "0.1.0",
					entries: [
						{
							id: "command:jarvis-status",
							surface: "command",
							legacyReference: "jarvis status",
							status: "missing",
						},
					],
				}),
				"fixture.json",
			);
			expect(manifest.entries).toHaveLength(1);
			expect(manifest.entries[0]?.status).toBe("missing");
		}),
	);
});
