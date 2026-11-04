/**
 * "Sign in with Harnessy app" signs in the tab the user is on. It asks the native
 * app to approve a one-time request, waits in place, and finishes in the same tab:
 * the route stays where it was and no new tab or window opens.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BrowserSignIn } from "../../src/portal/app/components/BrowserSignIn.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const beginBrowserSignIn = vi.fn<() => Promise<{ id: string; claim: string }>>();
const claimBrowserSignIn = vi.fn<(id: string, claim: string) => Promise<boolean>>();
const onSignedIn = vi.fn();
const render = async () =>
	act(async () =>
		root.render(
			<BrowserSignIn client={{ beginBrowserSignIn, claimBrowserSignIn } as never} onSignedIn={onSignedIn} />,
		),
	);
const button = () => container.querySelector("button")!;

beforeEach(() => {
	vi.useFakeTimers();
	container = document.createElement("div");
	document.body.replaceChildren(container);
	root = createRoot(container);
	window.location.hash = "#/terminal/agent";
	beginBrowserSignIn.mockResolvedValue({ id: "req-1", claim: "secret" });
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

it("waits in this tab until the app approves, then signs in once and keeps the route", async () => {
	const open = vi.spyOn(window, "open");
	claimBrowserSignIn.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
	await render();
	expect(button().textContent).toBe("Sign in with Harnessy app");
	await act(async () => button().click());
	expect(button().textContent).toBe("Waiting for Harnessy…");
	expect(button().disabled).toBe(true);
	expect(container.querySelector("output")?.textContent).toBe(
		"Allow Harnessy to open. Sign-in will finish in this tab.",
	);
	expect(claimBrowserSignIn).toHaveBeenCalledWith("req-1", "secret");
	expect(onSignedIn).not.toHaveBeenCalled();
	await act(async () => vi.advanceTimersByTimeAsync(500));
	expect(onSignedIn).toHaveBeenCalledOnce();
	expect(open).not.toHaveBeenCalled();
	expect(window.location.hash).toBe("#/terminal/agent");
});

it("says so when sign-in cannot start, and lets the user try again", async () => {
	beginBrowserSignIn.mockRejectedValueOnce(new Error("offline"));
	await render();
	await act(async () => button().click());
	expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not start sign-in. Try again shortly.");
	expect(button().disabled).toBe(false);
});

it("reports a refused claim and an expired request, then re-enables the button", async () => {
	claimBrowserSignIn.mockRejectedValueOnce(new Error("Request was already used"));
	await render();
	await act(async () => button().click());
	expect(container.querySelector('[role="alert"]')?.textContent).toBe("Request was already used");
	expect(button().textContent).toBe("Sign in with Harnessy app");
	claimBrowserSignIn.mockResolvedValue(false);
	await act(async () => button().click());
	await act(async () => vi.advanceTimersByTimeAsync(60_500));
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"Sign-in expired. Try again and allow Harnessy to open.",
	);
	expect(onSignedIn).not.toHaveBeenCalled();
	claimBrowserSignIn.mockRejectedValueOnce("not an error");
	await act(async () => button().click());
	expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not sign in. Try again.");
});

it("stops waiting when the page leaves before the app answers", async () => {
	let finish: (value: { id: string; claim: string }) => void = () => undefined;
	beginBrowserSignIn.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	await act(async () => button().click());
	await act(async () => root.render(null));
	await act(async () => finish({ id: "late", claim: "c" }));
	expect(claimBrowserSignIn).not.toHaveBeenCalled();
});
