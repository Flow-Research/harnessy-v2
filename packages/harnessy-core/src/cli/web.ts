import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { Console, Schema } from "effect";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import { ANYTYPE_DEFAULT_BASE_URL, ANYTYPE_DEFAULT_VERSION } from "../connectors/anytype.ts";
import { HarnessError } from "../errors.ts";
import { runExecutorBuiltin } from "../executor-builtin.ts";

const DEFAULT_COCKPIT_PORT = 4788;
const COCKPIT_READY_TIMEOUT_MS = 30_000;
const COCKPIT_REQUEST_TIMEOUT_MS = 10_000;
const COCKPIT_HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const ANYTYPE_SLUG = "anytype";
const ANYTYPE_SPEC_URL = new URL("../../resources/anytype.openapi.json", import.meta.url);

type WebFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RegisterBundledAnytypeOptions {
	readonly cockpitUrl: string;
	readonly token: string;
	readonly fetchImpl?: WebFetch;
	readonly readyTimeoutMillis?: number;
	readonly requestTimeoutMillis?: number;
	readonly signal?: AbortSignal;
}

export type BundledAnytypeRegistration = "registered" | "already-registered";

const responseError = async (action: string, response: Response): Promise<Error> => {
	const detail = (await response.text()).trim().slice(0, 500);
	return new Error(`${action} failed with HTTP ${response.status}${detail === "" ? "" : `: ${detail}`}`);
};

const requestSignal = (signal: AbortSignal | undefined, timeoutMillis: number): AbortSignal => {
	const timeout = AbortSignal.timeout(Math.max(1, timeoutMillis));
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
};

const normalizeScopeDir = (scopeDir: string): string => {
	const resolved = resolve(scopeDir);
	return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
};

