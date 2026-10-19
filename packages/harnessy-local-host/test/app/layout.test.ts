/**
 * Layout rules jsdom cannot measure, read from the stylesheet: the phone
 * breakpoint the screens use matches the stylesheet's, and a command chip's
 * copy button keeps its own width beside a long command.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PHONE_LAYOUT_QUERY, WIDE_LAYOUT_QUERY } from "../../src/portal/app/lib/media.ts";

const app = readFileSync(new URL("../../src/portal/app/styles/app.css", import.meta.url), "utf8");

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
const rule = (selector: string): Readonly<Record<string, string>> => {
	const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{([^}]*)\\}`, "u").exec(
		app,
	);
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
});
