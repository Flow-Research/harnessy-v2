/**
 * Layout breakpoints shared by the stylesheet and the screens. The phone query
 * matches the `@media (max-width: 760px)` block in `app.css`; the wide query is
 * where the detail pane sits beside its list.
 */
import { useEffect, useState } from "react";

export const WIDE_LAYOUT_QUERY = "(min-width: 1100px)";
export const PHONE_LAYOUT_QUERY = "(max-width: 760px)";

const matchesNow = (query: string, fallback: boolean): boolean =>
	typeof window.matchMedia === "function" ? window.matchMedia(query).matches : fallback;

/** Whether `query` matches; follows resizes. Without `matchMedia`, `fallback`. */
export const useMediaQuery = (query: string, fallback: boolean): boolean => {
	const [matches, setMatches] = useState(() => matchesNow(query, fallback));
	useEffect(() => {
		if (typeof window.matchMedia === "function") {
			const list = window.matchMedia(query);
			const onChange = () => setMatches(list.matches);
			onChange();
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		}
		return undefined;
	}, [query]);
	return matches;
};

/** Whether the window is wide enough for the side-by-side detail. */
export const useWideLayout = (): boolean => useMediaQuery(WIDE_LAYOUT_QUERY, true);

/** Whether the window has the phone layout, where tables become stacked cards. */
export const usePhoneLayout = (): boolean => useMediaQuery(PHONE_LAYOUT_QUERY, false);
