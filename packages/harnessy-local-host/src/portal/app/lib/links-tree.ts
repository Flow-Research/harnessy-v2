/**
 * The saved-links tree as the Links screen reads it from `GET /v1/links`
 * (`links.json` version 2). The portal checks every rule; these helpers only
 * shape the tree for display and grey out moves that the portal would refuse.
 */

export interface SavedLink {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly addedAt: string;
	/** The folder that holds the link, or `null` at the top level. */
	readonly parentId: string | null;
}

export interface LinkFolder {
	readonly id: string;
	readonly name: string;
	readonly parentId: string | null;
	readonly addedAt: string;
}

export interface LinksTree {
	readonly version: 2;
	readonly folders: readonly LinkFolder[];
	readonly links: readonly SavedLink[];
}

/** Which sibling list a reorder names. */
export type LinkKind = "links" | "folders";

/** The portal's limits, repeated here so the screen can explain them before a request. */
export const FOLDER_DEPTH_MAX = 6;
export const FOLDER_NAME_MAX = 80;

export const EMPTY_TREE: LinksTree = { version: 2, folders: [], links: [] };

/** A link or folder, as the row menu and the dialogs handle it. */
export interface LinkItem {
	readonly kind: "link" | "folder";
	readonly id: string;
	readonly name: string;
	readonly parentId: string | null;
}

export const itemOf = (entry: SavedLink | LinkFolder): LinkItem =>
	"url" in entry
		? { kind: "link", id: entry.id, name: entry.title, parentId: entry.parentId }
		: { kind: "folder", id: entry.id, name: entry.name, parentId: entry.parentId };

export type TreeRow =
	| {
			readonly kind: "folder";
			readonly folder: LinkFolder;
			readonly depth: number;
			readonly count: number;
			readonly expanded: boolean;
	  }
	| { readonly kind: "link"; readonly link: SavedLink; readonly depth: number }
	| { readonly kind: "empty"; readonly id: string; readonly depth: number };

export const childFolders = (tree: LinksTree, parentId: string | null): LinkFolder[] =>
	tree.folders.filter((folder) => folder.parentId === parentId);

export const childLinks = (tree: LinksTree, parentId: string | null): SavedLink[] =>
	tree.links.filter((link) => link.parentId === parentId);

/** The ids of the `kind` children of `parentId`, in saved order. */
export const siblingIds = (tree: LinksTree, kind: LinkKind, parentId: string | null): string[] =>
	(kind === "folders" ? childFolders(tree, parentId) : childLinks(tree, parentId)).map((item) => item.id);

/** `tree` with the `kind` children of `parentId` shown in `ids` order. Ids it does not hold are dropped. */
export const withOrder = (
	tree: LinksTree,
	kind: LinkKind,
	parentId: string | null,
	ids: readonly string[],
): LinksTree => {
	const order = <T extends { readonly id: string; readonly parentId: string | null }>(items: readonly T[]): T[] => {
		const byId = new Map(items.filter((item) => item.parentId === parentId).map((item) => [item.id, item]));
		const ordered = ids.map((id) => byId.get(id)).filter((item) => item !== undefined);
		if (ordered.length !== byId.size) return [...items];
		let next = 0;
		return items.map((item) => (item.parentId === parentId ? ordered[next++]! : item));
	};
	return kind === "folders" ? { ...tree, folders: order(tree.folders) } : { ...tree, links: order(tree.links) };
};

/** The rows shown: folders first, then links, descending only into expanded folders. */
export const visibleRows = (tree: LinksTree, expanded: ReadonlySet<string>): TreeRow[] => {
	const rows: TreeRow[] = [];
	// A walk from the top reaches only folders with a path to it, so it ends even on a malformed tree.
	const walk = (parentId: string | null, depth: number) => {
		for (const folder of childFolders(tree, parentId)) {
			const open = expanded.has(folder.id);
			const count = childFolders(tree, folder.id).length + childLinks(tree, folder.id).length;
			rows.push({ kind: "folder", folder, depth, count, expanded: open });
			if (open && count === 0) rows.push({ kind: "empty", id: folder.id, depth: depth + 1 });
			else if (open) walk(folder.id, depth + 1);
		}
		for (const link of childLinks(tree, parentId)) rows.push({ kind: "link", link, depth });
	};
	walk(null, 0);
	return rows;
};

/** The depth of folder `id` (top level is 1; `null` is 0). */
export const folderDepth = (tree: LinksTree, id: string | null): number => {
	let depth = 0;
	for (let at = id; at !== null && depth <= tree.folders.length; depth++)
		at = tree.folders.find((folder) => folder.id === at)?.parentId ?? null;
	return depth;
};

/** Folder `id` and every folder inside it. */
export const folderAndInside = (tree: LinksTree, id: string): Set<string> => {
	const inside = new Set([id]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const folder of tree.folders)
			if (folder.parentId !== null && inside.has(folder.parentId) && !inside.has(folder.id)) {
				inside.add(folder.id);
				grew = true;
			}
	}
	return inside;
};

/** How many folders and links a folder removal also removes. */
export const countInside = (tree: LinksTree, id: string): { readonly folders: number; readonly links: number } => {
	const inside = folderAndInside(tree, id);
	return {
		folders: inside.size - 1,
		links: tree.links.filter((link) => link.parentId !== null && inside.has(link.parentId)).length,
	};
};

/** Every folder in display order, with its depth (top level is 1). */
export const folderOptions = (tree: LinksTree): Array<{ readonly folder: LinkFolder; readonly depth: number }> => {
	const options: Array<{ folder: LinkFolder; depth: number }> = [];
	const walk = (parentId: string | null, depth: number) => {
		for (const folder of childFolders(tree, parentId)) {
			options.push({ folder, depth });
			walk(folder.id, depth + 1);
		}
	};
	walk(null, 1);
	return options;
};

/**
 * Whether `item` may move into folder `target` (`null`: the top level). A folder cannot
 * move into itself or a folder inside it, nor so deep that a folder inside it passes the limit.
 */
export const canMoveInto = (tree: LinksTree, item: LinkItem, target: string | null): boolean => {
	if (item.kind === "link") return true;
	const inside = folderAndInside(tree, item.id);
	if (target !== null && inside.has(target)) return false;
	const levels = Math.max(...[...inside].map((id) => folderDepth(tree, id))) - folderDepth(tree, item.id) + 1;
	return folderDepth(tree, target) + levels <= FOLDER_DEPTH_MAX;
};

const EXPANDED_KEY = "harnessy.links.expanded";

/** The folders this browser keeps open. Storage may be refused; the tree then starts closed. */
export const storedExpanded = (): Set<string> => {
	try {
		const value: unknown = JSON.parse(window.localStorage.getItem(EXPANDED_KEY) ?? "[]");
		return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
	} catch {
		return new Set();
	}
};

export const storeExpanded = (ids: ReadonlySet<string>): void => {
	try {
		window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
	} catch {
		// Storage refused: the folders stay open for this page only.
	}
};
