/**
 * Links: the owner's saved links. A web or app link (any scheme but the
 * code-running ones) opens in a new tab with `noopener noreferrer`. A file link
 * cannot open from this page (browsers block `file:` from `http:`), so the portal
 * opens that saved path on its own computer. Adding, removing, reordering and
 * opening a file are page-token actions; the links live in the portal's own state.
 * Reorder by dragging a row's handle (mouse or touch) or with the arrow keys on it.
 */
import { ExternalLink, FileText, GripVertical } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";

import { Card, EmptyState } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import { useResource } from "../lib/data.tsx";
import type { SessionClient } from "../lib/session.ts";
import "./links.css";

export interface SavedLink {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly addedAt: string;
}

/** Schemes that would run code in this signed-in page. The portal refuses them too. */
const BLOCKED = new Set(["javascript:", "data:", "vbscript:", "blob:"]);

/** How a saved link opens: a new-tab `href`, a portal-opened file, or not at all. */
export const linkTarget = (
	url: string,
): { kind: "href"; href: string } | { kind: "file"; path: string } | undefined => {
	if (/[\p{Cc}\p{Cf}]/u.test(url) || !/^[a-z][a-z0-9+.-]*:/iu.test(url)) return undefined;
	try {
		const parsed = new URL(url);
		if (BLOCKED.has(parsed.protocol) || parsed.username || parsed.password) return undefined;
		if (parsed.protocol === "file:") return { kind: "file", path: decodeURIComponent(parsed.pathname) };
		return { kind: "href", href: parsed.href };
	} catch {
		return undefined;
	}
};

/** An entry the portal may accept: a full file path, or a URL with a scheme that runs no code. */
const acceptable = (value: string): boolean =>
	value.startsWith("/") || value.startsWith("~/") || linkTarget(value) !== undefined;

const detailOf = (url: string): string => {
	const target = linkTarget(url);
	if (target?.kind === "file") return target.path;
	// Web links show their site; app and other links show the whole address, since their
	// "host" (such as `file` in `vscode://file/…`) says little.
	return target?.kind === "href" && /^https?:/u.test(target.href) ? new URL(target.href).host : url;
};

/** `ids` with `id` moved to `index`. */
export const moveId = (ids: readonly string[], id: string, index: number): string[] => {
	const rest = ids.filter((other) => other !== id);
	const at = Math.max(0, Math.min(index, rest.length));
	return [...rest.slice(0, at), id, ...rest.slice(at)];
};

const sameOrder = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id, index) => id === b[index]);

