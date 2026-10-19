/**
 * Inbox, the home screen: everything that needs Julian, ranked by the server.
 * Keys: j/k move, Enter follows the primary action, c copies the first command,
 * o opens the owning service or screen.
 */
import { BookOpen, Cpu, Megaphone, Mic, Plug, Radio, Sun } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { ActionList } from "../components/actions.tsx";
import { DetailPane } from "../components/DetailPane.tsx";
import { EmptyState, Stat, StatusDot, type Tone, WithTile } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import type { InboxItem, InboxResponse, JobsResponse } from "../lib/api-types.ts";
import { copyText, followHandoff } from "../lib/browser.ts";
import { useResource } from "../lib/data.tsx";
import { dateTime, greeting, plural, relativeTime, visibleText } from "../lib/format.ts";
import { isPageFocus, useScreenKeys } from "../lib/keys.tsx";
import { routeHref } from "../lib/router.ts";

const SOURCE_ICONS = {
	community: Megaphone,
	life: Sun,
	meetings: Mic,
	fathom: Radio,
	jobs: Cpu,
	connections: Plug,
	learning: BookOpen,
} as const;

export const SEVERITY: Readonly<Record<InboxItem["severity"], { readonly label: string; readonly tone: Tone }>> = {
	action_required: { label: "Needs you", tone: "danger" },
	attention: { label: "Attention", tone: "attention" },
	info: { label: "Info", tone: "ok" },
};

/** Keyboard handling for the list, kept apart so it can be tested without a DOM. */
export const inboxKeyAction = (
	key: string,
	items: ReadonlyArray<InboxItem>,
	selected: number,
): { readonly kind: "select"; readonly index: number } | { readonly kind: "primary" | "copy" | "open" } | undefined => {
	if (items.length === 0) return undefined;
	if (key === "j") return { kind: "select", index: Math.min(items.length - 1, selected + 1) };
	if (key === "k") return { kind: "select", index: Math.max(0, selected - 1) };
	if (key === "Enter") return { kind: "primary" };
	if (key === "c") return { kind: "copy" };
	if (key === "o") return { kind: "open" };
	return undefined;
};

/** The headline when the list is empty: "Nothing needs you." only when every source was read. */
export const emptyInboxTitle = (unreadable: number): string =>
	unreadable === 0 ? "Nothing needs you." : `Nothing found, but ${plural(unreadable, "source")} could not be read.`;

const Detail = ({ item }: { item: InboxItem }) => (
	<>
		<p className="label">
			{item.source} · owned by {item.owner.label}
		</p>
		<h2 className="detail-title">{visibleText(item.title)}</h2>
		<p className="text-2">{visibleText(item.detail)}</p>
		{item.context === "" ? null : <p className="muted">{visibleText(item.context)}</p>}
		<ActionList actions={item.actions} />
		<p className="fine-print">
			Approvals and publishing stay in the owning service. Harnessy shows, links and lets you copy; it runs nothing.
		</p>
	</>
);

