import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export interface MeetingSetupConsent {
	state: string;
	authorizationUrl: string;
	complete: (code: string) => Promise<void>;
	cancel: () => Promise<void>;
}

/** One finite, operator-driven consent window. The adapter must honor the abort signal. */
export async function runMeetingSetupConsent(input: {
	start: (redirectUri: string, signal: AbortSignal) => Promise<MeetingSetupConsent>;
	onReady: (localOrigin: string) => void | Promise<void>;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<void> {
	const timeoutMs = input.timeoutMs ?? 300_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
		throw new Error("Invalid consent timeout");
	}
	if (input.signal?.aborted) throw new Error("Meeting setup consent cancelled");
	const controller = new AbortController();
	let consent: MeetingSetupConsent | undefined;
	let exchange: Promise<void> | undefined;
	let origin = "";
	let authorizationUrl = "";
	let consumed = false;
	let stopped = false;
	let failure = false;
	let finish = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const stop = (failed: boolean) => {
		if (stopped) return;
		stopped = true;
		failure = failed;
		if (failed) controller.abort();
		finish();
	};
	const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
		const send = (status: number, body: string, html = false) => {
			response.writeHead(status, {
				"Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"Content-Security-Policy":
					"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
				"X-Content-Type-Options": "nosniff",
				Connection: "close",
			});
			response.end(body);
		};
		if (request.method !== "GET" || request.headers.host !== origin.slice(7)) {
			send(400, "Invalid request");
			return;
		}
		const raw = request.url ?? "";
		if (
			!raw.startsWith("/") ||
			raw.startsWith("//") ||
			raw.includes("\\") ||
			raw.length > 8192 ||
			/%(?![0-9a-f]{2})/i.test(raw)
		) {
			send(400, "Invalid request");
			return;
		}
		if (stopped || consumed || !consent) {
			send(409, "Consent window unavailable");
			return;
		}
		if (raw === "/") {
			const escaped = authorizationUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
			send(
				200,
				`<!doctype html><title>Native meeting connection setup</title><h1>Connect Google</h1><p>No meetings will be published.</p><a href="${escaped}">Continue to Google consent</a>`,
				true,
			);
			return;
		}
		const url = new URL(raw, origin);
		if (
			!raw.startsWith("/oauth/callback?") ||
			url.pathname !== "/oauth/callback" ||
			url.origin !== origin ||
			url.hash
		) {
			send(404, "Not found");
			return;
		}
		const params = url.searchParams;
		const allowed = new Set([
			"iss",
			"state",
			"code",
			"error",
			"error_description",
			"error_uri",
			"scope",
			"authuser",
			"prompt",
			"hd",
		]);
		if ([...params.keys()].some((key) => !allowed.has(key) || params.getAll(key).length !== 1)) {
			send(400, "Invalid callback");
			return;
		}
		const state = Buffer.from(params.get("state") ?? "");
		const expected = Buffer.from(consent.state);
		const code = params.get("code");
		const error = params.get("error");
		if (
			// Google's modern authorization endpoint always returns this exact RFC 9207 issuer.
			params.get("iss") !== "https://accounts.google.com" ||
			state.length !== expected.length ||
			!timingSafeEqual(state, expected) ||
			params.has("code") === params.has("error") ||
			Boolean(code) === Boolean(error) ||
			(code && (!/^[\x21-\x7e]+$/.test(code) || code.length > 4096))
		) {
			send(400, "Invalid callback");
			return;
		}
		consumed = true;
		if (error) {
			send(400, "Google consent was not completed. Return to the terminal.");
			stop(true);
			return;
		}
		const complete = consent.complete;
		exchange = Promise.resolve()
			.then(() => complete(code!))
			.then(
				() => {
					send(200, "Connection setup completed. Return to the terminal.");
					stop(false);
				},
				() => {
					send(400, "Connection setup failed. Return to the terminal.");
					stop(true);
				},
			);
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	const abort = () => stop(true);
	input.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
		});
		server.on("error", abort);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Invalid listener");
		origin = `http://127.0.0.1:${address.port}`;
		if (stopped) throw new Error("Cancelled");
		const redirectUri = `${origin}/oauth/callback`;
		consent = await input.start(redirectUri, controller.signal);
		if (stopped) throw new Error("Cancelled");
		const target = new URL(consent.authorizationUrl);
		if (
			target.origin !== "https://accounts.google.com" ||
			target.username ||
			target.password ||
			target.hash ||
			(target.pathname !== "/o/oauth2/v2/auth" && target.pathname !== "/o/oauth2/auth") ||
			!consent.state ||
			consent.state.length > 1024 ||
			target.searchParams.getAll("state").length !== 1 ||
			target.searchParams.get("state") !== consent.state ||
			target.searchParams.getAll("redirect_uri").length !== 1 ||
			target.searchParams.get("redirect_uri") !== redirectUri
		) {
			throw new Error("Invalid authorization URL");
		}
		authorizationUrl = target.href;
		await input.onReady(origin);
		await done;
		if (failure) throw new Error("Consent failed");
	} catch {
		stop(true);
		failure = true;
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", abort);
		controller.abort();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await exchange;
		try {
			await consent?.cancel();
		} catch {
			failure = true;
		}
	}
	if (failure) throw new Error("Meeting setup consent did not complete; inspect local setup state before retrying");
}
