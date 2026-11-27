import { signHostRequest, verifyHostRequest } from "./host-auth.ts";
import {
	type HostEnrollment,
	type HostRequestUnsigned,
	hostContractVersion,
	hostEnrollmentSchema,
	hostOutcomeSchema,
	hostRequestUnsignedSchema,
} from "./host-contract.ts";

type HostOutcome = ReturnType<typeof hostOutcomeSchema.parse>;
type HostBody = HostRequestUnsigned["body"];

export interface GardenHostTransportConfiguration {
	/** A trusted deployment origin. No path, credentials, query, or fragment is allowed. */
	readonly origin: string;
	readonly enrollment: HostEnrollment;
	readonly privateKey: Parameters<typeof signHostRequest>[1];
	readonly timeoutMs?: number;
	readonly maximumResponseBytes?: number;
	readonly now?: () => number;
}

export type GardenHostTransportResult =
	| { readonly status: "received"; readonly outcome: HostOutcome; readonly attempts: number }
	| { readonly status: "refused"; readonly httpStatus: number; readonly attempts: number }
	| {
			readonly status: "unavailable";
			readonly httpStatus: number;
			readonly delivery: "unknown";
			readonly attempts: number;
	  }
	| {
			readonly status: "transport_lost";
			readonly reason: "timeout" | "network";
			readonly delivery: "unknown";
			readonly attempts: number;
	  }
	| {
			readonly status: "protocol_error";
			readonly reason: string;
			readonly delivery: "unknown";
			readonly attempts: number;
	  }
	| { readonly status: "invalid_request"; readonly reason: string; readonly attempts: number };

export interface GardenHostTransport {
	readonly endpoint: string;
	send(body: HostBody): Promise<GardenHostTransportResult>;
}

/** HTTPS authenticates Garden. This client never follows redirects or sends session credentials. */
export const createGardenHostTransport = (configuration: GardenHostTransportConfiguration): GardenHostTransport =>
	makeTransport(configuration, false);

/** Test fixtures must explicitly opt into a literal loopback HTTP origin. */
export const createLoopbackGardenHostTransportForTest = (
	configuration: GardenHostTransportConfiguration,
	authorization: { readonly purpose: "isolated-http-fixture" },
): GardenHostTransport => {
	if (authorization.purpose !== "isolated-http-fixture") throw new Error("Loopback test authorization required");
	return makeTransport(configuration, true);
};

const makeTransport = (configuration: GardenHostTransportConfiguration, loopbackTest: boolean): GardenHostTransport => {
	const origin = new URL(configuration.origin);
	if (
		origin.username !== "" ||
		origin.password !== "" ||
		origin.search !== "" ||
		origin.hash !== "" ||
		origin.pathname !== "/" ||
		(loopbackTest
			? origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname)
			: origin.protocol !== "https:")
	)
		throw new Error("Garden requires an exact HTTPS origin; isolated tests require a literal HTTP loopback origin");
	const enrollment = hostEnrollmentSchema.parse(configuration.enrollment);
	const privateKey = configuration.privateKey;
	if (privateKey.type !== "private" || privateKey.algorithm.name !== "Ed25519" || !privateKey.usages.includes("sign"))
		throw new Error("Garden host transport requires an Ed25519 signing key");
	const timeoutMs = configuration.timeoutMs ?? 15_000;
	const maximumBytes = configuration.maximumResponseBytes ?? 262_144;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 60_000 ||
		!Number.isSafeInteger(maximumBytes) ||
		maximumBytes < 1 ||
		maximumBytes > 1_048_576
	)
		throw new Error("Invalid Garden host transport bounds");
	const endpoint = new URL("/api/execution-hosts/receive", origin).href;
	const now = configuration.now ?? Date.now;
	let clockFloor = 0;

	return {
		endpoint,
		async send(input) {
			// Parsing clones the operation before any await. The caller owns durable retry decisions.
			const parsed = hostRequestUnsignedSchema.shape.body.safeParse(input);
			if (!parsed.success) return { status: "invalid_request", reason: "Malformed host operation", attempts: 0 };
			const body = parsed.data;
			if (
				body.operation === "event" &&
				(body.event.hostId !== enrollment.hostId || body.event.workspaceId !== enrollment.workspaceId)
			)
				return { status: "invalid_request", reason: "Event differs from enrolled scope", attempts: 0 };
			if (
				body.operation === "intervention" &&
				(body.intervention.hostId !== enrollment.hostId || body.intervention.workspaceId !== enrollment.workspaceId)
			)
				return { status: "invalid_request", reason: "Intervention differs from enrolled scope", attempts: 0 };
			const attempts = 1;
			const signedAt = now();
			if (!Number.isSafeInteger(signedAt) || signedAt < clockFloor)
				return { status: "invalid_request", reason: "Invalid or regressed host clock", attempts: attempts - 1 };
			clockFloor = signedAt;
			const request = await signHostRequest(
				{
					contractVersion: hostContractVersion,
					hostId: enrollment.hostId,
					workspaceId: enrollment.workspaceId,
					keyGeneration: enrollment.keyGeneration,
					nonce: crypto.randomUUID(),
					signedAt,
					body,
				},
				privateKey,
			).catch(() => undefined);
			if (request === undefined || (await verifyHostRequest(request, enrollment, signedAt)).status !== "verified")
				return {
					status: "invalid_request",
					reason: "Signing key does not match enrolled host",
					attempts: attempts - 1,
				};
			const result = await exchange(
				endpoint,
				JSON.stringify(request),
				body,
				enrollment,
				timeoutMs,
				maximumBytes,
				now,
				signedAt,
				attempts,
				(at) => {
					clockFloor = Math.max(clockFloor, at);
				},
			);
			return result;
		},
	};
};

