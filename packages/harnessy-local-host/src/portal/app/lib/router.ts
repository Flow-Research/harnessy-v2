/**
 * A small hash router. Routes are `#/<screen>[/<rest>]`. Unknown screens fall
 * back to the Inbox. The sign-in fragment (`#code=…`) is not a route; the
 * session module consumes it first.
 */
import { useEffect, useState } from "react";

export const SCREENS = ["inbox", "today", "tasks", "jobs", "reviews", "learning", "connections"] as const;
export type Screen = (typeof SCREENS)[number];

export interface Route {
	readonly screen: Screen;
	/** Path segments after the screen, already URI-decoded. */
	readonly rest: ReadonlyArray<string>;
}

export const SCREEN_TITLES: Readonly<Record<Screen, string>> = {
	inbox: "Inbox",
	today: "Today",
	tasks: "Tasks",
	jobs: "Jobs",
	reviews: "Reviews",
	learning: "Learning",
	connections: "Connections",
};

const decode = (segment: string): string => {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
};

export const parseRoute = (hash: string): Route => {
	const parts = hash
		.replace(/^#\/?/u, "")
		.split("/")
		.filter((part) => part.length > 0);
	const screen = (SCREENS as ReadonlyArray<string>).includes(parts[0] ?? "") ? (parts[0] as Screen) : "inbox";
	return { screen, rest: screen === parts[0] ? parts.slice(1).map(decode) : [] };
};

export const routeHref = (screen: Screen, ...rest: ReadonlyArray<string>): string =>
	`#/${[screen, ...rest.map((part) => encodeURIComponent(part))].join("/")}`;

export interface HashLocation {
	readonly hash: () => string;
	readonly setHash: (hash: string) => void;
	readonly subscribe: (listener: () => void) => () => void;
}

export const browserLocation = (): HashLocation => ({
	hash: () => window.location.hash,
	setHash: (hash) => {
		window.location.hash = hash;
	},
	subscribe: (listener) => {
		window.addEventListener("hashchange", listener);
		return () => window.removeEventListener("hashchange", listener);
	},
});

/** The current route; re-renders on every hash change. */
export const useRoute = (location: HashLocation): Route => {
	const [route, setRoute] = useState(() => parseRoute(location.hash()));
	useEffect(() => location.subscribe(() => setRoute(parseRoute(location.hash()))), [location]);
	return route;
};
