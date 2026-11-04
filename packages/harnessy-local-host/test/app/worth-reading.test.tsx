import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { readingHref, readingText, WorthReading } from "../../src/portal/app/components/WorthReading.tsx";
import { parseMarkdown } from "../../src/portal/app/lib/markdown.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Worth Reading", () => {
	it("renders bracketed article links and decoded descriptions without exposing URLs or interpreting HTML", async () => {
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<WorthReading
						blocks={parseMarkdown(
							[
								"- [Local&#45;first &amp; private](<https://example.com/article?q=one&amp;page=2>) — A description &#40;HN&#41; &lt;img src=x onerror=alert(1)&gt;",
								"- [Second article](http://example.org/) — Another description.",
								"- [Unsafe article](<javascript:alert>) — Still readable.",
							].join("\n"),
						)}
					/>,
				),
			);
			const links = [...container.querySelectorAll("a")];
			expect(links.map((link) => link.textContent)).toEqual(["Local-first & private", "Second article"]);
			expect(links[0]!.href).toBe("https://example.com/article?q=one&page=2");
			for (const link of links) {
				expect(link.target).toBe("_blank");
				expect(link.rel).toBe("noopener noreferrer");
			}
			expect(container.querySelectorAll(".reading-description")).toHaveLength(3);
			expect(links[0]!.nextElementSibling?.textContent).toContain("A description (HN)");
			expect(container.textContent).toContain("Unsafe article");
			expect(container.textContent).not.toMatch(/https?:|javascript:|&#|&amp;/u);
			expect(container.querySelector("img,script,iframe")).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});
	it.each([
		"javascript:alert(1)",
		"data:text/html,test",
		"file:///tmp/a",
		"//example.com",
		"https://user:pass@example.com",
		"https://example.com\\evil",
		"https://example.com/&#10;bad",
		"&#106;avascript:alert",
		"https://",
		"https://example.com/\u202etest",
	])("rejects unsafe target %s", (value) => {
		expect(readingHref(value)).toBeUndefined();
	});
	it("decodes decimal, hexadecimal and named entities as text", () => {
		expect(readingText("Local&#45;first &#x2014; &ldquo;private&rdquo; &amp; safe")).toBe(
			"Local-first — “private” & safe",
		);
	});
	it("keeps a title-only article clickable without an empty description and preserves prose links", async () => {
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<WorthReading
						blocks={parseMarkdown(
							"Reading context.\n\n- [Title only](https://example.com/title)\n- Explore https://example.com/context",
						)}
					/>,
				),
			);
			expect(container.textContent).toContain("Reading context.");
			expect(container.querySelectorAll(".reading-description")).toHaveLength(0);
			expect([...container.querySelectorAll("a")].map((a) => a.href)).toEqual([
				"https://example.com/title",
				"https://example.com/context",
			]);
		} finally {
			await act(async () => root.unmount());
		}
	});
});
