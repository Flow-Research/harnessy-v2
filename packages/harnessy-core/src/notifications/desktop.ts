import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import * as Result from "effect/Result";

/** How a notifier process ended. `detail` is fixed text: never the process's own output. */
export interface ProcessOutcome {
	readonly ok: boolean;
	readonly detail: "exit 0" | `exit ${number}` | "stopped by a signal" | "timed out" | "could not start";
}

/** The only process seam: argv, never a shell string, with an exact environment and a time limit. */
export type StartProcess = (
	file: string,
	args: ReadonlyArray<string>,
	options: { readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number },
) => Promise<ProcessOutcome>;

/** After a timeout, how long a process gets to exit on SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 500;

/**
 * Live process starter: no shell, no stdio, hidden window, bounded time.
 * On timeout it sends SIGTERM, then SIGKILL after `KILL_GRACE_MS`, and
 * settles no later than that, even if the process never reports its exit.
 */
export const startProcess: StartProcess = (file, args, { env, timeoutMs }) =>
	new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		const finish = (outcome: ProcessOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(escalation);
			resolve(outcome);
		};
		// Node throws for invalid arguments (such as a NUL byte) before any process exists.
		const spawned = Result.try(() =>
			spawn(file, [...args], { shell: false, stdio: "ignore", windowsHide: true, env: { ...env } }),
		);
		if (Result.isFailure(spawned)) {
			finish({ ok: false, detail: "could not start" });
			return;
		}
		const child = spawned.success;
		// Node reports a process that cannot start (ENOENT, EACCES) here, not as a throw.
		child.once("error", () => finish({ ok: false, detail: "could not start" }));
		child.once("close", (code) =>
			finish(
				timedOut
					? { ok: false, detail: "timed out" }
					: code === 0
						? { ok: true, detail: "exit 0" }
						: { ok: false, detail: typeof code === "number" ? `exit ${code}` : "stopped by a signal" },
			),
		);
		timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			escalation = setTimeout(() => {
				child.kill("SIGKILL");
				finish({ ok: false, detail: "timed out" });
			}, KILL_GRACE_MS);
		}, timeoutMs);
	});

/** What the notifier may learn about the machine. Every field is injectable for tests. */
export interface NotifyEnvironment {
	readonly platform: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly home: string;
	/** True when `path` is an executable regular file. */
	readonly isExecutable: (path: string) => boolean;
}

/** Live check: a regular file, and executable for this user outside Windows. */
export const isExecutableFile =
	(platform: string) =>
	(path: string): boolean => {
		const stat = Result.try(() => statSync(path));
		if (Result.isFailure(stat) || !stat.success.isFile()) return false;
		return platform === "win32" || Result.isSuccess(Result.try(() => accessSync(path, constants.X_OK)));
	};

/**
 * Absolute path of `name` on PATH, or undefined. Relative PATH entries
 * (such as `.`) are skipped, so a file in the working directory can never
 * stand in for a notifier.
 */
