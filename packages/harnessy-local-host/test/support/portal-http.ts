/** Raw loopback HTTP for portal tests: every header, including Host, is under the test's control. */
import { request } from "node:http";

import { portalClientProofHeader } from "../../src/portal/auth.ts";
import { newPortalSecret } from "../../src/portal/token-store.ts";

export interface RawResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly text: string;
	readonly json: unknown;
}

export interface RawRequest {
	readonly method?: string;
	readonly path: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	/** Send the Host header the server expects (default true). */
	readonly host?: boolean;
	/** Send the body with chunked transfer encoding and no Content-Length. */
	readonly chunked?: boolean;
}

export const rawRequest = (port: number, options: RawRequest): Promise<RawResponse> =>
	new Promise((resolveRequest, rejectRequest) => {
		const outgoing = request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path,
				setHost: false,
				headers: {
					...(options.host === false ? {} : { Host: `127.0.0.1:${port}` }),
					...(options.body === undefined
						? {}
						: options.chunked === true
							? { "Transfer-Encoding": "chunked" }
							: { "Content-Length": String(Buffer.byteLength(options.body)) }),
					...options.headers,
				},
			},
			(incoming) => {
				const chunks: Buffer[] = [];
				incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
				incoming.on("end", () => {
					const text = Buffer.concat(chunks).toString("utf8");
					let json: unknown;
					try {
						json = JSON.parse(text);
					} catch {
						json = undefined;
					}
					resolveRequest({ status: incoming.statusCode ?? 0, headers: incoming.headers, text, json });
				});
			},
		);
		outgoing.on("error", rejectRequest);
		if (options.body !== undefined) outgoing.write(options.body);
		outgoing.end();
	});

export const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/**
 * An install-token proof header for one request, made the way the CLI makes it:
 * a fresh challenge from the server, then an HMAC over challenge, origin, method and path.
 */
export const installProof = async (
	port: number,
	token: string,
	method: string,
	path: string,
): Promise<Record<string, string>> => {
	const issued = await rawRequest(port, {
		method: "POST",
		path: "/v1/session/challenge",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ nonce: newPortalSecret() }),
	});
	const { challenge } = issued.json as { challenge: string };
	return { Authorization: portalClientProofHeader(token, challenge, `http://127.0.0.1:${port}`, method, path) };
};
