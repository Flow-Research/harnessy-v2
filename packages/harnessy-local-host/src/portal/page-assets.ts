/**
 * The portal page's static files: `index.html`, `app.css` and the three page
 * scripts. They are read once at start and served from memory.
 *
 * The HTML has no inline script, no inline style and no event-handler
 * attribute, so the strict CSP (`script-src 'self'; style-src 'self'`) allows
 * everything it needs and nothing else. It contains no token or other secret.
 *
 * In a build, the scripts are the compiled `dist/portal/page/*.js`. When the
 * package runs from source (tests, `node src/portal-cli.ts`), the `.ts` files are
 * type-stripped with Node's own stripper and their relative `.ts` imports point
 * at the served `.js` names. Either way each script may import only another
 * page script; anything else is refused at load.
 */
import { lstatSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTAL_PAGE_SCRIPTS = ["app", "mount", "view-model"] as const;

export interface PortalPageAsset {
	readonly contentType: string;
	readonly body: Buffer;
}

/** Served path to file, for example `/app.js`. */
export type PortalPageAssets = ReadonlyMap<string, PortalPageAsset>;

export const PORTAL_INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Harnessy portal</title>
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
</head>
<body>
<header>
<p class="brand">Harnessy</p>
<nav aria-label="Pages">
<a href="#/today">Today</a>
<a href="#/health">Health</a>
<a href="#/connections">Connections</a>
</nav>
</header>
<h1 id="page-title">Today</h1>
<main id="main" aria-live="polite"><p class="muted">Loading</p></main>
<footer><p class="muted">Read-only. Approvals, publishing and sign-in stay in each owning service.</p></footer>
</body>
</html>
`;

/** Brand colours from the landing page, as variables a designer can change in one place. */
export const PORTAL_APP_CSS = `:root {
	--ink: #12151a;
	--paper: #f7f8fa;
	--panel: #ffffff;
	--line: #dde1e6;
	--muted: #5b6470;
	--accent: #2fc7b0;
	--warm: #e8963c;
	--bad: #c2412d;
	color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
	:root { --ink: #e9edf2; --paper: #12151a; --panel: #1b1f26; --line: #2c323b; --muted: #9aa3ad; }
}
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 960px; padding: 0 16px 32px; background: var(--paper); color: var(--ink);
	font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.brand { margin: 0; font-weight: 700; }
nav { display: flex; gap: 12px; }
nav a, a { color: var(--accent); }
h1 { font-size: 22px; margin: 20px 0 8px; }
h2 { font-size: 16px; margin: 0 0 8px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
.rows { list-style: none; margin: 0; padding: 0; }
.row { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; padding: 6px 0; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.row p { flex-basis: 100%; margin: 2px 0; }
.count { margin-left: auto; }
.muted { color: var(--muted); }
.note { color: var(--muted); font-size: 14px; }
.ok { color: var(--accent); }
.warn { color: var(--warm); }
.bad { color: var(--bad); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--paper); padding: 1px 4px; border-radius: 4px;
	overflow-wrap: anywhere; }
`;

const RELATIVE_TS_IMPORT = /(\bfrom\s+["']\.\/[a-z-]+)\.ts(["'])/gu;
const IMPORT_SPECIFIER = /\b(?:from|import)\s*["']([^"']+)["']/gu;

/** The default page directory: `page/` next to this module, in `src/` or `dist/`. */
export const defaultPortalPageDir = (): string => fileURLToPath(new URL("./page/", import.meta.url));

const isFile = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** One page script as browser JavaScript. */
const loadScript = (pageDir: string, name: string): Buffer => {
	const compiled = join(pageDir, `${name}.js`);
	const source = isFile(compiled)
		? readFileSync(compiled, "utf8")
		: stripTypeScriptTypes(readFileSync(join(pageDir, `${name}.ts`), "utf8"), { mode: "strip" }).replace(
				RELATIVE_TS_IMPORT,
				"$1.js$2",
			);
	const allowed = new Set(PORTAL_PAGE_SCRIPTS.map((script) => `./${script}.js`));
	for (const match of source.matchAll(IMPORT_SPECIFIER))
		if (!allowed.has(match[1]!)) throw new Error(`portal_page_import_refused: ${name}`);
	return Buffer.from(source, "utf8");
};

/** Read every page file once. Throws when a script is missing or imports anything but another page script. */
export const loadPortalPageAssets = (pageDir: string = defaultPortalPageDir()): PortalPageAssets => {
	const assets = new Map<string, PortalPageAsset>([
		["/", { contentType: "text/html; charset=utf-8", body: Buffer.from(PORTAL_INDEX_HTML, "utf8") }],
		["/app.css", { contentType: "text/css; charset=utf-8", body: Buffer.from(PORTAL_APP_CSS, "utf8") }],
	]);
	for (const name of PORTAL_PAGE_SCRIPTS)
		assets.set(`/${name}.js`, { contentType: "text/javascript; charset=utf-8", body: loadScript(pageDir, name) });
	return assets;
};
