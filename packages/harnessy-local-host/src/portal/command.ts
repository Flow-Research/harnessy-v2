/**
 * `harnessy-portal` commands: `serve`, `status`, `open` and `service-plan`.
 *
 * `service-plan` prints the LaunchAgent and installs nothing. The default state
 * directory (`~/.harnessy/portal`) is never created here; a state directory is
 * created only when it is named with `--state-dir` or `HARNESSY_PORTAL_STATE_DIR`.
 */
import { request } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_READ_TIMEOUT_MS, type LaunchdProbe } from "@harnessy/core/read-model";
import * as Result from "effect/Result";

import { isPortalServerProof, portalClientProofHeader } from "./auth.ts";
import { renderPortalLaunchAgent } from "./launchd-plan.ts";
import { PORTAL_DEFAULT_PORT, PORTAL_HOST, type PortalServer, startPortalServer } from "./server.ts";
import { createPortalSources } from "./sources.ts";
import {
	newPortalSecret,
	PortalStateError,
	preparePortalStateDir,
	readOrCreatePortalInstallToken,
	readPortalInstallToken,
} from "./token-store.ts";

export const PORTAL_USAGE =
	"harnessy-portal serve [--port N] [--state-dir DIR] [--home-root DIR] [--workspace-root DIR] | " +
	"status [--port N] [--state-dir DIR] | open [--port N] [--state-dir DIR] [--print] | " +
	"service-plan [--port N] [--state-dir DIR]";

const OPTIONS = {
	port: { type: "string" },
	"state-dir": { type: "string" },
	"home-root": { type: "string" },
	"workspace-root": { type: "string" },
	host: { type: "string" },
	print: { type: "boolean" },
} as const;

export interface PortalCommandIo {
	readonly env: NodeJS.ProcessEnv;
	readonly homeDir: string;
	readonly write: (text: string) => void;
	readonly version: string;
	/** The installed `portal-cli.js`, for `service-plan`. */
	readonly cliPath: string;
	readonly nodePath: string;
	readonly probe: LaunchdProbe;
	/** Open a URL in the browser (`open` without `--print`). */
	readonly openUrl: (url: string) => void;
	/** Time limit for one request to the portal (default 5 s). */
	readonly requestTimeoutMs?: number;
}

export type PortalCommandResult =
	| { readonly kind: "done" }
	| { readonly kind: "serving"; readonly server: PortalServer };

const fail = (code: string): never => {
	throw new PortalStateError(code);
};

const parsePort = (value: string | undefined, allowEphemeral: boolean): number => {
	if (value === undefined) return PORTAL_DEFAULT_PORT;
	const port = /^\d{1,5}$/u.test(value) ? Number(value) : Number.NaN;
	if (!(port >= (allowEphemeral ? 0 : 1) && port <= 65_535)) fail("invalid_port");
	return port;
};

const absolute = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined;
	if (resolve(value) !== value) fail("path_not_absolute");
	return value;
};

interface ClientResponse {
	readonly status: number;
	readonly body: unknown;
}

/** One request to the local portal. The response body is read up to 1 MiB. */
const send = (
	port: number,
	method: "GET" | "POST",
	path: string,
	headers: Readonly<Record<string, string>>,
	body: string,
	timeoutMs: number,
): Promise<ClientResponse> =>
	new Promise((resolveCall, rejectCall) => {
		const outgoing = request(
			{
				host: PORTAL_HOST,
				port,
				method,
				path,
				timeout: timeoutMs,
				headers: { ...headers, Host: `${PORTAL_HOST}:${port}`, "Content-Length": String(Buffer.byteLength(body)) },
			},
			(incoming) => {
				const chunks: Buffer[] = [];
				let size = 0;
				incoming.on("data", (chunk: Buffer) => {
					size += chunk.byteLength;
					if (size <= 1024 * 1024) chunks.push(chunk);
				});
				incoming.on("end", () => {
					try {
						resolveCall({
							status: incoming.statusCode!,
							body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
						});
					} catch {
						rejectCall(new PortalStateError("portal_response_invalid"));
					}
				});
			},
		);
		outgoing.on("timeout", () => outgoing.destroy());
		outgoing.on("error", () => rejectCall(new PortalStateError("portal_unreachable")));
		outgoing.end(body);
	});

const expectOk = (response: ClientResponse): unknown => {
	if (response.status !== 200) fail(response.status === 401 ? "portal_unauthorized" : "portal_request_failed");
	return response.body;
};

