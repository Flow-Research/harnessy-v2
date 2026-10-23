import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type NotifyConfig,
	readNotificationSettings,
	resolveNotifyConfig,
	settingsPath,
} from "../src/notifications/config.ts";
import {
	appleScriptString,
	desktopBackend,
	findExecutable,
	flagSet,
	hasDisplay,
	isExecutableFile,
	KILL_GRACE_MS,
	type NotifyEnvironment,
	type StartProcess,
	startProcess,
	WINDOWS_TOAST_SCRIPT,
} from "../src/notifications/desktop.ts";
import {
	createNotifier,
	liveEnvironment,
	liveNotifier,
	type Notification,
	type NotifierDeps,
	prepare,
	terminalLine,
} from "../src/notifications/notifier.ts";
import {
	allowedPushUrl,
	allowedToken,
	type Fetch,
	ntfyRequest,
	type OutgoingNotification,
	postWithRetry,
	RETRY_DELAY_MS,
	webhookRequest,
} from "../src/notifications/remote.ts";
import { cleanText, headerText, redact, TEXT_LIMITS } from "../src/notifications/sanitize.ts";

const HOME = "/Users/someone";
/** Joins a fake credential at runtime, so the repository's secret scanner never sees a token-shaped literal. */
const fake = (...parts: ReadonlyArray<string>) => parts.join("");
const TOKEN = "tk_abcdefghijklmnopqrstuvwxyz123456";

/** A machine whose only executables are the listed absolute paths. */
const machine = (
	platform: string,
	env: Record<string, string | undefined> = {},
	executables: ReadonlyArray<string> = [],
): NotifyEnvironment & { readonly probed: string[] } => {
	const probed: string[] = [];
	return {
		platform,
		env,
		home: HOME,
		probed,
		isExecutable: (path) => {
			probed.push(path);
			return executables.includes(path);
		},
	};
};

const base = (overrides: Partial<NotifyConfig> = {}): NotifyConfig => ({ mode: "auto", warnings: [], ...overrides });

interface Started {
	readonly file: string;
	readonly args: ReadonlyArray<string>;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
}
interface Posted {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
}

/** A notifier over fakes; every process start, HTTP request and log line is recorded. */
const harness = (
	config: NotifyConfig,
	environment: NotifyEnvironment,
	options: {
		readonly processOk?: boolean;
		readonly status?: number;
		readonly start?: StartProcess;
		readonly fetch?: Fetch;
		readonly log?: (line: string) => void;
	} = {},
) => {
	const started: Started[] = [];
	const posted: Posted[] = [];
	const logs: string[] = [];
	const sleeps: number[] = [];
	const deps: NotifierDeps = {
		config,
		environment,
		start:
			options.start ??
			(async (file, args, { env, timeoutMs }) => {
				started.push({ file, args, env, timeoutMs });
				return options.processOk === false ? { ok: false, detail: "exit 1" } : { ok: true, detail: "exit 0" };
			}),
		fetch:
			options.fetch ??
			(async (url, init) => {
				posted.push({ url, headers: init.headers, body: init.body });
				return { status: options.status ?? 200 };
			}),
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		now: () => Date.UTC(2026, 9, 23, 12, 0, 0),
		log: options.log ?? ((line) => logs.push(line)),
	};
	return { notifier: createNotifier(deps), started, posted, logs, sleeps };
};

const needsYou: Notification = {
	event: "pr_ready",
	title: "Ready to merge",
	message: "PR #7 for task 11111111 passed its checks.",
	nextStep: "Review and merge PR #7.",
};

