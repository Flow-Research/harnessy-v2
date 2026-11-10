import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * One saved link. `id` is portal-assigned; `title` and `url` are owner-entered.
 * `parentId` is the folder that holds it, or `null` at the top level.
 */
export interface SavedLink {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly addedAt: string;
	readonly parentId: string | null;
}

/** One folder of saved links. `parentId` is the folder that holds it, or `null` at the top level. */
export interface LinkFolder {
	readonly id: string;
	readonly name: string;
	readonly parentId: string | null;
	readonly addedAt: string;
}

/**
 * The saved links file (`links.json` version 2). Sibling order is the order in each
 * array. Version 1, a plain array of links, is read as links at the top level.
 */
export interface LinksTree {
	readonly version: 2;
	readonly folders: readonly LinkFolder[];
	readonly links: readonly SavedLink[];
}

/** Which sibling list a reorder names. */
export type LinkKind = "links" | "folders";

export const LINKS_MAX = 200;
export const LINK_TITLE_MAX = 120;
export const LINK_URL_MAX = 2048;
export const FOLDERS_MAX = 100;
/** A top-level folder is at depth 1. */
export const FOLDER_DEPTH_MAX = 6;
export const FOLDER_NAME_MAX = 80;
const MAX_FILE_BYTES = 1024 * 1024;
const ID = /^[a-f0-9-]{36}$/u;

/**
 * Schemes that run code in the page that follows them. A saved link opens from the
 * signed-in portal page, so these are never stored or followed.
 */
