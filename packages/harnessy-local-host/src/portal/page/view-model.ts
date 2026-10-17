/**
 * The portal page's view model: API responses in, plain node descriptions out.
 *
 * This module runs in the browser. It is pure: it never touches the DOM, and it
 * treats every value from the API as untrusted. Text stays text; the only
 * attribute a node can carry besides a fixed class is a link that
 * {@link safeHref} has checked. A malformed response becomes an "unavailable"
 * line instead of an exception.
 */

export type PortalTag = "section" | "h2" | "h3" | "p" | "ul" | "li" | "a" | "code" | "span" | "strong";

/** The only class names the page sets. They exist in `app.css`. */
export type PortalClass = "tile" | "rows" | "row" | "muted" | "note" | "ok" | "warn" | "bad" | "count";

export interface PortalNode {
	readonly tag: PortalTag;
	readonly text?: string;
	readonly className?: PortalClass;
	/** Only for `a`. The mount checks it again with {@link safeHref}. */
	readonly href?: string;
	readonly children?: ReadonlyArray<PortalNode>;
}

export type PortalPageRoute = "today" | "health" | "connections";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);
/** The longest text one node shows. The API's own limits are lower; this bounds a broken response. */
export const MAX_TEXT_LENGTH = 300;
const MAX_ROWS = 64;

/**
 * A link the page may render: `http://127.0.0.1:<port>/...` or `http://localhost:<port>/...`
 * with an explicit port, no credentials, no query string and no fragment. Anything else,
 * including `javascript:` and other hosts, gives `undefined`.
 */
