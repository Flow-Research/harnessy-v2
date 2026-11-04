/**
 * The development showcase renders the app's real controls and its preview
 * switches change the document the way the app's own settings do.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Showcase } from "../../src/portal/app/showcase/Showcase.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
	container = document.createElement("div");
	document.body.replaceChildren(container);
	root = createRoot(container);
	await act(async () => root.render(<Showcase />));
});

afterEach(async () => {
	await act(async () => root.unmount());
	for (const name of ["data-theme", "data-density", "dir"]) document.documentElement.removeAttribute(name);
});

const press = async (label: string) =>
	act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith(label))!.click());

it("shows every button variant, and every button has an accessible name", () => {
	const classes = [...container.querySelectorAll("button")].map((b) => b.className);
	for (const variant of ["button button-primary", "button", "button button-quiet", "button button-danger"])
		expect(classes).toContain(variant);
	const unnamed = [...container.querySelectorAll("button")].filter(
		(b) => !(b.textContent?.trim() || b.getAttribute("aria-label")),
	);
	expect(unnamed).toEqual([]);
	expect(container.querySelector('[aria-busy="true"]')?.hasAttribute("disabled")).toBe(true);
});

it("switches theme, density and direction on the document, and toggles a pressed button", async () => {
	await press("Light theme");
	expect(document.documentElement.dataset.theme).toBe("light");
	await press("Light theme");
	expect(document.documentElement.dataset.theme).toBe("dark");
	await press("Compact density");
	expect(document.documentElement.dataset.density).toBe("compact");
	await press("Compact density");
	expect(document.documentElement.dataset.density).toBe("comfortable");
	await press("Right to left");
	expect(document.documentElement.dir).toBe("rtl");
	await press("Right to left");
	expect(document.documentElement.dir).toBe("ltr");
	await press("Toggle");
	expect(container.querySelector('[aria-pressed="true"]')?.textContent).toBe("Toggle (on)");
});
