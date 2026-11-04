import { describe, expect, it, vi } from "vitest";
import { SessionClient, type SessionEnvironment, TOKEN_KEY } from "../../src/portal/app/lib/session.ts";

const token = "t".repeat(43);
const expiresAt = "2026-11-05T12:00:00Z";
const setup = (remote = false, hash = "#/inbox", signedIn = true) => {
	const values = new Map<string, string>();
	if (signedIn) values.set(TOKEN_KEY, JSON.stringify({ token, expiresAt: Date.parse(expiresAt) }));
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: vi.fn((key: string, value: string) => {
			values.set(key, value);
		}),
		removeItem: vi.fn((key: string) => {
			values.delete(key);
		}),
	};
	const fetch = vi
		.fn<SessionEnvironment["fetch"]>()
		.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
	const replaceUrl = vi.fn();
	const env = { remote, hash: () => hash, storage, fetch, replaceUrl, now: () => Date.parse("2026-11-04T12:00:00Z") };
	return { client: new SessionClient(env), env, storage, fetch, replaceUrl };
};

describe("session action requests", () => {
	it.each([false, true])(
		"sends exact action payloads with origin-specific credentials (remote=%s)",
		async (remote) => {
			const { client, fetch } = setup(remote);
			const items = [{ key: "life:weekly", revision: "r1" }];
			await client.inboxAction("archive", items);
			await client.inboxAction("restore", items);
			await client.closeWeeklyDraft("a".repeat(64), "The week has passed.");
			await client.terminalAction({ action: "input", id: "session", data: "Ẹ káàárọ̀\r" });
			await client.generateBrief();
			expect(fetch.mock.calls.map(([path, init]) => [path, JSON.parse(init.body!)])).toEqual([
				["/v1/inbox/action", { action: "archive", items }],
				["/v1/inbox/action", { action: "restore", items }],
				[`/v1/life/weekly/${"a".repeat(64)}/close`, { reason: "The week has passed." }],
				["/v1/terminal/action", { action: "input", id: "session", data: "Ẹ káàárọ̀\r" }],
				["/v1/life/brief/generate", {}],
			]);
			for (const [, init] of fetch.mock.calls)
				expect(init).toMatchObject({
					method: "POST",
					credentials: remote ? "same-origin" : "omit",
					redirect: "error",
					cache: "no-store",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				});
		},
	);

	it("reports stale Inbox selections and weekly conflicts without leaking server error text", async () => {
		const { client, fetch } = setup();
		fetch.mockResolvedValue({ status: 409, json: async () => ({ error: "private internal detail" }) });
		expect(await client.inboxAction("archive", [])).toEqual({
			kind: "error",
			message: expect.stringContaining("selection is retained"),
		});
		expect(await client.closeWeeklyDraft("a".repeat(64), "reason")).toEqual({
			kind: "error",
			message: expect.stringContaining("draft changed"),
		});
		fetch.mockResolvedValue({ status: 503, json: async () => ({ error: "private internal detail" }) });
		expect(await client.closeWeeklyDraft("a".repeat(64), "reason")).toEqual({
			kind: "error",
			message: expect.stringContaining("reason is retained"),
		});
		expect(await client.generateBrief()).toEqual({
			kind: "error",
			message: "Could not start the daily brief. Try again shortly.",
		});
	});

	it.each([
		["terminal_backend_failed", "session backend"],
		["terminal_observer_take_control", "Take control"],
		["exact_conversation_unavailable", "No verified conversation ID"],
		["runner_unavailable", "not installed"],
		["session_directory_missing", "working directory is missing"],
		["terminal_backend_unavailable", "Herdr did not start"],
		["terminal_already_running", "already running. Open its terminal to continue; no new process was started"],
		["terminal_resume_unverified", "session is retained and was not restarted. Check the host"],
		["terminal_identity_unverified", "session is retained. Check the host before attaching"],
		["terminal_transition_in_progress", "Wait for its status to update before changing or ending"],
		["unknown_private_error", "Terminal request failed"],
		[undefined, "Terminal request failed"],
	])("explains terminal failure %s without exposing raw errors", async (error, message) => {
		const { client, fetch } = setup();
		fetch.mockResolvedValue({ status: 409, json: async () => ({ error }) });
		expect(await client.terminalAction({ action: "resume", id: "session" })).toEqual({
			kind: "error",
			message: expect.stringContaining(message!),
		});
	});

	it("explains an unverified end without claiming the session stopped or retrying the destructive action", async () => {
		const { client, fetch } = setup();
		fetch.mockResolvedValue({ status: 409, json: async () => ({ error: "terminal_end_unverified" }) });
		expect(await client.terminalAction({ action: "close", id: "session" })).toEqual({
			kind: "error",
			message:
				"Could not verify that the process ended. The session is retained. Refresh its status and check the host before trying again.",
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(client.session()?.token).toBe(token);
	});

	it("forgets refused credentials and never sends a later write until signed in again", async () => {
		const { client, fetch, storage } = setup(true);
		fetch.mockResolvedValue({ status: 401, json: async () => ({}) });
		expect(await client.inboxAction("archive", [])).toEqual({ kind: "signed_out" });
		expect(storage.removeItem).toHaveBeenCalledWith(TOKEN_KEY);
		expect(await client.closeWeeklyDraft("a".repeat(64), "reason")).toEqual({ kind: "signed_out" });
		expect(fetch).toHaveBeenCalledOnce();
	});
});

describe("device session restoration", () => {
	it.each([false, true])(
		"restores a remote device with cookies and removes a pairing secret before sending (pair=%s)",
		async (pair) => {
			const { client, fetch, replaceUrl, storage } = setup(true, pair ? `#pair=${token}` : "#/terminal", false);
			fetch.mockImplementation(async () => {
				if (pair) expect(replaceUrl).toHaveBeenCalledWith("/#/today");
				return { status: 200, json: async () => ({ token, expiresAt }) };
			});
			await client.restoreDevice();
			expect(fetch).toHaveBeenCalledWith(pair ? "/v1/session/pair" : "/v1/session/device", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(pair ? { code: token } : {}),
				credentials: "same-origin",
				cache: "no-store",
				redirect: "error",
			});
			expect(client.session()?.token).toBe(token);
			expect(storage.setItem).toHaveBeenCalledWith(TOKEN_KEY, expect.any(String));
			if (!pair) expect(replaceUrl).not.toHaveBeenCalled();
		},
	);

	it.each([{}, { token: "bad", expiresAt }, { token }, { token, expiresAt: "never" }])(
		"rejects malformed remote credentials %j",
		async (body) => {
			const { client, fetch, storage } = setup(true, "#/inbox", false);
			fetch.mockResolvedValue({ status: 200, json: async () => body });
			await client.restoreDevice();
			expect(client.session()).toBeUndefined();
			expect(storage.setItem).not.toHaveBeenCalled();
		},
	);

	it("stays signed out after refused or offline device restoration and skips local restoration", async () => {
		const { client, fetch } = setup(true, "#/inbox", false);
		fetch.mockResolvedValueOnce({ status: 403, json: async () => ({}) }).mockRejectedValueOnce(new Error("offline"));
		await client.restoreDevice();
		await client.restoreDevice();
		expect(client.session()).toBeUndefined();
		const local = setup(false, "#/inbox", false);
		await local.client.restoreDevice();
		expect(local.fetch).not.toHaveBeenCalled();
		await expect(client.beginBrowserSignIn()).rejects.toThrow("Use device pairing");
	});
});

describe("native sign-in response validation", () => {
	it.each([
		{ status: 503, body: {} },
		{ status: 200, body: { id: "bad", claim: token } },
		{ status: 200, body: { id: token, claim: "bad" } },
	])("rejects invalid start response %j", async ({ status, body }) => {
		const { client, fetch } = setup(false, "#/inbox", false);
		fetch.mockResolvedValue({ status, json: async () => body });
		await expect(client.beginBrowserSignIn()).rejects.toThrow("Could not start sign-in");
		expect(client.session()).toBeUndefined();
	});

	it.each([
		{ token: "bad", expiresAt },
		{ token, expiresAt: "never" },
	])("rejects an invalid claim response %j", async (body) => {
		const { client, fetch } = setup(false, "#/inbox", false);
		fetch.mockResolvedValue({ status: 200, json: async () => body });
		await expect(client.claimBrowserSignIn(token, token)).rejects.toThrow("Invalid sign-in response");
		expect(client.session()).toBeUndefined();
	});

	it("retains a valid native session in memory when storage is blocked", async () => {
		const { client, fetch, storage } = setup(false, "#/inbox", false);
		storage.setItem.mockImplementation(() => {
			throw new Error("storage blocked");
		});
		fetch.mockResolvedValue({ status: 200, json: async () => ({ token, expiresAt }) });
		expect(await client.claimBrowserSignIn(token, token)).toBe(true);
		expect(client.session()?.token).toBe(token);
	});
});
