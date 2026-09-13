import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Effect } from "effect";

/** Synthetic authorization server. Every address is numeric loopback; no credentials are discovered. */
export const meetingOAuthWire = Effect.gen(function* () {
	const requests: Array<{ path: string; body: string }> = [];
	const codes = new Map<string, { challenge: string; redirect: string; client: string }>();
	const tokens = new Set<string>();
	let origin = "";
	const controls = { beforeTokenResponse: async () => {} };
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", origin);
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString("utf8");
		requests.push({ path: url.pathname, body });
		response.setHeader("content-type", "application/json");
		response.setHeader("connection", "close");
		if (url.pathname.startsWith("/.well-known/")) {
			response.end(
				JSON.stringify({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					scopes_supported: ["https://www.googleapis.com/auth/drive.file"],
				}),
			);
			return;
		}
		if (url.pathname === "/authorize") {
			const code = randomUUID();
			const redirect = url.searchParams.get("redirect_uri") ?? "";
			codes.set(code, {
				redirect,
				challenge: url.searchParams.get("code_challenge") ?? "",
				client: url.searchParams.get("client_id") ?? "",
			});
			const callback = new URL(redirect);
			callback.searchParams.set("code", code);
			callback.searchParams.set("state", url.searchParams.get("state") ?? "");
			response.writeHead(302, { location: callback.href });
			response.end();
			return;
		}
		if (url.pathname === "/token") {
			const params = new URLSearchParams(body);
			const code = params.get("code") ?? "";
			const expected = codes.get(code);
			const verifier = createHash("sha256")
				.update(params.get("code_verifier") ?? "")
				.digest("base64url");
			if (
				!expected ||
				expected.challenge !== verifier ||
				expected.redirect !== params.get("redirect_uri") ||
				expected.client !== params.get("client_id") ||
				params.get("client_secret") !== "test-secret"
			) {
				response.statusCode = 400;
				response.end(JSON.stringify({ error: "invalid_grant", error_description: "PRIVATE_TOKEN_RESPONSE" }));
				return;
			}
			codes.delete(code);
			const accessToken = `at_${randomUUID()}`;
			tokens.add(accessToken);
			await controls.beforeTokenResponse();
			response.end(
				JSON.stringify({
					access_token: accessToken,
					refresh_token: `rt_${randomUUID()}`,
					token_type: "Bearer",
					expires_in: 3600,
					scope: "https://www.googleapis.com/auth/drive.file",
				}),
			);
			return;
		}
		response.statusCode = 404;
		response.end("{}");
	});
	yield* Effect.acquireRelease(
		Effect.promise(
			() =>
				new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", resolve);
				}),
		),
		() =>
			Effect.promise(
				() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
			),
	);
	const address = server.address();
	if (address === null || typeof address === "string") return yield* Effect.die("fixture address unavailable");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		authorizationEndpoint: `${origin}/authorize`,
		tokenEndpoint: `${origin}/token`,
		controls,
		requests: Effect.sync(() => [...requests]),
		clearRequests: Effect.sync(() => {
			requests.length = 0;
		}),
		acceptsAuthorizationHeader: (value: string | undefined) =>
			Effect.sync(() => tokens.has(value?.replace(/^Bearer /u, "") ?? "")),
		completeAuthorizationCodeFlow: ({ authorizationUrl }: { authorizationUrl: string }) =>
			Effect.promise(async () => {
				const response = await fetch(authorizationUrl, { redirect: "manual" });
				const callback = new URL(response.headers.get("location") ?? "");
				await response.arrayBuffer();
				return { state: callback.searchParams.get("state") ?? "", code: callback.searchParams.get("code") ?? "" };
			}),
	};
});
