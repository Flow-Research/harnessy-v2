import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { SafeMarkdown } from "../../src/portal/app/components/SafeMarkdown.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("links prose URLs across blocks, preserves punctuation and code, and rejects unsafe targets", async () => {
	const container = document.createElement("div");
	const root = createRoot(container);
	const text = [
		"# https://example.test/heading",
		"",
		"Slides (https://docs.google.com/presentation/d/example/edit).",
		"",
		"- **https://example.test/path_(detail)** and <https://example.test/angle>",
		"",
		"> http://example.test/query?a=1&b=2#section",
		"",
		"| Reference |\n| --- |\n| https://example.test/table |",
		"",
		"[https://example.test/label](https://example.test/target)",
		"",
		"`https://example.test/code`",
		"",
		"```\nhttps://example.test/fenced\n```",
		"",
		"[bad](javascript:alert) [data](data:text/html,bad) https://user:password@example.test/ https://example.test/\\evil https://",
	].join("\n");
	try {
		await act(async () => root.render(<SafeMarkdown text={text} />));
		const links = [...container.querySelectorAll("a")];
		expect(links.map((a) => a.href)).toEqual([
			"https://example.test/heading",
			"https://docs.google.com/presentation/d/example/edit",
			"https://example.test/path_(detail)",
			"https://example.test/angle",
			"http://example.test/query?a=1&b=2#section",
			"https://example.test/table",
			"https://example.test/target",
		]);
		for (const link of links) {
			expect(link.target).toBe("_blank");
			expect(link.relList.contains("noopener")).toBe(true);
			expect(link.relList.contains("noreferrer")).toBe(true);
		}
		expect(container.textContent).toContain("Slides (https://docs.google.com/presentation/d/example/edit).");
		expect(container.querySelector("a a, code a, script")).toBeNull();
	} finally {
		await act(async () => root.unmount());
	}
});
