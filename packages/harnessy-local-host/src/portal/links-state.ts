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

/** One saved link. `id` is portal-assigned; `title` and `url` are owner-entered. */
export interface SavedLink {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly addedAt: string;
}

export const LINKS_MAX = 200;
export const LINK_TITLE_MAX = 120;
export const LINK_URL_MAX = 2048;
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

const defaultTitle = (url: string): string => {
	const file = linkFilePath(url);
	if (file !== undefined) return basename(file) || file;
	const parsed = new URL(url);
	return (parsed.hostname || parsed.href.slice(parsed.protocol.length)).slice(0, LINK_TITLE_MAX);
};

const normalizeTitle = (value: string, url: string): string | undefined => {
	const title = value.trim() || defaultTitle(url);
	return title.length > LINK_TITLE_MAX || /[\p{Cc}\p{Cf}]/u.test(title) ? undefined : title;
};

const isSavedLink = (value: unknown): value is SavedLink => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const link = value as Record<string, unknown>;
	return (
		Object.keys(link).length === 4 &&
		typeof link.id === "string" &&
		ID.test(link.id) &&
		typeof link.title === "string" &&
		normalizeTitle(link.title, "http://x/") === link.title &&
		typeof link.url === "string" &&
		normalizeLinkUrl(link.url) === link.url &&
		typeof link.addedAt === "string" &&
		!Number.isNaN(Date.parse(link.addedAt))
	);
};

export class LinkRefused extends Error {}

/** The owner's saved links: portal-local state, written only by explicit page actions. */
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

	read(): SavedLink[] {
		let fd: number;
		try {
			fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("invalid_links_state");
			const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
			if (!Array.isArray(value) || value.length > LINKS_MAX || !value.every(isSavedLink))
				throw new Error("invalid_links_state");
			return value;
		} finally {
			closeSync(fd);
		}
	}

	add(title: string, url: string): SavedLink {
		const href = normalizeLinkUrl(url.trim(), this.#home);
		if (href === undefined) throw new LinkRefused("invalid_url");
		const name = normalizeTitle(title, href);
		if (name === undefined) throw new LinkRefused("invalid_title");
		const links = this.read();
		if (links.length >= LINKS_MAX) throw new LinkRefused("links_full");
		const link: SavedLink = { id: randomUUID(), title: name, url: href, addedAt: this.#clock().toISOString() };
		this.#write([...links, link]);
		return link;
	}

	remove(id: string): void {
		const links = this.read();
		const next = links.filter((link) => link.id !== id);
		if (next.length === links.length) throw new LinkRefused("link_missing");
		this.#write(next);
	}

	/** Put the links in `ids` order. `ids` must name every current link exactly once. */
	reorder(ids: readonly string[]): void {
		const links = this.read();
		const byId = new Map(links.map((link) => [link.id, link]));
		if (ids.length !== links.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id)))
			throw new LinkRefused("links_changed");
		this.#write(ids.map((id) => byId.get(id)!));
	}

	/**
	 * The path of saved file link `id`, checked to exist now, and whether the portal must
	 * only reveal it (see `fileRunsCode`) instead of opening it.
	 */
	fileTarget(id: string): { readonly path: string; readonly reveal: boolean } {
		const link = this.read().find((entry) => entry.id === id);
		if (link === undefined) throw new LinkRefused("link_missing");
		const path = linkFilePath(link.url);
		if (path === undefined) throw new LinkRefused("not_a_file");
		if (!existsSync(path)) throw new LinkRefused("file_missing");
		return { path, reveal: fileRunsCode(path) };
	}

	#write(links: readonly SavedLink[]): void {
		const temp = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(links), { mode: 0o600, flag: "wx" });
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