interface Handle {
	readonly dragging: boolean;
	readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
	readonly onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
	readonly onPointerUp: () => void;
	readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

const LinkRow = ({
	link,
	client,
	onChanged,
	handle,
}: {
	link: SavedLink;
	client: SessionClient;
	onChanged: () => void;
	handle: Handle;
}) => {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [opening, setOpening] = useState(false);
	const [notice, setNotice] = useState("");
	const target = linkTarget(link.url);
	return (
		<li className={handle.dragging ? "link-row link-dragging" : "link-row"} data-link-id={link.id}>
			<button
				type="button"
				className="link-handle"
				aria-label={`Move ${link.title}`}
				aria-describedby="link-order-hint"
				onPointerDown={handle.onPointerDown}
				onPointerMove={handle.onPointerMove}
				onPointerUp={handle.onPointerUp}
				onPointerCancel={handle.onPointerUp}
				onKeyDown={handle.onKeyDown}
			>
				<GripVertical size={16} strokeWidth={1.5} aria-hidden="true" />
			</button>
			<div className="link-main">
				{target === undefined ? (
					<span className="link-title">{link.title}</span>
				) : target.kind === "file" ? (
					<button
						type="button"
						className="link-title link-file"
						aria-busy={opening}
						disabled={opening}
						onClick={() => {
							setOpening(true);
							void client.openLinkFile(link.id).then((result) => {
								setOpening(false);
								const revealed =
									result.kind === "ok" && (result.body as { revealed?: unknown }).revealed === true;
								setNotice(
									revealed
										? "Shown in Finder, not opened: this file can run a program. Open it from there if you trust it."
										: "",
								);
								setError(
									result.kind === "ok"
										? ""
										: result.kind === "error"
											? result.message
											: "Sign in again to open files.",
								);
							});
						}}
					>
						{link.title}
						<FileText size={14} strokeWidth={1.5} aria-hidden="true" />
						<span className="sr-only"> (opens on the computer that runs the portal)</span>
					</button>
				) : (
					<a className="link-title" href={target.href} target="_blank" rel="noopener noreferrer">
						{link.title}
						<ExternalLink size={14} strokeWidth={1.5} aria-hidden="true" />
						<span className="sr-only"> (opens in a new tab)</span>
					</a>
				)}
				<span className="link-host mono" title={link.url}>
					{detailOf(link.url)}
				</span>
				{error ? (
					<p className="link-error" role="alert">
						{error}
					</p>
				) : null}
				{notice ? <output className="fine-print link-notice">{notice}</output> : null}
			</div>
			<div className="link-actions">
				{confirming ? (
					<>
						<button type="button" className="button button-sm button-quiet" onClick={() => setConfirming(false)}>
							Keep
						</button>
						<button
							type="button"
							className="button button-sm button-danger"
							aria-busy={busy}
							disabled={busy}
							onClick={() => {
								setBusy(true);
								void client.removeLink(link.id).then((result) => {
									setBusy(false);
									setConfirming(false);
									if (result.kind === "error") setError(result.message);
									onChanged();
								});
							}}
						>
							Remove
						</button>
					</>
				) : (
					<button
						type="button"
						className="button button-sm button-quiet"
						aria-label={`Remove ${link.title}`}
						onClick={() => setConfirming(true)}
					>
						Remove
					</button>
				)}
			</div>
		</li>
	);
};

export const LinksScreen = ({ client }: { client: SessionClient }) => {
	const links = useResource<{ links: SavedLink[] }>("/v1/links");
	const [title, setTitle] = useState("");
	const [url, setUrl] = useState("");
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const list = links.data?.links ?? [];
	const serverIds = list.map((link) => link.id);
	const serverKey = serverIds.join(",");
	// The order shown while dragging, or after a move until the portal's list changes.
	// `base` is the portal order the draft started from: once the portal answers with
	// another order (the saved one, or another view's), the portal order is shown again.
	const [draft, setDraft] = useState<{ ids: string[]; base: string } | null>(null);
	const draftRef = useRef<{ ids: string[]; base: string } | null>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const [orderError, setOrderError] = useState("");
	const [announcement, setAnnouncement] = useState("");
	const live = draft !== null && (dragging !== null || draft.base === serverKey) ? draft.ids : null;
	const currentIds = () => {
		const held = draftRef.current;
		return held !== null && (dragging !== null || held.base === serverKey) ? held.ids : serverIds;
	};
	const updateDraft = (ids: string[] | null) => {
		const next = ids === null ? null : { ids, base: draftRef.current?.base ?? serverKey };
		draftRef.current = next;
		setDraft(next);
	};
	const byId = new Map(list.map((link) => [link.id, link]));
	const shown = (live ?? serverIds).map((id) => byId.get(id)).filter((link) => link !== undefined);

	const saveOrder = (ids: string[], moved: string) => {
		if (sameOrder(ids, serverIds)) {
			updateDraft(null);
			return;
		}
		const position = ids.indexOf(moved) + 1;
		setAnnouncement(`${byId.get(moved)?.title ?? "Link"} moved to position ${position} of ${ids.length}.`);
		void client.reorderLinks(ids).then((result) => {
			if (result.kind === "ok") setOrderError("");
			else {
				updateDraft(null);
				setOrderError(result.kind === "error" ? result.message : "Sign in again to reorder links.");
			}
			links.refresh();
		});
	};

	const handleFor = (id: string): Handle => ({
		dragging: dragging === id,
		onPointerDown: (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.currentTarget.setPointerCapture?.(event.pointerId);
			const start = currentIds();
			draftRef.current = null;
			updateDraft(start);
			setDragging(id);
		},
		onPointerMove: (event) => {
			const held = draftRef.current?.ids;
			if (dragging !== id || held === undefined) return;
			const over = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-link-id]");
			const target = over?.dataset.linkId;
			if (target === undefined || target === id) return;
			// Over a different row, the order always changes.
			updateDraft(moveId(held, id, held.indexOf(target)));
		},
		onPointerUp: () => {
			if (dragging !== id) return;
			setDragging(null);
			// A press always starts a draft, so a release during a drag always has one.
			saveOrder(draftRef.current!.ids, id);
		},
		onKeyDown: (event) => {
			const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
			if (step === 0) return;
			event.preventDefault();
			const current = currentIds();
			if (current !== draftRef.current?.ids) draftRef.current = null;
			const index = current.indexOf(id) + step;
			if (index < 0 || index >= current.length) return;
			const next = moveId(current, id, index);
			updateDraft(next);
			saveOrder(next, id);
		},
	});

