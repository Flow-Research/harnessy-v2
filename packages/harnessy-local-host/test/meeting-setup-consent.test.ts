import { request } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { runMeetingSetupConsent } from "../src/meeting-setup-consent.ts";

function get(origin: string, path = "/", headers: Record<string, string> = {}, method = "GET") {
	return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
		const req = request(`${origin}${path}`, { headers, method }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
		});
		req.on("error", reject);
		req.end();
	});
}

function fixture(options: { complete?: () => Promise<void>; timeoutMs?: number; url?: string } = {}) {
	let ready!: (origin: string) => void;
	const origin = new Promise<string>((resolve) => {
		ready = resolve;
	});
	const controller = new AbortController();
	const complete = vi.fn(options.complete ?? (async () => {}));
	const cancel = vi.fn(async () => {});
	const run = runMeetingSetupConsent({
		signal: controller.signal,
		timeoutMs: options.timeoutMs ?? 5000,
		onReady: ready,
		start: async (redirectUri) => ({
			state: "synthetic-state",
			authorizationUrl:
				options.url ??
				`https://accounts.google.com/o/oauth2/v2/auth?state=synthetic-state&redirect_uri=${encodeURIComponent(redirectUri)}`,
			complete,
			cancel,
		}),
	});
	const result = run.then(
		() => "ok",
		(error: Error) => error.message,
	);
	return { origin, result, controller, complete, cancel };
}

