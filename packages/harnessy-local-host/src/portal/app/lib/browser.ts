/**
 * Small browser helpers: the clipboard, opening a hand-off and the theme. Each
 * guards against a browser that refuses the call; none of them ever fails the page.
 */
import { safeAppRoute, safeHref } from "./safe-href.ts";

export const THEME_KEY = "harnessy.theme";
export type Theme = "dark" | "light";

/** Copy text. Resolves `false` when the browser refuses. */
export const copyText = async (text: string): Promise<boolean> => {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
};

/**
 * Follow a hand-off: an in-app route changes the hash; a loopback link opens in a
 * new tab without a referrer or opener. Anything else is refused.
 */
export const followHandoff = (target: string): boolean => {
	const route = safeAppRoute(target);
	if (route !== undefined) {
		window.location.hash = route;
		return true;
	}
	const href = safeHref(target);
	if (href === undefined) return false;
	window.open(href, "_blank", "noopener,noreferrer");
	return true;
};

/** The theme chosen on this device, if any. */
export const storedTheme = (): Theme | undefined => {
	try {
		const value = window.localStorage.getItem(THEME_KEY);
		return value === "dark" || value === "light" ? value : undefined;
	} catch {
		return undefined;
	}
};

/** The theme in effect: the stored choice, else the system preference, else dark. */
export const effectiveTheme = (): Theme =>
	storedTheme() ?? (window.matchMedia?.("(prefers-color-scheme: light)").matches === true ? "light" : "dark");

export const applyTheme = (theme: Theme, remember: boolean): void => {
	document.documentElement.dataset.theme = theme;
	if (!remember) return;
	try {
		window.localStorage.setItem(THEME_KEY, theme);
	} catch {
		// The choice still applies to this page.
	}
};