/** Wait for the cockpit API and idempotently install Harnessy's bundled AnyType card. */
export async function registerBundledAnytype({
	cockpitUrl,
	token,
	fetchImpl = globalThis.fetch,
	readyTimeoutMillis = COCKPIT_READY_TIMEOUT_MS,
	requestTimeoutMillis = COCKPIT_REQUEST_TIMEOUT_MS,
	signal,
}: RegisterBundledAnytypeOptions): Promise<BundledAnytypeRegistration> {
	const baseUrl = cockpitUrl.replace(/\/$/, "");
	const deadline = Date.now() + readyTimeoutMillis;
	for (;;) {
		if (signal?.aborted) throw signal.reason;
		const response = await fetchImpl(`${baseUrl}/api/health`, {
			signal: requestSignal(signal, Math.min(COCKPIT_HEALTH_REQUEST_TIMEOUT_MS, deadline - Date.now())),
		}).then(
			(value) => value,
			(error: unknown) => (signal?.aborted ? Promise.reject(error) : undefined),
		);
		if (response !== undefined) {
			await response.body?.cancel();
			if (response.ok) break;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Cockpit API did not become ready at ${baseUrl} within ${readyTimeoutMillis}ms.`);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	const headers = { Authorization: `Bearer ${token}` };
	const existing = await fetchImpl(`${baseUrl}/api/openapi/integrations/${ANYTYPE_SLUG}`, {
		headers,
		signal: requestSignal(signal, requestTimeoutMillis),
	});
	if (!existing.ok) throw await responseError("Checking the bundled AnyType integration", existing);
	if ((await existing.json()) !== null) return "already-registered";

	const added = await fetchImpl(`${baseUrl}/api/openapi/specs`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify({
			spec: { kind: "blob", value: readFileSync(ANYTYPE_SPEC_URL, "utf8") },
			slug: ANYTYPE_SLUG,
			name: "AnyType",
			description: "Local-first AnyType knowledge through Harnessy.",
			baseUrl: ANYTYPE_DEFAULT_BASE_URL,
			headers: { "Anytype-Version": ANYTYPE_DEFAULT_VERSION },
			healthCheck: { operation: "spaces_list" },
			authenticationTemplate: [
				{
					slug: "apiKey",
					type: "apiKey",
					label: "Pairing API key",
					headers: {
						Authorization: ["Bearer ", { type: "variable", name: "apiKey" }],
					},
				},
			],
		}),
		signal: requestSignal(signal, requestTimeoutMillis),
	});
	if (added.status === 409) {
		await added.body?.cancel();
		return "already-registered";
	}
	if (!added.ok) throw await responseError("Registering the bundled AnyType integration", added);
	await added.body?.cancel();
	return "registered";
}

const portFlag = Flag.integer("port").pipe(
	Flag.withDescription("Preferred port for the packaged cockpit service (default 4788)"),
	Flag.optional,
);

const dataDirFlag = Flag.string("data-dir").pipe(
	Flag.withDescription("Executor data directory (default ~/.executor)"),
	Flag.optional,
);

const scopeFlag = Flag.string("scope").pipe(
	Flag.withDescription("Executor workspace scope (default: current directory)"),
	Flag.optional,
);

const EngineServerManifest = Schema.Struct({
	dataDir: Schema.String,
	scopeDir: Schema.NullOr(Schema.String),
	connection: Schema.Struct({
		origin: Schema.String,
		auth: Schema.Struct({
			kind: Schema.Literal("bearer"),
			token: Schema.String,
		}),
	}),
});

export interface EngineConnection {
	readonly cockpitUrl: string;
	readonly token: string;
}

export interface WaitForEngineConnectionOptions {
	readonly dataDir: string;
	readonly fetchImpl?: WebFetch;
	readonly readyTimeoutMillis?: number;
	readonly expectedScopeDir?: string | null;
	readonly signal?: AbortSignal;
}

/** Follow Executor's live manifest until it advertises this data directory and answers health checks. */
export async function waitForEngineConnection({
	dataDir,
	fetchImpl = globalThis.fetch,
	readyTimeoutMillis = COCKPIT_READY_TIMEOUT_MS,
	expectedScopeDir,
	signal,
}: WaitForEngineConnectionOptions): Promise<EngineConnection> {
	const resolvedDataDir = resolve(dataDir);
	const manifestPath = join(resolvedDataDir, "server-control", "server.json");
	const deadline = Date.now() + readyTimeoutMillis;
	for (;;) {
		if (signal?.aborted) throw signal.reason;
		const manifest = await readFile(manifestPath, "utf8")
			.then((raw) => Schema.decodeUnknownSync(EngineServerManifest)(JSON.parse(raw) as unknown))
			.then(
				(value) => value,
				() => undefined,
			);
		if (
			manifest !== undefined &&
			resolve(manifest.dataDir) === resolvedDataDir &&
			manifest.connection.auth.token !== ""
		) {
			const remainingMillis = deadline - Date.now();
			const response = await fetchImpl(`${manifest.connection.origin.replace(/\/$/, "")}/api/health`, {
				signal: requestSignal(signal, Math.min(COCKPIT_HEALTH_REQUEST_TIMEOUT_MS, remainingMillis)),
			}).then(
				(value) => value,
				(error: unknown) => (signal?.aborted ? Promise.reject(error) : undefined),
			);
			if (response?.ok) {
				const healthy = (await response.text()).trim() === "ok";
				if (healthy) {
					const manifestScopeDir = manifest.scopeDir === null ? null : normalizeScopeDir(manifest.scopeDir);
					if (expectedScopeDir !== undefined && manifestScopeDir !== expectedScopeDir) {
						throw new Error(
							`The running Executor daemon is scoped to ${manifestScopeDir ?? "global state"}, but ${expectedScopeDir ?? "global state"} was requested. Stop the existing daemon before opening this scope.`,
						);
					}
					return {
						cockpitUrl: manifest.connection.origin,
						token: manifest.connection.auth.token,
					};
				}
			} else {
				await response?.body?.cancel();
			}
		}
		if (Date.now() >= deadline) {
			throw new Error(`Executor did not publish a reachable server manifest within ${readyTimeoutMillis}ms.`);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
}

export const webCommand = Command.make(
	"web",
	{ port: portFlag, dataDir: dataDirFlag, scope: scopeFlag },
	({ port, dataDir, scope }) =>
		Effect.gen(function* () {
			const resolvedPort = Option.getOrElse(port, () => DEFAULT_COCKPIT_PORT);
			const resolvedScopeDir = normalizeScopeDir(Option.isSome(scope) ? scope.value : process.cwd());
			const executorDataDir = resolve(
				Option.getOrElse(dataDir, () => process.env.EXECUTOR_DATA_DIR?.trim() || join(homedir(), ".executor")),
			);
			const executorEnv: NodeJS.ProcessEnv = {
				...process.env,
				EXECUTOR_DATA_DIR: executorDataDir,
			};
			yield* Console.log(`Executor data: ${executorDataDir}`);
			const daemonExitCode = yield* runExecutorBuiltin({
				args: [
					"daemon",
					"run",
					"--port",
					String(resolvedPort),
					"--hostname",
					"127.0.0.1",
					"--scope",
					resolvedScopeDir,
				],
				env: executorEnv,
			});
			if (daemonExitCode !== 0) {
				return yield* new HarnessError({ message: `Executor daemon exited with code ${daemonExitCode}.` });
			}

			const connection = yield* Effect.tryPromise({
				try: () =>
					waitForEngineConnection({
						dataDir: executorDataDir,
						expectedScopeDir: resolvedScopeDir,
					}),
				catch: (cause) =>
					new HarnessError({
						message: `The packaged Executor daemon did not become reachable: ${String(cause)}`,
					}),
			});
			yield* Effect.tryPromise({
				try: () =>
					registerBundledAnytype({
						cockpitUrl: connection.cockpitUrl,
						token: connection.token,
					}),
				catch: (cause) =>
					new HarnessError({
						message: `Failed to register the bundled AnyType integration: ${String(cause)}`,
					}),
			}).pipe(Effect.catch((error) => Console.warn(`Bundled AnyType registration warning: ${error.message}`)));

			const webExitCode = yield* runExecutorBuiltin({ args: ["web"], env: executorEnv });
			if (webExitCode !== 0) {
				return yield* new HarnessError({ message: `Executor web command exited with code ${webExitCode}.` });
			}
		}),
).pipe(Command.withDescription("Start or attach the packaged engine daemon and open its cockpit"));