export const LINK_BLOCKED_SCHEMES: ReadonlySet<string> = new Set(["javascript:", "data:", "vbscript:", "blob:"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;

/**
 * The URL a saved link opens, or `undefined` when it is refused. Any URL with a
 * scheme is accepted except the code-running schemes above. A full file path
 * (`/…`, or `~/…` with `home`) is stored as its `file://` URL. Credentials,
 * control and format characters are refused everywhere; whitespace is accepted
 * only in a file path or `file:` URL, where the parser encodes it. The stored value
 * is the parser's form, so the text shown is the text followed.
 */
export const normalizeLinkUrl = (value: string, home?: string): string | undefined => {
	if (value.length > LINK_URL_MAX || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
	const path = value.startsWith("~/") && home !== undefined ? join(home, value.slice(2)) : value;
	if (path.startsWith("/")) {
		// No `..`, `.` or doubled separators: the path saved is the path opened.
		if (normalize(path) !== path) return undefined;
		const href = pathToFileURL(path).href;
		return href.length > LINK_URL_MAX ? undefined : href;
	}
	if (!SCHEME.test(value)) return undefined;
	const file = /^file:/iu.test(value);
	if (!file && /[\s<>\\]/u.test(value)) return undefined;
	try {
		const url = new URL(value);
		if (LINK_BLOCKED_SCHEMES.has(url.protocol) || url.username || url.password) return undefined;
		if (url.protocol === "file:" && (url.host !== "" || url.search || url.hash)) return undefined;
		return url.href.length > LINK_URL_MAX ? undefined : url.href;
	} catch {
		return undefined;
	}
};

/** The local path of a `file:` link, or `undefined` for any other link. */
export const linkFilePath = (url: string): string | undefined =>
	url.startsWith("file:") ? fileURLToPath(url) : undefined;

/** Whether `value`, as typed, names a local file: a path or a `file:` URL. */
export const isFileEntry = (value: string): boolean => {
	const entry = value.trim();
	return entry.startsWith("/") || entry.startsWith("~") || /^file:/iu.test(entry);
};

/**
 * Bundles, scripts, installers and shortcut files that the system opener would run
 * or follow rather than show. Matched on the saved path and on its resolved target.
 */
const RUNNABLE =
	/\.(?:app|command|terminal|tool|sh|bash|zsh|csh|ksh|fish|py|pl|rb|js|mjs|scpt|scptd|applescript|workflow|action|shortcut|pkg|mpkg|dmg|jar|webloc|inetloc|fileloc|url|prefpane|bundle|plugin|kext|osax|systemextension)$/iu;

/**
 * Whether opening `path` could start a program: a runnable type (above) or a file with
 * an executable bit. The portal reveals such a file in the file manager instead.
 */
export const fileRunsCode = (path: string): boolean => {
	const real = realpathSync(path);
	if ([path, real].some((candidate) => RUNNABLE.test(candidate.replace(/\/+$/u, "")))) return true;
	const stat = statSync(real);
	return stat.isFile() && (stat.mode & 0o111) !== 0;
};

/**
 * The name used when none is given: a file's name, a site's host name, or the rest of
 * the address. It is trimmed like a typed name; when that leaves nothing usable (such as
 * `mailto:` alone), the address itself is the name.
 */
const defaultTitle = (url: string): string => {
	const file = linkFilePath(url);
	const parsed = new URL(url);
	const name = (file !== undefined ? basename(file) : parsed.hostname || parsed.href.slice(parsed.protocol.length))
		.trim()
		.slice(0, LINK_TITLE_MAX)
		.trim();
	return name && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : url.slice(0, LINK_TITLE_MAX);
};

const normalizeTitle = (value: string, url: string): string | undefined => {
	const title = value.trim() || defaultTitle(url);
	return title.length > LINK_TITLE_MAX || /[\p{Cc}\p{Cf}]/u.test(title) ? undefined : title;
};

const normalizeFolderName = (value: string): string | undefined => {
	const name = value.trim();
	return name.length === 0 || name.length > FOLDER_NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(name) ? undefined : name;
};

/** A name for a link as typed, or `undefined`. The result always passes the read check below. */
const linkTitle = (value: string, url: string): string | undefined => {
	const title = normalizeTitle(value, url);
	// Never write an entry that a later read would refuse: one bad entry makes the whole file unreadable.
	return title !== undefined && normalizeTitle(title, "http://x/") === title ? title : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const isParent = (value: unknown): boolean => value === null || isId(value);
const isDate = (value: unknown): boolean => typeof value === "string" && !Number.isNaN(Date.parse(value));

const hasLinkFields = (link: Record<string, unknown>): boolean =>
	isId(link.id) &&
	typeof link.title === "string" &&
	normalizeTitle(link.title, "http://x/") === link.title &&
	typeof link.url === "string" &&
	normalizeLinkUrl(link.url) === link.url &&
	isDate(link.addedAt);

/** A version 1 entry: a link without `parentId`. */
const isV1Link = (value: unknown): value is Omit<SavedLink, "parentId"> =>
	isRecord(value) && Object.keys(value).length === 4 && hasLinkFields(value);

const isSavedLink = (value: unknown): value is SavedLink =>
	isRecord(value) && Object.keys(value).length === 5 && hasLinkFields(value) && isParent(value.parentId);

const isFolder = (value: unknown): value is LinkFolder =>
	isRecord(value) &&
	Object.keys(value).length === 4 &&
	isId(value.id) &&
	typeof value.name === "string" &&
	normalizeFolderName(value.name) === value.name &&
	isParent(value.parentId) &&
	isDate(value.addedAt);

const folderMap = (tree: LinksTree): Map<string, LinkFolder> =>
	new Map(tree.folders.map((folder) => [folder.id, folder]));

/** The depth of folder `id` (top level is 1; `null` is 0), or infinity for a missing parent or a cycle. */
const folderDepth = (folders: ReadonlyMap<string, LinkFolder>, id: string | null): number => {
	let depth = 0;
	for (let at = id; at !== null; depth++) {
		const folder = folders.get(at);
		if (folder === undefined || depth > FOLDERS_MAX) return Number.POSITIVE_INFINITY;
		at = folder.parentId;
	}
	return depth;
};

/** Folder `id` and every folder inside it, at any depth. */
const folderAndInside = (folders: readonly LinkFolder[], id: string): Set<string> => {
	const inside = new Set([id]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const folder of folders)
			if (folder.parentId !== null && inside.has(folder.parentId) && !inside.has(folder.id)) {
				inside.add(folder.id);
				grew = true;
			}
	}
	return inside;
};

/** Unique ids, every parent present, no cycle and no folder deeper than the limit. */
const isConsistent = (tree: LinksTree): boolean => {
	const folders = folderMap(tree);
	const ids = new Set([...tree.folders, ...tree.links].map((item) => item.id));
	return (
		ids.size === tree.folders.length + tree.links.length &&
		tree.folders.every((folder) => folderDepth(folders, folder.id) <= FOLDER_DEPTH_MAX) &&
		tree.links.every((link) => link.parentId === null || folders.has(link.parentId))
	);
};

/** The tree in a parsed `links.json`, or `undefined` when the file is not one the portal wrote. */
const parseTree = (value: unknown): LinksTree | undefined => {
	let tree: LinksTree;
	if (Array.isArray(value)) {
		if (value.length > LINKS_MAX || !value.every(isV1Link)) return undefined;
		tree = { version: 2, folders: [], links: value.map((link) => ({ ...link, parentId: null })) };
	} else {
		if (!isRecord(value) || Object.keys(value).sort().join(",") !== "folders,links,version" || value.version !== 2)
			return undefined;
		const { folders, links } = value;
		if (
			!Array.isArray(folders) ||
			!Array.isArray(links) ||
			folders.length > FOLDERS_MAX ||
			links.length > LINKS_MAX ||
			!folders.every(isFolder) ||
			!links.every(isSavedLink)
		)
			return undefined;
		tree = { version: 2, folders, links };
	}
	return isConsistent(tree) ? tree : undefined;
};

/** `items` with `item` placed at `index` among its siblings (the items with its `parentId`). */
const place = <T extends { readonly id: string; readonly parentId: string | null }>(
	items: readonly T[],
	item: T,
	index: number,
): T[] => {
	const rest = items.filter((other) => other.id !== item.id);
	const before = rest.filter((other) => other.parentId === item.parentId)[index];
	const at = before === undefined ? rest.length : rest.indexOf(before);
	return [...rest.slice(0, at), item, ...rest.slice(at)];
};

/** `items` with the children of `parentId` in `ids` order. `ids` must name each of them exactly once. */
const reorderSiblings = <T extends { readonly id: string; readonly parentId: string | null }>(
	items: readonly T[],
	parentId: string | null,
	ids: readonly string[],
): T[] => {
	const byId = new Map(items.filter((item) => item.parentId === parentId).map((item) => [item.id, item]));
	if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id)))
		throw new LinkRefused("links_changed");
	let next = 0;
	return items.map((item) => (item.parentId === parentId ? byId.get(ids[next++]!)! : item));
};

