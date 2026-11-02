import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HandoffButton, HandoffProvider } from "../../src/portal/app/components/actions.tsx";
import { type FetchInit, SessionClient, TOKEN_KEY } from "../../src/portal/app/lib/session.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	root = createRoot(container);
	vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.restoreAllMocks();
});

describe("portal sign-in handoff button", () => {
	it("requires a provider for service actions", async () => {
		await act(async () =>
			root.render(
				<HandoffButton action={{ kind: "handoff", label: "Open", target: "harnessy:open:cockpit", note: null }} />,
			),
		);
		await act(async () => container.querySelector("button")!.click());
		expect(container.textContent).toContain("Your Harnessy session ended");
	});
	it("sends terminal actions as JSON with the page token and reports errors", async () => {
		const fetch = vi.fn(async (_path: string, _init: FetchInit) => ({
			status: 200,
			json: async () => ({ ok: true }),
		}));
		const client = new SessionClient({
			hash: () => "",
			replaceUrl: () => undefined,
			now: () => 1,
			storage: {
				getItem: () => JSON.stringify({ token: "t".repeat(43), expiresAt: 1000 }),
				setItem: () => undefined,
				removeItem: () => undefined,
			},
			fetch,
		});
		expect((await client.terminalAction({ action: "input", id: "fixture", data: "hello\r" })).kind).toBe("ok");
		expect(fetch).toHaveBeenCalledWith(
			"/v1/terminal/action",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: "input", id: "fixture", data: "hello\r" }),
				credentials: "omit",
				redirect: "error",
			}),
		);
		fetch.mockResolvedValue({ status: 503, json: async () => ({ ok: false }) });
		expect(await client.terminalAction({ action: "create" })).toMatchObject({
			kind: "error",
			message: expect.stringContaining("Terminal request failed"),
		});
		await client.generateBrief();
		expect(fetch).toHaveBeenLastCalledWith("/v1/life/brief/generate", expect.objectContaining({ body: "{}" }));
	});
	it("posts the page session once, shows progress, and opens no unauthenticated URL", async () => {
		const calls: { path: string; init: FetchInit }[] = [];
		let finish: ((response: { status: number; json: () => Promise<unknown> }) => void) | undefined;
		const token = "t".repeat(43);
		const client = new SessionClient({
			hash: () => "",
			replaceUrl: () => undefined,
			now: () => 1,
			storage: {
				getItem: (key) => (key === TOKEN_KEY ? JSON.stringify({ token, expiresAt: 1000 }) : null),
				setItem: () => undefined,
				removeItem: () => undefined,
			},
			fetch: async (path, init) => {
				calls.push({ path, init });
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
		});
		await act(async () =>
			root.render(
				<HandoffProvider open={(service) => client.open(service)}>
					<HandoffButton
						action={{
							kind: "handoff",
							label: "Open meeting review",
							target: "harnessy:open:meeting-review",
							note: null,
						}}
					/>
				</HandoffProvider>,
			),
		);
		const button = container.querySelector("button")!;
		await act(async () => button.click());
		expect(button.disabled).toBe(true);
		expect(container.textContent).toContain("Opening in your browser");
		await act(async () => button.click());
		expect(calls).toEqual([
			{
				path: "/v1/open/meeting-review",
				init: {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: "{}",
					credentials: "omit",
					cache: "no-store",
					redirect: "error",
				},
			},
		]);
		await act(async () => finish!({ status: 200, json: async () => ({ opened: true }) }));
		expect(button.disabled).toBe(false);
		expect(container.querySelector("output")?.textContent).toBe("Opened in your browser.");
		expect(window.open).not.toHaveBeenCalled();
	});

	it.each(["signed_out", "error", "throw"] as const)(
		"shows an actionable %s failure and allows a retry",
		async (kind) => {
			const open = vi.fn(async () => {
				if (kind === "throw") throw new Error("private internal failure");
				return kind === "error" ? ({ kind, message: "Check the service on Jobs." } as const) : ({ kind } as const);
			});
			await act(async () =>
				root.render(
					<HandoffProvider open={open}>
						<HandoffButton
							action={{
								kind: "handoff",
								label: "Open community review",
								target: "harnessy:open:community-review",
								note: null,
							}}
						/>
					</HandoffProvider>,
				),
			);
			await act(async () => container.querySelector("button")!.click());
			expect(container.querySelector("button")!.disabled).toBe(false);
			expect(container.querySelector("output")?.textContent).toMatch(
				kind === "signed_out" ? /Run harnessy open/u : /Jobs/u,
			);
			expect(container.textContent).not.toContain("private internal failure");
			expect(window.open).not.toHaveBeenCalled();
		},
	);

	it.each([401, 409, 503])("handles HTTP %s through the session client", async (status) => {
		const client = new SessionClient({
			hash: () => "",
			replaceUrl: () => undefined,
			now: () => 1,
			storage: {
				getItem: () => JSON.stringify({ token: "t".repeat(43), expiresAt: 1000 }),
				setItem: () => undefined,
				removeItem: () => undefined,
			},
			fetch: async () => ({ status, json: async () => ({ error: "service_open_failed" }) }),
		});
		const result = await client.open("cockpit");
		expect(result.kind).toBe(status === 401 ? "signed_out" : "error");
		if (result.kind === "error")
			expect(result.message).toContain(status === 409 ? "Try again shortly" : "Jobs screen");
	});
});
