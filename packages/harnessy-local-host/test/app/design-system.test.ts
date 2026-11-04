/**
 * The design-system contract (docs/portal-design-system.md), read from source.
 *
 * These checks catch the failure that made Quick Actions unreadable in the light
 * theme: a stylesheet used `var(--surface)`, which no theme defined, and fell back
 * to a hard-coded dark colour beside browser-default buttons. Every token a
 * stylesheet uses must exist, colours come from tokens.css only, and every
 * button in the app takes a class from the system instead of browser chrome.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDir = fileURLToPath(new URL("../../src/portal/app/", import.meta.url));

const filesUnder = (directory: string, extension: string): string[] =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? filesUnder(join(directory, entry.name), extension)
			: entry.name.endsWith(extension)
				? [join(directory, entry.name)]
				: [],
	);

const relativeName = (path: string) => path.slice(appDir.length);
const tokens = readFileSync(join(appDir, "styles", "tokens.css"), "utf8");
const stylesheets = filesUnder(appDir, ".css").filter((path) => !path.endsWith("fonts.css"));
const components = filesUnder(appDir, ".tsx");

describe("design-system contract", () => {
	it("finds the stylesheets and components it checks", () => {
		expect(stylesheets.map(relativeName).sort()).toEqual(
			expect.arrayContaining([
				"components/quick-actions.css",
				"screens/terminal.css",
				"styles/app.css",
				"styles/tokens.css",
			]),
		);
		expect(components.length).toBeGreaterThan(15);
	});

	it("defines every custom property a stylesheet uses", () => {
		const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/gu)].map((match) => match[1]));
		const undefinedTokens = stylesheets.flatMap((path) =>
			[...readFileSync(path, "utf8").matchAll(/var\((--[a-z0-9-]+)/gu)]
				.map((match) => match[1]!)
				.filter((name) => !defined.has(name))
				.map((name) => `${relativeName(path)}: ${name}`),
		);
		expect(undefinedTokens).toEqual([]);
	});

	it("takes colours from tokens.css only", () => {
		const rawColours = stylesheets
			.filter((path) => !path.endsWith("tokens.css"))
			.flatMap((path) =>
				readFileSync(path, "utf8")
					.split("\n")
					.map((line, index) => [line, index + 1] as const)
					.filter(([line]) => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu.test(line.replace(/\/\*.*?\*\//gu, "")))
					.map(([line, number]) => `${relativeName(path)}:${number}: ${line.trim()}`),
			);
		expect(rawColours).toEqual([]);
	});

	it("gives every button in the app a class, so none falls back to browser chrome", () => {
		const unclassed = components.flatMap((path) =>
			[...readFileSync(path, "utf8").matchAll(/<button\b[^>]*?>/gsu)]
				.filter((match) => !/\bclassName=/u.test(match[0]))
				.map((match) => `${relativeName(path)}: ${match[0].replace(/\s+/gu, " ").slice(0, 80)}`),
		);
		expect(unclassed).toEqual([]);
	});

	it("raises every control to 44 px on touch screens", () => {
		const coarse = tokens.slice(tokens.indexOf("@media (pointer: coarse)"));
		expect(coarse).toMatch(/--control-h:\s*44px/u);
		expect(coarse).toMatch(/--control-h-sm:\s*44px/u);
	});
});
