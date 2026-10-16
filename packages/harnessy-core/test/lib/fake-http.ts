import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

/**
 * A recording, in-memory {@link HttpClient} for deterministic tests.
 *
 * Mirrors the fake-spawner pattern: swap the real HTTP client for one that
 * records every request and returns canned JSON, so connector tests never need
 * a live server (or AnyType desktop app) and never hit the network.
 */
export interface RecordedRequest {
	readonly url: string;
	readonly method: string;
	readonly headers: Readonly<Record<string, string | undefined>>;
	/** Decoded request body text, when the request carried one. */
	readonly body: string | undefined;
}

/** Best-effort decode of an HttpClientRequest body into text for assertions. */
const decodeBody = (body: unknown): string | undefined => {
	if (body && typeof body === "object" && "body" in body) {
		const raw = (body as { readonly body: unknown }).body;
		if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
		if (typeof raw === "string") return raw;
	}
	return undefined;
};

/** Canned response for a single request. */
export interface FakeHttpResponse {
	/** HTTP status to return. Defaults to 200. */
	readonly status?: number;
	/** JSON body to return. */
	readonly body?: unknown;
	/** Response headers, such as Retry-After. */
	readonly headers?: Readonly<Record<string, string>>;
}

export interface FakeHttp {
	/** Layer providing the recording client in place of the real platform one. */
	readonly layer: Layer.Layer<HttpClient.HttpClient>;
	/** Requests recorded so far, in order. */
	readonly calls: ReadonlyArray<RecordedRequest>;
}

/**
 * Build a recording fake HTTP client.
 *
 * @param handler maps each recorded request to a canned response (default: 200, empty object).
 */
export const makeFakeHttp = (handler: (request: RecordedRequest) => FakeHttpResponse = () => ({})): FakeHttp => {
	const calls: Array<RecordedRequest> = [];
	const client = HttpClient.make((request) => {
		const recorded: RecordedRequest = {
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: decodeBody(request.body),
		};
		calls.push(recorded);
		const response = handler(recorded);
		const web = new Response(JSON.stringify(response.body ?? {}), {
			status: response.status ?? 200,
			headers: { "content-type": "application/json", ...response.headers },
		});
		return Effect.succeed(HttpClientResponse.fromWeb(request, web));
	});
	return {
		layer: Layer.succeed(HttpClient.HttpClient, client),
		get calls() {
			return calls;
		},
	};
};
