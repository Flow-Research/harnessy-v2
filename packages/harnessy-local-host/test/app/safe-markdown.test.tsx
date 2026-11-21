import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished } from "vitest";
import { LinkedText, MarkdownBlocks, SafeMarkdown } from "../../src/portal/app/components/SafeMarkdown.tsx";
import type { Block, Inline } from "../../src/portal/app/lib/markdown.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const render = async (element: ReactElement): Promise<HTMLElement> => {
	const container = document.createElement("div");
	const root = createRoot(container);
	onTestFinished(async () => {
		await act(async () => root.unmount());
	});
	await act(async () => root.render(element));
	return container;
};

const hrefs = (container: HTMLElement): ReadonlyArray<string | null> =>
	[...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

it("links a URL at the start of the text and one after a space", async () => {
	const container = await render(<LinkedText text="https://example.test/first then https://example.test/second" />);
	expect(hrefs(container)).toEqual(["https://example.test/first", "https://example.test/second"]);
	expect(container.textContent).toBe("https://example.test/first then https://example.test/second");
});

it("leaves a URL glued to a preceding word, path or scheme character as text", async () => {
	const text = "seehttps://example.test/a x/https://example.test/b 9https://example.test/c @https://example.test/d";
	const container = await render(<LinkedText text={text} />);
	expect(hrefs(container)).toEqual([]);
	expect(container.textContent).toBe(text);
});

it("drops closing brackets and punctuation that belong to the sentence, not the URL", async () => {
	const text =
		"(https://example.test/a). [https://example.test/b], {https://example.test/c}; https://example.test/d.), https://example.test/e_(f)!";
	const container = await render(<LinkedText text={text} />);
	expect(hrefs(container)).toEqual([
		"https://example.test/a",
		"https://example.test/b",
		"https://example.test/c",
		"https://example.test/d",
		"https://example.test/e_(f)",
	]);
	expect([...container.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
		"https://example.test/a",
		"https://example.test/b",
		"https://example.test/c",
		"https://example.test/d",
		"https://example.test/e_(f)",
	]);
	expect(container.textContent).toBe(text);
});

it("keeps a URL the external-link policy refuses as text and still links the next one", async () => {
	const text = "https://user:password@example.test/ and https://example.test/ok";
	const container = await render(<LinkedText text={text} />);
	expect(hrefs(container)).toEqual(["https://example.test/ok"]);
	expect(container.textContent).toBe(text);
});

it("renders text without any URL unchanged", async () => {
	const container = await render(<LinkedText text="nothing to link here" />);
	expect(container.querySelector("a")).toBeNull();
	expect(container.textContent).toBe("nothing to link here");
});

it("renders strong, emphasis and code, in prose and inside a link, without nesting anchors", async () => {
	const container = await render(
		<SafeMarkdown
			text={[
				"Some **strong https://example.test/strong** and *em https://example.test/em* and `https://example.test/code`.",
				"",
				"[**bold** and *soft* `lit` https://example.test/label](https://example.test/target)",
			].join("\n")}
		/>,
	);
	expect(hrefs(container)).toEqual([
		"https://example.test/strong",
		"https://example.test/em",
		"https://example.test/target",
	]);
	expect(container.querySelector("strong a")?.textContent).toBe("https://example.test/strong");
	expect(container.querySelector("em a")?.textContent).toBe("https://example.test/em");
	expect(container.querySelector("p > code.inline-code")?.textContent).toBe("https://example.test/code");
	const link = container.querySelector('a[href="https://example.test/target"]');
	expect(link?.getAttribute("target")).toBe("_blank");
	expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
	expect(link?.querySelector("strong")?.textContent).toBe("bold");
	expect(link?.querySelector("em")?.textContent).toBe("soft");
	expect(link?.querySelector("code.inline-code")?.textContent).toBe("lit");
	expect(link?.textContent).toBe("bold and soft lit https://example.test/label");
	expect(container.querySelector("a a")).toBeNull();
});

it("shows a link with a refused target as its label followed by the target, never as an anchor", async () => {
	const container = await render(
		<SafeMarkdown text="[**label** https://example.test/inside](ftp://example.test/file) [script](javascript:alert)" />,
	);
	expect(container.querySelector("a")).toBeNull();
	const spans = [...container.querySelectorAll("span.link-text")];
	expect(spans.map((span) => span.textContent)).toEqual([
		"label https://example.test/inside (ftp://example.test/file)",
		"script (javascript:alert)",
	]);
	expect(spans[0]?.querySelector("strong")?.textContent).toBe("label");
	expect(spans.map((span) => span.querySelector("span.muted")?.textContent)).toEqual([
		"(ftp://example.test/file)",
		"(javascript:alert)",
	]);
});

it("renders task items, plain items and a nested list in a bullet list", async () => {
	const container = await render(
		<SafeMarkdown
			text={["- [x] shipped", "- [ ] pending", "- plain", "  - nested", "  - [X] nested done"].join("\n")}
		/>,
	);
	const list = container.querySelector(".markdown > ul");
	expect(container.querySelector(".markdown > ol")).toBeNull();
	const items = [...(list?.children ?? [])];
	expect(items.map((item) => item.className)).toEqual(["task-done", "task-open", ""]);
	expect(items.map((item) => item.hasAttribute("class"))).toEqual([true, true, false]);

	const [done, open, plain] = items;
	expect(done?.querySelector(".checkbox [aria-hidden='true']")?.textContent).toBe("☑");
	expect(done?.querySelector(".checkbox .sr-only")?.textContent).toBe("done: ");
	expect(done?.textContent).toBe("☑done: shipped");
	expect(done?.querySelector("ul")).toBeNull();
	expect(open?.querySelector(".checkbox [aria-hidden='true']")?.textContent).toBe("☐");
	expect(open?.querySelector(".checkbox .sr-only")?.textContent).toBe("open: ");
	expect(open?.textContent).toBe("☐open: pending");
	expect(plain?.querySelector(":scope > .checkbox")).toBeNull();

	const nested = [...(plain?.querySelector(":scope > ul")?.children ?? [])];
	expect(nested.map((item) => item.className)).toEqual(["", "task-done"]);
	expect(nested.map((item) => item.textContent)).toEqual(["nested", "☑done: nested done"]);
});

it("renders a numbered list as an ordered list", async () => {
	const container = await render(<SafeMarkdown text={["1. first", "2. second"].join("\n")} />);
	expect(container.querySelector(".markdown > ul")).toBeNull();
	expect([...container.querySelectorAll(".markdown > ol > li")].map((item) => item.textContent)).toEqual([
		"first",
		"second",
	]);
});

it("renders each heading one level down and stops at h6", async () => {
	const container = await render(
		<SafeMarkdown text={["# one", "## two", "### three", "#### four", "##### five", "###### six"].join("\n")} />,
	);
	expect(container.querySelector("h1")).toBeNull();
	expect([...container.querySelectorAll(".md-heading")].map((h) => `${h.tagName} ${h.textContent}`)).toEqual([
		"H2 one",
		"H3 two",
		"H4 three",
		"H5 four",
		"H6 five",
		"H6 six",
	]);
});

it("renders a quote, a fenced block, a rule and a table with its rows", async () => {
	const container = await render(
		<SafeMarkdown
			text={[
				"> quoted **words**",
				"",
				"```",
				"<b>not markup</b> https://example.test/fenced",
				"```",
				"",
				"---",
				"",
				"| Name | Link |",
				"| --- | --- |",
				"| `a` | https://example.test/row |",
				"| b | [label](https://example.test/cell) |",
			].join("\n")}
		/>,
	);
	expect(container.querySelector("blockquote p strong")?.textContent).toBe("words");
	expect(container.querySelector("pre.code-block > code")?.textContent).toBe(
		"<b>not markup</b> https://example.test/fenced",
	);
	expect(container.querySelector("pre a, pre b")).toBeNull();
	expect(container.querySelectorAll(".markdown > hr")).toHaveLength(1);

	const table = container.querySelector(".table-scroll > table.md-table");
	expect([...(table?.querySelectorAll("thead th") ?? [])].map((cell) => cell.textContent)).toEqual(["Name", "Link"]);
	const rows = [...(table?.querySelectorAll("tbody tr") ?? [])];
	expect(rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent))).toEqual([
		["a", "https://example.test/row"],
		["b", "label"],
	]);
	expect(rows[0]?.querySelector("td code.inline-code")?.textContent).toBe("a");
	expect(hrefs(container)).toEqual(["https://example.test/row", "https://example.test/cell"]);
});

