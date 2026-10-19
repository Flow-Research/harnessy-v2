/** The OpenAPI 3.1 document of the portal API, built from the route table and the Core schemas. */
import { PORTAL_SCHEMA_VERSION, PortalApiSchemas } from "@harnessy/core/read-model";

import type { PortalRoute } from "./routes.ts";

/** TypeBox schemas are JSON Schema; a JSON round trip drops TypeBox's own symbol keys. */
const jsonSchema = (schema: unknown): unknown => JSON.parse(JSON.stringify(schema)) as unknown;

const errorResponse = (description: string) => ({
	description,
	content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

export const buildPortalOpenApi = (routes: ReadonlyArray<PortalRoute>, version: string): Record<string, unknown> => {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const route of routes) {
		const security =
			route.auth === "install"
				? [{ installProof: [] }]
				: route.auth === "read"
					? [{ bearer: [] }, { installProof: [] }]
					: undefined;
		const field = route.auth === "code" ? "code" : route.auth === "challenge" ? "nonce" : undefined;
		const responses: Record<string, unknown> = {
			"200": {
				description: route.summary,
				content: {
					"application/json": {
						schema: route.schema === null ? { type: "object" } : { $ref: `#/components/schemas/${route.schema}` },
					},
				},
			},
			"400": errorResponse("Wrong Host header or request shape"),
			"403": errorResponse("Cross-origin request"),
		};
		if (security !== undefined || route.auth === "code")
			responses["401"] = errorResponse("Missing or invalid credential");
		if (route.params !== undefined) responses["404"] = errorResponse("A path parameter does not match its pattern");
		paths[route.path] = {
			...paths[route.path],
			[route.method.toLowerCase()]: {
				operationId: route.operationId,
				summary: route.summary,
				...(security === undefined ? {} : { security }),
				...(route.params === undefined
					? {}
					: {
							parameters: Object.entries(route.params).map(([name, param]) => ({
								name,
								in: "path",
								required: true,
								description: param.description,
								example: param.example,
								schema: { type: "string", pattern: param.pattern },
							})),
						}),
				...(field !== undefined
					? {
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: {
											type: "object",
											properties: { [field]: { type: "string", minLength: 43, maxLength: 43 } },
											required: [field],
											additionalProperties: false,
										},
									},
								},
							},
						}
					: {}),
				responses,
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Harnessy portal API",
			version,
			description:
				"Read-only local portal API. Loopback only. It never publishes, approves, consumes grants or signs. " +
				`Response schema version ${PORTAL_SCHEMA_VERSION}.`,
		},
		servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "8790" } } }],
		paths,
		components: {
			securitySchemes: {
				bearer: { type: "http", scheme: "bearer", description: "A read-only page token from /v1/session/exchange" },
				installProof: {
					type: "apiKey",
					in: "header",
					name: "Authorization",
					description:
						"HarnessyProof <challenge>.<HMAC-SHA256(install token, client-proof label, challenge, origin, method, path)>; " +
						"the install token itself is never sent",
				},
			},
			schemas: Object.fromEntries(
				Object.entries(PortalApiSchemas).map(([name, schema]) => [name, jsonSchema(schema)]),
			),
		},
	};
};
