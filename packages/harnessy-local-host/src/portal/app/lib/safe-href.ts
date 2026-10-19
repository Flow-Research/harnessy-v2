/**
 * The only links the app renders as links.
 *
 * A link must be `http://127.0.0.1:<port>/...`, `http://[::1]:<port>/...` or
 * `http://localhost:<port>/...` with an explicit port, no credentials, no query string and no fragment.
 * Anything else, including `javascript:` and every other host, is shown as text
 * until an allow-list for external links has been reviewed. The value must
 * already be in the form the URL parser gives it (see `safeHref`).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

export const safeHref = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value.length > 256) return undefined;
	// Judge the URL the browser will follow, parsed by the browser's own parser,
	// never the raw string. A value the parser would change (stripped control
	// characters or whitespace, a case-folded scheme or host, a numeric host such
	// as 127.1, a default or zero-padded port, dot segments, backslashes,
	// percent-encoding) is refused rather than normalised: the text checked is
	// the text followed. The one change allowed is the "/" an empty path gets.
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.href !== value && url.href !== `${value}/`) return undefined;
	if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.port === "") return undefined;
	if (url.username !== "" || url.password !== "") return undefined;
	// An empty query or fragment ("…/?", "…/#") leaves `search` and `hash` empty but is still in `href`.
	if (url.search !== "" || url.hash !== "" || /[?#]/u.test(url.href)) return undefined;
	return url.href;
};

/** An in-app route such as `#/jobs/fathom-poll`: letters, digits and `-`, `_`, `.`, `/` only. */
export const safeAppRoute = (value: unknown): string | undefined =>
	typeof value === "string" && /^#\/[A-Za-z0-9/_.-]{0,200}$/u.test(value) && !value.includes("..") ? value : undefined;
