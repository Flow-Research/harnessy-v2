/**
 * One keyboard dispatcher for the whole app. The app listens on the window once;
 * global shortcuts (⌘K, `g` + letter) are decided there first, and only a key
 * they did not take is passed to the current screen's handler. A screen never
 * listens on the window itself, so it can never act on the second key of a
 * `g` chord or race the app for the same key press.
 */
import { createContext, type ReactNode, type RefObject, useContext, useEffect } from "react";

export type ScreenKeyHandler = (event: KeyboardEvent) => void;

const ScreenKeysContext = createContext<RefObject<ScreenKeyHandler | null> | null>(null);

export const ScreenKeysProvider = ({
	handler,
	children,
}: {
	handler: RefObject<ScreenKeyHandler | null>;
	children: ReactNode;
}) => <ScreenKeysContext.Provider value={handler}>{children}</ScreenKeysContext.Provider>;

/** Register the current screen's key handler for as long as the screen is shown. */
export const useScreenKeys = (handler: ScreenKeyHandler): void => {
	const slot = useContext(ScreenKeysContext);
	useEffect(() => {
		if (slot === null) return undefined;
		slot.current = handler;
		return () => {
			if (slot.current === handler) slot.current = null;
		};
	});
};

/** The focus is in a text field, where every key is typing. */
export const isTyping = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement && (target.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/u.test(target.tagName));

/** Nothing in particular has the focus (the page, or the main area after "Skip to content"): the key is meant for the page, not for a control. */
export const isPageFocus = (target: EventTarget | null): boolean =>
	!(target instanceof Element) ||
	target === document.body ||
	target === document.documentElement ||
	target.id === "main";

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keep Tab and Shift+Tab inside a modal `container`: from the last control to the first, and back. */
export const trapTab = (
	event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
	container: HTMLElement | null,
): void => {
	if (event.key !== "Tab" || container === null) return;
	const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (first === undefined || last === undefined) {
		event.preventDefault();
		return;
	}
	const active = document.activeElement;
	if (event.shiftKey && (active === first || active === container || !container.contains(active))) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && (active === last || !container.contains(active))) {
		event.preventDefault();
		first.focus();
	}
};
