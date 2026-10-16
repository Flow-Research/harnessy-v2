import { type CodeExecutor, defaultMcpResource, Effect, type ExecutorDbHandle, Unauthorized } from "@harnessy/engine";
import {
	type BuiltMcpServer,
	type HarnessyEngineR2Bucket,
	McpAgentSessionDOBase,
	type McpSessionInit,
	makeHarnessyEngineWorker,
	type SessionDbHandle,
	type SessionMeta,
} from "@harnessy/engine/cloudflare";

interface Env {
	readonly HARNESSY_ENGINE_BLOBS: HarnessyEngineR2Bucket;
}

const codeExecutor: CodeExecutor = {
	execute: () => Effect.succeed({ result: null, output: [], logs: [] }),
};

const fakePostgresHandle = (): ExecutorDbHandle => ({
	db: {} as ExecutorDbHandle["db"],
	fuma: {} as ExecutorDbHandle["fuma"],
	close: async () => {},
});

export class HarnessyEngineMcpSession extends McpAgentSessionDOBase<Env, SessionDbHandle> {
	protected openSessionDb(): SessionDbHandle {
		return { end: async () => {} };
	}

	protected resolveSessionMeta(token: McpSessionInit): Effect.Effect<SessionMeta> {
		return Effect.succeed({
			organizationId: token.organizationId,
			organizationName: "Harnessy fixture",
			userId: token.userId,
			resource: token.resource ?? defaultMcpResource,
		});
	}

	protected buildMcpServer(): Effect.Effect<BuiltMcpServer> {
		return Effect.die("Harnessy engine fixture does not run an MCP server during dry-run");
	}
}

const worker = makeHarnessyEngineWorker({
	auth: {
		kind: "provider",
		betterAuth: {
			baseURL: "https://garden.example.com/api/auth",
			secret: "fixture-host-owned-secret",
		},
		provider: () => ({
			authenticate: (request) =>
				request.headers.has("authorization")
					? Effect.succeed({
							accountId: "fixture-account",
							organizationId: "fixture-organization",
							organizationName: "Harnessy fixture",
							email: "fixture@example.com",
							name: "Harnessy fixture",
							avatarUrl: null,
							roles: [],
						})
					: Effect.fail(new Unauthorized({})),
		}),
	},
	postgres: {
		kind: "acquire",
		acquire: () => Effect.succeed(fakePostgresHandle()),
	},
	r2: {
		bucket: (env: Env) => env.HARNESSY_ENGINE_BLOBS,
	},
	plugins: { api: [] as const },
	codeExecutor,
	mountPrefix: "/api",
	mcpExport: HarnessyEngineMcpSession,
});

export default worker;
