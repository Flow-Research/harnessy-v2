/**
 * The Harnessy app's static files, pinned by `asset-manifest.json`.
 *
 * The app is built by Vite into `dist/portal-app/` (see `app/vite.config.ts`).
 * The build writes a manifest that lists every file it emitted with its byte
 * length and SHA-256. At start the portal reads the manifest, reads each listed
 * file once (never following a symbolic link), checks its length and digest and
 * serves it from memory. A file on disk that the manifest does not list is never
 * served, and any mismatch stops the portal from starting.
 *
 * `index.html` is checked too: it may load scripts and styles only from files in
 * the manifest, and it may hold no inline script, inline style or event-handler
 * attribute. So the strict CSP (`script-src 'self'; style-src 'self'`) allows
 * everything the app needs and nothing else. Files with a content hash in their
 * name are cached as immutable; `index.html` is never cached.
 *
 * When no manifest exists (a source checkout that was never built), a small
 * page without any script says so instead.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTAL_ASSET_MANIFEST = "asset-manifest.json";
export const PORTAL_ASSET_MANIFEST_SCHEMA = "harnessy.portal.asset-manifest.v1";
export const PORTAL_NO_STORE = "no-store";
export const PORTAL_IMMUTABLE = "public, max-age=31536000, immutable";
/** One file may be at most this large; the whole bundle at most {@link MAX_BUNDLE_BYTES}. */
export const MAX_ASSET_BYTES = 4 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
export const MAX_ASSETS = 256;
const MAX_MANIFEST_BYTES = 256 * 1024;

export const PORTAL_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".woff2": "font/woff2",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
};

/** A relative path of one or two plain segments. No segment starts with a dot, so `..` is impossible. */
const ASSET_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\/)?[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
/** Vite names a built file `<name>-<hash>.<ext>`; such a file never changes under the same name. */
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2|svg)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface PortalPageAsset {
	readonly contentType: string;
	readonly body: Buffer;
	readonly cacheControl: string;
}

/** Served path to file, for example `/assets/index-1a2b3c4d.js`. `/` is the app's `index.html`. */
export type PortalPageAssets = ReadonlyMap<string, PortalPageAsset>;

export class PortalAssetError extends Error {
	readonly code: string;

	constructor(code: string, path?: string) {
		super(path === undefined ? code : `${code}: ${path}`);
		this.name = "PortalAssetError";
		this.code = code;
	}
}

