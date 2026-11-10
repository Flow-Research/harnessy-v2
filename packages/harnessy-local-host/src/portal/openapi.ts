/** The OpenAPI 3.1 document of the portal API, built from the route table and the Core schemas. */
import { PORTAL_SCHEMA_VERSION, PortalApiSchemas } from "@harnessy/core/read-model";

import { FOLDER_NAME_MAX, FOLDERS_MAX, LINK_TITLE_MAX, LINK_URL_MAX, LINKS_MAX } from "./links-state.ts";
import type { PortalRoute } from "./routes.ts";

/** TypeBox schemas are JSON Schema; a JSON round trip drops TypeBox's own symbol keys. */
const jsonSchema = (schema: unknown): unknown => JSON.parse(JSON.stringify(schema)) as unknown;

const errorResponse = (description: string) => ({
	description,
	content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const LINK_ID = { type: "string", maxLength: 64 };
const LINK_PARENT = { oneOf: [LINK_ID, { type: "null" }], description: "A folder ID, or null for the top level" };

/** `GET /v1/links`: the saved tree. Sibling order is array order. */
const LINKS_TREE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["version", "folders", "links"],
	properties: {
		version: { const: 2 },
		folders: {
			type: "array",
			maxItems: FOLDERS_MAX,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "name", "parentId", "addedAt"],
				properties: {
					id: LINK_ID,
					name: { type: "string", minLength: 1, maxLength: FOLDER_NAME_MAX },
					parentId: LINK_PARENT,
					addedAt: { type: "string", format: "date-time" },
				},
			},
		},
		links: {
			type: "array",
			maxItems: LINKS_MAX,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "title", "url", "addedAt", "parentId"],
				properties: {
					id: LINK_ID,
					title: { type: "string", minLength: 1, maxLength: LINK_TITLE_MAX },
					url: { type: "string", maxLength: LINK_URL_MAX },
					addedAt: { type: "string", format: "date-time" },
					parentId: LINK_PARENT,
				},
			},
		},
	},
};

const linksAction = (action: string, properties: Record<string, unknown>, optional: string[] = []) => ({
	type: "object",
	additionalProperties: false,
	required: ["action", ...Object.keys(properties).filter((name) => !optional.includes(name))],
	properties: { action: { const: action }, ...properties },
});

/** `POST /v1/links/action`: one action per request. */
const LINKS_ACTION_SCHEMA = {
	oneOf: [
		linksAction("add", { title: { type: "string" }, url: { type: "string" }, parentId: LINK_PARENT }, ["parentId"]),
		linksAction("addFolder", { name: { type: "string" }, parentId: LINK_PARENT }),
		linksAction("rename", { id: LINK_ID, name: { type: "string" } }),
		linksAction("move", {
			id: LINK_ID,
			parentId: LINK_PARENT,
			index: { type: "integer", minimum: 0, maximum: LINKS_MAX },
		}),
		linksAction("remove", { id: LINK_ID }),
		linksAction("reorder", {
			kind: { enum: ["links", "folders"] },
			parentId: LINK_PARENT,
			ids: { type: "array", maxItems: LINKS_MAX, items: LINK_ID },
		}),
		linksAction("open", { id: LINK_ID }),
	],
};