export class LinkRefused extends Error {}

const EMPTY: LinksTree = { version: 2, folders: [], links: [] };

/** The owner's saved links and folders: portal-local state, written only by explicit page actions. */
export class LinksState {
	readonly file: string;
	readonly #clock: () => Date;
	readonly #home: string | undefined;
	/** `home` expands a `~/` file path; without it such a path is refused. */
	constructor(file: string, clock: () => Date = () => new Date(), home?: string) {
		this.file = file;
		this.#clock = clock;
		this.#home = home;
	}

	/** The saved tree. A version 1 file is read as top-level links; the next write saves version 2. */
	read(): LinksTree {
		let fd: number;
		try {
			fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("invalid_links_state");
			const tree = parseTree(JSON.parse(readFileSync(fd, "utf8")));
			if (tree === undefined) throw new Error("invalid_links_state");
			return tree;
		} finally {
			closeSync(fd);
		}
	}

	/** Save a link at the end of folder `parentId` (`null`: the top level). */
	add(title: string, url: string, parentId: string | null = null): SavedLink {
		const href = normalizeLinkUrl(url.trim(), this.#home);
		if (href === undefined) throw new LinkRefused("invalid_url");
		const name = linkTitle(title, href);
		if (name === undefined) throw new LinkRefused("invalid_title");
		const tree = this.read();
		if (tree.links.length >= LINKS_MAX) throw new LinkRefused("links_full");
		requireFolder(tree, parentId);
		const link: SavedLink = {
			id: randomUUID(),
			title: name,
			url: href,
			addedAt: this.#clock().toISOString(),
			parentId,
		};
		this.#write({ ...tree, links: [...tree.links, link] });
		return link;
	}

	/** Make a folder at the end of the folders in `parentId` (`null`: the top level). */
	addFolder(name: string, parentId: string | null): LinkFolder {
		const folderName = normalizeFolderName(name);
		if (folderName === undefined) throw new LinkRefused("invalid_name");
		const tree = this.read();
		if (tree.folders.length >= FOLDERS_MAX) throw new LinkRefused("folders_full");
		requireFolder(tree, parentId);
		if (folderDepth(folderMap(tree), parentId) >= FOLDER_DEPTH_MAX) throw new LinkRefused("folder_too_deep");
		const folder: LinkFolder = { id: randomUUID(), name: folderName, parentId, addedAt: this.#clock().toISOString() };
		this.#write({ ...tree, folders: [...tree.folders, folder] });
		return folder;
	}

	/** Rename a link (an empty name derives one, as on add) or a folder. */
	rename(id: string, name: string): void {
		const tree = this.read();
		if (tree.folders.some((folder) => folder.id === id)) {
			const folderName = normalizeFolderName(name);
			if (folderName === undefined) throw new LinkRefused("invalid_name");
			this.#write({
				...tree,
				folders: tree.folders.map((folder) => (folder.id === id ? { ...folder, name: folderName } : folder)),
			});
			return;
		}
		const link = tree.links.find((entry) => entry.id === id);
		if (link === undefined) throw new LinkRefused("link_missing");
		const title = linkTitle(name, link.url);
		if (title === undefined) throw new LinkRefused("invalid_title");
		this.#write({ ...tree, links: tree.links.map((entry) => (entry.id === id ? { ...entry, title } : entry)) });
	}

