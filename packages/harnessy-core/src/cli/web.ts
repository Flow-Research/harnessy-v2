import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
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

const ENGINE_IDENTITY_PATH = "/api/local-auth/identity";
const ENGINE_IDENTITY_PURPOSE = "executor-local-identity-v2";

/** A literal address without IPv6 brackets, lowercased. */
const normalizeEngineAddress = (address: string): string =>
	address
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, "$1");

/**
 * The canonical IP literal Executor publishes and proves, or `undefined`.
 * Mirrors `canonicalIpLiteral` in executor/apps/local/src/serve-shared.ts:
 * IPv6 compressed and lowercased, an IPv4-mapped address as its IPv4 form,
 * no zone ID.
 */
export const canonicalEngineLiteral = (value: string): string | undefined => {
	const literal = normalizeEngineAddress(value);
	if (literal.includes("%")) return undefined;
	if (isIP(literal) === 4) return literal;
	if (isIP(literal) !== 6) return undefined;
	const compressed = new URL(`http://[${literal}]/`).hostname.slice(1, -1);
	const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(compressed);
	if (mapped === null) return compressed;
	const high = Number.parseInt(mapped[1] as string, 16);
	const low = Number.parseInt(mapped[2] as string, 16);
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

/**
 * The proof an Executor holding `token` and listening on `address`:`port`
 * returns for `nonce`. Mirrors `localIdentityProof` in
 * executor/apps/local/src/serve-shared.ts.
 */
export const engineIdentityProof = (token: string, address: string, port: number, nonce: string): string =>
	createHmac("sha256", token)
		.update(`${ENGINE_IDENTITY_PURPOSE}|${normalizeEngineAddress(address)}|${port}|${nonce}`)
		.digest("base64url");

const enginePort = (url: URL): number => (url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port));

/**
 * Ask the server at `origin` to prove it holds `token` (an HMAC over a fresh
 * nonce and the literal address and port connected to) before anything sends
 * it the bearer. A process that took over a stale manifest's port cannot
 * answer, and one on the same port in the other IP family that relays the
 * challenge to the real server gets a proof for the real server's address,
 * which does not verify. A host name never verifies: `localhost` can resolve
 * to the other family first. Use {@link resolveVerifiedEngineOrigin} for a
 * manifest that names `localhost`.
 */
export async function verifyEngineIdentity(
	origin: string,
	token: string,
	fetchImpl: WebFetch,
	signal: AbortSignal,
): Promise<boolean> {
	const url = URL.canParse(origin) ? new URL(origin) : undefined;
	if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) return false;
	// Only the canonical literal Executor publishes: a name, or another
	// spelling such as [::ffff:127.0.0.1], never verifies.
	const host = normalizeEngineAddress(url.hostname);
	const address = canonicalEngineLiteral(host);
	if (address === undefined || address !== host) return false;
	const port = enginePort(url);
	const nonce = randomBytes(32).toString("base64url");
	const response = await fetchImpl(`${url.origin}${ENGINE_IDENTITY_PATH}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ nonce }),
		redirect: "error",
		signal,
	}).then(
		(value) => value,
		() => undefined,
	);
	if (response === undefined) return false;
	if (!response.ok) {
		await response.body?.cancel();
		return false;
	}
	const body = (await response.json().then(
		(value: unknown) => value,
		() => undefined,
	)) as { readonly proof?: unknown } | undefined;
	if (typeof body?.proof !== "string") return false;
	const expected = Buffer.from(engineIdentityProof(token, address, port, nonce));
	const actual = Buffer.from(body.proof);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The literal origin of the server that proves it holds `token`, or
 * `undefined`. A literal origin is checked as is; a `localhost` origin (from
 * an Executor that published the name) is re-resolved to `127.0.0.1`, then
 * `[::1]`, on the same port. The bearer must go only to the returned origin.
 */
export async function resolveVerifiedEngineOrigin(
	origin: string,
	token: string,
	fetchImpl: WebFetch,
	signal: AbortSignal,
): Promise<string | undefined> {
	const url = URL.canParse(origin) ? new URL(origin) : undefined;
	if (url === undefined) return undefined;
	const candidates =
		url.hostname.toLowerCase() === "localhost"
			? ["127.0.0.1", "[::1]"].map((host) => `${url.protocol}//${host}:${enginePort(url)}`)
			: [url.origin];
	for (const candidate of candidates) {
		if (await verifyEngineIdentity(candidate, token, fetchImpl, signal)) return candidate;
	}
	return undefined;
}

/**
 * Follow Executor's live manifest until it advertises this data directory,
 * answers health checks and proves it holds the manifest's token.
 */
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
	let unverifiedOrigin: string | undefined;
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
					const verifiedOrigin = await resolveVerifiedEngineOrigin(
						manifest.connection.origin,
						manifest.connection.auth.token,
						fetchImpl,
						requestSignal(
							signal,
							Math.min(COCKPIT_HEALTH_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
						),
					);
					if (verifiedOrigin !== undefined) {
						return {
							cockpitUrl: verifiedOrigin,
							token: manifest.connection.auth.token,
						};
					}
					unverifiedOrigin = manifest.connection.origin;
				}
			} else {
				await response?.body?.cancel();
			}
		}
		if (Date.now() >= deadline) {
			if (unverifiedOrigin !== undefined) {
				throw new Error(
					`The server at ${unverifiedOrigin} did not prove it is the Executor for ${resolvedDataDir}, so Harnessy did not send it the token. If it is an Executor from before this check, restart it; otherwise another program uses that port. An Executor bound to all interfaces (0.0.0.0 or ::) never proves its identity: bind 127.0.0.1 or ::1.`,
				);
			}
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
).pipe(
	Command.withDescription(
		"Start or attach the Tools engine (the Executor cockpit: integrations, OAuth, secrets, policies, toolkits). " +
			"For your day-to-day app, use `harnessy open`.",
	),
);