	const submit = () => {
		const address = url.trim();
		if (!acceptable(address)) {
			setError(
				"Enter a full address, such as https://…, mailto:… or vscode://…, or a file path that starts with / or ~/. Addresses that run code (javascript:, data:) are refused.",
			);
			return;
		}
		setSaving(true);
		void client.addLink(title.trim(), address).then((result) => {
			setSaving(false);
			if (result.kind === "ok") {
				setTitle("");
				setUrl("");
				setError("");
				links.refresh();
			} else setError(result.kind === "error" ? result.message : "Sign in again to save links.");
		});
	};

	return (
		<div className="screen">
			<ScreenHeader title="Links" />
			<div className="grid">
				<Card title="Add a link">
					<form
						className="link-form"
						onSubmit={(event) => {
							event.preventDefault();
							submit();
						}}
						noValidate
					>
						<label className="field" htmlFor="link-url">
							Address or file path
							<input
								id="link-url"
								className="input mono"
								type="text"
								inputMode="url"
								autoCapitalize="off"
								spellCheck={false}
								placeholder="https://…, mailto:…, /Users/you/file.pdf"
								maxLength={2048}
								required
								value={url}
								onChange={(event) => setUrl(event.target.value)}
							/>
						</label>
						<label className="field" htmlFor="link-title">
							Name
							<input
								id="link-title"
								className="input"
								maxLength={120}
								placeholder="Optional; the site name is used if empty"
								value={title}
								onChange={(event) => setTitle(event.target.value)}
							/>
						</label>
						{error ? (
							<p className="link-error" role="alert">
								{error}
							</p>
						) : null}
						<div className="button-row">
							<button type="submit" className="button button-primary" disabled={saving} aria-busy={saving}>
								Add link
							</button>
						</div>
					</form>
				</Card>
				<Card title={`Saved links${list.length ? ` (${list.length})` : ""}`}>
					{links.status === "error" && list.length === 0 ? (
						<EmptyState title="Links could not be loaded" tone="attention">
							<p>{links.message}</p>
						</EmptyState>
					) : links.data === undefined ? (
						<p className="muted">Loading</p>
					) : list.length === 0 ? (
						<EmptyState title="No links yet">
							<p>
								Add an address or a file path above. Web links open in a new tab; files open on this computer.
							</p>
						</EmptyState>
					) : (
						<>
							<p id="link-order-hint" className="fine-print">
								Drag a link by its handle to reorder, or focus the handle and use the up and down arrow keys.
							</p>
							{orderError ? (
								<p className="link-error" role="alert">
									{orderError}
								</p>
							) : null}
							<ul className="link-list">
								{shown.map((link) => (
									<LinkRow
										key={link.id}
										link={link}
										client={client}
										onChanged={links.refresh}
										handle={handleFor(link.id)}
									/>
								))}
							</ul>
							<p className="sr-only" aria-live="polite">
								{announcement}
							</p>
						</>
					)}
				</Card>
			</div>
		</div>
	);
};