describe("sanitiser", () => {
	it("replaces the home directory with ~ and hides every other absolute path", () => {
		expect(redact(`log at ${HOME}/Code/app/run.log and /etc/passwd`, { home: HOME })).toBe(
			"log at ~/Code/app/run.log and <path>",
		);
		expect(redact(`home is ${HOME}`, { home: `${HOME}/` })).toBe("home is ~");
		expect(redact("C:\\Users\\me\\repo and C:/Users/me/x and D:\\data", { home: "C:\\Users\\me" })).toBe(
			"~\\repo and ~/x and <path>",
		);
		expect(redact("share \\\\server\\private\\x", {})).toBe("share <path>");
		expect(redact("(see /var/tmp/x) path=/srv/app", {})).toBe("(see <path>) path=<path>");
		// The home prefix of a longer user name is not that home.
		expect(redact(`${HOME}x/file`, { home: HOME })).toBe("<path>");
		// A one-character home would match everywhere; it is ignored.
		expect(redact("a / b", { home: "/" })).toBe("a / b");
		// URLs, relative paths and ~ paths stay readable.
		expect(redact("https://github.com/flow/app/pull/7 work/branch ~/notes", {})).toBe(
			"https://github.com/flow/app/pull/7 work/branch ~/notes",
		);
	});

	it("redacts tokens, credentials in URLs, secret assignments and configured secrets", () => {
		const cases: ReadonlyArray<[string, string]> = [
			[fake("key gh", "p_abcdefghijklmnopqrstuvwxyz0123"), "key <redacted>"],
			[fake("github", "_pat_11ABCDEFG0123456789_abcdefghij"), "<redacted>"],
			[fake("gl", "pat-abcdefghij0123456789"), "<redacted>"],
			[fake("xo", "xb-1234567890-abcdef"), "<redacted>"],
			[fake("s", "k-ant-api03-abcdefghij"), "<redacted>"],
			[TOKEN, "<redacted>"],
			[fake("np", "m_abcdefghijklmnopqrstuvwxyz"), "<redacted>"],
			[fake("AK", "IAABCDEFGHIJKLMNOP"), "<redacted>"],
			[fake("ey", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijk"), "<redacted>"],
			["https://user:pa55@example.com/x", "https://example.com/x"],
			["https://hooks.example.com/x?token=abc123&mode=1", "https://hooks.example.com/x?token=<redacted>&mode=1"],
			["password: hunter2, api_key=xyz", "password: <redacted>, api_key=<redacted>"],
			["Authorization: Bearer abc.def", "Authorization: <redacted> abc.def"],
			["send Bearer abc.def now", "send Bearer <redacted> now"],
			["Review the key changes and the token expiry", "Review the key changes and the token expiry"],
			["opaque a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7", "opaque <redacted>"],
		];
		for (const [input, output] of cases) expect(redact(input)).toBe(output);
		// UUIDs, words and numbers are not keys.
		const kept =
			"11111111-2222-4333-8444-555555555555 abcdefghijklmnopqrstuvwxyzabcdefghij 12345678901234567890123456789012345";
		expect(redact(kept)).toBe(kept);
		expect(redact("value s3cr3t-value here", { secrets: ["s3cr3t-value", "ab"] })).toBe("value <redacted> here");
	});

	it("removes control, direction and broken characters, then trims, de-dashes and cuts to the limit", () => {
		expect(redact("a\u0000b\u001bc\u202ed\u2066e\ud800f\udc00g")).toBe("a b cdefg");
		expect(cleanText("  --  hello \n\t world  ", 80)).toBe("hello world");
		expect(cleanText("x".repeat(500), TEXT_LIMITS.message)).toBe(`${"x".repeat(397)}...`);
		expect(cleanText("exactly", 7)).toBe("exactly");
		expect(cleanText(`${HOME}/a`, 80, { home: HOME })).toBe("~/a");
		expect(headerText("Merge \u00e9t\u00e9 \u2713")).toBe("Merge ?t? ?");
	});
});

describe("configuration", () => {
	it("finds Harnessy's settings file in the agent directory", () => {
		expect(settingsPath({}, "/home/me")).toBe(join("/home/me", ".hsy", "agent", "settings.json"));
		expect(settingsPath({ HSY_CODING_AGENT_DIR: " /agent " }, "/home/me")).toBe(join("/agent", "settings.json"));
		expect(settingsPath({ HSY_CODING_AGENT_DIR: "  " }, "/home/me")).toBe(
			join("/home/me", ".hsy", "agent", "settings.json"),
		);
	});

	it("reads the notifications key and ignores what it cannot use, without repeating values", () => {
		const read = (text: string) => readNotificationSettings("/x", () => text);
		expect(
			read(
				JSON.stringify({
					agentName: "Jarvis",
					notifications: {
						mode: "terminal",
						ntfy: { url: " https://ntfy.sh/topic ", token: TOKEN },
						webhook: { url: "https://hooks.example.com/h" },
					},
				}),
			),
		).toEqual({
			settings: {
				mode: "terminal",
				ntfy: { url: "https://ntfy.sh/topic", token: TOKEN },
				webhook: { url: "https://hooks.example.com/h" },
			},
			warnings: [],
		});
		expect(read(JSON.stringify({ notifications: { ntfy: { token: TOKEN }, webhook: { url: "" } } }))).toEqual({
			settings: { ntfy: { token: TOKEN } },
			warnings: [],
		});
		expect(read(JSON.stringify({ notifications: { ntfy: { url: "https://n" } } })).settings).toEqual({
			ntfy: { url: "https://n" },
		});
		expect(read(JSON.stringify({ notifications: { mode: "loud", ntfy: [], webhook: 3 } }))).toEqual({
			settings: {},
			warnings: ["notifications.mode must be one of auto, off, desktop, terminal"],
		});
		expect(read(JSON.stringify({ notifications: "on" }))).toEqual({ settings: {}, warnings: [] });
		expect(read("[]")).toEqual({ settings: {}, warnings: [] });
		expect(read("{ not json")).toEqual({ settings: {}, warnings: ["the Harnessy settings file is not valid JSON"] });
		const missing = Object.assign(new Error("no file"), { code: "ENOENT" });
		const denied = Object.assign(new Error(`EACCES ${HOME}`), { code: "EACCES" });
		for (const [failure, warnings] of [
			[missing, []],
			[denied, ["the Harnessy settings file could not be read"]],
			["thrown text", ["the Harnessy settings file could not be read"]],
		] as const)
			expect(
				readNotificationSettings("/x", () => {
					throw failure;
				}),
			).toEqual({ settings: {}, warnings });
	});

	it("reads a real settings file and treats a missing one as empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnessy-notify-settings-"));
		try {
			const path = join(dir, "settings.json");
			expect(readNotificationSettings(path)).toEqual({ settings: {}, warnings: [] });
			writeFileSync(path, JSON.stringify({ notifications: { mode: "off" } }));
			expect(readNotificationSettings(path)).toEqual({ settings: { mode: "off" }, warnings: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("takes the mode from the flag, then NO_NOTIFY, then HSY_NOTIFY, then settings, and turns auto off under CI", () => {
		const mode = (
			flag: Parameters<typeof resolveNotifyConfig>[0],
			env: Record<string, string>,
			settings: Parameters<typeof resolveNotifyConfig>[2] = {},
			ci = false,
		) => resolveNotifyConfig(flag, env, settings, ci).mode;
		expect(mode("desktop", { NO_NOTIFY: "1", HSY_NOTIFY: "off" }, { mode: "off" }, true)).toBe("desktop");
		expect(mode(undefined, { NO_NOTIFY: "1", HSY_NOTIFY: "desktop" })).toBe("off");
		expect(mode(undefined, { NO_NOTIFY: "", HSY_NOTIFY: "terminal" })).toBe("terminal");
		for (const word of ["off", "0", "false", "NO"]) expect(mode(undefined, { HSY_NOTIFY: word })).toBe("off");
		for (const word of ["1", "true", "yes", "on", " Auto "])
			expect(mode(undefined, { HSY_NOTIFY: word })).toBe("auto");
		expect(mode(undefined, { HSY_NOTIFY: "" }, { mode: "terminal" })).toBe("terminal");
		expect(mode(undefined, {}, { mode: "desktop" })).toBe("desktop");
		expect(mode(undefined, {})).toBe("auto");
		expect(mode(undefined, {}, {}, true)).toBe("off");
		expect(mode("auto", {}, {}, true)).toBe("off");
		expect(mode(undefined, {}, { mode: "terminal" }, true)).toBe("terminal");
		const invalid = resolveNotifyConfig(undefined, { HSY_NOTIFY: "loud" }, { mode: "terminal" }, false);
		expect(invalid).toEqual({
			mode: "terminal",
			warnings: ["HSY_NOTIFY must be one of auto, off, desktop, terminal"],
		});
	});

	it("enables push only for safe URLs, preferring the environment, and never repeats a value in a warning", () => {
		const settings = {
			ntfy: { url: "https://ntfy.example.com/settings-topic", token: "tk_settings" },
			webhook: { url: "https://hooks.example.com/settings" },
		};
		expect(resolveNotifyConfig(undefined, {}, settings, false)).toEqual({
			mode: "auto",
			ntfy: { url: "https://ntfy.example.com/settings-topic", token: "tk_settings" },
			webhookUrl: "https://hooks.example.com/settings",
			warnings: [],
		});
		expect(
			resolveNotifyConfig(
				undefined,
				{
					HSY_NOTIFY_NTFY_URL: "http://localhost:8080/topic",
					HSY_NOTIFY_NTFY_TOKEN: TOKEN,
					HSY_NOTIFY_WEBHOOK_URL: "http://127.0.0.1:9/h",
				},
				settings,
				false,
			),
		).toEqual({
			mode: "auto",
			ntfy: { url: "http://localhost:8080/topic", token: TOKEN },
			webhookUrl: "http://127.0.0.1:9/h",
			warnings: [],
		});
		const unsafe = resolveNotifyConfig(
			undefined,
			{
				HSY_NOTIFY_NTFY_URL: "http://ntfy.sh/secret-topic",
				HSY_NOTIFY_NTFY_TOKEN: "two words",
				HSY_NOTIFY_WEBHOOK_URL: "https://user:pw@hooks.example.com/h",
			},
			{},
			false,
		);
		expect(unsafe.ntfy).toBeUndefined();
		expect(unsafe.webhookUrl).toBeUndefined();
		expect(unsafe.warnings).toHaveLength(3);
		expect(unsafe.warnings.join(" ")).not.toMatch(/secret-topic|two words|user:pw|hooks\.example/u);
		// A valid URL with a bad token sends without the token.
		expect(
			resolveNotifyConfig(
				undefined,
				{ HSY_NOTIFY_NTFY_URL: "https://ntfy.sh/t", HSY_NOTIFY_NTFY_TOKEN: "bad token" },
				{},
				false,
			).ntfy,
		).toEqual({ url: "https://ntfy.sh/t" });
	});
});

describe("process starter", () => {
	const node = process.execPath;
	const run = (script: string, timeoutMs = 10_000, env: Record<string, string> = {}) =>
		startProcess(node, ["-e", script], { env, timeoutMs });

	it("reports success, a failing exit code and a process that cannot start", async () => {
		expect(await run("process.exit(0)")).toEqual({ ok: true, detail: "exit 0" });
		expect(await run("process.exit(3)")).toEqual({ ok: false, detail: "exit 3" });
		expect(
			await startProcess(join(tmpdir(), "harnessy-no-such-notifier"), [], { env: {}, timeoutMs: 1_000 }),
		).toEqual({ ok: false, detail: "could not start" });
		// Node refuses a NUL byte before any process exists.
		expect(await startProcess(`${node}\u0000`, [], { env: {}, timeoutMs: 1_000 })).toEqual({
			ok: false,
			detail: "could not start",
		});
	});

	it("passes exactly the given environment and no shell", async () => {
		expect(
			await run(
				"process.exit(process.env.HARNESSY_NOTIFY_TITLE === 'a \"b\" $(c)' && process.env.HARNESSY_SECRET === undefined ? 0 : 7)",
				10_000,
				{ HARNESSY_NOTIFY_TITLE: 'a "b" $(c)' },
			),
		).toEqual({ ok: true, detail: "exit 0" });
		expect(
			await startProcess(node, ["-e", "process.exit(process.argv[1] === '$(whoami)' ? 0 : 5)", "$(whoami)"], {
				env: {},
				timeoutMs: 10_000,
			}),
		).toEqual({
			ok: true,
			detail: "exit 0",
		});
	});

	it("stops a process that outlives its time limit", async () => {
		const started = Date.now();
		expect(await run("setInterval(() => {}, 1000)", 200)).toEqual({ ok: false, detail: "timed out" });
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")(
		"kills a process that ignores SIGTERM, and names a signal death",
		async () => {
			const started = Date.now();
			expect(await run("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", 200)).toEqual({
				ok: false,
				detail: "timed out",
			});
			expect(Date.now() - started).toBeGreaterThanOrEqual(200 + KILL_GRACE_MS - 50);
			expect(await run("process.kill(process.pid, 'SIGKILL')")).toEqual({
				ok: false,
				detail: "stopped by a signal",
			});
		},
	);
});

describe("executable lookup", () => {
	it("checks real files: executable regular files only", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnessy-notify-which-"));
		try {
			const tool = join(dir, process.platform === "win32" ? "tool.exe" : "tool");
			const plain = join(dir, "plain");
			writeFileSync(tool, "");
			writeFileSync(plain, "");
			chmodSync(tool, 0o755);
			chmodSync(plain, 0o644);
			mkdirSync(join(dir, "folder"));
			const check = isExecutableFile(process.platform);
			expect(check(tool)).toBe(true);
			expect(check(join(dir, "folder"))).toBe(false);
			expect(check(join(dir, "missing"))).toBe(false);
			expect(isExecutableFile("linux")(plain)).toBe(process.platform === "win32");
			expect(isExecutableFile("win32")(plain)).toBe(true);
			expect(findExecutable("tool", { ...liveEnvironment(), env: { PATH: dir, Path: dir, PATHEXT: ".EXE" } })).toBe(
				tool,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("searches only absolute PATH entries, in order", () => {
		const env = machine("linux", { PATH: ":relative:./bin:/usr/local/bin:/usr/bin" }, [
			"/usr/bin/notify-send",
			"/usr/local/bin/notify-send",
		]);
		expect(findExecutable("notify-send", env)).toBe("/usr/local/bin/notify-send");
		expect(env.probed).toEqual(["/usr/local/bin/notify-send"]);
		expect(findExecutable("notify-send", machine("linux", {}))).toBeUndefined();
		expect(
			findExecutable("notify-send", machine("linux", { Path: "/usr/bin" }, ["/usr/bin/notify-send"])),
		).toBeUndefined();
	});

	it("uses Windows path rules and PATHEXT on win32, whatever the host", () => {
		const env = machine("win32", { PATH: "C:\\Tools;relative;;D:\\Bin", PATHEXT: ".COM;.EXE;" }, [
			"D:\\Bin\\tool.exe",
		]);
		expect(findExecutable("tool", env)).toBe("D:\\Bin\\tool.exe");
		expect(env.probed).toEqual([
			"C:\\Tools\\tool.com",
			"C:\\Tools\\tool.exe",
			"D:\\Bin\\tool.com",
			"D:\\Bin\\tool.exe",
		]);
		const fallback = machine("win32", { Path: "C:\\Tools" }, ["C:\\Tools\\tool.cmd"]);
		expect(findExecutable("tool", fallback)).toBe("C:\\Tools\\tool.cmd");
		expect(fallback.probed).toEqual(["C:\\Tools\\tool.exe", "C:\\Tools\\tool.cmd"]);
		expect(findExecutable("tool", machine("win32", {}))).toBeUndefined();
	});

	it("reads yes/no environment flags", () => {
		for (const value of ["1", "true", "yes", "anything"]) expect(flagSet(value)).toBe(true);
		for (const value of [undefined, "", " 0 ", "false", "No", "off"]) expect(flagSet(value)).toBe(false);
	});
});

describe("desktop backends", () => {
	it("escapes AppleScript strings", () => {
		expect(appleScriptString('He said "hi" \\ ok')).toBe('"He said \\"hi\\" \\\\ ok"');
	});

	it("knows when a desktop notification can be seen", () => {
		expect(hasDisplay(machine("linux", { DISPLAY: ":0" }))).toBe(true);
		expect(hasDisplay(machine("linux", { WAYLAND_DISPLAY: "wayland-0", SSH_CONNECTION: "1 2 3 4" }))).toBe(true);
		expect(hasDisplay(machine("linux", { DISPLAY: "" }))).toBe(false);
		expect(hasDisplay(machine("darwin"))).toBe(true);
		expect(hasDisplay(machine("darwin", { SSH_CONNECTION: "10.0.0.1 5 10.0.0.2 22" }))).toBe(false);
		expect(hasDisplay(machine("darwin", { SSH_TTY: "/dev/ttys001" }))).toBe(false);
		expect(hasDisplay(machine("win32"))).toBe(true);
		expect(hasDisplay(machine("win32", { SSH_CONNECTION: "x" }))).toBe(false);
		expect(hasDisplay(machine("freebsd", { DISPLAY: ":0" }))).toBe(false);
	});

	it("prefers terminal-notifier on macOS and passes text only as separate arguments", () => {
		const env = machine("darwin", { PATH: "/opt/homebrew/bin:/usr/bin", HOME, GITHUB_TOKEN: "x" }, [
			"/opt/homebrew/bin/terminal-notifier",
			"/usr/bin/osascript",
		]);
		const backend = desktopBackend(env);
		expect(backend?.name).toBe("terminal-notifier");
		expect(backend?.file).toBe("/opt/homebrew/bin/terminal-notifier");
		expect(backend?.args("T", "-B", "pr_ready")).toEqual([
			"-title",
			"T",
			"-message",
			"-B",
			"-group",
			"harnessy-pr_ready",
		]);
		expect(backend?.env("T", "B")).toEqual({ PATH: "/usr/bin:/bin", HOME });
		expect(
			desktopBackend(machine("darwin", { PATH: "/opt/homebrew/bin" }, ["/opt/homebrew/bin/terminal-notifier"]))?.env(
				"T",
				"B",
			),
		).toEqual({ PATH: "/usr/bin:/bin" });
	});

	it("falls back to osascript on macOS with an escaped script and a fixed PATH", () => {
		const backend = desktopBackend(machine("darwin", { PATH: "/usr/bin", HOME }, ["/usr/bin/osascript"]));
		expect(backend?.name).toBe("osascript");
		expect(backend?.file).toBe("/usr/bin/osascript");
		expect(backend?.args('Harnessy: "x"', "a \\ b", "e")).toEqual([
			"-e",
			'display notification "a \\\\ b" with title "Harnessy: \\"x\\""',
		]);
		expect(backend?.env("T", "B")).toEqual({ PATH: "/usr/bin:/bin" });
		expect(desktopBackend(machine("darwin", { PATH: "/usr/bin" }))).toBeUndefined();
	});

	it("uses notify-send on Linux with only the desktop session variables", () => {
		const env = machine(
			"linux",
			{
				PATH: "/usr/bin",
				DISPLAY: ":0",
				DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
				XDG_RUNTIME_DIR: "/run/user/1000",
				HOME,
				GITHUB_TOKEN: "ghp_secret",
				HSY_NOTIFY_NTFY_TOKEN: TOKEN,
			},
			["/usr/bin/notify-send"],
		);
		const backend = desktopBackend(env);
		expect(backend?.name).toBe("notify-send");
		expect(backend?.args("-T", "B", "e")).toEqual(["--app-name=Harnessy", "--", "-T", "B"]);
		expect(backend?.env("T", "B")).toEqual({
			PATH: "/usr/bin:/bin",
			DISPLAY: ":0",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
			XDG_RUNTIME_DIR: "/run/user/1000",
			HOME,
		});
		expect(desktopBackend(machine("linux", { PATH: "/usr/bin" }))).toBeUndefined();
	});

	it("runs a fixed PowerShell toast script on Windows with the text only in environment variables", () => {
		const env = machine(
			"win32",
			{ SystemRoot: "C:\\Windows\\", TEMP: "C:\\Temp", USERPROFILE: "C:\\Users\\me", GITHUB_TOKEN: "x" },
			["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
		);
		const backend = desktopBackend(env);
		expect(backend?.name).toBe("powershell");
		expect(backend?.file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		const args = backend?.args("Title '; Remove-Item", "Body $(evil)", "e") ?? [];
		expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
		expect(args).toHaveLength(4);
		expect(Buffer.from(args[3] ?? "", "base64").toString("utf16le")).toBe(WINDOWS_TOAST_SCRIPT);
		expect(args.join(" ")).not.toContain("Remove-Item");
		expect(backend?.env("Title '; Remove-Item", "Body $(evil)")).toEqual({
			SystemRoot: "C:\\Windows\\",
			TEMP: "C:\\Temp",
			USERPROFILE: "C:\\Users\\me",
			HARNESSY_NOTIFY_TITLE: "Title '; Remove-Item",
			HARNESSY_NOTIFY_MESSAGE: "Body $(evil)",
		});
		expect(WINDOWS_TOAST_SCRIPT).toContain("CreateTextNode($env:HARNESSY_NOTIFY_TITLE)");
		expect(WINDOWS_TOAST_SCRIPT).toContain("CreateTextNode($env:HARNESSY_NOTIFY_MESSAGE)");

		const windir = machine("win32", { windir: "E:\\Win" }, [
			"E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
		]);
		expect(desktopBackend(windir)?.file).toBe("E:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		const fallback = machine("win32", {});
		expect(desktopBackend(fallback)).toBeUndefined();
		expect(fallback.probed).toEqual(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
		expect(
			desktopBackend(machine("freebsd", { PATH: "/usr/local/bin" }, ["/usr/local/bin/notify-send"])),
		).toBeUndefined();
	});
});

describe("remote push", () => {
	const outgoing: OutgoingNotification = {
		event: "pr_ready",
		title: "Ready to merge",
		message: "PR #7 passed.",
		nextStep: "Merge PR #7.",
		needsYou: true,
	};

	it("accepts HTTPS, or HTTP only to this machine, and never URLs with credentials", () => {
		for (const url of ["https://ntfy.sh/topic", "http://localhost:8080/t", "http://127.0.0.1/t", "http://[::1]:9/t"])
			expect(allowedPushUrl(url)).toBe(true);
		for (const url of [
			"http://ntfy.sh/topic",
			"http://localhost.evil.com/t",
			"https://user@ntfy.sh/t",
			"https://:pw@ntfy.sh/t",
			"ftp://ntfy.sh/t",
			"ntfy.sh/topic",
			"",
		])
			expect(allowedPushUrl(url)).toBe(false);
		expect(allowedToken(TOKEN)).toBe(true);
		for (const token of ["", "a b", "a\r\nX-Evil: 1", "\u00e9", "x".repeat(513)])
			expect(allowedToken(token)).toBe(false);
	});

	it("builds the ntfy request with the token only in the Authorization header", () => {
		expect(ntfyRequest(outgoing, TOKEN)).toEqual({
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				Title: "Harnessy: Ready to merge",
				Priority: "high",
				Tags: "harnessy,pr_ready",
				Authorization: `Bearer ${TOKEN}`,
			},
			body: "PR #7 passed.\nNext: Merge PR #7.",
		});
		const quiet = ntfyRequest({ ...outgoing, title: "Fertig \u2713", nextStep: "", needsYou: false }, undefined);
		expect(quiet).toEqual({
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				Title: "Harnessy: Fertig ?",
				Priority: "default",
				Tags: "harnessy,pr_ready",
			},
			body: "PR #7 passed.",
		});
	});

	it("builds the webhook payload with exactly the documented fields", () => {
		const request = webhookRequest(outgoing, Date.UTC(2026, 9, 23, 12, 0, 0));
		expect(request.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(request.body)).toEqual({
			event: "pr_ready",
			title: "Ready to merge",
			message: "PR #7 passed.",
			next_step: "Merge PR #7.",
			ts: "2026-10-23T12:00:00.000Z",
		});
	});

	it("retries once on a network error, a timeout, 429 or 5xx, and never on other statuses", async () => {
		const send = async (results: ReadonlyArray<number | Error | string>) => {
			const queue = [...results];
			const sleeps: number[] = [];
			const inits: Parameters<Fetch>[1][] = [];
			const result = await postWithRetry(
				async (_url, init) => {
					inits.push(init);
					const next = queue.shift();
					if (typeof next === "number") return { status: next };
					throw next;
				},
				async (ms) => {
					sleeps.push(ms);
				},
				"https://n/t",
				{},
				"body",
				1_000,
			);
			return { result, attempts: inits.length, sleeps, init: inits[0] };
		};
		const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
		const abort = Object.assign(new Error("a"), { name: "AbortError" });
		expect(await send([204])).toMatchObject({ result: { ok: true, detail: "HTTP 204" }, attempts: 1, sleeps: [] });
		expect(await send([503, 200])).toMatchObject({ result: { ok: true }, attempts: 2, sleeps: [RETRY_DELAY_MS] });
		expect(await send([500, 502])).toMatchObject({ result: { ok: false, detail: "HTTP 502" }, attempts: 2 });
		expect(await send([429, 429])).toMatchObject({ result: { ok: false, detail: "HTTP 429" }, attempts: 2 });
		expect(await send([404])).toMatchObject({ result: { ok: false, detail: "HTTP 404" }, attempts: 1 });
		expect(await send([301])).toMatchObject({ result: { ok: false, detail: "HTTP 301" }, attempts: 1 });
		expect(await send([new TypeError("fetch failed"), 200])).toMatchObject({ result: { ok: true }, attempts: 2 });
		expect(await send([timeout, abort])).toMatchObject({ result: { ok: false, detail: "timed out" }, attempts: 2 });
		expect(await send(["not an error", "again"])).toMatchObject({
			result: { ok: false, detail: "network error" },
			attempts: 2,
		});
		const { init } = await send([200]);
		expect(init).toMatchObject({ method: "POST", redirect: "error", body: "body" });
		expect(init?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("notifier", () => {
	it("sends nothing at all when off, but still reports configuration problems once", async () => {
		const h = harness(
			base({ mode: "off", warnings: ["the ntfy URL is ignored"] }),
			machine("darwin", {}, ["/usr/bin/osascript"]),
		);
		await h.notifier.notify(needsYou);
		await h.notifier.notify(needsYou);
		expect(h.logs).toEqual(["[harnessy] notification warning: the ntfy URL is ignored"]);
		expect(h.started).toEqual([]);
		expect(h.posted).toEqual([]);
	});

	it("shows a desktop notification where a display exists, and no terminal line then", async () => {
		const h = harness(base(), machine("darwin", { PATH: "/usr/bin" }, ["/usr/bin/osascript"]));
		await h.notifier.notify(needsYou);
		expect(h.started).toEqual([
			{
				file: "/usr/bin/osascript",
				args: [
					"-e",
					'display notification "PR #7 for task 11111111 passed its checks. Next: Review and merge PR #7." with title "Harnessy: Ready to merge"',
				],
				env: { PATH: "/usr/bin:/bin" },
				timeoutMs: 5_000,
			},
		]);
		expect(h.logs).toEqual([]);
		await h.notifier.notify({ event: "accepted", title: "Accepted", message: "Done." });
		expect(h.started[1]?.args).toEqual(["-e", 'display notification "Done." with title "Harnessy: Accepted"']);
	});

	it("prints one terminal line when headless: no display, SSH, terminal mode or no installed notifier", async () => {
		const line =
			"[harnessy] Ready to merge: PR #7 for task 11111111 passed its checks. Next: Review and merge PR #7.";
		for (const [config, environment] of [
			[base(), machine("linux", { PATH: "/usr/bin" }, ["/usr/bin/notify-send"])],
			[base(), machine("darwin", { SSH_CONNECTION: "a b c d" }, ["/usr/bin/osascript"])],
			[base({ mode: "terminal" }), machine("darwin", {}, ["/usr/bin/osascript"])],
			[base(), machine("linux", { DISPLAY: ":0", PATH: "/usr/bin" })],
		] as const) {
			const h = harness(config, environment);
			await h.notifier.notify(needsYou);
			expect(h.started).toEqual([]);
			expect(h.logs).toEqual([line]);
		}
	});

	it("falls back to the terminal line with a warning when the desktop notifier fails", async () => {
		const h = harness(
			base(),
			machine("win32", {}, ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]),
			{
				processOk: false,
			},
		);
		await h.notifier.notify(needsYou);
		expect(h.started).toHaveLength(1);
		expect(h.logs).toEqual([
			"[harnessy] notification warning: powershell failed (exit 1)",
			"[harnessy] Ready to merge: PR #7 for task 11111111 passed its checks. Next: Review and merge PR #7.",
		]);
	});

	it("tries the desktop even without a detected display in desktop mode, and says when none is installed", async () => {
		const forced = harness(
			base({ mode: "desktop" }),
			machine("darwin", { SSH_TTY: "/dev/ttys001" }, ["/usr/bin/osascript"]),
		);
		await forced.notifier.notify(needsYou);
		expect(forced.started).toHaveLength(1);
		expect(forced.logs).toEqual([]);
		const none = harness(base({ mode: "desktop" }), machine("linux", { DISPLAY: ":0" }));
		await none.notifier.notify(needsYou);
		expect(none.logs).toEqual([
			"[harnessy] notification warning: no desktop notifier is installed here",
			"[harnessy] Ready to merge: PR #7 for task 11111111 passed its checks. Next: Review and merge PR #7.",
		]);
	});

	it("pushes to ntfy and the webhook only when configured, with sanitized text and the token only in a header", async () => {
		const quiet = harness(base({ mode: "terminal" }), machine("linux"));
		await quiet.notifier.notify(needsYou);
		expect(quiet.posted).toEqual([]);

		const h = harness(
			base({
				mode: "terminal",
				ntfy: { url: "https://ntfy.example.com/topic", token: TOKEN },
				webhookUrl: "https://hooks.example.com/h",
			}),
			machine("linux"),
		);
		await h.notifier.notify({
			event: "blocked",
			title: `Blocked in ${HOME}/Code/app`,
			message: `Agent stopped: token=${TOKEN} at /private/var/x; see ${HOME}/.ssh/id_rsa`,
			nextStep: `Use ${TOKEN} nowhere`,
		});
		expect(h.posted.map((post) => post.url)).toEqual([
			"https://ntfy.example.com/topic",
			"https://hooks.example.com/h",
		]);
		const [ntfy, webhook] = h.posted;
		expect(ntfy?.headers.Authorization).toBe(`Bearer ${TOKEN}`);
		expect(ntfy?.headers.Title).toBe("Harnessy: Blocked in ~/Code/app");
		expect(ntfy?.body).toBe(
			"Agent stopped: token=<redacted> at <path>; see ~/.ssh/id_rsa\nNext: Use <redacted> nowhere",
		);
		expect(JSON.parse(webhook?.body ?? "")).toEqual({
			event: "blocked",
			title: "Blocked in ~/Code/app",
			message: "Agent stopped: token=<redacted> at <path>; see ~/.ssh/id_rsa",
			next_step: "Use <redacted> nowhere",
			ts: "2026-10-23T12:00:00.000Z",
		});
		const everythingSent = JSON.stringify([webhook, ntfy?.body, h.logs]);
		expect(everythingSent).not.toContain(TOKEN);
		expect(everythingSent).not.toContain(HOME);
		expect(Object.keys(webhook?.headers ?? {})).toEqual(["Content-Type"]);
	});

	it("logs a push failure without the URL or token, and still prints the line", async () => {
		const h = harness(
			base({
				mode: "terminal",
				ntfy: { url: "https://ntfy.example.com/secret-topic" },
				webhookUrl: "https://hooks.example.com/secret",
			}),
			machine("linux"),
			{ status: 401 },
		);
		await h.notifier.notify(needsYou);
		expect(h.logs).toEqual([
			"[harnessy] notification warning: ntfy push failed (HTTP 401)",
			"[harnessy] notification warning: webhook push failed (HTTP 401)",
			"[harnessy] Ready to merge: PR #7 for task 11111111 passed its checks. Next: Review and merge PR #7.",
		]);
		expect(h.posted[0]?.headers.Authorization).toBeUndefined();
		expect(h.sleeps).toEqual([]);
	});

	it("cleans the notification fields and their defaults", () => {
		expect(prepare({ event: "Not An Event!", title: "  ", message: "m" }, HOME, [])).toEqual({
			event: "notification",
			title: "Harnessy",
			message: "m",
			nextStep: "",
			needsYou: true,
		});
		expect(prepare({ ...needsYou, needsYou: false }, HOME, []).needsYou).toBe(false);
		expect(terminalLine({ event: "e", title: "T", message: "M", nextStep: "", needsYou: true })).toBe(
			"[harnessy] T: M",
		);
	});

	it("never throws or rejects, even when the process seam and the log both throw", async () => {
		const exploding = harness(base(), machine("darwin", {}, ["/usr/bin/osascript"]), {
			start: () => {
				throw new Error(`boom ${HOME}`);
			},
		});
		await expect(exploding.notifier.notify(needsYou)).resolves.toBeUndefined();
		expect(exploding.logs).toEqual(["[harnessy] notification warning: notification failed"]);

		const silent = harness(base({ mode: "terminal" }), machine("linux"), {
			log: () => {
				throw new Error("stderr closed");
			},
		});
		await expect(silent.notifier.notify(needsYou)).resolves.toBeUndefined();
	});
});

describe("live notifier", () => {
	let server: Server;
	let url = "";
	const received: Array<{ readonly headers: Record<string, unknown>; readonly body: string }> = [];
	let failNext = 0;
	beforeAll(async () => {
		server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += String(chunk);
			});
			request.on("end", () => {
				received.push({ headers: request.headers, body });
				response.statusCode = failNext-- > 0 ? 503 : 204;
				response.end();
			});
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
	});
	afterAll(() => new Promise<void>((done) => server.close(() => done())));

	it("reads the environment and the settings file, prints the line and posts a real webhook with one retry", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnessy-notify-live-"));
		try {
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({ notifications: { mode: "terminal", webhook: { url } } }),
			);
			const logs: string[] = [];
			failNext = 1;
			const notifier = liveNotifier(
				undefined,
				(line) => logs.push(line),
				() => ({
					...machine("linux"),
					env: { HSY_CODING_AGENT_DIR: dir, CI: "true" },
				}),
			);
			await notifier.notify(needsYou);
			expect(logs).toEqual([
				"[harnessy] Ready to merge: PR #7 for task 11111111 passed its checks. Next: Review and merge PR #7.",
			]);
			expect(received).toHaveLength(2);
			expect(received[1]?.headers["content-type"]).toBe("application/json");
			expect(JSON.parse(received[1]?.body ?? "")).toMatchObject({
				event: "pr_ready",
				next_step: "Review and merge PR #7.",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("logs one warning and sends nothing when it cannot even be set up", async () => {
		const logs: string[] = [];
		const notifier = liveNotifier(
			"terminal",
			(line) => logs.push(line),
			() => {
				throw new Error("no home");
			},
		);
		await notifier.notify(needsYou);
		await notifier.notify(needsYou);
		expect(logs).toEqual(["[harnessy] notification warning: notifications could not be set up"]);
		const mute = liveNotifier(
			"terminal",
			() => {
				throw new Error("stderr closed");
			},
			() => {
				throw new Error("no home");
			},
		);
		await expect(mute.notify(needsYou)).resolves.toBeUndefined();
	});

	it("probes this process", () => {
		const environment = liveEnvironment();
		expect(environment.platform).toBe(process.platform);
		expect(environment.env).toBe(process.env);
		expect(environment.isExecutable(process.execPath)).toBe(true);
	});
});

/**
 * Real platform checks. They never show a notification on a developer
 * machine: each runs only on its CI runner, or uses a recording process seam.
 */
describe("this platform", () => {
	it.runIf(process.platform === "linux" && !flagSet(process.env.DISPLAY) && !flagSet(process.env.WAYLAND_DISPLAY))(
		"Linux without a display: auto mode prints the terminal line and starts no process",
		async () => {
			const h = harness(base(), liveEnvironment());
			await h.notifier.notify(needsYou);
			expect(h.started).toEqual([]);
			expect(h.logs).toEqual([
				"[harnessy] Ready to merge: PR #7 for task 11111111 passed its checks. Next: Review and merge PR #7.",
			]);
		},
	);

	it.runIf(process.platform === "darwin")("macOS: the real probe finds a desktop notifier", () => {
		const backend = desktopBackend(liveEnvironment());
		expect(["terminal-notifier", "osascript"]).toContain(backend?.name);
	});

	it.runIf(process.platform === "win32" && flagSet(process.env.CI))(
		"Windows: the toast script parses, and the real toast runs to completion",
		async () => {
			const backend = desktopBackend(liveEnvironment());
			expect(backend?.name).toBe("powershell");
			const file = backend?.file ?? "";
			const parse = spawnSync(
				file,
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:HARNESSY_SCRIPT, [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 3 }",
				],
				{ env: { ...process.env, HARNESSY_SCRIPT: WINDOWS_TOAST_SCRIPT }, encoding: "utf8", timeout: 60_000 },
			);
			expect(parse.stdout).toBe("");
			expect(parse.status).toBe(0);
			const title = "Harnessy CI";
			const body = "Notifier test from the Windows runner.";
			const outcome = await startProcess(file, backend?.args(title, body, "test") ?? [], {
				env: backend?.env(title, body) ?? {},
				timeoutMs: 60_000,
			});
			// A service session may refuse to show a toast (exit 1); it must still start and finish.
			console.log(`Windows toast outcome: ${outcome.detail}`);
			expect(["exit 0", "exit 1"]).toContain(outcome.detail);
		},
		90_000,
	);
});