export const InboxScreen = ({ selectedKey, now }: { selectedKey: string | undefined; now: number }) => {
	const inbox = useResource<InboxResponse>("/v1/inbox");
	const jobs = useResource<JobsResponse>("/v1/jobs");
	const tile = inbox.data?.tiles.inbox;
	const items = useMemo(() => (tile?.state === "ok" ? (tile.data?.items ?? []) : []), [tile]);
	const index = Math.max(
		0,
		items.findIndex((item) => item.key === selectedKey),
	);
	const selected = items[index];
	const list = useRef<HTMLUListElement>(null);
	const [notice, setNotice] = useState("");
	const select = (next: number) => {
		const item = items[next];
		if (item !== undefined) window.location.replace(routeHref("inbox", item.key));
	};
	const copyCommand = (item: InboxItem) => {
		const command = item.actions.find((candidate) => candidate.kind === "copy");
		if (command === undefined) return;
		void copyText(command.target).then((ok) =>
			setNotice(ok ? `Copied: ${visibleText(command.target)}` : "The browser refused to copy."),
		);
	};

	// The app passes only keys no global shortcut took. On the page or in the list, j/k/c/o act;
	// Enter acts only when no control has the focus, so a focused link or button keeps its own Enter.
	useScreenKeys((event) => {
		const onPage = isPageFocus(event.target);
		const inList = event.target instanceof Node && list.current?.contains(event.target) === true;
		if (!onPage && !inList) return;
		if (event.key === "Enter" && !onPage) return;
		const action = inboxKeyAction(event.key, items, index);
		if (action === undefined) return;
		event.preventDefault();
		const item = items[index]!;
		if (action.kind === "select") select(action.index);
		else if (action.kind === "copy") copyCommand(item);
		else {
			const handoff = item.actions.find((candidate) => candidate.kind === "handoff");
			if (handoff !== undefined) followHandoff(handoff.target);
			else if (action.kind === "primary") copyCommand(item);
		}
	});

	const jobList = jobs.data?.tiles.jobs.state === "ok" ? jobs.data.tiles.jobs.data : undefined;
	const supervised = jobList?.jobs.filter((job) => job.kind !== "on-demand") ?? [];
	const healthy = supervised.filter((job) => job.health === "ok").length;
	const unreadable = tile?.state === "ok" ? (tile.data?.unreadable.length ?? 0) : 0;

	return (
		<div className="screen">
			<ScreenHeader title={`${greeting(now)}, Julian`}>
				{tile?.state === "ok" && tile.data !== undefined ? (
					<p className="text-2">
						{tile.data.counts.action_required === 0
							? tile.data.items.length === 0
								? emptyInboxTitle(unreadable)
								: "Nothing needs you."
							: `${plural(tile.data.counts.action_required, "thing")} need${tile.data.counts.action_required === 1 ? "s" : ""} you.`}
						{tile.data.nextJob === null
							? ""
							: ` Next job: ${tile.data.nextJob.name} at ${dateTime(tile.data.nextJob.at)}.`}
					</p>
				) : null}
			</ScreenHeader>
			{tile?.state === "ok" && tile.data !== undefined ? (
				<div className="stats">
					<Stat value={tile.data.counts.action_required} label="Needs you" tone="danger" />
					<Stat value={tile.data.counts.attention} label="Attention" tone="attention" />
					<Stat
						value={jobList === undefined ? "–" : `${healthy}/${supervised.length}`}
						label="Jobs healthy"
						tone={jobList !== undefined && healthy === supervised.length ? "ok" : "attention"}
					/>
				</div>
			) : null}
			{inbox.status === "loading" ? <p className="muted">Loading</p> : null}
			{inbox.status === "error" && inbox.data === undefined ? <p className="tone-danger">{inbox.message}</p> : null}
			<WithTile tile={tile}>
				{(data) =>
					data.items.length === 0 ? (
						<EmptyState
							title={emptyInboxTitle(data.unreadable.length)}
							tone={unreadable > 0 ? "attention" : undefined}
						>
							{data.nextJob === null ? null : (
								<p>
									Next job: {data.nextJob.name} at {dateTime(data.nextJob.at)}.
								</p>
							)}
						</EmptyState>
					) : (
						<div className="split">
							<ul className="list" aria-label="Inbox" ref={list}>
								{data.items.map((item, position) => {
									const Icon = SOURCE_ICONS[item.source];
									const severity = SEVERITY[item.severity];
									return (
										<li key={item.key}>
											<a
												href={routeHref("inbox", item.key)}
												className={[
													"row",
													item.severity === "action_required" ? "row-rule" : "",
													position === index ? "row-selected" : "",
												].join(" ")}
												aria-current={position === index ? "true" : undefined}
											>
												<span className="row-severity">
													<StatusDot tone={severity.tone} label={severity.label} />
												</span>
												<span className="row-main">
													<span className="row-title">{visibleText(item.title)}</span>
													<span className="row-context">{visibleText(item.context)}</span>
												</span>
												<span className="row-meta">
													<Icon size={16} strokeWidth={1.5} aria-hidden="true" />
													<span className="sr-only">{item.source}</span>
													{item.since === null ? null : <span>{relativeTime(item.since, now)}</span>}
												</span>
											</a>
										</li>
									);
								})}
							</ul>
							{selected === undefined ? null : (
								<DetailPane
									label="Selected item"
									open={selectedKey !== undefined && selected.key === selectedKey}
									onClose={() => window.location.replace(routeHref("inbox"))}
								>
									<Detail item={selected} />
								</DetailPane>
							)}
						</div>
					)
				}
			</WithTile>
			{tile?.state === "ok" && tile.data !== undefined && tile.data.unreadable.length > 0 ? (
				<p className="fine-print">Could not read: {tile.data.unreadable.join(", ")}</p>
			) : null}
			<p className="copy-notice" aria-live="polite">
				{notice}
			</p>
		</div>
	);
};