export const buildPortalOpenApi = (routes: ReadonlyArray<PortalRoute>, version: string): Record<string, unknown> => {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const route of routes) {
		const security =
			route.auth === "install"
				? [{ installProof: [] }]
				: route.auth === "open" ||
						route.auth === "brief" ||
						route.auth === "terminal" ||
						route.auth === "weekly" ||
						route.auth === "inbox-action" ||
						route.auth === "links"
					? [{ bearer: [] }]
					: route.auth === "read"
						? [{ bearer: [] }, { installProof: [] }]
						: undefined;
		const field = route.auth === "code" ? "code" : route.auth === "challenge" ? "nonce" : undefined;
		const responses: Record<string, unknown> = {
			"200": {
				description: route.summary,
				content: {
					"application/json": {
						schema:
							route.auth === "links" && route.method === "GET"
								? LINKS_TREE_SCHEMA
								: route.schema === null
									? { type: "object" }
									: { $ref: `#/components/schemas/${route.schema}` },
					},
				},
			},
			"400": errorResponse("Wrong Host header or request shape"),
			"403": errorResponse("Cross-origin request"),
		};
		if (security !== undefined || route.auth === "code")
			responses["401"] = errorResponse("Missing or invalid credential");
		if (route.params !== undefined) responses["404"] = errorResponse("A path parameter does not match its pattern");
		if (route.auth === "open") {
			responses["409"] = errorResponse("Another view is opening");
			responses["503"] = errorResponse("The local sign-in helper could not open the view");
		}
		if (route.auth === "brief") responses["503"] = errorResponse("Daily brief generation is unavailable");
		if (route.auth === "terminal") responses["503"] = errorResponse("Interactive terminals are unavailable");
		paths[route.path] = {
			...paths[route.path],
			[route.method.toLowerCase()]: {
				operationId: route.operationId,
				summary: route.summary,
				...(route.auth === "inbox-action"
					? {
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: {
											type: "object",
											additionalProperties: false,
											required: ["action", "items"],
											properties: {
												action: { enum: ["archive", "restore"] },
												items: {
													type: "array",
													minItems: 1,
													maxItems: 100,
													items: {
														type: "object",
														additionalProperties: false,
														required: ["key", "revision"],
														properties: {
															key: { type: "string", maxLength: 500 },
															revision: { type: "string", maxLength: 16000 },
														},
													},
												},
											},
										},
									},
								},
							},
						}
					: {}),
				...(route.auth === "links" && route.method === "POST"
					? { requestBody: { required: true, content: { "application/json": { schema: LINKS_ACTION_SCHEMA } } } }
					: {}),
				...(route.auth === "weekly" && route.method === "POST"
					? {
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: {
											type: "object",
											properties: { reason: { type: "string", minLength: 1, maxLength: 200 } },
											required: ["reason"],
											additionalProperties: false,
										},
									},
								},
							},
						}
					: {}),
				...(route.auth === "terminal" && route.method === "POST"
					? {
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: {
											oneOf: [
												{
													type: "object",
													properties: { action: { const: "create" } },
													required: ["action"],
													additionalProperties: false,
												},
												{
													type: "object",
													properties: { action: { const: "close" }, id: { type: "string" } },
													required: ["action", "id"],
													additionalProperties: false,
												},
												{
													type: "object",
													properties: {
														action: { const: "input" },
														id: { type: "string" },
														data: { type: "string", description: "At most 256 UTF-8 bytes" },
													},
													required: ["action", "id", "data"],
													additionalProperties: false,
												},
												{
													type: "object",
													properties: {
														action: { const: "resize" },
														id: { type: "string" },
														cols: { type: "integer", minimum: 2, maximum: 500 },
														rows: { type: "integer", minimum: 2, maximum: 200 },
													},
													required: ["action", "id", "cols", "rows"],
													additionalProperties: false,
												},
											],
										},
									},
								},
							},
						}
					: {}),
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
				...(route.auth === "open" || (route.auth === "brief" && route.method === "POST")
					? {
							requestBody: {
								required: true,
								content: { "application/json": { schema: { type: "object", additionalProperties: false } } },
							},
						}
					: field !== undefined
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
				"Local portal API with fixed browser handoffs and daily brief generation. Loopback only. " +
				`Response schema version ${PORTAL_SCHEMA_VERSION}.`,
		},
		servers: [{ url: "http://127.0.0.1:{port}", variables: { port: { default: "8790" } } }],
		paths,
		components: {
			securitySchemes: {
				bearer: { type: "http", scheme: "bearer", description: "A page token from /v1/session/exchange" },
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