describe("one-time native setup consent listener", () => {
	it("accepts Google's documented authorization-response issuer", async () => {
		const setup = fixture();
		try {
			const response = await get(
				await setup.origin,
				"/oauth/callback?state=synthetic-state&code=synthetic-code&iss=https%3A%2F%2Faccounts.google.com",
			);
			expect(response.status).toBe(200);
			expect(await setup.result).toBe("ok");
			expect(setup.complete).toHaveBeenCalledExactlyOnceWith("synthetic-code");
		} finally {
			setup.controller.abort();
			await setup.result;
		}
	});
	it("serves only a local landing page and consumes exact callback once", async () => {
		const setup = fixture();
		const origin = await setup.origin;
		expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		const landing = await get(origin);
		expect(landing.status).toBe(200);
		expect(landing.body).toContain("https://accounts.google.com/");
		expect(landing.headers["referrer-policy"]).toBe("no-referrer");
		expect(landing.headers["cache-control"]).toBe("no-store");
		expect(
			(
				await get(
					origin,
					"/oauth/callback?iss=https%3A%2F%2Faccounts.google.com&state=synthetic-state&code=synthetic-code&scope=email&authuser=0&prompt=consent",
				)
			).status,
		).toBe(200);
		expect(await setup.result).toBe("ok");
		expect(setup.complete).toHaveBeenCalledExactlyOnceWith("synthetic-code");
		expect(setup.cancel).toHaveBeenCalledOnce();
		await expect(get(origin)).rejects.toThrow();
	});

	it.each([
		"",
		"&iss=",
		"&iss=https%3A%2F%2Fattacker.invalid",
		"&iss=http%3A%2F%2Faccounts.google.com",
		"&iss=accounts.google.com",
		"&iss=https%3A%2F%2Faccounts.google.com%2F",
		"&iss=https%3A%2F%2Faccounts.google.com%40attacker.invalid",
		"&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com",
	])("rejects missing, nonexact or duplicate issuer without consuming the flow: %s", async (issuer) => {
		const setup = fixture();
		const origin = await setup.origin;
		try {
			for (const outcome of ["code=synthetic-code", "error=access_denied"]) {
				const response = await get(origin, `/oauth/callback?state=synthetic-state&${outcome}${issuer}`);
				expect(response.status).toBe(400);
				expect(response.body).toBe("Invalid callback");
			}
			expect(setup.complete).not.toHaveBeenCalled();
			expect((await get(origin)).status).toBe(200);
		} finally {
			setup.controller.abort();
			await setup.result;
		}
	});

	it.each([
		"/oauth/callback?state=wrong&code=secret",
		"/oauth/callback?state=synthetic-state&state=synthetic-state&code=secret",
		"/oauth/callback?state=synthetic-state&code=a&code=b",
		"/oauth/callback?state=synthetic-state&code=a&error=denied",
		"/oauth/callback?state=synthetic-state&code=a&error=",
		"/oauth/callback?state=synthetic-state",
		"/oauth/callback?state=synthetic-state&code=%0A",
		"/oauth/callback?state=synthetic-state&code=%xx",
		"/oauth/callback?state=synthetic-state&code=a&unknown=b",
		"//other.invalid/oauth/callback?state=synthetic-state&code=a",
	])("rejects invalid callback without exchanging: %s", async (path) => {
		const setup = fixture();
		expect((await get(await setup.origin, `${path}&iss=https%3A%2F%2Faccounts.google.com`)).status).toBe(400);
		expect(setup.complete).not.toHaveBeenCalled();
		setup.controller.abort();
		expect(await setup.result).not.toBe("ok");
		expect(setup.cancel).toHaveBeenCalledOnce();
	});

	it("rejects foreign Host, unsupported methods, and unknown routes", async () => {
		const setup = fixture();
		const origin = await setup.origin;
		expect((await get(origin, "/", { Host: "attacker.invalid" })).status).toBe(400);
		expect((await get(origin, "/", {}, "POST")).status).toBe(400);
		expect((await get(origin, "/missing")).status).toBe(404);
		setup.controller.abort();
		await setup.result;
		expect(setup.complete).not.toHaveBeenCalled();
	});

	it("denial cancels without exchanging or reflecting provider text", async () => {
		const setup = fixture();
		const response = await get(
			await setup.origin,
			"/oauth/callback?iss=https%3A%2F%2Faccounts.google.com&state=synthetic-state&error=secret&error_description=private",
		);
		expect(response.status).toBe(400);
		expect(response.body).not.toMatch(/secret|private/);
		expect(await setup.result).not.toBe("ok");
		expect(setup.complete).not.toHaveBeenCalled();
	});

	it("blocks concurrent and replay callbacks while an exchange is pending", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const setup = fixture({ complete: () => pending });
		const origin = await setup.origin;
		const first = get(origin, "/oauth/callback?iss=https%3A%2F%2Faccounts.google.com&state=synthetic-state&code=one");
		await vi.waitFor(() => expect(setup.complete).toHaveBeenCalledOnce());
		expect(
			(await get(origin, "/oauth/callback?iss=https%3A%2F%2Faccounts.google.com&state=synthetic-state&code=two"))
				.status,
		).toBe(409);
		release();
		expect((await first).status).toBe(200);
		expect(await setup.result).toBe("ok");
	});

	it("redacts exchange failure and closes the listener", async () => {
		const setup = fixture({
			complete: async () => {
				throw new Error("private credential");
			},
		});
		const response = await get(
			await setup.origin,
			"/oauth/callback?iss=https%3A%2F%2Faccounts.google.com&state=synthetic-state&code=one",
		);
		expect(response.status).toBe(400);
		expect(response.body).not.toContain("private credential");
		expect(await setup.result).not.toContain("private credential");
		expect(setup.cancel).toHaveBeenCalledOnce();
	});

	it("times out and cancels the flow", async () => {
		const setup = fixture({ timeoutMs: 40 });
		const origin = await setup.origin;
		expect(await setup.result).not.toBe("ok");
		expect(setup.cancel).toHaveBeenCalledOnce();
		await expect(get(origin)).rejects.toThrow();
	});

	it.each([
		"https://attacker.invalid/auth",
		"http://accounts.google.com/o/oauth2/v2/auth",
		"https://accounts.google.com/o/oauth2/v2/auth?state=wrong",
	])("rejects unsafe authorization URL %s", async (url) => {
		const setup = fixture({ url });
		expect(await setup.result).not.toBe("ok");
		expect(setup.cancel).toHaveBeenCalledOnce();
	});

	it("does not start after cancellation or an invalid timeout", async () => {
		const start = vi.fn();
		await expect(runMeetingSetupConsent({ start, onReady: () => {}, signal: AbortSignal.abort() })).rejects.toThrow(
			"cancelled",
		);
		await expect(runMeetingSetupConsent({ start, onReady: () => {}, timeoutMs: 0 })).rejects.toThrow("timeout");
		expect(start).not.toHaveBeenCalled();
	});

	it("cancels a delayed start before exposing the landing page", async () => {
		const cancel = vi.fn(async () => {});
		const onReady = vi.fn();
		await expect(
			runMeetingSetupConsent({
				timeoutMs: 20,
				onReady,
				start: async (_redirect, signal) => {
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					return { state: "state", authorizationUrl: "secret", complete: async () => {}, cancel };
				},
			}),
		).rejects.toThrow("did not complete");
		expect(onReady).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("retains ownership until an aborted exchange settles", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const setup = fixture({ complete: () => pending });
		const origin = await setup.origin;
		const response = get(
			origin,
			"/oauth/callback?iss=https%3A%2F%2Faccounts.google.com&state=synthetic-state&code=one",
		).catch(() => undefined);
		await vi.waitFor(() => expect(setup.complete).toHaveBeenCalledOnce());
		setup.controller.abort();
		await response;
		expect(setup.cancel).not.toHaveBeenCalled();
		release();
		expect(await setup.result).not.toBe("ok");
		expect(setup.cancel).toHaveBeenCalledOnce();
	});

	it("fails closed without exposing startup or cleanup errors", async () => {
		const onReady = vi.fn();
		await expect(
			runMeetingSetupConsent({
				onReady,
				start: async () => {
					throw new Error("secret startup detail");
				},
			}),
		).rejects.toThrow("Meeting setup consent did not complete");
		await expect(
			runMeetingSetupConsent({
				onReady,
				start: async () => ({
					state: "state",
					authorizationUrl: "invalid",
					complete: async () => {},
					cancel: async () => {
						throw new Error("secret cleanup detail");
					},
				}),
			}),
		).rejects.toThrow("Meeting setup consent did not complete");
		expect(onReady).not.toHaveBeenCalled();
	});
});
