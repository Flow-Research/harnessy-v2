import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { BriefGenerationProvider, GenerateBrief } from "../../src/portal/app/components/GenerateBrief.tsx";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import type { ApiResult } from "../../src/portal/app/lib/session.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(["signed_out", "error", "throw", "missing_provider"])(
	"shows %s without leaving regeneration disabled",
	async (kind) => {
		const container = document.createElement("div");
		const root = createRoot(container);
		const store = new DataStore({ get: async () => ({ kind: "ok", body: { state: "idle", message: "" } }) });
		const generate = async (): Promise<ApiResult> => {
			if (kind === "throw") throw new Error("private");
			return kind === "error" ? { kind: "error", message: "Service unavailable" } : { kind: "signed_out" };
		};
		try {
			await act(async () =>
				root.render(
					<DataProvider store={store}>
						{kind === "missing_provider" ? (
							<GenerateBrief missing={false} />
						) : (
							<BriefGenerationProvider generate={generate}>
								<GenerateBrief missing={false} />
							</BriefGenerationProvider>
						)}
					</DataProvider>,
				),
			);
			expect(container.querySelector("button")!.textContent).toBe("Regenerate today’s brief");
			await act(async () => container.querySelector("button")!.click());
			expect(container.querySelector("button")!.disabled).toBe(false);
			expect(container.querySelector("output")!.textContent).toMatch(
				/session ended|Service unavailable|Could not start/u,
			);
			expect(container.textContent).not.toContain("private");
		} finally {
			await act(async () => root.unmount());
		}
	},
);

it("disables duplicate clicks, refreshes the completed brief, and permits retry after failure", async () => {
	const container = document.createElement("div");
	const root = createRoot(container);
	let state = "idle";
	let calls = 0;
	const reads: string[] = [];
	const store = new DataStore({
		get: async (path) => {
			reads.push(path);
			return { kind: "ok", body: { state, message: state === "failed" ? "Generation timed out. Try again." : "" } };
		},
	});
	try {
		await act(async () =>
			root.render(
				<DataProvider store={store}>
					<BriefGenerationProvider
						generate={async () => {
							calls++;
							state = "running";
							return { kind: "ok", body: {} };
						}}
					>
						<GenerateBrief missing />
					</BriefGenerationProvider>
				</DataProvider>,
			),
		);
		const button = container.querySelector("button")!;
		expect(button.textContent).toBe("Generate today’s brief");
		await act(async () => button.click());
		expect(button.disabled).toBe(true);
		await act(async () => button.click());
		expect(calls).toBe(1);
		state = "succeeded";
		await act(async () => store.refresh("/v1/life/brief/generation"));
		expect(reads).toContain("/v1/life/brief");
		expect(reads).toContain("/v1/today");
		expect(button.disabled).toBe(false);
		state = "failed";
		await act(async () => store.refresh("/v1/life/brief/generation"));
		expect(container.textContent).toContain("Generation timed out. Try again.");
		await act(async () => button.click());
		expect(calls).toBe(2);
	} finally {
		await act(async () => root.unmount());
	}
});