it("renders a table that has a header and no rows", async () => {
	const container = await render(<SafeMarkdown text={["| Only |", "| --- |"].join("\n")} />);
	expect(container.querySelector("thead th")?.textContent).toBe("Only");
	expect(container.querySelectorAll("tbody tr")).toHaveLength(0);
});

it("renders nothing for a block or an inline node of a kind it does not know", async () => {
	const unknownBlock = { type: "mystery", text: "hidden block" } as unknown as Block;
	const unknownInline = { type: "mystery", text: "hidden inline" } as unknown as Inline;
	const blocks: ReadonlyArray<Block> = [
		unknownBlock,
		{
			type: "paragraph",
			children: [{ type: "text", text: "before " }, unknownInline, { type: "text", text: "after" }],
		},
		{
			type: "paragraph",
			children: [{ type: "link", href: "https://example.test/known", children: [unknownInline] }],
		},
	];
	const container = await render(<MarkdownBlocks blocks={blocks} />);
	expect(container.children).toHaveLength(2);
	expect(container.textContent).toBe("before after");
	expect(hrefs(container)).toEqual(["https://example.test/known"]);
	expect(container.querySelector("a")?.textContent).toBe("");
});

it("renders an empty document as an empty markdown container", async () => {
	const container = await render(<SafeMarkdown text="" />);
	expect(container.querySelector(".markdown")?.childNodes).toHaveLength(0);
});
