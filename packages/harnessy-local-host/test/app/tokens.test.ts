/**
 * The palette meets WCAG AA for text: every text token reaches 4.5:1 on every
 * surface in both themes, and the stylesheet never colours text with a raw tone
 * token (those are for dots, rules, borders and badges).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = new URL("../../src/portal/app/styles/", import.meta.url);
const tokens = readFileSync(new URL("tokens.css", styles), "utf8");
const app = readFileSync(new URL("app.css", styles), "utf8");

/** The custom properties declared in the block that starts at `selector`. */
const block = (selector: string): Readonly<Record<string, string>> => {
	const start = tokens.indexOf(selector);
	expect(start).toBeGreaterThanOrEqual(0);
	const body = tokens.slice(tokens.indexOf("{", start) + 1, tokens.indexOf("}", start));
	return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/giu)].map((m) => [m[1]!, m[2]!]));
};

const luminance = (hex: string): number => {
	const [r, g, b] = [1, 3, 5].map((index) => {
		const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string): number => {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
};

const TEXT = ["text", "text-2", "muted", "ok-text", "attention-text", "danger-text", "idle-text"];
const SURFACES = ["bg", "panel", "raised"];

describe("palette contrast", () => {
	const dark = block(":root {");
	const light = block(':root:not([data-theme="dark"])');
	const manualLight = block(':root[data-theme="light"]');

	it("declares the light theme once for the system preference and once for the manual choice", () => {
		expect(manualLight).toEqual(light);
	});

	it.each([
		["dark", dark],
		["light", light],
	] as const)("keeps every text token at 4.5:1 or more on every %s surface", (_name, theme) => {
		const failures: string[] = [];
		for (const text of TEXT)
			for (const surface of SURFACES) {
				const ratio = contrast(theme[text]!, theme[surface]!);
				if (ratio < 4.5) failures.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
			}
		// Primary buttons and danger badges set text on a tone fill.
		if (contrast(theme["on-accent"]!, theme.ok!) < 4.5) failures.push("on-accent on ok");
		if (contrast(theme.bg!, theme.danger!) < 4.5) failures.push("bg on danger (badge)");
		expect(failures).toEqual([]);
	});

	it("rejects the unadjusted spec values the mockup corrected", () => {
		expect(contrast("#6e7580", "#1b1f26")).toBeLessThan(4.5);
		expect(contrast("#14917f", "#edefec")).toBeLessThan(4.5);
	});

	it("colours text only with the -text tokens", () => {
		expect(app.match(/(?:^|[\s;{])color:\s*var\(--(?:ok|attention|danger|idle)\)/gmu) ?? []).toEqual([]);
	});
});