/**
 * One request made with the install token, which is never sent. The listener must first prove,
 * for a fresh nonce and this exact origin, that it holds the token; only then does the client send
 * a single-use proof for this method and path. A process that merely holds the port learns nothing reusable.
 */
const callWithInstallProof = async (
	port: number,
	token: string,
	method: "GET" | "POST",
	path: string,
	timeoutMs: number,
): Promise<unknown> => {
	const origin = `http://${PORTAL_HOST}:${port}`;
	const nonce = newPortalSecret();
	const issued = expectOk(
		await send(
			port,
			"POST",
			"/v1/session/challenge",
			{ "Content-Type": "application/json" },
			JSON.stringify({ nonce }),
			timeoutMs,
		),
	) as { readonly challenge?: unknown; readonly proof?: unknown } | null;
	const challenge = issued?.challenge;
	const proof = issued?.proof;
	if (
		typeof challenge !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/u.test(challenge) ||
		typeof proof !== "string" ||
		!isPortalServerProof(token, nonce, challenge, origin, proof)
	)
		fail("portal_unverified");
	const header = portalClientProofHeader(token, challenge as string, origin, method, path);
	return expectOk(await send(port, method, path, { Authorization: header }, "", timeoutMs));
};

export const runPortalCommand = async (
	args: ReadonlyArray<string>,
	io: PortalCommandIo,
): Promise<PortalCommandResult> => {
	const parsed = Result.try(() =>
		parseArgs({ args: [...args], allowPositionals: true, strict: true, options: OPTIONS }),
	);
	if (Result.isFailure(parsed)) return fail("invalid_arguments");
	const { values, positionals } = parsed.success;
	const [command, ...extra] = positionals;
	if (command === undefined || extra.length > 0) return fail("invalid_command");
	const only = (allowed: ReadonlyArray<string>) => {
		for (const key of Object.keys(values)) if (!allowed.includes(key)) fail("invalid_arguments");
	};
	const explicitStateDir = absolute(values["state-dir"]) ?? absolute(io.env.HARNESSY_PORTAL_STATE_DIR || undefined);
	const stateDir = explicitStateDir ?? join(io.homeDir, ".harnessy", "portal");
	const timeoutMs = io.requestTimeoutMs ?? 5_000;

	switch (command) {
		case "serve": {
			only(["port", "state-dir", "home-root", "workspace-root", "host"]);
			if (values.host !== undefined && values.host !== PORTAL_HOST) fail("host_refused");
			const port = parsePort(values.port, true);
			const root = preparePortalStateDir(stateDir, { create: explicitStateDir !== undefined });
			const installToken = readOrCreatePortalInstallToken(root);
			const workspaceRoot = absolute(values["workspace-root"]);
			const sources = createPortalSources({
				homeRoot: absolute(values["home-root"]) ?? io.homeDir,
				...(workspaceRoot === undefined ? {} : { workspaceRoot }),
				env: io.env,
				probe: io.probe,
				timeoutMs: DEFAULT_READ_TIMEOUT_MS,
				clock: () => new Date(),
			});
			const server = await startPortalServer({
				installToken,
				sources,
				version: io.version,
				port,
				log: (entry) => io.write(`${JSON.stringify(entry)}\n`),
			});
			return { kind: "serving", server };
		}
		case "status": {
			only(["port", "state-dir"]);
			const port = parsePort(values.port, false);
			const token = readPortalInstallToken(stateDir);
			const healthz = expectOk(await send(port, "GET", "/v1/healthz", {}, "", timeoutMs));
			const health = await callWithInstallProof(port, token, "GET", "/v1/health", timeoutMs);
			io.write(`${JSON.stringify({ ok: true, port, healthz, health }, null, 2)}\n`);
			return { kind: "done" };
		}
		case "open": {
			only(["port", "state-dir", "print"]);
			const port = parsePort(values.port, false);
			const token = readPortalInstallToken(stateDir);
			const body = (await callWithInstallProof(port, token, "POST", "/v1/session/code", timeoutMs)) as {
				readonly code: string;
			};
			// A fragment never reaches a server or a log.
			const url = `http://${PORTAL_HOST}:${port}/#code=${body.code}`;
			if (values.print === true) io.write(`${url}\n`);
			else io.openUrl(url);
			return { kind: "done" };
		}
		case "service-plan": {
			only(["port", "state-dir"]);
			io.write(
				renderPortalLaunchAgent({
					nodePath: io.nodePath,
					cliPath: io.cliPath,
					port: parsePort(values.port, false),
					stateDir,
				}),
			);
			return { kind: "done" };
		}
		default:
			return fail("invalid_command");
	}
};