	/**
	 * Move a link or folder into `parentId` at sibling `index` (past the end: last). A folder
	 * cannot move into itself or a folder inside it, nor deeper than the depth limit.
	 */
	move(id: string, parentId: string | null, index: number): void {
		const tree = this.read();
		requireFolder(tree, parentId);
		const folders = folderMap(tree);
		const folder = folders.get(id);
		if (folder !== undefined) {
			const inside = folderAndInside(tree.folders, id);
			if (parentId !== null && inside.has(parentId)) throw new LinkRefused("invalid_move");
			const levels = Math.max(...[...inside].map((other) => folderDepth(folders, other))) - folderDepth(folders, id);
			if (folderDepth(folders, parentId) + levels + 1 > FOLDER_DEPTH_MAX) throw new LinkRefused("folder_too_deep");
			this.#write({ ...tree, folders: place(tree.folders, { ...folder, parentId }, index) });
			return;
		}
		const link = tree.links.find((entry) => entry.id === id);
		if (link === undefined) throw new LinkRefused("link_missing");
		this.#write({ ...tree, links: place(tree.links, { ...link, parentId }, index) });
	}

	/** Remove a link, or a folder with every folder and link inside it. */
	remove(id: string): void {
		const tree = this.read();
		if (tree.folders.some((folder) => folder.id === id)) {
			const inside = folderAndInside(tree.folders, id);
			this.#write({
				version: 2,
				folders: tree.folders.filter((folder) => !inside.has(folder.id)),
				links: tree.links.filter((link) => link.parentId === null || !inside.has(link.parentId)),
			});
			return;
		}
		const links = tree.links.filter((link) => link.id !== id);
		if (links.length === tree.links.length) throw new LinkRefused("link_missing");
		this.#write({ ...tree, links });
	}

	/** Put the `kind` children of `parentId` in `ids` order. `ids` must name each of them exactly once. */
	reorder(kind: LinkKind, parentId: string | null, ids: readonly string[]): void {
		const tree = this.read();
		this.#write(
			kind === "folders"
				? { ...tree, folders: reorderSiblings(tree.folders, parentId, ids) }
				: { ...tree, links: reorderSiblings(tree.links, parentId, ids) },
		);
	}

	/**
	 * The path of saved file link `id`, checked to exist now, and whether the portal must
	 * only reveal it (see `fileRunsCode`) instead of opening it.
	 */
	fileTarget(id: string): { readonly path: string; readonly reveal: boolean } {
		const link = this.read().links.find((entry) => entry.id === id);
		if (link === undefined) throw new LinkRefused("link_missing");
		const path = linkFilePath(link.url);
		if (path === undefined) throw new LinkRefused("not_a_file");
		if (!existsSync(path)) throw new LinkRefused("file_missing");
		return { path, reveal: fileRunsCode(path) };
	}

	#write(tree: LinksTree): void {
		const temp = `${this.file}.${randomUUID()}.tmp`;
		try {
			const file: LinksTree = { version: 2, folders: tree.folders, links: tree.links };
			writeFileSync(temp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
			renameSync(temp, this.file);
		} finally {
			try {
				unlinkSync(temp);
			} catch {
				/* Renamed or not created. */
			}
		}
	}
}

const requireFolder = (tree: LinksTree, parentId: string | null): void => {
	if (parentId !== null && !tree.folders.some((folder) => folder.id === parentId))
		throw new LinkRefused("folder_missing");
};
