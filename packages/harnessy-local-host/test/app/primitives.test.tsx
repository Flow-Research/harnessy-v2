/**
 * The small display components, one branch at a time: what each renders with and
 * without its optional props, and the words and tone of every tile state.
 */
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	Badge,
	Card,
	EmptyState,
	FreshnessStamp,
	Stat,
	StatusDot,
	type TabItem,
	Tabs,
	TILE_STATE_TONE,
	TileState,
	tileStateText,
	WithTile,
} from "../../src/portal/app/components/primitives.tsx";
import type { Tile } from "../../src/portal/app/lib/api-types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const READ_AT = "2026-10-18T22:00:00.000Z";
const NOW = Date.parse(READ_AT);

let root: Root;
let container: HTMLDivElement;

const render = async (node: ReactNode): Promise<HTMLDivElement> => {
	await act(async () => root.render(node));
	return container;
};

const tile = <A,>(state: string, extra: { data?: A; reason?: string } = {}): Tile<A> =>
	({ state, readAt: READ_AT, ...extra }) as Tile<A>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
});

describe("StatusDot", () => {
	it("shows a still dot and the word by default", async () => {
		const view = await render(<StatusDot tone="ok" label="Running" />);
		expect(view.querySelector(".status")?.className).toBe("status status-ok");
		expect(view.querySelector(".status")?.textContent).toBe("Running");
		expect(view.querySelector(".dot")?.className).toBe("dot");
		expect(view.querySelector(".dot")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("pulses when asked to", async () => {
		const view = await render(<StatusDot tone="attention" label="Working" pulse />);
		expect(view.querySelector(".status")?.className).toBe("status status-attention");
		expect(view.querySelector(".dot")?.className).toBe("dot dot-pulse");
	});

	it("stays still when pulse is false", async () => {
		const view = await render(<StatusDot tone="danger" label="Failed" pulse={false} />);
		expect(view.querySelector(".dot")?.className).toBe("dot");
	});
});

describe("Badge", () => {
	it("shows a count above zero with its label for screen readers", async () => {
		const view = await render(<Badge count={3} tone="attention" label="Waiting" />);
		const badge = view.querySelector(".badge");
		expect(badge?.className).toBe("badge badge-attention");
		expect(badge?.getAttribute("title")).toBe("Waiting");
		expect(badge?.querySelector(".sr-only")?.textContent).toBe("Waiting: ");
		expect(badge?.textContent).toBe("Waiting: 3");
	});

	it("renders nothing for zero or less", async () => {
		expect((await render(<Badge count={0} tone="ok" label="Waiting" />)).innerHTML).toBe("");
		expect((await render(<Badge count={-1} tone="ok" label="Waiting" />)).innerHTML).toBe("");
	});
});

describe("Card", () => {
	it("renders only its children when it has no title or actions", async () => {
		const view = await render(
			<Card>
				<p>Body</p>
			</Card>,
		);
		expect(view.querySelector("section")?.className).toBe("card");
		expect(view.querySelector(".card-head")).toBeNull();
		expect(view.querySelector("section")?.textContent).toBe("Body");
	});

	it("renders a title, actions and an extra class", async () => {
		const view = await render(
			<Card title="Jobs" actions={<button type="button">Refresh</button>} className="wide">
				<p>Body</p>
			</Card>,
		);
		expect(view.querySelector("section")?.className).toBe("card wide");
		expect(view.querySelector(".card-head h2.label")?.textContent).toBe("Jobs");
		expect(view.querySelector(".card-head button")?.textContent).toBe("Refresh");
	});

	it("renders a head with a title and no actions", async () => {
		const view = await render(<Card title="Jobs">Body</Card>);
		expect(view.querySelector(".card-head")?.textContent).toBe("Jobs");
		expect(view.querySelector(".card-head button")).toBeNull();
	});

	it("renders a head with actions and no title", async () => {
		const view = await render(<Card actions={<button type="button">Refresh</button>}>Body</Card>);
		expect(view.querySelector(".card-head h2")).toBeNull();
		expect(view.querySelector(".card-head button")?.textContent).toBe("Refresh");
	});
});

describe("EmptyState", () => {
	it("renders a plain title with no tone and no body", async () => {
		const view = await render(<EmptyState title="Nothing waiting" />);
		expect(view.querySelector("div")?.className).toBe("empty");
		expect(view.querySelector("p")?.className).toBe("empty-title");
		expect(view.querySelector("p")?.textContent).toBe("Nothing waiting");
		expect(view.querySelector(".empty-body")).toBeNull();
	});

	it("renders a toned title with a body", async () => {
		const view = await render(
			<EmptyState title="Could not load" tone="danger">
				Try again
			</EmptyState>,
		);
		expect(view.querySelector("div")?.className).toBe("empty empty-danger");
		expect(view.querySelector("p")?.className).toBe("empty-title tone-danger");
		expect(view.querySelector(".empty-body")?.textContent).toBe("Try again");
	});
});

describe("FreshnessStamp", () => {
	it("says loading before the first read", async () => {
		const view = await render(<FreshnessStamp at={undefined} now={NOW} />);
		expect(view.querySelector("span")?.className).toBe("freshness");
		expect(view.querySelector("span")?.textContent).toBe("loading");
		expect(view.querySelector("span")?.hasAttribute("title")).toBe(false);
	});

	it("shows how long ago a fresh read happened", async () => {
		const view = await render(<FreshnessStamp at={NOW - 4_000} now={NOW} />);
		expect(view.querySelector("span")?.className).toBe("freshness");
		expect(view.querySelector("span")?.textContent).toBe("read 4 s ago");
		expect(view.querySelector("span")?.getAttribute("title")).toBe("When this screen last read the API");
	});

	it("is not stale at exactly one minute", async () => {
		const view = await render(<FreshnessStamp at={NOW - 60_000} now={NOW} />);
		expect(view.querySelector("span")?.className).toBe("freshness");
		expect(view.querySelector("span")?.textContent).toBe("read 1 min ago");
	});

	it("marks a read older than a minute as stale", async () => {
		const view = await render(<FreshnessStamp at={NOW - 120_000} now={NOW} />);
		expect(view.querySelector("span")?.className).toBe("freshness stale");
		expect(view.querySelector("span")?.textContent).toBe("read 2 min ago");
	});
});

describe("Tabs", () => {
	type TabId = "open" | "done";
	const items: ReadonlyArray<TabItem<TabId>> = [
		{ id: "open", label: "Open", count: 2 },
		{ id: "done", label: "Done" },
	];

	it("links each tab, marks the current one and shows counts where given", async () => {
		const view = await render(<Tabs items={items} current="open" hrefOf={(id) => `#/tasks/${id}`} label="Tasks" />);
		expect(view.querySelector("nav")?.getAttribute("aria-label")).toBe("Tasks");
		const links = [...view.querySelectorAll("a")];
		expect(links.map((link) => link.getAttribute("href"))).toEqual(["#/tasks/open", "#/tasks/done"]);
		expect(links.map((link) => link.className)).toEqual(["tab tab-current", "tab"]);
		expect(links.map((link) => link.getAttribute("aria-current"))).toEqual(["page", null]);
		expect(links[0]?.querySelector(".tab-count")?.textContent).toBe("2");
		expect(links[0]?.textContent).toBe("Open2");
		expect(links[1]?.querySelector(".tab-count")).toBeNull();
		expect(links[1]?.textContent).toBe("Done");
	});

	it("shows a count of zero", async () => {
		const view = await render(
			<Tabs
				items={[{ id: "open", label: "Open", count: 0 }]}
				current="done"
				hrefOf={(id) => `#/${id}`}
				label="Tasks"
			/>,
		);
		expect(view.querySelector(".tab-count")?.textContent).toBe("0");
		expect(view.querySelector("a")?.hasAttribute("aria-current")).toBe(false);
	});
});

describe("tileStateText", () => {
	it("explains a missing tile by its reason", () => {
		expect(tileStateText("missing", "config_missing")).toBe("Not set up yet");
		expect(tileStateText("missing", "meeting_disabled")).toBe("Turned off in the configuration");
		expect(tileStateText("missing", "not_loaded")).toBe("Not loaded in launchd");
		expect(tileStateText("missing", "database_missing")).toBe("Not started yet");
		expect(tileStateText("missing", "file_missing")).toBe("Not written yet");
		expect(tileStateText("missing", "generation_unrecorded")).toBe("Nothing recorded yet");
	});

	it("falls back for a missing tile with no reason or an unknown one", () => {
		expect(tileStateText("missing", undefined)).toBe("Nothing here yet");
		expect(tileStateText("missing", "something_new")).toBe("Nothing here yet");
	});

	it("names every other state and ignores its reason", () => {
		expect(tileStateText("busy", undefined)).toBe("Busy: another process is writing. Try again shortly");
		expect(tileStateText("recovering", "config_missing")).toBe(
			"Recovering: a write was interrupted. The owning service will repair it",
		);
		expect(tileStateText("unsupported", undefined)).toBe("Not supported here");
		expect(tileStateText("unsafe", undefined)).toBe("Refused: the file failed a safety check");
		expect(tileStateText("error", undefined)).toBe("Could not be read");
	});

	it("says No data for a state it does not know", () => {
		expect(tileStateText("ok", undefined)).toBe("No data");
		expect(tileStateText("something_new", "config_missing")).toBe("No data");
	});
});

describe("TileState", () => {
	it("says No data when there is no tile", async () => {
		const view = await render(<TileState tile={undefined} />);
		expect(view.querySelector("p")?.className).toBe("muted");
		expect(view.querySelector("p")?.textContent).toBe("No data");
	});

	it("shows the state's words in its tone, with the reason in brackets", async () => {
		const view = await render(<TileState tile={tile("missing", { reason: "file_missing" })} />);
		expect(view.querySelector("p")?.className).toBe("tile-state tone-idle");
		expect(view.querySelector("p")?.textContent).toBe("Not written yet (file_missing)");
		expect(view.querySelector("span")?.className).toBe("mono muted");
	});

	it("leaves the brackets out when the tile gives no reason", async () => {
		const view = await render(<TileState tile={tile("busy")} />);
		expect(view.querySelector("p")?.className).toBe("tile-state tone-attention");
		expect(view.querySelector("p")?.textContent).toBe("Busy: another process is writing. Try again shortly");
		expect(view.querySelector("span")).toBeNull();
	});

	it("uses the tone of every known state", async () => {
		for (const [state, tone] of Object.entries(TILE_STATE_TONE)) {
			const view = await render(<TileState tile={tile(state)} />);
			expect(view.querySelector("p")?.className).toBe(`tile-state tone-${tone}`);
		}
	});

	it("treats a state it does not know as danger", async () => {
		const view = await render(<TileState tile={tile("something_new")} />);
		expect(view.querySelector("p")?.className).toBe("tile-state tone-danger");
		expect(view.querySelector("p")?.textContent).toBe("No data");
	});
});

describe("WithTile", () => {
	const count = (data: { count: number }) => <strong>{data.count} items</strong>;

	it("renders the data of an ok tile", async () => {
		const view = await render(<WithTile tile={tile("ok", { data: { count: 5 } })}>{count}</WithTile>);
		expect(view.querySelector("strong")?.textContent).toBe("5 items");
		expect(view.querySelector(".tile-state")).toBeNull();
	});

	it("renders the state line of an ok tile that carries no data", async () => {
		const view = await render(<WithTile tile={tile<{ count: number }>("ok")}>{count}</WithTile>);
		expect(view.querySelector("strong")).toBeNull();
		expect(view.querySelector("p")?.className).toBe("tile-state tone-danger");
		expect(view.querySelector("p")?.textContent).toBe("No data");
	});

	it("renders the state line of a tile that is not ok, even with data", async () => {
		const view = await render(
			<WithTile tile={tile("error", { data: { count: 5 }, reason: "read_failed" })}>{count}</WithTile>,
		);
		expect(view.querySelector("strong")).toBeNull();
		expect(view.querySelector("p")?.className).toBe("tile-state tone-danger");
		expect(view.querySelector("p")?.textContent).toBe("Could not be read (read_failed)");
	});

	it("says No data when there is no tile", async () => {
		const view = await render(<WithTile<{ count: number }> tile={undefined}>{count}</WithTile>);
		expect(view.querySelector("strong")).toBeNull();
		expect(view.querySelector("p")?.className).toBe("muted");
	});
});

describe("Stat", () => {
	it("renders a value and its label", async () => {
		const view = await render(<Stat value={12} label="Open tasks" />);
		expect(view.querySelector(".stat-value")?.className).toBe("stat-value");
		expect(view.querySelector(".stat-value")?.textContent).toBe("12");
		expect(view.querySelector(".stat-label")?.textContent).toBe("Open tasks");
	});

	it("tones the value when given a tone", async () => {
		const view = await render(<Stat value="3" label="Failed" tone="danger" />);
		expect(view.querySelector(".stat-value")?.className).toBe("stat-value tone-danger");
	});
});
