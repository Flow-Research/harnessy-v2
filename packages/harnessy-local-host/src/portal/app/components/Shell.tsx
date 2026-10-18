/**
 * The app frame: the left rail (a bottom bar at phone width), the top bar and
 * the screen area.
 */
import {
	BookOpen,
	CircleCheck,
	Cpu,
	Ellipsis,
	Inbox,
	Megaphone,
	Moon,
	Plug,
	RefreshCw,
	Search,
	Sun,
	SunMedium,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { clockTime } from "../lib/format.ts";
import { routeHref, SCREEN_TITLES, type Screen } from "../lib/router.ts";
import { Badge, FreshnessStamp } from "./primitives.tsx";

const ICONS: Readonly<Record<Screen, typeof Inbox>> = {
	inbox: Inbox,
	today: Sun,
	tasks: CircleCheck,
	jobs: Cpu,
	reviews: Megaphone,
	learning: BookOpen,
	connections: Plug,
};

/** Rail order and the `g` + letter shortcut of each screen. */
export const NAV: ReadonlyArray<{ readonly screen: Screen; readonly key: string }> = [
	{ screen: "inbox", key: "i" },
	{ screen: "today", key: "t" },
	{ screen: "tasks", key: "k" },
	{ screen: "jobs", key: "j" },
	{ screen: "reviews", key: "r" },
	{ screen: "learning", key: "l" },
	{ screen: "connections", key: "c" },
];

const PHONE_PRIMARY: ReadonlyArray<Screen> = ["inbox", "today", "tasks", "jobs"];

/** Sub-pages of a screen that the rail lists under it and the breadcrumb names. */
export const SUB_PAGES: Readonly<
	Partial<Record<Screen, ReadonlyArray<{ readonly id: string; readonly title: string }>>>
> = {
	reviews: [
		{ id: "meetings", title: "Meetings" },
		{ id: "community", title: "Community" },
	],
	connections: [{ id: "tools", title: "Tools & integrations" }],
};

/** The title of `screen`'s sub-page `id`, if it is one. */
export const subPageTitle = (screen: Screen, id: string | undefined): string | undefined =>
	SUB_PAGES[screen]?.find((page) => page.id === id)?.title;

export interface ShellBadges {
	readonly inbox: number;
	readonly jobs: number;
}

const NavLink = ({
	screen,
	current,
	shortcut,
	badges,
	compact = false,
}: {
	screen: Screen;
	current: Screen;
	shortcut?: string;
	badges: ShellBadges;
	compact?: boolean;
}) => {
	const Icon = ICONS[screen];
	return (
		<a
			href={routeHref(screen)}
			className={screen === current ? "nav-link nav-current" : "nav-link"}
			aria-current={screen === current ? "page" : undefined}
		>
			<Icon size={16} strokeWidth={1.5} aria-hidden="true" />
			<span className="nav-label">{SCREEN_TITLES[screen]}</span>
			{shortcut === undefined || compact ? null : (
				<kbd className="nav-key" aria-label={`Shortcut g then ${shortcut}`}>
					{shortcut}
				</kbd>
			)}
			{screen === "inbox" ? <Badge count={badges.inbox} tone="danger" label="Needs you" /> : null}
			{screen === "jobs" ? <Badge count={badges.jobs} tone="danger" label="Jobs in error" /> : null}
		</a>
	);
};

export const Rail = ({ current, sub, badges }: { current: Screen; sub?: string | undefined; badges: ShellBadges }) => (
	<nav className="rail" aria-label="Main">
		<a className="brand" href={routeHref("inbox")}>
			<span className="brand-mark" aria-hidden="true">
				<SunMedium size={20} strokeWidth={1.8} />
			</span>
			<span className="brand-name">Harnessy</span>
		</a>
		<div className="rail-links">
			{NAV.map((item) => (
				<div key={item.screen} className="rail-item">
					<NavLink screen={item.screen} current={current} shortcut={item.key} badges={badges} />
					{item.screen === "reviews"
						? (SUB_PAGES.reviews ?? []).map((page) => {
								const here = current === "reviews" && sub === page.id;
								return (
									<a
										key={page.id}
										href={routeHref("reviews", page.id)}
										className={here ? "nav-sub nav-current" : "nav-sub"}
										aria-current={here ? "page" : undefined}
									>
										{page.title}
									</a>
								);
							})
						: null}
				</div>
			))}
		</div>
		<a
			className="rail-tools"
			href={routeHref("connections", "tools")}
			aria-current={current === "connections" && sub === "tools" ? "page" : undefined}
		>
			<Plug size={16} strokeWidth={1.5} aria-hidden="true" />
			Tools &amp; integrations
		</a>
		<p className="rail-note">Opens the cockpit (harnessy web) in a new tab. Agent tools, OAuth, secrets.</p>
	</nav>
);

export const BottomBar = ({ current, badges }: { current: Screen; badges: ShellBadges }) => {
	const [more, setMore] = useState(false);
	const inMore = !PHONE_PRIMARY.includes(current);
	return (
		<nav className="bottom-bar" aria-label="Main">
			{PHONE_PRIMARY.map((screen) => (
				<NavLink key={screen} screen={screen} current={current} badges={badges} compact />
			))}
			<button
				type="button"
				className={inMore ? "nav-link nav-current" : "nav-link"}
				aria-expanded={more}
				onClick={() => setMore(!more)}
			>
				<Ellipsis size={16} strokeWidth={1.5} aria-hidden="true" />
				<span className="nav-label">More</span>
			</button>
			{more ? (
				<div className="more-sheet">
					{NAV.filter((item) => !PHONE_PRIMARY.includes(item.screen)).map((item) => (
						<a
							key={item.screen}
							href={routeHref(item.screen)}
							className="more-link"
							onClick={() => setMore(false)}
						>
							{SCREEN_TITLES[item.screen]}
						</a>
					))}
				</div>
			) : null}
		</nav>
	);
};

export const TopBar = ({
	screen,
	sub,
	fetchedAt,
	now,
	sessionExpiresAt,
	theme,
	onToggleTheme,
	onOpenPalette,
	onRefresh,
}: {
	screen: Screen;
	sub?: string | undefined;
	fetchedAt: number | undefined;
	now: number;
	sessionExpiresAt: number | undefined;
	theme: "dark" | "light";
	onToggleTheme: () => void;
	onOpenPalette: () => void;
	onRefresh: () => void;
}) => (
	<header className="top-bar">
		<nav className="crumbs" aria-label="Breadcrumb">
			Harnessy /{" "}
			{subPageTitle(screen, sub) === undefined ? (
				<span className="crumb-current" aria-current="page">
					{SCREEN_TITLES[screen]}
				</span>
			) : (
				<>
					<a href={routeHref(screen)}>{SCREEN_TITLES[screen]}</a> ›{" "}
					<span className="crumb-current" aria-current="page">
						{subPageTitle(screen, sub)}
					</span>
				</>
			)}
		</nav>
		<div className="top-spacer" />
		<FreshnessStamp at={fetchedAt} now={now} />
		<button type="button" className="icon-button" onClick={onRefresh} aria-label="Read again">
			<RefreshCw size={14} strokeWidth={1.5} />
		</button>
		{sessionExpiresAt === undefined ? null : (
			<span className="session-chip" title="Read-only sign-in. Actions arrive in Phase B.">
				Read until {clockTime(sessionExpiresAt)} · actions locked
			</span>
		)}
		<button type="button" className="search-button" onClick={onOpenPalette} aria-keyshortcuts="Meta+K Control+K">
			<Search size={14} strokeWidth={1.5} aria-hidden="true" />
			<span>Search or copy…</span>
			<kbd>⌘K</kbd>
		</button>
		<button
			type="button"
			className="icon-button"
			onClick={onToggleTheme}
			aria-label={theme === "dark" ? "Use the light theme" : "Use the dark theme"}
		>
			{theme === "dark" ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
		</button>
	</header>
);

export const ScreenHeader = ({ title, children }: { title: string; children?: ReactNode }) => (
	<div className="screen-header">
		<h1 className="screen-title">{title}</h1>
		{children}
	</div>
);
