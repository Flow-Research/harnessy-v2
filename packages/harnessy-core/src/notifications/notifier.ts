import { homedir } from "node:os";
import * as Result from "effect/Result";
import {
	type NotifyConfig,
	type NotifyMode,
	readNotificationSettings,
	resolveNotifyConfig,
	settingsPath,
} from "./config.ts";
import {
	desktopBackend,
	flagSet,
	hasDisplay,
	isExecutableFile,
	type NotifyEnvironment,
	type StartProcess,
	startProcess,
} from "./desktop.ts";
import { type Fetch, ntfyRequest, type OutgoingNotification, postWithRetry, webhookRequest } from "./remote.ts";
import { cleanText, TEXT_LIMITS } from "./sanitize.ts";

/** One thing worth telling the person. Use fixed text, short ids, PR numbers and SHAs only. */
export interface Notification {
	/** Short machine name such as `pr_ready`; anything else becomes `notification`. */
	readonly event: string;
	readonly title: string;
	readonly message: string;
	/** What the person should do next, shown after `Next:`. */
	readonly nextStep?: string;
	/** True when the person must act; remote pushes use high priority. Defaults to true. */
	readonly needsYou?: boolean;
}

export interface Notifier {
	/** Deliver `notification`. Never throws and never rejects; failures become logged warnings. */
	readonly notify: (notification: Notification) => Promise<void>;
}

export interface NotifierDeps {
	readonly config: NotifyConfig;
	readonly environment: NotifyEnvironment;
	readonly start: StartProcess;
	readonly fetch: Fetch;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
	/** Harnessy's log: one line per call, to stderr in the CLI. */
	readonly log: (line: string) => void;
	/** Time limit for each desktop process and each HTTP attempt. */
	readonly timeoutMs?: number;
}

export const NOTIFY_TIMEOUT_MS = 5_000;

const EVENT = /^[a-z][a-z0-9_]{0,39}$/u;

/** The one line shown when no desktop notification was delivered, and written to the log. */
export const terminalLine = (notification: OutgoingNotification): string =>
	`[harnessy] ${notification.title}: ${notification.message}${notification.nextStep === "" ? "" : ` Next: ${notification.nextStep}`}`;

/** Clean every field; the configured token is redacted wherever it appears. */
export const prepare = (
	notification: Notification,
	home: string,
	secrets: ReadonlyArray<string>,
): OutgoingNotification => {
	const options = { home, secrets };
	return {
		event: EVENT.test(notification.event) ? notification.event : "notification",
		title: cleanText(notification.title, TEXT_LIMITS.title, options) || "Harnessy",
		message: cleanText(notification.message, TEXT_LIMITS.message, options),
		nextStep: cleanText(notification.nextStep ?? "", TEXT_LIMITS.nextStep, options),
		needsYou: notification.needsYou ?? true,
	};
};

/**
 * Build a notifier from resolved configuration and injected seams. The
 * configuration's warnings are logged once, on the first notification.
 */
export const createNotifier = (deps: NotifierDeps): Notifier => {
	const { config, environment } = deps;
	const timeoutMs = deps.timeoutMs ?? NOTIFY_TIMEOUT_MS;
	const secrets = config.ntfy?.token === undefined ? [] : [config.ntfy.token];
	let warned = false;
	const warn = (what: string) => deps.log(`[harnessy] notification warning: ${what}`);

	const desktop = async (outgoing: OutgoingNotification): Promise<boolean> => {
		if (config.mode === "terminal" || (config.mode === "auto" && !hasDisplay(environment))) return false;
		const backend = desktopBackend(environment);
		if (backend === undefined) {
			if (config.mode === "desktop") warn("no desktop notifier is installed here");
			return false;
		}
		const title = `Harnessy: ${outgoing.title}`;
		const body = outgoing.nextStep === "" ? outgoing.message : `${outgoing.message} Next: ${outgoing.nextStep}`;
		const outcome = await deps.start(backend.file, backend.args(title, body, outgoing.event), {
			env: backend.env(title, body),
			timeoutMs,
		});
		if (!outcome.ok) warn(`${backend.name} failed (${outcome.detail})`);
		return outcome.ok;
	};

	const remote = async (outgoing: OutgoingNotification): Promise<void> => {
		const sends: Array<Promise<void>> = [];
		if (config.ntfy !== undefined) {
			const request = ntfyRequest(outgoing, config.ntfy.token);
			const url = config.ntfy.url;
			sends.push(
				postWithRetry(deps.fetch, deps.sleep, url, request.headers, request.body, timeoutMs).then((result) => {
					if (!result.ok) warn(`ntfy push failed (${result.detail})`);
				}),
			);
		}
		if (config.webhookUrl !== undefined) {
			const request = webhookRequest(outgoing, deps.now());
			const url = config.webhookUrl;
			sends.push(
				postWithRetry(deps.fetch, deps.sleep, url, request.headers, request.body, timeoutMs).then((result) => {
					if (!result.ok) warn(`webhook push failed (${result.detail})`);
				}),
			);
		}
		await Promise.all(sends);
	};

	const deliver = async (notification: Notification): Promise<void> => {
		if (!warned) {
			warned = true;
			for (const warning of config.warnings) warn(warning);
		}
		if (config.mode === "off") return;
		const outgoing = prepare(notification, environment.home, secrets);
		const [shown] = await Promise.all([desktop(outgoing), remote(outgoing)]);
		if (!shown) deps.log(terminalLine(outgoing));
	};

	return {
		// A notifier must never fail the command it reports on. If even the log throws, there is nowhere left to report.
		notify: (notification) =>
			Promise.resolve()
				.then(() => deliver(notification))
				.catch(() => {
					Result.try(() => warn("notification failed"));
				}),
	};
};

/** The live environment probe: this process's platform, variables and home directory. */
export const liveEnvironment = (): NotifyEnvironment => ({
	platform: process.platform,
	env: process.env,
	home: homedir(),
	isExecutable: isExecutableFile(process.platform),
});

/**
 * The notifier the CLI uses: the `--notify` flag (if given), the environment
 * and Harnessy's settings file decide the mode and the push targets. If even
 * that setup fails, the result logs one warning and sends nothing.
 */
export const liveNotifier = (
	flag: NotifyMode | undefined,
	log: (line: string) => void,
	probe: () => NotifyEnvironment = liveEnvironment,
): Notifier => {
	const built = Result.try(() => {
		const environment = probe();
		const read = readNotificationSettings(settingsPath(environment.env, environment.home));
		const resolved = resolveNotifyConfig(flag, environment.env, read.settings, flagSet(environment.env.CI));
		return createNotifier({
			config: { ...resolved, warnings: [...read.warnings, ...resolved.warnings] },
			environment,
			start: startProcess,
			fetch: (url, init) => globalThis.fetch(url, init),
			sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
			now: Date.now,
			log,
		});
	});
	if (Result.isSuccess(built)) return built.success;
	let warned = false;
	return {
		notify: async () => {
			if (warned) return;
			warned = true;
			Result.try(() => log("[harnessy] notification warning: notifications could not be set up"));
		},
	};
};
