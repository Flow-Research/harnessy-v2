/**
 * Built-in, cross-platform notifications: a desktop notification where one
 * can be shown (macOS, Linux, Windows), one terminal line elsewhere, and
 * optional ntfy or webhook pushes. `notify` never throws.
 */
export type { NotificationSettings, NotifyConfig, NotifyMode } from "./notifications/config.ts";
export { NOTIFY_MODES, readNotificationSettings, resolveNotifyConfig, settingsPath } from "./notifications/config.ts";
export type { NotifyEnvironment, ProcessOutcome, StartProcess } from "./notifications/desktop.ts";
export { startProcess } from "./notifications/desktop.ts";
export type { Notification, Notifier, NotifierDeps } from "./notifications/notifier.ts";
export { createNotifier, liveEnvironment, liveNotifier } from "./notifications/notifier.ts";
export type { Fetch } from "./notifications/remote.ts";
export { cleanText, redact } from "./notifications/sanitize.ts";
