import { createServer, type Server } from "node:http";
import { describe, expect, it } from "@effect/vitest";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import {
	AuthTemplateSlug,
	ConnectionName,
	type CredentialProvider,
	createExecutor,
	Effect,
	IntegrationSlug,
	ProviderItemId,
	ProviderKey,
	Tenant,
	ToolAddress,
} from "@executor-js/sdk/core";

interface SmokeServer {
	readonly baseUrl: string;
	readonly server: Server;
}

const serveGreetingApi = Effect.acquireRelease(
	Effect.callback<SmokeServer, Error>((resume) => {
		const server = createServer((request, response) => {
			if (request.method === "GET" && request.url === "/hello") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ message: "hello from one Effect runtime" }));
				return;
			}

			response.writeHead(404).end();
		});

		server.once("error", (error) => resume(Effect.fail(error)));
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				resume(Effect.fail(new Error("smoke server did not bind a TCP address")));
				return;
			}
			resume(
				Effect.succeed({
					baseUrl: `http://127.0.0.1:${address.port}`,
					server,
				}),
			);
		});
	}),
	({ server }) =>
		Effect.callback<void, Error>((resume) => {
			server.close((error) => resume(error ? Effect.fail(error) : Effect.void));
		}).pipe(Effect.orDie),
);

const makeCredentialProvider = (): CredentialProvider => {
	const values = new Map<string, string>();
	return {
		key: ProviderKey.make("smoke-memory"),
		writable: true,
		get: (id) => Effect.succeed(values.get(String(id)) ?? null),
		set: (id, value) => Effect.sync(() => void values.set(String(id), value)),
		delete: (id) => Effect.sync(() => void values.delete(String(id))),
		list: () => Effect.succeed([...values.keys()].map((id) => ({ id: ProviderItemId.make(id), name: id }))),
	};
};

const openApiDocument = (baseUrl: string) =>
	JSON.stringify({
		openapi: "3.1.0",
		info: { title: "Harnessy Engine Smoke", version: "1.0.0" },
		servers: [{ url: baseUrl }],
		paths: {
			"/hello": {
				get: {
					operationId: "getGreeting",
					tags: ["greetings"],
					responses: {
						"200": {
							description: "Greeting",
							content: {
								"application/json": {
									schema: {
										type: "object",
										properties: { message: { type: "string" } },
										required: ["message"],
									},
								},
							},
						},
					},
				},
			},
		},
	});

describe("vendored Executor composition", () => {
	it.effect("registers, lists, and invokes an OpenAPI tool on the Harnessy Effect runtime", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { baseUrl } = yield* serveGreetingApi;
				const executor = yield* Effect.acquireRelease(
					createExecutor({
						tenant: Tenant.make("harnessy-engine-smoke"),
						plugins: [openApiPlugin()] as const,
						providers: [makeCredentialProvider()],
						onElicitation: "accept-all",
					}),
					(executor) => executor.close().pipe(Effect.orDie),
				);

				yield* executor.openapi.addSpec({
					slug: "smoke",
					authenticationTemplate: [],
					spec: { kind: "blob", value: openApiDocument(baseUrl) },
				});
				yield* executor.connections.create({
					owner: "org",
					name: ConnectionName.make("main"),
					integration: IntegrationSlug.make("smoke"),
					template: AuthTemplateSlug.make("none"),
					values: {},
				});

				const tools = yield* executor.tools.list({ integration: IntegrationSlug.make("smoke") });
				expect(tools.map((tool) => String(tool.name))).toContain("greetings.getGreeting");

				const result = yield* executor.execute(ToolAddress.make("tools.smoke.org.main.greetings.getGreeting"), {});
				expect(result).toMatchObject({
					ok: true,
					data: { message: "hello from one Effect runtime" },
				});
			}),
		),
	);
});
