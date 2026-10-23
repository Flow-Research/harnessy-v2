import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as Result from "effect/Result";
import { HSY_CONFIG_DIR } from "../hsy-runtime-env.ts";
import { allowedPushUrl, allowedToken } from "./remote.ts";

/**
 * `auto` picks a desktop notification where a display exists and the
 * terminal line elsewhere; `desktop` always tries the desktop first;
 * `terminal` prints only the line; `off` sends nothing at all.
 */
export const NOTIFY_MODES = ["auto", "off", "desktop", "terminal"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

const isMode = (value: unknown): value is NotifyMode => NOTIFY_MODES.includes(value as NotifyMode);

/** The `notifications` key of Harnessy's `settings.json`. Every field is optional. */
export interface NotificationSettings {
	readonly mode?: NotifyMode;
	readonly ntfy?: { readonly url?: string; readonly token?: string };
	readonly webhook?: { readonly url?: string };
}

/** Everything the notifier needs to decide what to send where. */
export interface NotifyConfig {
	readonly mode: NotifyMode;
	readonly ntfy?: { readonly url: string; readonly token?: string };
	readonly webhookUrl?: string;
	/** Problems found while reading the configuration, as fixed text without values. */
	readonly warnings: ReadonlyArray<string>;
}

/** `$HSY_CODING_AGENT_DIR/settings.json`, else `~/.hsy/agent/settings.json`: Harnessy's user settings. */
export const settingsPath = (env: Readonly<Record<string, string | undefined>>, home: string): string =>
	join(env.HSY_CODING_AGENT_DIR?.trim() || join(home, HSY_CONFIG_DIR, "agent"), "settings.json");

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/**
 * Read the `notifications` key from the settings file. A missing file means
 * no settings; an unreadable or malformed one is reported as a warning and
 * ignored. Unknown values are ignored the same way.
 */
export const readNotificationSettings = (
	path: string,
	read: (path: string) => string = (file) => readFileSync(file, "utf8"),
): { readonly settings: NotificationSettings; readonly warnings: ReadonlyArray<string> } => {
	const raw = Result.try(() => read(path));
	if (Result.isFailure(raw)) {
		const error = raw.failure;
		const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
		return { settings: {}, warnings: missing ? [] : ["the Harnessy settings file could not be read"] };
	}
	const parsed = Result.try((): unknown => JSON.parse(raw.success));
	if (Result.isFailure(parsed)) return { settings: {}, warnings: ["the Harnessy settings file is not valid JSON"] };
	const value = record(record(parsed.success)?.notifications);
	if (value === undefined) return { settings: {}, warnings: [] };
	const warnings: string[] = [];
	if (value.mode !== undefined && !isMode(value.mode))
		warnings.push(`notifications.mode must be one of ${NOTIFY_MODES.join(", ")}`);
	const ntfy = record(value.ntfy);
	const webhook = record(value.webhook);
	const ntfyUrl = text(ntfy?.url);
	const ntfyToken = text(ntfy?.token);
	const webhookUrl = text(webhook?.url);
	return {
		settings: {
			...(isMode(value.mode) ? { mode: value.mode } : {}),
			...(ntfyUrl === undefined && ntfyToken === undefined
				? {}
				: {
						ntfy: {
							...(ntfyUrl === undefined ? {} : { url: ntfyUrl }),
							...(ntfyToken === undefined ? {} : { token: ntfyToken }),
						},
					}),
			...(webhookUrl === undefined ? {} : { webhook: { url: webhookUrl } }),
		},
		warnings,
	};
};

/** `HSY_NOTIFY` values: a mode, or a yes/no word. */
const envMode = (value: string | undefined): NotifyMode | "invalid" | undefined => {
	const word = value?.trim().toLowerCase();
	if (word === undefined || word === "") return undefined;
	if (isMode(word)) return word;
	if (["0", "false", "no"].includes(word)) return "off";
	if (["1", "true", "yes", "on"].includes(word)) return "auto";
	return "invalid";
};

/**
 * Resolve the configuration. The mode comes from the `--notify` flag, else
 * `NO_NOTIFY` (any value turns notifications off), else `HSY_NOTIFY`, else
 * the settings file, else `auto`; `auto` becomes `off` when `CI` is set.
 * Push URLs and the ntfy token come from `HSY_NOTIFY_NTFY_URL`,
 * `HSY_NOTIFY_NTFY_TOKEN` and `HSY_NOTIFY_WEBHOOK_URL`, else the settings
 * file. A URL that is not HTTPS (or HTTP to this machine) is ignored with a
 * warning; values are never repeated in warnings.
 */
export const resolveNotifyConfig = (
	flag: NotifyMode | undefined,
	env: Readonly<Record<string, string | undefined>>,
	settings: NotificationSettings,
	ciSet: boolean,
): NotifyConfig => {
	const warnings: string[] = [];
	const fromEnv = env.NO_NOTIFY !== undefined && env.NO_NOTIFY !== "" ? "off" : envMode(env.HSY_NOTIFY);
	if (fromEnv === "invalid") warnings.push(`HSY_NOTIFY must be one of ${NOTIFY_MODES.join(", ")}`);
	const chosen = flag ?? (fromEnv === "invalid" ? undefined : fromEnv) ?? settings.mode ?? "auto";
	const mode = chosen === "auto" && ciSet ? "off" : chosen;
	const ntfyUrl = text(env.HSY_NOTIFY_NTFY_URL) ?? settings.ntfy?.url;
	const ntfyToken = text(env.HSY_NOTIFY_NTFY_TOKEN) ?? settings.ntfy?.token;
	const webhookUrl = text(env.HSY_NOTIFY_WEBHOOK_URL) ?? settings.webhook?.url;
	const ntfyOk = ntfyUrl !== undefined && allowedPushUrl(ntfyUrl);
	if (ntfyUrl !== undefined && !ntfyOk)
		warnings.push("the ntfy URL is ignored: use https, or http only to localhost, with no user name or password");
	const tokenOk = ntfyToken !== undefined && allowedToken(ntfyToken);
	if (ntfyToken !== undefined && !tokenOk)
		warnings.push("the ntfy token is ignored: it must be one word of visible ASCII");
	const webhookOk = webhookUrl !== undefined && allowedPushUrl(webhookUrl);
	if (webhookUrl !== undefined && !webhookOk)
		warnings.push("the webhook URL is ignored: use https, or http only to localhost, with no user name or password");
	return {
		mode,
		...(ntfyOk ? { ntfy: { url: ntfyUrl, ...(tokenOk ? { token: ntfyToken } : {}) } } : {}),
		...(webhookOk ? { webhookUrl } : {}),
		warnings,
	};
};
