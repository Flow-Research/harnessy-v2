/** The portal API route table. The server and the OpenAPI document are both built from it. */
import type { PortalApiSchemaName } from "@harnessy/core/read-model";

import type { PortalSources } from "./sources.ts";

/**
 * `none`: open. `challenge`: open; returns a single-use challenge and the server's proof.
 * `install`: a client proof made with the install token from `portal.token` (the token itself
 * is never sent). `code`: a one-time code and the exact portal Origin.
 * `read`: a page token or a client proof.
 */
export type PortalRouteAuth = "none" | "challenge" | "install" | "code" | "read";

export interface PortalRoute {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly operationId: string;
	readonly summary: string;
	readonly auth: PortalRouteAuth;
	/** The response schema; `null` for the OpenAPI document itself. */
	readonly schema: PortalApiSchemaName | null;
	/** For a data route: the response name and the source that fills its tiles. */
	readonly data?: { readonly name: string; readonly source: keyof PortalSources };
}

export const PORTAL_ROUTES: ReadonlyArray<PortalRoute> = [
	{
		method: "GET",
		path: "/v1/healthz",
		operationId: "getHealthz",
		summary: "Liveness and version",
		auth: "none",
		schema: "Healthz",
	},
	{
		method: "GET",
		path: "/v1/openapi.json",
		operationId: "getOpenApi",
		summary: "This OpenAPI document",
		auth: "none",
		schema: null,
	},
	{
		method: "POST",
		path: "/v1/session/challenge",
		operationId: "createSessionChallenge",
		summary: "Get a single-use challenge (60 s) and the server's proof that it holds the install token",
		auth: "challenge",
		schema: "SessionChallenge",
	},
	{
		method: "POST",
		path: "/v1/session/code",
		operationId: "createSessionCode",
		summary: "Mint a one-time code (60 s, single use) with an install-token proof",
		auth: "install",
		schema: "SessionCode",
	},
	{
		method: "POST",
		path: "/v1/session/exchange",
		operationId: "exchangeSessionCode",
		summary: "Exchange a one-time code for a read-only page token (8 h)",
		auth: "code",
		schema: "SessionExchange",
	},
	{
		method: "GET",
		path: "/v1/today",
		operationId: "getToday",
		summary: "Life brief, readings, weekly runs and what waits for you",
		auth: "read",
		schema: "Today",
		data: { name: "today", source: "today" },
	},
	{
		method: "GET",
		path: "/v1/health",
		operationId: "getHealth",
		summary: "Service state from launchd",
		auth: "read",
		schema: "Health",
		data: { name: "health", source: "health" },
	},
	{
		method: "GET",
		path: "/v1/connections",
		operationId: "getConnections",
		summary: "Connection status and the owning service for each credential",
		auth: "read",
		schema: "Connections",
		data: { name: "connections", source: "connections" },
	},
	{
		method: "GET",
		path: "/v1/meetings/summary",
		operationId: "getMeetingsSummary",
		summary: "Meeting publication queue, provider health and Fathom",
		auth: "read",
		schema: "Meetings",
		data: { name: "meetings", source: "meetings" },
	},
	{
		method: "GET",
		path: "/v1/community/summary",
		operationId: "getCommunitySummary",
		summary: "Community briefing configuration and queue",
		auth: "read",
		schema: "Community",
		data: { name: "community", source: "community" },
	},
	{
		method: "GET",
		path: "/v1/learning/summary",
		operationId: "getLearningSummary",
		summary: "Learning library catalog counts",
		auth: "read",
		schema: "Learning",
		data: { name: "learning", source: "learning" },
	},
	{
		method: "GET",
		path: "/v1/workspace/summary",
		operationId: "getWorkspaceSummary",
		summary: "Registered workspace, doctor issues and skill count",
		auth: "read",
		schema: "Workspace",
		data: { name: "workspace", source: "workspace" },
	},
];