export const findExecutable = (name: string, environment: NotifyEnvironment): string | undefined => {
	const windows = environment.platform === "win32";
	const path = environment.env.PATH ?? (windows ? environment.env.Path : undefined) ?? "";
	const extensions = windows ? (environment.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
	// The target platform's path rules, not the host's, so tests behave the same everywhere.
	const paths = windows ? win32 : posix;
	for (const dir of path.split(windows ? ";" : ":")) {
		if (dir === "" || !paths.isAbsolute(dir)) continue;
		for (const extension of extensions) {
			const candidate = paths.join(dir, `${name}${extension.toLowerCase()}`);
			if (environment.isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
};

/** True when a variable is set to something other than empty, `0` or `false`. */
export const flagSet = (value: string | undefined): boolean =>
	value !== undefined && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());

/** A desktop notifier this machine can run, with its exact argv and environment. */
export interface DesktopBackend {
	readonly name: "terminal-notifier" | "osascript" | "notify-send" | "powershell";
	readonly file: string;
	readonly args: (title: string, body: string, event: string) => ReadonlyArray<string>;
	readonly env: (title: string, body: string) => Readonly<Record<string, string>>;
}

/** An AppleScript string literal: only `\` and `"` need escaping once control characters are gone. */
export const appleScriptString = (text: string): string => `"${text.replace(/[\\"]/gu, (char) => `\\${char}`)}"`;

/**
 * Fixed PowerShell script: the title and message arrive only through
 * environment variables and enter the toast as XML text nodes, so no
 * notification text is ever parsed as PowerShell or XML.
 */
export const WINDOWS_TOAST_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
	"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
	"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
	"$text = $xml.GetElementsByTagName('text')",
	"$text.Item(0).AppendChild($xml.CreateTextNode($env:HARNESSY_NOTIFY_TITLE)) | Out-Null",
	"$text.Item(1).AppendChild($xml.CreateTextNode($env:HARNESSY_NOTIFY_MESSAGE)) | Out-Null",
	"$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
	"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
].join("\n");

/** `-EncodedCommand` takes base64 UTF-16LE, so the fixed script needs no command-line quoting. */
const ENCODED_TOAST_SCRIPT = Buffer.from(WINDOWS_TOAST_SCRIPT, "utf16le").toString("base64");

/** Copy only the named variables that are set. */
const pick = (env: NotifyEnvironment["env"], names: ReadonlyArray<string>): Record<string, string> =>
	Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));

const LINUX_SESSION_VARS = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "HOME"];
const WINDOWS_SESSION_VARS = ["SystemRoot", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA"];

/** True when the session can show a desktop notification at all: a local graphical login. */
export const hasDisplay = (environment: NotifyEnvironment): boolean => {
	const remote = flagSet(environment.env.SSH_CONNECTION) || flagSet(environment.env.SSH_TTY);
	if (environment.platform === "linux")
		return flagSet(environment.env.DISPLAY) || flagSet(environment.env.WAYLAND_DISPLAY);
	return (environment.platform === "darwin" || environment.platform === "win32") && !remote;
};

/**
 * The desktop notifier for this platform, or undefined when none is
 * installed: terminal-notifier on PATH or `/usr/bin/osascript` on macOS,
 * `notify-send` on Linux, Windows PowerShell under `%SystemRoot%`.
 */
export const desktopBackend = (environment: NotifyEnvironment): DesktopBackend | undefined => {
	const { env, platform } = environment;
	if (platform === "darwin") {
		const terminalNotifier = findExecutable("terminal-notifier", environment);
		if (terminalNotifier !== undefined)
			return {
				name: "terminal-notifier",
				file: terminalNotifier,
				args: (title, body, event) => ["-title", title, "-message", body, "-group", `harnessy-${event}`],
				env: () => ({ PATH: "/usr/bin:/bin", ...pick(env, ["HOME"]) }),
			};
		if (environment.isExecutable("/usr/bin/osascript"))
			return {
				name: "osascript",
				file: "/usr/bin/osascript",
				args: (title, body) => [
					"-e",
					`display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`,
				],
				env: () => ({ PATH: "/usr/bin:/bin" }),
			};
		return undefined;
	}
	if (platform === "linux") {
		const notifySend = findExecutable("notify-send", environment);
		return notifySend === undefined
			? undefined
			: {
					name: "notify-send",
					file: notifySend,
					args: (title, body) => ["--app-name=Harnessy", "--", title, body],
					env: () => ({ PATH: "/usr/bin:/bin", ...pick(env, LINUX_SESSION_VARS) }),
				};
	}
	if (platform === "win32") {
		const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
		const powershell = `${root.replace(/[\\/]+$/u, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
		return environment.isExecutable(powershell)
			? {
					name: "powershell",
					file: powershell,
					args: () => ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_TOAST_SCRIPT],
					env: (title, body) => ({
						...pick(env, WINDOWS_SESSION_VARS),
						HARNESSY_NOTIFY_TITLE: title,
						HARNESSY_NOTIFY_MESSAGE: body,
					}),
				}
			: undefined;
	}
	return undefined;
};
