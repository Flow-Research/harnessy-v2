/**
 * Service-navigation links use safeHref; document links use safeExternalHref.
 *
 * A link must be `http://127.0.0.1:<port>/...`, `http://[::1]:<port>/...` or
 * `http://localhost:<port>/...` with an explicit port, no credentials, no query string and no fragment.
 * Other destinations are refused by this service-navigation policy. Document
 * links have a separate HTTP/HTTPS policy below. A service link must
 * already be in the form the URL parser gives it (see `safeHref`).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** External document links; separate from the stricter service-navigation policy. */
export const safeExternalHref = (value: string): string | undefined => {
	if (value.length > 2048 || !/^https?:\/\//iu.test(value) || /[\s\p{Cc}\p{Cf}\\<>]/u.test(value)) return undefined;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
};

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

/** Only the fixed helper's single-use review exchange may carry authentication in navigation. */
export const safeReviewHandoffHref = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value.length > 1024) return undefined;
	try {
		const url = new URL(value);
		if (
			url.href !== value ||
			url.protocol !== "http:" ||
			!["127.0.0.1", "[::1]"].includes(url.hostname) ||
			!url.port ||
			url.username ||
			url.password ||
			url.hash ||
			!["/", "/exchange"].includes(url.pathname)
		)
			return undefined;
		const keys = [...url.searchParams.keys()];
		if (
			keys.some((key) => !["code", "portal", "next"].includes(key)) ||
			new Set(keys).size !== keys.length ||
			!/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("code") ?? "")
		)
			return undefined;
		const portal = url.searchParams.get("portal");
		if (
			portal === null ||
			!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/u.test(portal) ||
			new URL(portal).port === ""
		)
			return undefined;
		if (
			url.searchParams.has("next") &&
			(url.pathname !== "/exchange" || url.searchParams.get("next") !== "google-reconnect")
		)
			return undefined;
		return value;
	} catch {
		return undefined;
	}
};
