import {
	type AppExtensions,
	type CodeExecutor,
	CodeExecutorProvider,
	type CommonProviders,
	consoleErrorCapture,
	DbProvider,
	dbProviderLayer,
	type EngineDecorator,
	EngineDecoratorNoop,
	ExecutorApp,
	type ExecutorDbHandle,
	type FailureRenderingStrategy,
	HostConfig,
	type HostConfigShape,
	type IdentityFailure,
	IdentityProvider,
	type IdentityProviderShape,
	type McpProviders,
	PluginsProvider,
	textFailureStrategy,
} from "@executor-js/api/server";
import { makeR2BlobStore } from "@executor-js/cloudflare/blob-store";
import type { AnyPlugin } from "@executor-js/sdk";
import { Effect, Layer } from "effect";

export interface HarnessyEnginePluginRequestContext {
	readonly mcpResource?: { readonly kind: "default" } | { readonly kind: "toolkit"; readonly slug: string };
}

export type HarnessyEngineRouteExtension = NonNullable<AppExtensions["routes"]>[number];

/**
 * Caller-owned Better Auth settings recorded with the Harnessy host config.
 * Harnessy does not instantiate Better Auth or consume these values.
 */
export interface HarnessyEngineBetterAuthHostMetadata {
	readonly baseURL: string;
	readonly secret: string;
}

interface HarnessyEngineAuthRoutes<Env> {
	readonly betterAuth?: HarnessyEngineBetterAuthHostMetadata;
	readonly routes?: (env: Env) => ReadonlyArray<HarnessyEngineRouteExtension>;
}

export type HarnessyEngineAuthConfig<Env, RIdentity = never> =
	| (HarnessyEngineAuthRoutes<Env> & {
			readonly kind: "provider";
			readonly provider: (env: Env) => IdentityProviderShape;
	  })
	| (HarnessyEngineAuthRoutes<Env> & {
			readonly kind: "layer";
			readonly layer: (env: Env) => Layer.Layer<IdentityProvider, never, RIdentity>;
	  });

export type HarnessyEnginePostgresConfig<Env, RDb = never> =
	| {
			readonly kind: "acquire";
			readonly acquire: (env: Env) => Effect.Effect<ExecutorDbHandle>;
	  }
	| {
			readonly kind: "layer";
			readonly layer: (env: Env) => Layer.Layer<DbProvider, never, RDb>;
	  };

export type HarnessyEngineR2Bucket = Parameters<typeof makeR2BlobStore>[0];

export interface HarnessyEngineR2Config<Env> {
	readonly bucket: (env: Env) => HarnessyEngineR2Bucket;
}

export interface HarnessyEnginePluginConfig<Env, TPlugins extends readonly AnyPlugin[]> {
	readonly api: TPlugins;
	readonly forRequest?: (env: Env, context?: HarnessyEnginePluginRequestContext) => TPlugins;
}

export interface HarnessyEngineWorkerConfig<
	Env,
	TPlugins extends readonly AnyPlugin[],
	RDb = never,
	RAcct = never,
	RStrategy = never,
	RBoot = never,
	RReq = never,
	RIdentity = never,
	RMcpAuth = never,
	McpExport = undefined,
> {
	readonly auth: HarnessyEngineAuthConfig<Env, RIdentity>;
	readonly postgres: HarnessyEnginePostgresConfig<Env, RDb>;
	readonly r2?: HarnessyEngineR2Config<Env>;
	readonly plugins: HarnessyEnginePluginConfig<Env, TPlugins>;
	readonly codeExecutor: CodeExecutor | ((env: Env) => CodeExecutor);
	readonly decorator?: Layer.Layer<EngineDecorator, never, RDb>;
	readonly host?: Omit<HostConfigShape, "oauthCallbackPath">;
	readonly failure?: FailureRenderingStrategy<IdentityFailure, RStrategy>;
	readonly errorCapture?: CommonProviders<RAcct>["errorCapture"];
	readonly account?: CommonProviders<RAcct>["account"];
	readonly mcp?: McpProviders<RMcpAuth>;
	readonly extensions?: (env: Env) => AppExtensions;
	readonly boot?: Layer.Layer<RBoot>;
	readonly requestScoped?: Layer.Layer<RReq>;
	readonly mountPrefix?: `/${string}`;
	readonly mcpExport?: McpExport;
}

export interface HarnessyEngineWorker<Env, McpExport> {
	readonly fetch: (request: Request, env: Env, context: ExecutionContext) => Promise<Response>;
	readonly dispose: () => Promise<void>;
	readonly mcpExport: McpExport;
}

