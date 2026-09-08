import type { ToolResult as ExecutorToolResult } from "@executor-js/sdk/core";
import { ToolResult } from "@executor-js/sdk/core";
import { Cause, Duration, Effect, type Layer, Option, Schema, Stream } from "effect";
import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
	type HttpClientResponse,
	type HttpClient as HttpClientService,
} from "effect/unstable/http";

const GOOGLE_DRIVE_BASE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DOCS_BASE_URL = "https://docs.googleapis.com/v1";
const DISCORD_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MILLIS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_MARKDOWN_BYTES = 512 * 1024;
const MAX_RETRY_AFTER_SECONDS = 3_600;

export type MeetingProviderTransportConfig =
	| { readonly kind: "production" }
	| {
			readonly kind: "test-loopback";
			readonly googleDriveBaseUrl: string;
			readonly googleDocsBaseUrl: string;
			readonly discordBaseUrl: string;
			readonly timeoutMillis?: number;
			readonly maxResponseBytes?: number;
			readonly maxMarkdownBytes?: number;
	  };

export interface ResolvedMeetingProviderTransport {
	readonly googleDriveBaseUrl: string;
	readonly googleDocsBaseUrl: string;
	readonly discordBaseUrl: string;
	readonly timeoutMillis: number;
	readonly maxResponseBytes: number;
	readonly maxMarkdownBytes: number;
}

export class MeetingProviderSafeFailure extends Schema.TaggedErrorClass<MeetingProviderSafeFailure>()(
	"MeetingProviderSafeFailure",
	{
		code: Schema.String,
		status: Schema.NullOr(Schema.Number),
		retryable: Schema.Boolean,
		retryAfterSeconds: Schema.NullOr(Schema.Number),
	},
) {
	override get message(): string {
		return "Meeting publication provider operation failed.";
	}
}

const failure = (
	code: string,
	options: {
		readonly status?: number;
		readonly retryable?: boolean;
		readonly retryAfterSeconds?: number | null;
	} = {},
) =>
	new MeetingProviderSafeFailure({
		code,
		status: options.status ?? null,
		retryable: options.retryable ?? false,
		retryAfterSeconds: options.retryAfterSeconds ?? null,
	});

const boundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number) =>
	value === undefined || !Number.isSafeInteger(value) || value < minimum || value > maximum ? fallback : value;

const normalizedLoopbackOrigin = (value: string): string | null => {
	try {
		const url = new URL(value);
		if (
			url.protocol !== "http:" ||
			(url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
			url.username !== "" ||
			url.password !== "" ||
			url.search !== "" ||
			url.hash !== "" ||
			(url.pathname !== "" && url.pathname !== "/")
		) {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
};

/** Resolve immutable production endpoints or an explicitly allowlisted test-only loopback transport. */
export const resolveMeetingProviderTransport = (
	config: MeetingProviderTransportConfig = { kind: "production" },
): ResolvedMeetingProviderTransport | null => {
	if (config.kind === "production") {
		return {
			googleDriveBaseUrl: GOOGLE_DRIVE_BASE_URL,
			googleDocsBaseUrl: GOOGLE_DOCS_BASE_URL,
			discordBaseUrl: DISCORD_BASE_URL,
			timeoutMillis: DEFAULT_TIMEOUT_MILLIS,
			maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
			maxMarkdownBytes: DEFAULT_MAX_MARKDOWN_BYTES,
		};
	}
	const googleDriveBaseUrl = normalizedLoopbackOrigin(config.googleDriveBaseUrl);
	const googleDocsBaseUrl = normalizedLoopbackOrigin(config.googleDocsBaseUrl);
	const discordBaseUrl = normalizedLoopbackOrigin(config.discordBaseUrl);
	if (googleDriveBaseUrl === null || googleDocsBaseUrl === null || discordBaseUrl === null) return null;
	return {
		googleDriveBaseUrl,
		googleDocsBaseUrl,
		discordBaseUrl,
		timeoutMillis: boundedInteger(config.timeoutMillis, DEFAULT_TIMEOUT_MILLIS, 10, 60_000),
		maxResponseBytes: boundedInteger(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 128, 1024 * 1024),
		maxMarkdownBytes: boundedInteger(config.maxMarkdownBytes, DEFAULT_MAX_MARKDOWN_BYTES, 1_024, 2 * 1024 * 1024),
	};
};

export const parseRetryAfterSeconds = (value: string | undefined, nowMillis = Date.now()): number | null => {
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (/^\d+$/u.test(trimmed)) {
		const seconds = Number(trimmed);
		return Number.isFinite(seconds) ? Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, seconds)) : null;
	}
	if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:,|\s).+\sGMT$/iu.test(trimmed)) return null;
	const parsed = Date.parse(trimmed);
	if (!Number.isFinite(parsed)) return null;
	return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil((parsed - nowMillis) / 1_000)));
};

const classifyStatus = (
	status: number,
	retryAfter: string | undefined,
	bodyRetryAfter: number | null = null,
): MeetingProviderSafeFailure => {
	if (status >= 300 && status < 400) return failure("unsafe_redirect", { status });
	if (status === 401) return failure("authentication_failed", { status });
	if (status === 403) return failure("permission_denied", { status });
	if (status === 404) return failure("provider_not_found", { status });
	if (status === 408) {
		return failure("request_timeout", {
			status,
			retryable: true,
			retryAfterSeconds: parseRetryAfterSeconds(retryAfter) ?? 60,
		});
	}
	if (status === 429) {
		return failure("rate_limited", {
			status,
			retryable: true,
			retryAfterSeconds:
				bodyRetryAfter === null
					? (parseRetryAfterSeconds(retryAfter) ?? 60)
					: Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, bodyRetryAfter)),
		});
	}
	if (status >= 500) {
		return failure("provider_unavailable", {
			status,
			retryable: true,
			retryAfterSeconds: parseRetryAfterSeconds(retryAfter) ?? 60,
		});
	}
	return failure("request_rejected", { status });
};

