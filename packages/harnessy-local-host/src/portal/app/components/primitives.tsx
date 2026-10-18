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

export const EmptyState = ({ title, children }: { title: string; children?: ReactNode }) => (
	<div className="empty">
		<p className="empty-title">{title}</p>
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

export const Tabs = <T extends string>({
	items,
	current,
	onSelect,
	label,
}: {
	items: ReadonlyArray<TabItem<T>>;
	current: T;
	onSelect: (id: T) => void;
	label: string;
}) => (
	<div className="tabs" role="tablist" aria-label={label}>
		{items.map((item) => (
			<button
				key={item.id}
				type="button"
				role="tab"
				aria-selected={item.id === current}
				className={item.id === current ? "tab tab-current" : "tab"}
				onClick={() => onSelect(item.id)}
			>
				{item.label}
				{item.count === undefined ? null : <span className="tab-count">{item.count}</span>}
			</button>
		))}
	</div>
);

const STATE_TEXT: Readonly<Record<string, string>> = {
	missing: "Not set up yet",
	busy: "Busy: another process is writing. Try again shortly",
	recovering: "Recovering: a write was interrupted. The owning service will repair it",
	unsupported: "Not supported here",
	unsafe: "Refused: the file failed a safety check",
	error: "Could not be read",
};

/** The line shown for a tile that is not `ok`. */
export const TileState = ({ tile }: { tile: Tile<unknown> | undefined }) => {
	if (tile === undefined) return <p className="muted">No data</p>;
	const summary = STATE_TEXT[tile.state] ?? "No data";
	return (
		<p
			className={
				tile.state === "missing" || tile.state === "busy" ? "tile-state tone-attention" : "tile-state tone-danger"
			}
		>
			{summary}
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
