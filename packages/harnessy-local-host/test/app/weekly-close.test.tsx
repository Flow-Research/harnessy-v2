import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CloseWeeklyDraft, WeeklyDraftProvider } from "../../src/portal/app/components/CloseWeeklyDraft.tsx";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";

const workOn = vi.fn();
vi.mock("../../src/portal/app/components/QuickActions.tsx", () => ({ useBriefAction: () => workOn }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => {
	await act(async () => root?.unmount());
	vi.clearAllMocks();
});
const hash = "a".repeat(64);
const render = async (
	close: (run: string, reason: string) => Promise<ApiResult>,
	state = "drafted",
	failure?: { phase: string; errors: string[]; recordedAt: string; rawDraftPreserved: boolean },
) => {
	const container = document.createElement("div");
	document.body.replaceChildren(container);
	const get = vi.fn(
		async (path: string): Promise<ApiResult> => ({
			kind: "ok",
			body: path.endsWith("/status")
				? { periodId: "2026-W44", state, failure }
				: {
						tiles: {
							weeklyRuns: {
								state: "ok",
								data: { runs: [{ runHash: hash, state, incompleteReconciliation: false }] },
							},
						},
					},
		}),
	);
	const store = new DataStore({ get });
	await act(async () => {
		root = createRoot(container);
		root.render(
			<DataProvider store={store}>
				<WeeklyDraftProvider close={close}>
					<CloseWeeklyDraft runHash={hash} />
				</WeeklyDraftProvider>
			</DataProvider>,
		);
	});
	return { container, get };
};
const click = async (label: string) => {
	await act(async () => {
		const button = [...document.querySelectorAll("button")].find((el) => el.textContent === label);
		expect(button).toBeDefined();
		button!.click();
	});
};
const fill = async (value: string) => {
	await act(async () => {
		const field = document.querySelector("textarea")!;
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
};

it("requires confirmation, retains the reason on failure, retries and refreshes the Inbox", async () => {
	const close = vi
		.fn<(run: string, reason: string) => Promise<ApiResult>>()
		.mockResolvedValueOnce({ kind: "error", message: "Draft changed; refresh first." })
		.mockResolvedValueOnce({ kind: "ok", body: { closed: true } });
	const { container, get } = await render(close);
	await click("Close draft");
	expect(document.activeElement?.id).toBe("weekly-close-reason");
	expect(document.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(true);
	await click("Cancel");
	expect(close).not.toHaveBeenCalled();
	await click("Close draft");
	await fill("  Old plan.  ");
	await click("Confirm close");
	expect(container.textContent).toContain("Draft changed; refresh first.");
	expect(document.querySelector("textarea")!.value).toBe("  Old plan.  ");
	await click("Confirm close");
	expect(close).toHaveBeenLastCalledWith(hash, "Old plan.");
	expect(container.textContent).toContain("Draft closed");
	expect(get.mock.calls.length).toBeGreaterThan(1);
});

it("disables close for an unresolved run", async () => {
	const close = vi.fn();
	await render(close, "unrecorded");
	await click("Close draft");
	expect(document.querySelector("textarea")).toBeNull();
	expect(close).not.toHaveBeenCalled();
});

it("explains an expired session without discarding the reason", async () => {
	const { container } = await render(async () => ({ kind: "signed_out" }));
	await click("Close draft");
	await fill("No longer needed.");
	await click("Confirm close");
	expect(container.textContent).toContain("Your session ended");
	expect(document.querySelector("textarea")!.value).toBe("No longer needed.");
});

it("opens an investigation with exact failure evidence and explains the saved partial draft", async () => {
	await render(vi.fn(), "failed", {
		phase: "validation",
		errors: ["Invalid weekly format"],
		recordedAt: "2026-11-04T00:00:00Z",
		rawDraftPreserved: true,
	});
	expect(document.body.textContent).toContain("stopped during validation");
	expect(document.body.textContent).toContain("partial draft was saved");
	await click("Investigate with an agent");
	expect(workOn).toHaveBeenCalledWith(
		expect.objectContaining({
			title: "Investigate weekly plan 2026-W44",
			source: `Weekly run ${hash}`,
			text: expect.stringContaining("Invalid weekly format"),
		}),
	);
});

it("does not submit twice while closing and preserves the reason after a network rejection", async () => {
	let reject: (reason: Error) => void = () => undefined;
	const close = vi.fn(
		() =>
			new Promise<ApiResult>((_resolve, fail) => {
				reject = fail;
			}),
	);
	await render(close);
	await click("Close draft");
	await fill("Old plan.");
	await act(async () => {
		document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
	expect(close).toHaveBeenCalledOnce();
	expect(document.querySelector("textarea")!.disabled).toBe(true);
	await act(async () => reject(new Error("network interrupted")));
	expect(document.body.textContent).toContain("Refresh the status before trying again");
	expect(document.querySelector("textarea")!.value).toBe("Old plan.");
});