const readBoundedText = (
	response: HttpClientResponse.HttpClientResponse,
	maxBytes: number,
): Effect.Effect<string, MeetingProviderSafeFailure> =>
	Effect.gen(function* () {
		const declared = response.headers["content-length"];
		if (declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
			return yield* failure("response_too_large", {
				retryable: true,
				retryAfterSeconds: 60,
			});
		}
		const chunks: Array<Uint8Array> = [];
		let byteLength = 0;
		yield* response.stream.pipe(
			Stream.runForEach((chunk) => {
				if (byteLength + chunk.byteLength > maxBytes) {
					return Effect.fail(failure("response_too_large", { retryable: true, retryAfterSeconds: 60 }));
				}
				return Effect.sync(() => {
					chunks.push(chunk);
					byteLength += chunk.byteLength;
				});
			}),
			Effect.mapError((cause) =>
				cause instanceof MeetingProviderSafeFailure
					? cause
					: failure("network_error", { retryable: true, retryAfterSeconds: 60 }),
			),
		);
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return yield* Effect.try({
			try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			catch: () => failure("invalid_response", { retryable: true, retryAfterSeconds: 60 }),
		});
	});

export type MeetingHttpMethod = "GET" | "POST" | "PATCH";

export interface MeetingHttpRequest<S extends Schema.Top & { readonly DecodingServices: never }> {
	readonly method: MeetingHttpMethod;
	readonly url: string;
	readonly token: string;
	readonly authScheme?: "Bearer" | "Bot";
	readonly body?: unknown;
	readonly schema: S;
	readonly transport: ResolvedMeetingProviderTransport;
	readonly httpClientLayer: Layer.Layer<HttpClientService.HttpClient>;
}

/** One bounded, no-redirect JSON request whose failure channel contains sanitized metadata only. */
export const executeMeetingJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
	input: MeetingHttpRequest<S>,
): Effect.Effect<S["Type"], MeetingProviderSafeFailure> => {
	const operation: Effect.Effect<S["Type"], MeetingProviderSafeFailure, HttpClientService.HttpClient> = Effect.gen(
		function* () {
			let request =
				input.method === "GET"
					? HttpClientRequest.get(input.url)
					: input.method === "POST"
						? HttpClientRequest.post(input.url)
						: HttpClientRequest.patch(input.url);
			request = request.pipe(
				HttpClientRequest.setHeaders({
					Accept: "application/json",
					Authorization: `${input.authScheme ?? "Bearer"} ${input.token}`,
					"User-Agent": "harnessy-meeting-publication/2",
				}),
			);
			if (input.body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, input.body);
			const client = HttpClient.withScope(yield* HttpClient.HttpClient);
			const response = yield* client
				.execute(request)
				.pipe(Effect.mapError(() => failure("network_error", { retryable: true, retryAfterSeconds: 60 })));
			if (response.status < 200 || response.status >= 300) {
				let bodyRetryAfter: number | null = null;
				if (response.status === 429) {
					const bodyText = yield* readBoundedText(response, input.transport.maxResponseBytes);
					const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(bodyText);
					if (Option.isSome(decoded) && typeof decoded.value === "object" && decoded.value !== null) {
						const retryAfter = (decoded.value as { readonly retry_after?: unknown }).retry_after;
						if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
							bodyRetryAfter = retryAfter;
						}
					}
				}
				return yield* classifyStatus(response.status, response.headers["retry-after"], bodyRetryAfter);
			}
			const text = yield* readBoundedText(response, input.transport.maxResponseBytes);
			return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(input.schema))(text).pipe(
				Effect.mapError(() => failure("invalid_response", { retryable: true, retryAfterSeconds: 60 })),
			);
		},
	).pipe(Effect.scoped);

	return operation.pipe(
		Effect.provide(input.httpClientLayer),
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.timeoutOrElse({
			duration: Duration.millis(input.transport.timeoutMillis),
			orElse: () => Effect.fail(failure("timeout", { retryable: true, retryAfterSeconds: 60 })),
		}),
		Effect.sandbox,
		Effect.mapError((cause) =>
			Option.getOrElse(Cause.findErrorOption(cause), () =>
				failure("network_error", { retryable: true, retryAfterSeconds: 60 }),
			),
		),
	);
};

export const safeToolResult = <A>(
	effect: Effect.Effect<A, MeetingProviderSafeFailure>,
): Effect.Effect<ExecutorToolResult<A>> =>
	effect.pipe(
		Effect.map((value) => ToolResult.ok(value)),
		Effect.catchCause((cause) => {
			const error = Option.getOrElse(Cause.findErrorOption(cause), () =>
				failure("provider_internal", { retryable: true, retryAfterSeconds: 60 }),
			);
			return Effect.succeed(
				ToolResult.fail({
					code: error.code,
					message: "Meeting publication provider operation failed.",
					...(error.status === null ? {} : { status: error.status }),
					retryable: error.retryable,
					details: { retryAfterSeconds: error.retryAfterSeconds },
				}),
			);
		}),
	);

export const inputFailure = () => failure("invalid_input");
export const credentialFailure = () => failure("missing_credential");
export const scopeFailure = () => failure("insufficient_scope");
export const configFailure = () => failure("invalid_provider_config");
export const identityFailure = () => failure("identity_mismatch");
export const duplicateFailure = () => failure("duplicate_resource");
export const checkpointFailure = () => failure("checkpoint_mismatch");
export const authorizationFailure = () => failure("invalid_grant");