const exchange = async (
	endpoint: string,
	payload: string,
	body: HostBody,
	enrollment: HostEnrollment,
	timeoutMs: number,
	maximumBytes: number,
	now: () => number,
	signedAt: number,
	attempts: number,
	observeClock: (at: number) => void,
): Promise<GardenHostTransportResult> => {
	if (new TextEncoder().encode(payload).byteLength > 65_536)
		return { status: "invalid_request", reason: "Host request exceeds byte limit", attempts: attempts - 1 };
	const controller = new AbortController();
	const deadline = performance.now() + timeoutMs;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const protocolError = (reason: string): GardenHostTransportResult => ({
		status: "protocol_error",
		reason,
		delivery: "unknown",
		attempts,
	});
	const result = await Promise.resolve()
		.then(async (): Promise<GardenHostTransportResult> => {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json", "cache-control": "no-store" },
				body: payload,
				redirect: "manual",
				credentials: "omit",
				referrerPolicy: "no-referrer",
				signal: controller.signal,
			});
			let headerBytes = 0;
			for (const [name, value] of response.headers)
				headerBytes += new TextEncoder().encode(`${name}: ${value}\r\n`).byteLength;
			if (headerBytes > 8192) {
				await response.body?.cancel();
				return protocolError("Garden response headers exceed byte limit");
			}
			if (
				response.redirected ||
				response.type === "opaqueredirect" ||
				response.url !== endpoint ||
				(response.status >= 300 && response.status < 400)
			) {
				await response.body?.cancel();
				return protocolError("Garden redirects are forbidden");
			}
			if (response.status !== 200) {
				await response.body?.cancel();
				if ([400, 401, 403, 404, 409].includes(response.status))
					return { status: "refused", httpStatus: response.status, attempts };
				return { status: "unavailable", httpStatus: response.status, delivery: "unknown", attempts };
			}
			if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
				await response.body?.cancel();
				return protocolError("Garden response must be JSON");
			}
			const length = response.headers.get("content-length");
			if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBytes)) {
				await response.body?.cancel();
				return protocolError("Garden response exceeds byte limit");
			}
			if (response.body === null) return protocolError("Garden response body is missing");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > maximumBytes) {
					await reader.cancel();
					return protocolError("Garden response exceeds byte limit");
				}
				chunks.push(chunk.value);
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			const json = await Promise.resolve()
				.then((): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
				.catch(() => undefined);
			const parsed = hostOutcomeSchema.safeParse(json);
			if (!parsed.success) return protocolError("Garden response does not match host outcome schema");
			const receivedAt = now();
			if (!Number.isSafeInteger(receivedAt) || receivedAt < signedAt)
				return protocolError("Invalid or regressed response clock");
			let outcome = retainCancellations(parsed.data, enrollment, receivedAt);
			if (!(await outcomeMatches(body, outcome, enrollment, receivedAt)))
				return protocolError("Garden response differs from requested operation or enrolled scope");
			const validatedAt = now();
			if (!Number.isSafeInteger(validatedAt) || validatedAt < receivedAt)
				return protocolError("Invalid or regressed response clock");
			outcome = retainCancellations(outcome, enrollment, validatedAt);
			if (
				(outcome.kind === "authority_current" && outcome.expiresAt <= validatedAt) ||
				(outcome.kind === "commands" && outcome.commands.some((entry) => commandExpiry(entry) <= validatedAt))
			)
				return protocolError("Garden authority expired during response validation");
			// Body decoding and asynchronous digest checks also consume the request deadline.
			if (timedOut || performance.now() >= deadline)
				return { status: "transport_lost", reason: "timeout", delivery: "unknown", attempts };
			observeClock(validatedAt);
			return { status: "received", outcome, attempts };
		})
		.catch(
			(): GardenHostTransportResult => ({
				status: "transport_lost",
				reason: timedOut ? "timeout" : "network",
				delivery: "unknown",
				attempts,
			}),
		);
	clearTimeout(timer);
	controller.abort();
	return result;
};

