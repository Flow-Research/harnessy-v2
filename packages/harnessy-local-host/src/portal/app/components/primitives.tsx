/**
 * Small display components. Text from the API is always rendered as React text
 * children, never as markup.
 */
import type { ReactNode } from "react";

import type { Tile } from "../lib/api-types.ts";
import { relativeTime } from "../lib/format.ts";

export type Tone = "ok" | "attention" | "danger" | "idle";

/** A status is a dot plus a word, never colour alone. */
export const StatusDot = ({ tone, label, pulse = false }: { tone: Tone; label: string; pulse?: boolean }) => (
	<span className={`status status-${tone}`}>
		<span className={pulse ? "dot dot-pulse" : "dot"} aria-hidden="true" />
		{label}
	</span>
);

export const Badge = ({ count, tone, label }: { count: number; tone: Tone; label: string }) =>
	count > 0 ? (
		<span className={`badge badge-${tone}`} title={label}>
			<span className="sr-only">{label}: </span>
			{count}
		</span>
	) : null;

export const Card = ({
	title,
	children,
	actions,
	className,
}: {
	title?: ReactNode;
	children: ReactNode;
	actions?: ReactNode;
	className?: string;
}) => (
	<section className={className === undefined ? "card" : `card ${className}`}>
		{title === undefined && actions === undefined ? null : (
			<header className="card-head">
				{title === undefined ? null : <h2 className="label">{title}</h2>}
				{actions}
			</header>
		)}
		{children}
	</section>
);

export const EmptyState = ({ title, tone, children }: { title: string; tone?: Tone; children?: ReactNode }) => (
	<div className={tone === undefined ? "empty" : `empty empty-${tone}`}>
		<p className={tone === undefined ? "empty-title" : `empty-title tone-${tone}`}>{title}</p>
		{children === undefined ? null : <div className="empty-body">{children}</div>}
	</div>
);

/** "read 4 s ago", with a dashed underline when the data is more than a minute old. */
export const FreshnessStamp = ({ at, now }: { at: number | undefined; now: number }) =>
	at === undefined ? (
		<span className="freshness">loading</span>
	) : (
		<span className={now - at > 60_000 ? "freshness stale" : "freshness"} title="When this screen last read the API">
			read {relativeTime(new Date(at).toISOString(), now)}
		</span>
	);

export interface TabItem<T extends string> {
	readonly id: T;
	readonly label: string;
	readonly count?: number;
}

/** View switches that change the route: links in a nav, the current one marked `aria-current="page"`. */
export const Tabs = <T extends string>({
	items,
	current,
	hrefOf,
	label,
}: {
	items: ReadonlyArray<TabItem<T>>;
	current: T;
	hrefOf: (id: T) => string;
	label: string;
}) => (
	<nav className="tabs" aria-label={label}>
		{items.map((item) => (
			<a
				key={item.id}
				href={hrefOf(item.id)}
				aria-current={item.id === current ? "page" : undefined}
				className={item.id === current ? "tab tab-current" : "tab"}
			>
				{item.label}
				{item.count === undefined ? null : <span className="tab-count">{item.count}</span>}
			</a>
		))}
	</nav>
);

/** Tone of each tile state (spec 2.5): missing and unsupported are idle, busy and recovering need attention, error and unsafe are danger. */
export const TILE_STATE_TONE: Readonly<Record<string, Tone>> = {
	missing: "idle",
	unsupported: "idle",
	busy: "attention",
	recovering: "attention",
	error: "danger",
	unsafe: "danger",
};

const STATE_TEXT: Readonly<Record<string, string>> = {
	busy: "Busy: another process is writing. Try again shortly",
	recovering: "Recovering: a write was interrupted. The owning service will repair it",
	unsupported: "Not supported here",
	unsafe: "Refused: the file failed a safety check",
	error: "Could not be read",
};

/** `missing` means different things: nothing configured, nothing written yet, or nothing recorded yet. */
const MISSING_TEXT: Readonly<Record<string, string>> = {
	config_missing: "Not set up yet",
	config_unavailable: "Not set up yet",
	workspace_missing: "Not set up yet",
	meeting_disabled: "Turned off in the configuration",
	not_loaded: "Not loaded in launchd",
	ledger_uninitialized: "Not started yet",
	catalog_uninitialized: "Not started yet",
	database_missing: "Not started yet",
	file_missing: "Not written yet",
	run_missing: "Not written yet",
	no_preview: "Not written yet",
	generation_unrecorded: "Nothing recorded yet",
};

/** The words for a tile that is not `ok`. */
export const tileStateText = (state: string, reason: string | undefined): string =>
	state === "missing"
		? ((reason === undefined ? undefined : MISSING_TEXT[reason]) ?? "Nothing here yet")
		: (STATE_TEXT[state] ?? "No data");

/** The line shown for a tile that is not `ok`. */
export const TileState = ({ tile }: { tile: Tile<unknown> | undefined }) => {
	if (tile === undefined) return <p className="muted">No data</p>;
	return (
		<p className={`tile-state tone-${TILE_STATE_TONE[tile.state] ?? "danger"}`}>
			{tileStateText(tile.state, tile.reason)}
			{tile.reason === undefined ? null : <span className="mono muted"> ({tile.reason})</span>}
		</p>
	);
};

/** Render `ok` tile data, or the tile's state line. */
export const WithTile = <A,>({ tile, children }: { tile: Tile<A> | undefined; children: (data: A) => ReactNode }) =>
	tile?.state === "ok" && tile.data !== undefined ? children(tile.data) : <TileState tile={tile} />;

export const Stat = ({ value, label, tone }: { value: ReactNode; label: string; tone?: Tone }) => (
	<div className="stat">
		<div className={tone === undefined ? "stat-value" : `stat-value tone-${tone}`}>{value}</div>
		<div className="stat-label">{label}</div>
	</div>
);
