/**
 * Notification text leaves the machine (ntfy, webhooks) or shows on a lock
 * screen, so every field passes through here first. Callers should still put
 * only fixed text, short ids, PR numbers and SHAs in a notification; this is
 * the safety net for anything that slips through.
 */

/** Longest title, message and next step, in UTF-16 code units, after cleaning. */
export const TEXT_LIMITS = { title: 80, message: 400, nextStep: 200 } as const;

/** Control characters (Unicode Cc) and line separators, which become spaces. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
/** Format characters (Unicode Cf: zero-width, direction-changing) and lone surrogates (Cs), which could disguise text; removed. */
const INVISIBLE = /[\p{Cf}\p{Cs}]/gu;

/** `user:password@` inside a URL. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/giu;

/** `token=...`, `api_key: ...`, `password=...` and similar assignments, and `Bearer <value>`. */
const SECRET_ASSIGNMENT =
	/\b(?:(access[_-]?token|api[_-]?key|authorization|client[_-]?secret|key|passw(?:or)?d|pwd|secret|session|signature|sig|token)(\s*[=:]\s*)|(bearer)(\s+))(?!<redacted>)[^\s&"',;)]+/giu;

/** Well-known credential formats. */
const KNOWN_TOKEN =
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|tk_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gu;

/** Long opaque runs of letters and digits, which are usually keys. */
const OPAQUE = /[A-Za-z0-9_+/=-]{32,}/gu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** An absolute path token: POSIX `/x`, Windows `C:\x` or `C:/x`, or a UNC `\\host\share`. */
const ABSOLUTE_PATH = /(^|[\s"'`(<[=])((?:\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`)>\];,]*)/gu;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Both slash spellings of the home directory, longest first, so `C:\Users\me` and `C:/Users/me` both match. */
const homeSpellings = (home: string): ReadonlyArray<string> => {
	const trimmed = home.replace(/[\\/]+$/u, "");
	if (trimmed.length < 2) return [];
	return [...new Set([trimmed, trimmed.replaceAll("\\", "/"), trimmed.replaceAll("/", "\\")])];
};

/**
 * Shortest configured secret that is redacted. Shorter values would mangle
 * ordinary words, so a configured token must be at least this long to be
 * accepted at all (see `allowedToken`), and every accepted token is redacted.
 */
export const MIN_SECRET_LENGTH = 8;

export interface SanitizeOptions {
	/** The user's home directory; paths under it become `~`. */
	readonly home?: string;
	/** Exact values that must never appear, such as a configured access token. */
	readonly secrets?: ReadonlyArray<string>;
}

/**
 * Replace secrets and private paths in `text`:
 * configured secret values, URL credentials, `key=value` secrets, known token
 * formats and long opaque strings become `<redacted>`; the home directory
 * becomes `~`; any other absolute path becomes `<path>`. Control and
 * direction-changing characters are removed.
 */
export const redact = (text: string, options: SanitizeOptions = {}): string => {
	let out = text.replace(INVISIBLE, "").replace(CONTROL, " ");
	for (const secret of options.secrets ?? [])
		if (secret.length >= MIN_SECRET_LENGTH) out = out.replace(new RegExp(escapeRegExp(secret), "gu"), "<redacted>");
	out = out
		.replace(URL_USERINFO, "$1")
		.replace(SECRET_ASSIGNMENT, "$1$2$3$4<redacted>")
		.replace(KNOWN_TOKEN, "<redacted>")
		.replace(OPAQUE, (run) => (UUID.test(run) || !/\d/u.test(run) || !/[A-Za-z]/u.test(run) ? run : "<redacted>"));
	for (const home of homeSpellings(options.home ?? ""))
		out = out.replace(new RegExp(`${escapeRegExp(home)}(?=$|[\\\\/\\s"'\`)>\\]])`, "giu"), "~");
	// After `~` replacement, so `~/x` stays readable and other absolute paths are hidden.
	return out.replace(ABSOLUTE_PATH, (_match, before: string, path: string) =>
		// `//host` is the rest of a URL such as `https://host`, which the boundary already excludes.
		path === "/" ? `${before}${path}` : `${before}<path>`,
	);
};

/**
 * `redact`, then collapse whitespace, drop leading dashes (a notifier could
 * read them as an option) and cut to `limit` characters.
 */
export const cleanText = (text: string, limit: number, options: SanitizeOptions = {}): string => {
	const clean = redact(text, options)
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/^-+\s*/u, "");
	return clean.length <= limit ? clean : `${clean.slice(0, limit - 3).trimEnd()}...`;
};

/** HTTP header values must be visible ASCII; anything else becomes `?`. */
export const headerText = (text: string): string => text.replace(/[^\u0020-\u007e]/gu, "?");
