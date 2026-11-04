/**
 * Layout rules jsdom cannot measure, read from the stylesheet: the phone
 * breakpoint the screens use matches the stylesheet's, a command chip's copy
 * button keeps its own width beside a long command, and inbox rows follow the
 * spec's 40 px (32 px compact) height.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PHONE_LAYOUT_QUERY, WIDE_LAYOUT_QUERY } from "../../src/portal/app/lib/media.ts";

const app = readFileSync(new URL("../../src/portal/app/styles/app.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../src/portal/app/styles/tokens.css", import.meta.url), "utf8");

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
const rule = (selector: string, sheet = app): Readonly<Record<string, string>> => {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const match = sheet.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "u"));
	expect(match, `no rule for ${selector}`).not.toBeNull();
	return Object.fromEntries(
		[...match![1]!.matchAll(/([a-z-]+):\s*([^;]+);/gu)].map((declaration) => [
			declaration[1]!,
			declaration[2]!.trim(),
		]),
	);
};

describe("layout rules", () => {
	it("switches tables to cards at the stylesheet's phone breakpoint", () => {
		expect(app).toContain(`@media ${PHONE_LAYOUT_QUERY} {`);
		expect(WIDE_LAYOUT_QUERY).toBe("(min-width: 1100px)");
	});

	it("keeps a command chip's copy button at its own width, so a long command never wraps it letter by letter", () => {
		expect(rule(".command-row > .icon-button")).toMatchObject({ flex: "none", "white-space": "nowrap" });
		// The command itself shrinks and scrolls inside the chip instead.
		expect(rule(".command-text")).toMatchObject({ "min-width": "0", "overflow-x": "auto", "white-space": "nowrap" });
	});

	it("lets a stacked card's text wrap instead of widening the page", () => {
		expect(rule(".stack-card")).toMatchObject({ "min-width": "0", "overflow-wrap": "anywhere" });
		expect(rule(".stack-card-meta")).toMatchObject({ "flex-wrap": "wrap" });
	});

	it("gives inbox rows the spec's height: 40 px, or 32 px in compact density, with title and context on one line", () => {
		expect(rule(":root", tokens)).toMatchObject({ "--row": "40px", "--list-row": "var(--row)" });
		expect(rule(':root[data-density="compact"]', tokens)).toMatchObject({ "--list-row": "32px" });
		// No vertical padding, so the row is exactly its minimum height when the text fits on one line.
		expect(rule(".row")).toMatchObject({ "min-height": "var(--list-row)", padding: "0 16px" });
		expect(rule(".row-main")).toMatchObject({ overflow: "hidden", "white-space": "nowrap" });
		expect(rule(".row-title")).toMatchObject({ "text-overflow": "ellipsis", "min-width": "0" });
		expect(rule(".row-context")).toMatchObject({ "text-overflow": "ellipsis", "line-height": "18px" });
	});
});