export const safeHref = (value: unknown): string | undefined => {
	if (typeof value !== "string" || value.length > 256 || /[?#\s\\]/u.test(value)) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.port === "") return undefined;
	if (url.username !== "" || url.password !== "") return undefined;
	return url.href;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** A bounded string for display, or `undefined` when `value` is not a string. */
const text = (value: unknown): string | undefined =>
	typeof value === "string"
		? value.length > MAX_TEXT_LENGTH
			? `${value.slice(0, MAX_TEXT_LENGTH)}...`
			: value
		: undefined;

const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const node = (
	tag: PortalTag,
	content?: string,
	extra: {
		readonly className?: PortalClass;
		readonly href?: string;
		readonly children?: ReadonlyArray<PortalNode>;
	} = {},
): PortalNode => ({ tag, ...(content === undefined ? {} : { text: content }), ...extra });

const STATE_TEXT: Readonly<Record<string, string>> = {
	missing: "Not set up yet",
	busy: "Busy: another process is writing. Try again shortly",
	recovering: "Recovering: a write was interrupted. The owning service will repair it",
	unsupported: "Not supported here",
	unsafe: "Refused: the file failed a safety check",
	error: "Could not be read",
};

/** One line for a tile that is not `ok`. The state and reason are shown as text only. */
export const stateLine = (tile: unknown): PortalNode => {
	const state = text(field(tile, "state"));
	const reason = text(field(tile, "reason"));
	const summary = state === undefined ? "No data" : (STATE_TEXT[state] ?? "No data");
	return node("p", reason === undefined ? summary : `${summary} (${reason})`, {
		className: state === "busy" || state === "missing" ? "warn" : "bad",
	});
};

/** The tile's data when its state is `ok` and its data is an object; otherwise `undefined`. */
const okData = (tile: unknown): Readonly<Record<string, unknown>> | undefined => {
	const data = field(tile, "data");
	return field(tile, "state") === "ok" && isRecord(data) ? data : undefined;
};

/** A titled tile. Its body is built only from `ok` data; any other tile shows its state line. */
const tileSection = (
	title: string,
	tile: unknown,
	body: (data: Readonly<Record<string, unknown>>) => ReadonlyArray<PortalNode>,
): PortalNode => {
	const data = okData(tile);
	return node("section", undefined, {
		className: "tile",
		children: [node("h2", title), ...(data === undefined ? [stateLine(tile)] : body(data))],
	});
};

const countRow = (label: string, value: unknown): PortalNode => {
	const shown = count(value);
	return node("li", undefined, {
		className: "row",
		children: [
			node("span", label),
			node("strong", shown === undefined ? "unknown" : String(shown), { className: "count" }),
		],
	});
};

const rows = (children: ReadonlyArray<PortalNode>): PortalNode =>
	node("ul", undefined, { className: "rows", children });

const yesNo = (value: unknown, yes: string, no: string): string =>
	value === true ? yes : value === false ? no : "unknown";

const tilesOf = (response: unknown): Readonly<Record<string, unknown>> => {
	const tiles = field(response, "tiles");
	return isRecord(tiles) ? tiles : {};
};

const generatedLine = (response: unknown): PortalNode =>
	node("p", `Read at ${text(field(response, "generatedAt")) ?? "an unknown time"}`, { className: "muted" });

/** Today: what waits for Julian, the Life brief, readings, the weekly plan and setup. */
export const todayView = (response: unknown): ReadonlyArray<PortalNode> => {
	const tiles = tilesOf(response);
	return [
		generatedLine(response),
		tileSection("Waiting for you", tiles.waiting, (data) => [
			rows([
				countRow("Meetings to review", data.meetingsPendingReview),
				countRow("Community briefings to review", data.communityPendingReview),
				countRow("Fathom recordings in the inbox", data.fathomPendingInbox),
				countRow("Weekly plans drafted, not reconciled", data.weeklyRunsDrafted),
			]),
		]),
		tileSection("Today's brief", tiles.brief, (data) => [
			node("p", `Brief for ${text(data.date) ?? "unknown date"}`),
			node("p", yesNo(data.journaled, "Journaled", "Not journaled yet"), {
				className: data.journaled === true ? "ok" : "warn",
			}),
			node("p", text(data.relativePath) ?? "", { className: "muted" }),
		]),
		tileSection("Reading queue", tiles.readings, (data) => [
			rows([
				countRow("Available", data.available),
				countRow("Reserved", data.reserved),
				countRow("Delivered", data.delivered),
				countRow("Total", data.total),
			]),
		]),
		tileSection("Weekly plan", tiles.weeklyRuns, (data) => {
			const runs = Array.isArray(data.runs) ? data.runs.slice(0, MAX_ROWS) : [];
			return runs.length === 0
				? [node("p", "No weekly runs yet", { className: "muted" })]
				: [
						rows(
							runs.map((run) =>
								node("li", undefined, {
									className: "row",
									children: [
										node("span", text(field(run, "periodId")) ?? "unknown period"),
										node("strong", text(field(run, "state")) ?? "unknown"),
										...(field(run, "incompleteReconciliation") === true
											? [node("span", "reconciliation incomplete", { className: "warn" })]
											: []),
									],
								}),
							),
						),
					];
		}),
		tileSection("Latest preview", tiles.latestPreview, (data) => [
			node("p", text(data.name) ?? "unknown"),
			node("p", `Dated ${text(data.date) ?? "unknown"}`, { className: "muted" }),
		]),
		tileSection("Life setup", tiles.setup, (data) => [
			rows([
				node("li", yesNo(data.steeringReady, "Steering is ready", "Steering is not set up"), { className: "row" }),
				node("li", yesNo(data.compatibilityReady, "Compatibility is ready", "Compatibility is not set up"), {
					className: "row",
				}),
			]),
		]),
	];
};

const serviceRow = (label: string, tile: unknown): PortalNode => {
	const data = okData(tile);
	if (data === undefined)
		return node("li", undefined, { className: "row", children: [node("strong", label), stateLine(tile)] });
	const state = text(data.state);
	const pid = count(data.pid);
	const exit = typeof data.lastExitCode === "number" ? String(data.lastExitCode) : "none";
	const log = field(data, "lastLog");
	const details = [
		node("strong", label),
		node("span", state ?? "unknown state", { className: state === "running" ? "ok" : "warn" }),
		node("span", `pid ${pid === undefined ? "none" : String(pid)}, last exit ${exit}`, { className: "muted" }),
	];
	if (isRecord(log))
		details.push(
			node(
				"span",
				`last log: ${text(log.stream) ?? "unknown"} ${text(log.code) ?? "text"} at ${text(log.modifiedAt) ?? "unknown"}`,
				{ className: "muted" },
			),
		);
	return node("li", undefined, { className: "row", children: details });
};

/** Health: one row per launchd service. */
export const healthView = (response: unknown): ReadonlyArray<PortalNode> => {
	const tiles = tilesOf(response);
	const labels = Object.keys(tiles).sort().slice(0, MAX_ROWS);
	return [
		generatedLine(response),
		node("section", undefined, {
			className: "tile",
			children: [
				node("h2", "Services"),
				labels.length === 0
					? node("p", "No services reported", { className: "muted" })
					: rows(labels.map((label) => serviceRow(label, tiles[label]))),
			],
		}),
	];
};

const STATUS_CLASS: Readonly<Record<string, PortalClass>> = {
	connected: "ok",
	attention: "bad",
	not_configured: "warn",
	not_tracked: "muted",
	unknown: "muted",
};

const STATUS_TEXT: Readonly<Record<string, string>> = {
	connected: "Connected",
	attention: "Needs attention",
	not_configured: "Not configured",
	not_tracked: "Not tracked",
	unknown: "Unknown",
};

const actionNodes = (action: unknown): ReadonlyArray<PortalNode> => {
	if (!isRecord(action)) return [];
	const note = text(action.note);
	const notes = note === undefined ? [] : [node("p", note, { className: "note" })];
	if (action.kind === "link") {
		const href = safeHref(action.value);
		return href === undefined
			? [node("p", "Link withheld: not a local address", { className: "bad" }), ...notes]
			: [node("p", undefined, { children: [node("a", `Open ${href}`, { href })] }), ...notes];
	}
	if (action.kind === "command")
		return [
			node("p", undefined, {
				children: [node("span", "Run: ", { className: "muted" }), node("code", text(action.value) ?? "")],
			}),
			...notes,
		];
	return [];
};

const connectionRow = (connection: unknown): PortalNode => {
	const status = text(field(connection, "status")) ?? "unknown";
	const detail = text(field(connection, "detail"));
	const checkedAt = text(field(connection, "checkedAt"));
	const facts = [
		`owner: ${text(field(connection, "owner")) ?? "unknown"}`,
		...(detail === undefined ? [] : [detail]),
		...(checkedAt === undefined ? [] : [`checked ${checkedAt}`]),
	];
	return node("li", undefined, {
		className: "row",
		children: [
			node("strong", text(field(connection, "label")) ?? "Unnamed connection"),
			node("span", STATUS_TEXT[status] ?? "Unknown", { className: STATUS_CLASS[status] ?? "muted" }),
			node("span", facts.join(", "), { className: "muted" }),
			...actionNodes(field(connection, "action")),
		],
	});
};

const CONNECTION_GROUPS: ReadonlyArray<readonly [string, string]> = [
	["meeting", "Meeting publication (Google and Discord)"],
	["googleWorkspace", "Google Workspace CLI profiles"],
	["fathom", "Fathom"],
	["community", "Community briefing"],
	["cockpit", "Cockpit integrations"],
	["codex", "Codex"],
];

/** The fixed explanation at the top of the Connections page. */
export const CONNECT_GOOGLE_NOTE =
	"The portal never signs in to anything itself. To connect or reconnect Google, follow the action on the row: " +
	"a link opens the owning service's own page, and a command is for you to run in a terminal.";

/** Connections: one row per credential holder, with its hand-off to the owning service. */
export const connectionsView = (response: unknown): ReadonlyArray<PortalNode> => {
	const tiles = tilesOf(response);
	return [
		generatedLine(response),
		node("p", CONNECT_GOOGLE_NOTE, { className: "note" }),
		...CONNECTION_GROUPS.map(([key, title]) =>
			tileSection(title, tiles[key], (data) => {
				const connections = Array.isArray(data.connections) ? data.connections.slice(0, MAX_ROWS) : [];
				const omitted = count(data.omitted) ?? 0;
				return [
					connections.length === 0
						? node("p", "Nothing found", { className: "muted" })
						: rows(connections.map(connectionRow)),
					...(omitted > 0 ? [node("p", `${omitted} more not shown`, { className: "muted" })] : []),
				];
			}),
		),
	];
};

export const PAGE_TITLES: Readonly<Record<PortalPageRoute, string>> = {
	today: "Today",
	health: "Health",
	connections: "Connections",
};

/** The page for a location hash: `#/health`, `#/connections`, anything else is Today. */
export const routeOf = (hash: string): PortalPageRoute =>
	hash === "#/health" ? "health" : hash === "#/connections" ? "connections" : "today";

export const viewOf = (route: PortalPageRoute, response: unknown): ReadonlyArray<PortalNode> =>
	route === "health"
		? healthView(response)
		: route === "connections"
			? connectionsView(response)
			: todayView(response);

/** Shown when the page has no valid page token. */
export const signedOutView = (): ReadonlyArray<PortalNode> => [
	node("section", undefined, {
		className: "tile",
		children: [
			node("h2", "Sign in"),
			node("p", "This page needs a fresh sign-in link. In a terminal, run:"),
			node("p", undefined, { children: [node("code", "harnessy-portal open")] }),
			node("p", "The link works once and only from this computer.", { className: "muted" }),
		],
	}),
];

/** Shown when a request fails for a reason other than sign-in. */
export const failureView = (reason: string): ReadonlyArray<PortalNode> => [
	node("section", undefined, {
		className: "tile",
		children: [node("h2", "Could not load this page"), node("p", text(reason) ?? "unknown", { className: "bad" })],
	}),
];