/** A stale or foreign answer must not hold a valid cancellation hostage. All retained commands still pass normal validation. */
const retainCancellations = (outcome: HostOutcome, enrollment: HostEnrollment, now: number): HostOutcome => {
	if (outcome.kind !== "commands" || !outcome.commands.some((entry) => entry.kind === "cancel")) return outcome;
	return {
		...outcome,
		commands: outcome.commands.filter(
			(entry) =>
				entry.kind !== "answer" ||
				(entry.answer.hostId === enrollment.hostId &&
					entry.answer.workspaceId === enrollment.workspaceId &&
					entry.answer.operatorId === enrollment.operatorId &&
					entry.answer.expiresAt > now),
		),
	};
};

const commandExpiry = (entry: Extract<HostOutcome, { kind: "commands" }>["commands"][number]): number =>
	entry.kind === "launch"
		? entry.launch.grant.expiresAt
		: entry.kind === "cancel"
			? entry.command.expiresAt
			: entry.answer.expiresAt;

const outcomeMatches = async (
	body: HostBody,
	outcome: HostOutcome,
	enrollment: HostEnrollment,
	now: number,
): Promise<boolean> => {
	if (body.operation === "decline")
		return (
			outcome.kind === "declined" &&
			outcome.launchId === body.launchId &&
			outcome.requestDigest === body.requestDigest &&
			outcome.declineId === body.declineId &&
			outcome.reason === body.reason
		);
	if (body.operation === "authority")
		return (
			outcome.kind === "authority_refused" ||
			(outcome.kind === "authority_current" &&
				outcome.launchId === body.launchId &&
				outcome.grantId === body.grantId &&
				outcome.expiresAt > now)
		);
	if (body.operation === "acknowledge")
		return outcome.kind === "acknowledged" && outcome.launchId === body.launchId && outcome.runId === body.runId;
	if (body.operation === "event")
		return (
			outcome.kind === "event_recorded" &&
			outcome.launchId === body.event.launchId &&
			outcome.sequence === body.event.sequence
		);
	if (body.operation === "intervention")
		return (
			outcome.kind === "intervention_recorded" &&
			outcome.launchId === body.intervention.launchId &&
			outcome.interventionId === body.intervention.id
		);
	if (outcome.kind !== "commands" || outcome.commands.filter((entry) => entry.kind === "launch").length > 1)
		return false;
	const identities = new Set<string>();
	for (const entry of outcome.commands) {
		const command = entry.kind === "launch" ? entry.launch : entry.kind === "cancel" ? entry.command : entry.answer;
		if (command.hostId !== enrollment.hostId || command.workspaceId !== enrollment.workspaceId) return false;
		const identity =
			entry.kind === "launch"
				? `launch:${entry.launch.launchId}`
				: entry.kind === "cancel"
					? `cancel:${entry.command.commandId}`
					: `answer:${entry.answer.answerId}`;
		if (identities.has(identity)) return false;
		identities.add(identity);
		if (entry.kind === "answer") {
			if (entry.answer.operatorId !== enrollment.operatorId || entry.answer.expiresAt <= now) return false;
			continue;
		}
		if (entry.kind === "cancel") {
			if (entry.command.expiresAt <= now) return false;
			continue;
		}
		if (
			entry.launch.operatorId !== enrollment.operatorId ||
			entry.launch.capabilityDigest !== enrollment.capabilityDigest ||
			!enrollment.repositories.includes(entry.launch.job.repository) ||
			entry.launch.grant.issuedAt > now ||
			entry.launch.grant.expiresAt <= now
		)
			return false;
		const { requestDigest, ...unsigned } = entry.launch;
		const hash = async (value: unknown) =>
			Array.from(
				new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
		if (entry.launch.grant.jobDigest !== (await hash(entry.launch.job)) || requestDigest !== (await hash(unsigned)))
			return false;
	}
	return true;
};