/** Shown when the app bundle is not built. It loads nothing. */
export const PORTAL_FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Harnessy</title>
</head>
<body>
<h1>Harnessy</h1>
<p>The Harnessy app is not built in this installation, so only the read-only API is served.</p>
<p>Build it with <code>npm run build</code> in the source checkout, or install a release.</p>
</body>
</html>
`;

/** The default bundle directory: `dist/portal-app/` of this package, from `src/` or `dist/`. */
export const defaultPortalAppDir = (): string => fileURLToPath(new URL("../../dist/portal-app/", import.meta.url));

/** Read a regular file without following a final symbolic link. `undefined` when it does not exist. */
const readNoFollow = (path: string, maxBytes: number): Buffer | undefined => {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new PortalAssetError("portal_asset_unsafe", path);
	}
	try {
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) throw new PortalAssetError("portal_asset_unsafe", path);
		if (stat.size > maxBytes) throw new PortalAssetError("portal_asset_oversize", path);
		const body = Buffer.alloc(stat.size);
		const read = readSync(descriptor, body, 0, stat.size, 0);
		if (read !== stat.size) throw new PortalAssetError("portal_asset_unreadable", path);
		return body;
	} finally {
		closeSync(descriptor);
	}
};

interface ManifestEntry {
	readonly sha256: string;
	readonly bytes: number;
}

const parseManifest = (body: Buffer): ReadonlyMap<string, ManifestEntry> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString("utf8"));
	} catch {
		throw new PortalAssetError("portal_asset_manifest_invalid");
	}
	const record = parsed as { schema?: unknown; files?: unknown } | null;
	if (
		typeof record !== "object" ||
		record === null ||
		Object.keys(record).length !== 2 ||
		record.schema !== PORTAL_ASSET_MANIFEST_SCHEMA ||
		typeof record.files !== "object" ||
		record.files === null ||
		Array.isArray(record.files)
	)
		throw new PortalAssetError("portal_asset_manifest_invalid");
	const entries = Object.entries(record.files as Record<string, unknown>);
	if (entries.length === 0 || entries.length > MAX_ASSETS) throw new PortalAssetError("portal_asset_manifest_invalid");
	const files = new Map<string, ManifestEntry>();
	for (const [path, value] of entries) {
		const entry = value as { sha256?: unknown; bytes?: unknown } | null;
		if (
			!ASSET_PATH.test(path) ||
			PORTAL_ASSET_CONTENT_TYPES[extname(path)] === undefined ||
			typeof entry !== "object" ||
			entry === null ||
			Object.keys(entry).length !== 2 ||
			typeof entry.sha256 !== "string" ||
			!SHA256.test(entry.sha256) ||
			typeof entry.bytes !== "number" ||
			!Number.isSafeInteger(entry.bytes) ||
			entry.bytes < 0 ||
			entry.bytes > MAX_ASSET_BYTES
		)
			throw new PortalAssetError("portal_asset_manifest_invalid", path);
		files.set(path, { sha256: entry.sha256, bytes: entry.bytes });
	}
	if (!files.has("index.html")) throw new PortalAssetError("portal_asset_manifest_invalid", "index.html");
	return files;
};

/**
 * Refuse an `index.html` that the CSP would partly block or that loads anything
 * outside the manifest: an inline script, a `<style>` element, a `style` or `on…`
 * attribute, or a `src`/`href` that is not a listed file.
 */
export const assertPortalIndexHtml = (html: string, listed: ReadonlySet<string>): void => {
	if (/<style[\s>]/iu.test(html)) throw new PortalAssetError("portal_index_inline_style");
	if (/\sstyle\s*=/iu.test(html)) throw new PortalAssetError("portal_index_inline_style");
	if (/\son[a-z]+\s*=/iu.test(html)) throw new PortalAssetError("portal_index_event_handler");
	for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
		if (!/\ssrc\s*=/iu.test(script[1]!) || script[2]!.trim() !== "")
			throw new PortalAssetError("portal_index_inline_script");
	}
	// Every quoting form: "…", '…' and unquoted. Any src/href attribute that is not one of these is refused too.
	const attributes = [...html.matchAll(/\s(?:src|href|srcset|xlink:href)\s*=/giu)].length;
	const references = [
		...html.matchAll(/\s(?:src|href|srcset|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu),
	];
	if (references.length !== attributes) throw new PortalAssetError("portal_index_reference_unlisted");
	for (const reference of references) {
		const value = reference[1] ?? reference[2] ?? reference[3]!;
		if (!value.startsWith("/") || !listed.has(value.slice(1)))
			throw new PortalAssetError("portal_index_reference_unlisted", value);
	}
};

/**
 * Read and verify the bundle in `appDir`. Throws a {@link PortalAssetError} on
 * any unsafe, unlisted, oversize or tampered file. Without a manifest, serves
 * {@link PORTAL_FALLBACK_HTML} at `/`.
 */
export const loadPortalPageAssets = (appDir: string = defaultPortalAppDir()): PortalPageAssets => {
	const manifestBody = readNoFollow(join(appDir, PORTAL_ASSET_MANIFEST), MAX_MANIFEST_BYTES);
	if (manifestBody === undefined)
		return new Map([
			[
				"/",
				{
					contentType: PORTAL_ASSET_CONTENT_TYPES[".html"]!,
					body: Buffer.from(PORTAL_FALLBACK_HTML, "utf8"),
					cacheControl: PORTAL_NO_STORE,
				},
			],
		]);
	const manifest = parseManifest(manifestBody);
	const assets = new Map<string, PortalPageAsset>();
	let total = 0;
	for (const [path, entry] of manifest) {
		const body = readNoFollow(join(appDir, path), MAX_ASSET_BYTES);
		if (body === undefined) throw new PortalAssetError("portal_asset_missing", path);
		if (body.byteLength !== entry.bytes || createHash("sha256").update(body).digest("hex") !== entry.sha256)
			throw new PortalAssetError("portal_asset_digest_mismatch", path);
		total += body.byteLength;
		if (total > MAX_BUNDLE_BYTES) throw new PortalAssetError("portal_asset_oversize", path);
		const isIndex = path === "index.html";
		if (isIndex) assertPortalIndexHtml(body.toString("utf8"), new Set(manifest.keys()));
		assets.set(isIndex ? "/" : `/${path}`, {
			contentType: PORTAL_ASSET_CONTENT_TYPES[extname(path)]!,
			body,
			cacheControl: !isIndex && HASHED_NAME.test(path) ? PORTAL_IMMUTABLE : PORTAL_NO_STORE,
		});
	}
	return assets;
};