export const makeHarnessyEngineWorker = <
	Env,
	const TPlugins extends readonly AnyPlugin[],
	RDb = never,
	RAcct = never,
	RStrategy = never,
	RBoot = never,
	RReq = never,
	RIdentity = never,
	RMcpAuth = never,
	McpExport = undefined,
>(
	config: HarnessyEngineWorkerConfig<
		Env,
		TPlugins,
		RDb,
		RAcct,
		RStrategy,
		RBoot,
		RReq,
		RIdentity,
		RMcpAuth,
		McpExport
	>,
): HarnessyEngineWorker<Env, McpExport> => {
	if (config.postgres.kind === "layer" && config.r2) {
		throw new TypeError(
			"Harnessy engine cannot attach R2 to an injected Postgres layer; attach blobs to that layer's database handle.",
		);
	}

	let webHandler:
		| {
				readonly handler: (request: Request) => Promise<Response>;
				readonly dispose: () => Promise<void>;
		  }
		| undefined;
	let initialization: Promise<typeof webHandler> | undefined;
	let disposed = false;

	const initialize = async (env: Env): Promise<NonNullable<typeof webHandler>> => {
		if (webHandler) return webHandler;
		if (disposed) throw new Error("Harnessy engine Worker has been disposed.");

		const identityLayer =
			config.auth.kind === "provider"
				? Layer.succeed(IdentityProvider)(config.auth.provider(env))
				: config.auth.layer(env);
		const databaseLayer =
			config.postgres.kind === "acquire"
				? dbProviderLayer(
						config.postgres
							.acquire(env)
							.pipe(
								Effect.map((handle) =>
									config.r2 ? { ...handle, blobs: makeR2BlobStore(config.r2.bucket(env)) } : handle,
								),
							),
					)
				: config.postgres.layer(env);
		const databaseProjection = Layer.effect(DbProvider)(DbProvider);
		const requestScoped = (
			config.requestScoped ? Layer.merge(databaseLayer, config.requestScoped) : databaseLayer
		) as Layer.Layer<DbProvider | RReq>;
		const pluginsLayer = Layer.succeed(PluginsProvider)({
			plugins: (context) => config.plugins.forRequest?.(env, context) ?? config.plugins.api,
		});
		const hostLayer = Layer.succeed(HostConfig)({
			allowLocalNetwork: false,
			...config.host,
			oauthCallbackPath: `${config.mountPrefix ?? ""}/oauth/callback`,
		});
		const codeExecutor = typeof config.codeExecutor === "function" ? config.codeExecutor(env) : config.codeExecutor;
		const codeLayer = Layer.succeed(CodeExecutorProvider)(codeExecutor);
		const boot: Layer.Layer<RBoot> = config.boot ?? (Layer.empty as Layer.Layer<RBoot>);
		const configuredExtensions = config.extensions?.(env).routes ?? [];
		const authRoutes = config.auth.routes?.(env) ?? [];

		const harnessyApp = ExecutorApp.make({
			plugins: config.plugins.api,
			providers: {
				identity: identityLayer,
				account: config.account,
				mcp: config.mcp,
				errorCapture: config.errorCapture ?? consoleErrorCapture("harnessy-engine"),
				db: databaseProjection,
				engine: {
					codeExecutor: codeLayer,
					decorator: (config.decorator ?? EngineDecoratorNoop) as Layer.Layer<EngineDecorator>,
				},
				plugins: {
					provider: pluginsLayer,
					config: hostLayer,
				},
			},
			extensions: { routes: [...configuredExtensions, ...authRoutes] },
			config: {
				mountPrefix: config.mountPrefix,
				failure: config.failure ?? textFailureStrategy,
				mcpExport: config.mcpExport,
			},
			boot,
			requestScoped,
		});

		webHandler = harnessyApp.toWebHandler();
		return webHandler;
	};

	return {
		fetch: async (request, env, context) => {
			void context;
			if (!initialization) initialization = initialize(env);
			const current = await initialization;
			if (!current) throw new Error("Harnessy engine Worker initialization failed.");
			return current.handler(request);
		},
		dispose: async () => {
			disposed = true;
			const current = webHandler ?? (initialization ? await initialization : undefined);
			webHandler = undefined;
			initialization = undefined;
			await current?.dispose();
		},
		mcpExport: config.mcpExport as McpExport,
	};
};
