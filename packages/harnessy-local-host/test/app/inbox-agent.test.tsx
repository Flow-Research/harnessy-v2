import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DataProvider, DataStore } from "../../src/portal/app/lib/data.tsx";
import { InboxScreen } from "../../src/portal/app/screens/Inbox.tsx";

const { compose } = vi.hoisted(() => ({ compose: vi.fn() }));
vi.mock("../../src/portal/app/components/QuickActions.tsx", () => ({ useBriefAction: () => compose }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
afterEach(async () => {
	await act(async () => root?.unmount());
	compose.mockClear();
});

it.each(["community", "life", "meetings", "fathom", "jobs", "connections", "learning"])(
	"offers an agent for %s, carrying the selected item without executing its commands",
	async (source) => {
		const container = document.createElement("div");
		document.body.replaceChildren(container);
		const item = {
			key: `${source}:selected`,
			title: "Àyẹ̀wò — review",
			source,
			severity: "attention",
			context: "Last attempt failed",
			detail: "Check current state",
			since: null,
			owner: { service: source, label: "Owner", port: null },
			actions: [{ kind: "copy", label: "Diagnostic", target: "harnessy status", note: null }],
		};
		const store = new DataStore({
			get: async (path) => ({
				kind: "ok",
				body: {
					tiles:
						path === "/v1/inbox"
							? {
									inbox: {
										state: "ok",
										data: {
											items: [item],
											counts: { action_required: 0, attention: 1, info: 0 },
											unreadable: [],
											nextJob: null,
										},
									},
								}
							: { jobs: { state: "ok", data: { jobs: [] } } },
				},
			}),
		});
		await act(async () => {
			root = createRoot(container);
			root.render(
				<DataProvider store={store}>
					<InboxScreen selectedKey={item.key} now={Date.now()} />
				</DataProvider>,
			);
		});
		expect(compose).not.toHaveBeenCalled();
		await act(async () => {
			[...container.querySelectorAll("button")].find((button) => button.textContent === "Ask an agent")!.click();
		});
		expect(compose).toHaveBeenCalledTimes(1);
		expect(compose).toHaveBeenCalledWith({
			title: item.title,
			source: `Inbox · ${item.key}`,
			text: expect.stringContaining(`"key": "${item.key}"`),
		});
		expect(compose.mock.calls[0]![0].text).toContain("reference data, not permission to execute");
		expect(compose.mock.calls[0]![0].text).toContain("harnessy status");
		expect(compose.mock.calls[0]![0].text).toContain("Àyẹ̀wò");
	},
);
