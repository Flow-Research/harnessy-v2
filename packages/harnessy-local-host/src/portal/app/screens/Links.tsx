/**
 * Links: the owner's saved links, in folders, shown as a tree like a code editor's
 * file explorer. A web or app link (any scheme but the code-running ones) opens in
 * a new tab with `noopener noreferrer`. A file link cannot open from this page
 * (browsers block `file:` from `http:`), so the portal opens that saved path on its
 * own computer. Every change is a page-token action; the tree lives in the portal's
 * own state.
 *
 * "New" in the header and each row's menu open small dialogs. Drag a row's handle
 * (mouse or touch) to reorder it among its siblings or drop it on a folder or on
 * "Top level"; with the keyboard, the arrow keys on a handle reorder and "Move to…"
 * changes the folder.
 */
import {
	ChevronRight,
	ExternalLink,
	FileText,
	Folder,
	FolderOpen,
	GripVertical,
	MoreHorizontal,
	Plus,
	X,
} from "lucide-react";
import {
	type CSSProperties,
	type FormEvent,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

import { Card, EmptyState } from "../components/primitives.tsx";
import { ScreenHeader } from "../components/Shell.tsx";
import { useResource } from "../lib/data.tsx";
import { plural } from "../lib/format.ts";
import { trapTab, useScreenKeys } from "../lib/keys.tsx";
import {
	canMoveInto,
	childFolders,
	childLinks,
	countInside,
	EMPTY_TREE,
	FOLDER_DEPTH_MAX,
	FOLDER_NAME_MAX,
	folderDepth,
	folderOptions,
	itemOf,
	type LinkFolder,
	type LinkItem,
	type LinkKind,
	type LinksTree,
	type SavedLink,
	siblingIds,
	storedExpanded,
	storeExpanded,
	type TreeRow,
	visibleRows,
	withOrder,
} from "../lib/links-tree.ts";
import { routeHref } from "../lib/router.ts";
import type { ApiResult, SessionClient } from "../lib/session.ts";
import "./links.css";

export type { LinkFolder, LinksTree, SavedLink } from "../lib/links-tree.ts";

/** The Links screen's own keys. Change a key here; the screen reads it from this table only. */
export const LINKS_KEYS: Readonly<{ newLink: string }> = { newLink: "n" };

/** Route segments that open a dialog, used by the palette (`#/links/new-link`). */
export const LINKS_ROUTE_ACTIONS = { newLink: "new-link", newFolder: "new-folder" } as const;

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

const ADDRESS_HELP =
	"Enter a full address, such as https://…, mailto:… or vscode://…, or a file path that starts with / or ~/. Addresses that run code (javascript:, data:) are refused.";
const FOLDER_NAME_HELP = `Use a folder name of 1 to ${FOLDER_NAME_MAX} characters.`;

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

const failure = (result: ApiResult, signedOut: string): string =>
	result.kind === "error" ? result.message : signedOut;

interface MenuEntry {
	readonly label: string;
	readonly onSelect: () => void;
}

/**
 * A button with a small menu. Opening focuses the first item; the arrow keys move
 * between items; Escape, Tab or a press outside closes it and the focus returns to
 * the button.
 */
const MenuButton = ({
	label,
	className,
	children,
	items,
	open,
	onOpenChange,
}: {
	label: string;
	className: string;
	children: ReactNode;
	items: readonly MenuEntry[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	const wrap = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return undefined;
		wrap.current!.querySelector<HTMLElement>('[role="menuitem"]')!.focus();
		const outside = (event: Event) => {
			if (event.target instanceof Node && !wrap.current!.contains(event.target)) onOpenChange(false);
		};
		document.addEventListener("pointerdown", outside);
		return () => document.removeEventListener("pointerdown", outside);
	}, [open, onOpenChange]);
	const close = () => {
		onOpenChange(false);
		button.current?.focus();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const entries = [...wrap.current!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
		const at = entries.indexOf(document.activeElement as HTMLElement);
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			entries[(at + step + entries.length) % entries.length]!.focus();
		} else if (event.key === "Tab") onOpenChange(false);
	};
	return (
		<div className="link-menu" ref={wrap}>
			<button
				ref={button}
				type="button"
				className={className}
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => onOpenChange(!open)}
			>
				{children}
			</button>
			{open ? (
				<div className="link-menu-items" role="menu" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
					{items.map((item) => (
						<button
							key={item.label}
							type="button"
							role="menuitem"
							className="link-menu-item"
							onClick={() => {
								close();
								item.onSelect();
							}}
						>
							{item.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
};

/**
 * A small modal dialog. It focuses its first field, keeps Tab inside, closes on
 * Escape or a press on the backdrop, and gives the focus back to whatever had it.
 */
const Dialog = ({
	title,
	onClose,
	onSubmit,
	submitLabel,
	busy,
	error,
	children,
}: {
	title: string;
	onClose: () => void;
	onSubmit: () => void;
	submitLabel: string;
	busy: boolean;
	error: string;
	children: ReactNode;
}) => {
	const dialog = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const fields = [...dialog.current!.querySelectorAll<HTMLElement>("input:not([disabled]), select")];
		(fields.find((field) => field instanceof HTMLInputElement && field.checked) ?? fields[0]!).focus();
		return () => {
			if (opener?.isConnected === true && opener !== document.body) opener.focus();
		};
	}, []);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a backdrop press is a mouse shortcut; Escape and Cancel are the keyboard paths
		<div
			className="link-dialog-backdrop"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<div
				ref={dialog}
				className="link-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="link-dialog-title"
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					} else trapTab(event, dialog.current);
				}}
			>
				<header className="link-dialog-head">
					<h2 id="link-dialog-title">{title}</h2>
					<button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
						<X size={16} strokeWidth={1.5} aria-hidden="true" />
					</button>
				</header>
				<form
					className="link-form"
					noValidate
					onSubmit={(event: FormEvent) => {
						event.preventDefault();
						onSubmit();
					}}
				>
					{children}
					{error ? (
						<p className="link-error" role="alert">
							{error}
						</p>
					) : null}
					<div className="button-row">
						<button type="button" className="button button-quiet" onClick={onClose}>
							Cancel
						</button>
						<button type="submit" className="button button-primary" disabled={busy} aria-busy={busy}>
							{submitLabel}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
};

/** The "Save in" folder selector. Folders that cannot take a new folder are disabled. */
const FolderSelect = ({
	tree,
	value,
	onChange,
	forFolder,
}: {
	tree: LinksTree;
	value: string | null;
	onChange: (value: string | null) => void;
	forFolder: boolean;
}) => (
	<label className="field" htmlFor="link-parent">
		Save in
		<span className="select">
			<select id="link-parent" value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
				<option value="">Top level</option>
				{folderOptions(tree).map(({ folder, depth }) => (
					<option key={folder.id} value={folder.id} disabled={forFolder && depth >= FOLDER_DEPTH_MAX}>
						{`${"   ".repeat(depth - 1)}${folder.name}`}
					</option>
				))}
			</select>
		</span>
	</label>
);

type DialogState =
	| { readonly kind: "link" | "folder"; readonly parentId: string | null }
	| { readonly kind: "rename" | "move"; readonly item: LinkItem };

/** Each dialog: add a link, add a folder, rename, or move. `onDone` closes it after a save. */
const LinkDialog = ({
	state,
	tree,
	client,
	onClose,
	onDone,
}: {
	state: DialogState;
	tree: LinksTree;
	client: SessionClient;
	onClose: () => void;
	onDone: (message: string, open: string | null) => void;
}) => {
	const item = "item" in state ? state.item : undefined;
	const [url, setUrl] = useState("");
	const [name, setName] = useState(state.kind === "rename" ? item!.name : "");
	const [parentId, setParentId] = useState<string | null>("parentId" in state ? state.parentId : null);
	const [target, setTarget] = useState<string | null>(item?.parentId ?? null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const save = (request: () => Promise<ApiResult>, message: string, open: string | null) => {
		setBusy(true);
		void request().then((result) => {
			setBusy(false);
			if (result.kind === "ok") onDone(message, open);
			else setError(failure(result, "Sign in again to change links."));
		});
	};

	if (state.kind === "move") {
		const moving = item!;
		const options = [{ id: null, name: "Top level", depth: 0 }, ...folderOptions(tree).map(toOption)];
		return (
			<Dialog
				title={`Move “${moving.name}”`}
				submitLabel="Move"
				busy={busy}
				error={error}
				onClose={onClose}
				onSubmit={() => {
					if (target === moving.parentId) return onClose();
					const end = (moving.kind === "folder" ? childFolders(tree, target) : childLinks(tree, target)).length;
					const where =
						target === null ? "to the top level" : `into ${options.find((o) => o.id === target)!.name}`;
					save(() => client.moveLinkItem(moving.id, target, end), `${moving.name} moved ${where}.`, target);
				}}
			>
				<fieldset className="link-picker">
					<legend>Move to</legend>
					{options.map((option) => (
						<label
							key={option.id ?? ""}
							className="link-picker-option"
							style={{ "--depth": Math.min(option.depth, 4) } as CSSProperties}
						>
							<input
								type="radio"
								name="link-move-target"
								value={option.id ?? ""}
								checked={target === option.id}
								disabled={option.id !== moving.parentId && !canMoveInto(tree, moving, option.id)}
								onChange={() => setTarget(option.id)}
							/>
							{option.id === null ? (
								<FolderOpen size={14} strokeWidth={1.5} aria-hidden="true" />
							) : (
								<Folder size={14} strokeWidth={1.5} aria-hidden="true" />
							)}
							{option.name}
							{option.id === moving.parentId ? <span className="muted"> (current)</span> : null}
						</label>
					))}
				</fieldset>
			</Dialog>
		);
	}

	if (state.kind === "rename") {
		const renaming = item!;
		return (
			<Dialog
				title={`Rename ${renaming.kind}`}
				submitLabel="Rename"
				busy={busy}
				error={error}
				onClose={onClose}
				onSubmit={() => {
					const trimmed = name.trim();
					if (renaming.kind === "folder" && (trimmed.length === 0 || trimmed.length > FOLDER_NAME_MAX))
						return setError(FOLDER_NAME_HELP);
					save(() => client.renameLinkItem(renaming.id, trimmed), "Renamed.", null);
				}}
			>
				<label className="field" htmlFor="link-name">
					Name
					<input
						id="link-name"
						className="input"
						maxLength={renaming.kind === "folder" ? FOLDER_NAME_MAX : 120}
						placeholder={renaming.kind === "link" ? "Empty: the site name is used" : undefined}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
			</Dialog>
		);
	}

	if (state.kind === "folder")
		return (
			<Dialog
				title="New folder"
				submitLabel="Create folder"
				busy={busy}
				error={error}
				onClose={onClose}
				onSubmit={() => {
					const trimmed = name.trim();
					if (trimmed.length === 0 || trimmed.length > FOLDER_NAME_MAX) return setError(FOLDER_NAME_HELP);
					save(() => client.addLinkFolder(trimmed, parentId), `Folder ${trimmed} created.`, parentId);
				}}
			>
				<label className="field" htmlFor="link-name">
					Folder name
					<input
						id="link-name"
						className="input"
						maxLength={FOLDER_NAME_MAX}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<FolderSelect tree={tree} value={parentId} onChange={setParentId} forFolder />
			</Dialog>
		);

	return (
		<Dialog
			title="New link"
			submitLabel="Add link"
			busy={busy}
			error={error}
			onClose={onClose}
			onSubmit={() => {
				const address = url.trim();
				if (!acceptable(address)) return setError(ADDRESS_HELP);
				save(() => client.addLink(name.trim(), address, parentId), "Link added.", parentId);
			}}
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
					value={name}
					onChange={(event) => setName(event.target.value)}
				/>
			</label>
			<FolderSelect tree={tree} value={parentId} onChange={setParentId} forFolder={false} />
		</Dialog>
	);
};

const toOption = ({ folder, depth }: { folder: LinkFolder; depth: number }) => ({
	id: folder.id as string | null,
	name: folder.name,
	depth,
});

interface Handle {
	readonly dragging: boolean;
	readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
	readonly onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
	readonly onPointerUp: () => void;
	readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** The title of a link: a new-tab anchor, a file button the portal opens, or plain text. */
const LinkTitle = ({ link, client }: { link: SavedLink; client: SessionClient }) => {
	const [error, setError] = useState("");
	const [opening, setOpening] = useState(false);
	const [notice, setNotice] = useState("");
	const target = linkTarget(link.url);
	return (
		<>
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
							const revealed = result.kind === "ok" && (result.body as { revealed?: unknown }).revealed === true;
							setNotice(
								revealed
									? "Shown in Finder, not opened: this file can run a program. Open it from there if you trust it."
									: "",
							);
							setError(result.kind === "ok" ? "" : failure(result, "Sign in again to open files."));
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
		</>
	);
};

/** One row of the tree: a folder or a link, with its handle, menu and remove confirmation. */
const Row = ({
	row,
	tree,
	client,
	handle,
	selected,
	dropTarget,
	onToggle,
	onSelect,
	onDialog,
	onRemoved,
}: {
	row: Exclude<TreeRow, { kind: "empty" }>;
	tree: LinksTree;
	client: SessionClient;
	handle: Handle;
	selected: boolean;
	dropTarget: boolean;
	onToggle: (id: string, open: boolean) => void;
	onSelect: (id: string) => void;
	onDialog: (state: DialogState) => void;
	onRemoved: (message: string, error: string) => void;
}) => {
	const entry = row.kind === "folder" ? row.folder : row.link;
	const item = itemOf(entry);
	const [menu, setMenu] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const keep = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (confirming) keep.current?.focus();
	}, [confirming]);
	const common: MenuEntry[] = [
		{ label: "Rename", onSelect: () => onDialog({ kind: "rename", item }) },
		{ label: "Move to…", onSelect: () => onDialog({ kind: "move", item }) },
		{ label: "Remove", onSelect: () => setConfirming(true) },
	];
	const items: MenuEntry[] =
		row.kind === "folder"
			? [
					{ label: "New link here", onSelect: () => onDialog({ kind: "link", parentId: item.id }) },
					...(row.depth + 1 < FOLDER_DEPTH_MAX
						? [{ label: "New folder here", onSelect: () => onDialog({ kind: "folder", parentId: item.id }) }]
						: []),
					...common,
				]
			: common;
	const inside = row.kind === "folder" ? countInside(tree, item.id) : undefined;
	const classes = [
		"link-row",
		row.kind === "folder" ? "link-folder-row" : "",
		selected ? "link-selected" : "",
		dropTarget ? "link-drop-target" : "",
		handle.dragging ? "link-dragging" : "",
	].filter((name) => name !== "");
	return (
		<li
			className={classes.join(" ")}
			data-item-id={item.id}
			data-kind={item.kind}
			data-parent={item.parentId ?? ""}
			style={{ "--depth": row.depth } as CSSProperties}
			onContextMenu={(event) => {
				event.preventDefault();
				setMenu(true);
			}}
		>
			<button
				type="button"
				className="link-handle"
				aria-label={`Move ${item.name}`}
				aria-describedby="link-order-hint"
				onPointerDown={handle.onPointerDown}
				onPointerMove={handle.onPointerMove}
				onPointerUp={handle.onPointerUp}
				onPointerCancel={handle.onPointerUp}
				onKeyDown={handle.onKeyDown}
			>
				<GripVertical size={16} strokeWidth={1.5} aria-hidden="true" />
			</button>
			{row.kind === "folder" ? (
				<button
					type="button"
					className="link-chevron"
					aria-expanded={row.expanded}
					aria-label={`${row.expanded ? "Collapse" : "Expand"} ${item.name}`}
					onClick={() => onToggle(item.id, !row.expanded)}
				>
					<ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
				</button>
			) : (
				<span className="link-chevron" aria-hidden="true" />
			)}
			<div className="link-main">
				{row.kind === "folder" ? (
					<button
						type="button"
						className="link-title link-folder"
						aria-current={selected ? "true" : undefined}
						onClick={() => {
							onSelect(item.id);
							onToggle(item.id, !row.expanded);
						}}
					>
						{row.expanded ? (
							<FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />
						) : (
							<Folder size={16} strokeWidth={1.5} aria-hidden="true" />
						)}
						<span className="link-folder-name">{item.name}</span>
						<span className="link-count">
							{row.count}
							<span className="sr-only"> {row.count === 1 ? "item" : "items"}</span>
						</span>
					</button>
				) : (
					<LinkTitle link={row.link} client={client} />
				)}
			</div>
			<div className="link-actions">
				{confirming ? (
					<>
						<span className="link-confirm-text">
							{inside === undefined
								? "Remove this link?"
								: inside.folders + inside.links === 0
									? "Remove this empty folder?"
									: `Also removes ${plural(inside.folders, "folder")} and ${plural(inside.links, "link")} inside.`}
						</span>
						<button
							ref={keep}
							type="button"
							className="button button-sm button-quiet"
							onClick={() => setConfirming(false)}
						>
							Keep
						</button>
						<button
							type="button"
							className="button button-sm button-danger"
							aria-busy={busy}
							disabled={busy}
							onClick={() => {
								setBusy(true);
								void client.removeLink(item.id).then((result) => {
									setBusy(false);
									setConfirming(false);
									onRemoved(
										result.kind === "ok" ? `${item.name} removed.` : "",
										result.kind === "ok" ? "" : failure(result, "Sign in again to remove links."),
									);
								});
							}}
						>
							Remove
						</button>
					</>
				) : (
					<MenuButton
						label={`Actions for ${item.name}`}
						className="icon-button link-more"
						items={items}
						open={menu}
						onOpenChange={setMenu}
					>
						<MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
					</MenuButton>
				)}
			</div>
		</li>
	);
};

interface Draft {
	readonly kind: LinkKind;
	readonly parentId: string | null;
	readonly ids: string[];
	/** The portal's order of this sibling list when the draft began. */
	readonly base: string;
}

export const LinksScreen = ({ client, rest = [] }: { client: SessionClient; rest?: ReadonlyArray<string> }) => {
	const resource = useResource<LinksTree>("/v1/links");
	const tree = resource.data ?? EMPTY_TREE;
	const [expanded, setExpanded] = useState<Set<string>>(storedExpanded);
	const [chosen, setChosen] = useState<string | null>(null);
	const [newMenu, setNewMenu] = useState(false);
	const [dialog, setDialog] = useState<DialogState | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [treeError, setTreeError] = useState("");
	// The selected folder drives the "Save in" default; a removed folder falls back to the top level.
	const selected = chosen !== null && tree.folders.some((folder) => folder.id === chosen) ? chosen : null;
	const selectedRef = useRef(selected);
	selectedRef.current = selected;

	const setOpen = (id: string, open: boolean) =>
		setExpanded((current) => {
			if (current.has(id) === open) return current;
			const next = new Set(current);
			if (open) next.add(id);
			else next.delete(id);
			storeExpanded(next);
			return next;
		});

	const openDialog = (state: DialogState) => {
		setTreeError("");
		setDialog(state);
	};

	// The palette opens a dialog through the route (`#/links/new-link`); the route then returns to `#/links`.
	const intent = rest[0];
	useEffect(() => {
		if (intent !== LINKS_ROUTE_ACTIONS.newLink && intent !== LINKS_ROUTE_ACTIONS.newFolder) return;
		setDialog({ kind: intent === LINKS_ROUTE_ACTIONS.newLink ? "link" : "folder", parentId: selectedRef.current });
		window.location.replace(routeHref("links"));
	}, [intent]);

	useScreenKeys((event) => {
		if (dialog !== null || event.key !== LINKS_KEYS.newLink) return;
		event.preventDefault();
		openDialog({ kind: "link", parentId: selected });
	});

	// The order shown while dragging, while reorder saves are in flight, and after them
	// until the portal's order of that sibling list changes. Once the portal answers with
	// another order (the saved one, or another view's) and nothing is in flight, the
	// portal's order is shown again.
	const [draft, setDraft] = useState<Draft | null>(null);
	const draftRef = useRef<Draft | null>(null);
	const [drag, setDrag] = useState<LinkItem | null>(null);
	const [drop, setDrop] = useState<{ parentId: string | null } | null>(null);
	const dropRef = useRef<{ parentId: string | null } | null>(null);
	// Saves run one at a time, in order. `lastSent` is the order the portal holds once they
	// finish, so a move back to the first order is still sent.
	const pending = useRef(0);
	const lastSent = useRef("");
	const queue = useRef<Promise<unknown>>(Promise.resolve());
	const treeRef = useRef(tree);
	treeRef.current = tree;
	const keyOf = (from: LinksTree, kind: LinkKind, parentId: string | null) =>
		`${kind}:${parentId ?? ""}:${siblingIds(from, kind, parentId).join(",")}`;
	const holds = (held: Draft | null): held is Draft =>
		held !== null && (drag !== null || pending.current > 0 || held.base === keyOf(tree, held.kind, held.parentId));
	const shown = holds(draft) ? withOrder(tree, draft.kind, draft.parentId, draft.ids) : tree;
	const currentIds = (kind: LinkKind, parentId: string | null) => {
		const held = draftRef.current;
		return holds(held) && held.kind === kind && held.parentId === parentId
			? held.ids
			: siblingIds(tree, kind, parentId);
	};
	const setDraftTo = (next: Draft | null) => {
		draftRef.current = next;
		setDraft(next);
	};
	const startDraft = (kind: LinkKind, parentId: string | null, ids: string[]) =>
		setDraftTo({ kind, parentId, ids, base: keyOf(tree, kind, parentId) });
	const setDropTo = (next: { parentId: string | null } | null) => {
		dropRef.current = next;
		setDrop(next);
	};
	const nameOf = (id: string) =>
		tree.folders.find((folder) => folder.id === id)?.name ?? tree.links.find((link) => link.id === id)?.title;

	const enqueue = (request: () => Promise<ApiResult>, signedOut: string) => {
		pending.current += 1;
		queue.current = queue.current.then(request).then((result) => {
			pending.current -= 1;
			if (result.kind === "ok") {
				setTreeError("");
				// Keep showing the saved order until the refreshed tree replaces this one.
				const held = draftRef.current;
				if (pending.current === 0 && held !== null)
					setDraftTo({ ...held, base: keyOf(treeRef.current, held.kind, held.parentId) });
			} else {
				setDraftTo(null);
				setTreeError(failure(result, signedOut));
			}
			resource.refresh();
		});
	};

	const saveOrder = (held: Draft, moved: string) => {
		const key = `${held.kind}:${held.parentId ?? ""}:${held.ids.join(",")}`;
		if (key === (pending.current > 0 ? lastSent.current : keyOf(tree, held.kind, held.parentId))) {
			if (pending.current === 0) setDraftTo(null);
			return;
		}
		setAnnouncement(`${nameOf(moved)} moved to position ${held.ids.indexOf(moved) + 1} of ${held.ids.length}.`);
		lastSent.current = key;
		enqueue(() => client.reorderLinks(held.kind, held.parentId, held.ids), "Sign in again to reorder links.");
	};

	const moveInto = (item: LinkItem, parentId: string | null) => {
		const end = (item.kind === "folder" ? childFolders(tree, parentId) : childLinks(tree, parentId)).length;
		setDraftTo(null);
		if (parentId !== null) setOpen(parentId, true);
		setAnnouncement(`${item.name} moved ${parentId === null ? "to the top level" : `into ${nameOf(parentId)}`}.`);
		lastSent.current = "";
		enqueue(() => client.moveLinkItem(item.id, parentId, end), "Sign in again to move links.");
	};

	const kindOf = (item: LinkItem): LinkKind => (item.kind === "folder" ? "folders" : "links");

	const handleFor = (item: LinkItem): Handle => ({
		dragging: drag?.id === item.id,
		onPointerDown: (event) => {
			if (event.button !== 0) return;
			event.preventDefault();
			event.currentTarget.setPointerCapture?.(event.pointerId);
			const start = currentIds(kindOf(item), item.parentId);
			draftRef.current = null;
			startDraft(kindOf(item), item.parentId, start);
			setDropTo(null);
			setDrag(item);
		},
		onPointerMove: (event) => {
			const held = draftRef.current;
			if (drag?.id !== item.id || held === null) return;
			const over = document
				.elementFromPoint(event.clientX, event.clientY)
				?.closest<HTMLElement>("[data-item-id], [data-drop-root]");
			if (!over) return setDropTo(null);
			if (over.dataset.dropRoot !== undefined) return setDropTo(item.parentId === null ? null : { parentId: null });
			const target = over.dataset.itemId!;
			const sibling = over.dataset.kind === item.kind && (over.dataset.parent || null) === item.parentId;
			const into =
				over.dataset.kind === "folder" &&
				target !== item.id &&
				target !== item.parentId &&
				canMoveInto(tree, item, target);
			const box = over.getBoundingClientRect();
			const middle = box.height > 0 && Math.abs(event.clientY - (box.top + box.height / 2)) < box.height / 4;
			if (into && (!sibling || middle)) return setDropTo({ parentId: target });
			setDropTo(null);
			// Over a different sibling, the order always changes.
			if (sibling && target !== item.id)
				setDraftTo({ ...held, ids: moveId(held.ids, item.id, held.ids.indexOf(target)) });
		},
		onPointerUp: () => {
			if (drag?.id !== item.id) return;
			setDrag(null);
			const into = dropRef.current;
			setDropTo(null);
			// A press always starts a draft, so a release during a drag always has one.
			if (into !== null) moveInto(item, into.parentId);
			else saveOrder(draftRef.current!, item.id);
		},
		onKeyDown: (event) => {
			const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
			if (step === 0) return;
			event.preventDefault();
			const kind = kindOf(item);
			const held = draftRef.current;
			const current = currentIds(kind, item.parentId);
			const index = current.indexOf(item.id) + step;
			if (index < 0 || index >= current.length) return;
			const next: Draft = {
				kind,
				parentId: item.parentId,
				ids: moveId(current, item.id, index),
				// A draft of this list that is still shown keeps its base; otherwise the portal's order is the base.
				base: held !== null && current === held.ids ? held.base : keyOf(tree, kind, item.parentId),
			};
			setDraftTo(next);
			saveOrder(next, item.id);
		},
	});

	const rows = visibleRows(shown, expanded);
	const empty = tree.folders.length === 0 && tree.links.length === 0;
	const topCount = childFolders(tree, null).length + childLinks(tree, null).length;
	const newItems: MenuEntry[] = [
		{ label: "Link…", onSelect: () => openDialog({ kind: "link", parentId: selected }) },
		{
			label: "Folder…",
			onSelect: () =>
				openDialog({ kind: "folder", parentId: folderDepth(tree, selected) < FOLDER_DEPTH_MAX ? selected : null }),
		},
	];

	return (
		<div className="screen">
			<div className="links-head">
				<ScreenHeader title="Links" />
				<MenuButton
					label="New link or folder"
					className="button button-sm"
					items={newItems}
					open={newMenu}
					onOpenChange={setNewMenu}
				>
					<Plus size={16} strokeWidth={1.5} aria-hidden="true" />
					New
				</MenuButton>
			</div>
			<Card className="links-card">
				{resource.status === "error" && resource.data === undefined ? (
					<EmptyState title="Links could not be loaded" tone="attention">
						<p>{resource.message}</p>
					</EmptyState>
				) : resource.data === undefined ? (
					<p className="muted">Loading</p>
				) : empty ? (
					<EmptyState title="No links yet">
						<p>
							Choose New, then Link… or Folder…, or press {LINKS_KEYS.newLink}. Web links open in a new tab;
							files open on this computer.
						</p>
					</EmptyState>
				) : (
					<>
						<button
							type="button"
							className={drop?.parentId === null ? "link-root link-drop-target" : "link-root"}
							data-drop-root=""
							aria-current={selected === null ? "true" : undefined}
							onClick={() => setChosen(null)}
						>
							<FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />
							Top level
							<span className="link-count">{topCount}</span>
						</button>
						<p id="link-order-hint" className="sr-only">
							Drag a row by its handle to reorder it or drop it on a folder, or focus the handle and use the up
							and down arrow keys. Use Move to… in the row's menu to change its folder.
						</p>
						{treeError ? (
							<p className="link-error" role="alert">
								{treeError}
							</p>
						) : null}
						<ul className="link-list">
							{rows.map((row) =>
								row.kind === "empty" ? (
									<li
										key={`empty:${row.id}`}
										className="link-row link-empty muted"
										style={{ "--depth": row.depth } as CSSProperties}
									>
										Empty folder
									</li>
								) : (
									<Row
										key={row.kind === "folder" ? row.folder.id : row.link.id}
										row={row}
										tree={tree}
										client={client}
										handle={handleFor(itemOf(row.kind === "folder" ? row.folder : row.link))}
										selected={row.kind === "folder" && row.folder.id === selected}
										dropTarget={row.kind === "folder" && drop?.parentId === row.folder.id}
										onToggle={setOpen}
										onSelect={setChosen}
										onDialog={openDialog}
										onRemoved={(message, error) => {
											setAnnouncement(message);
											setTreeError(error);
											resource.refresh();
										}}
									/>
								),
							)}
						</ul>
					</>
				)}
			</Card>
			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>
			{dialog === null ? null : (
				<LinkDialog
					state={dialog}
					tree={tree}
					client={client}
					onClose={() => setDialog(null)}
					onDone={(message, open) => {
						setDialog(null);
						setAnnouncement(message);
						if (open !== null) setOpen(open, true);
						resource.refresh();
					}}
				/>
			)}
		</div>
	);
};
