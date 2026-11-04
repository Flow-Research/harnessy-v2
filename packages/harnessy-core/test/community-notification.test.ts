import { type ExecFileOptions, execFile } from "node:child_process";
import { expect, it } from "vitest";
import { notifyCommunityDraft } from "../src/jarvis/community-briefing/notification.ts";

/** The production options for a real test child, with the test-only keychain switch added last. */
const keychainOff = (options: ExecFileOptions): ExecFileOptions => ({
	...options,
	env: { ...options.env, PI_AUTH_ENCRYPTION: "off", HSY_AUTH_ENCRYPTION: "off" },
});

it.each(["pending", "error"] as const)(
	"submits a content-free %s message through a bounded shell-free child",
	async (kind) => {
		let calls = 0;
		const ok = await notifyCommunityDraft(
			kind,
			3,
			new AbortController().signal,
			"darwin",
			(file, args, options, completed) => {
				calls++;
				expect(file).toBe("/usr/bin/osascript");
				expect(args[0]).toBe("-e");
				expect(args[1]).toContain(kind === "pending" ? "3 weekly briefing drafts" : "Inspect the local run record");
				expect(options).toMatchObject({
					shell: false,
					timeout: 2000,
					killSignal: "SIGKILL",
					maxBuffer: 1024,
					// The exact environment the production notifier passes: asserted, not started.
					// harnessy-test-env: configuration, not a child process environment
					env: { PATH: "/usr/bin:/bin" },
				});
				// Exact: the production notifier passes PATH and nothing else.
				expect(Object.keys(options.env ?? {})).toEqual(["PATH"]);
				// Real process execution with the OS executable replaced, not a desktop alert. The child gets
				// the production environment plus the test-only keychain switch, which the secret check skips.
				execFile(
					process.execPath,
					[
						"-e",
						"if (Object.keys(process.env).some(k => k !== 'PI_AUTH_ENCRYPTION' && k !== 'HSY_AUTH_ENCRYPTION' && /TOKEN|SECRET|AUTH/.test(k))) process.exit(9);",
					],
					keychainOff(options),
					completed,
				);
			},
		);
		expect(ok).toBe(true);
		expect(calls).toBe(1);
	},
);

it("reports a failed notifier without propagating its private diagnostic", async () => {
	expect(
		await notifyCommunityDraft(
			"error",
			0,
			new AbortController().signal,
			"darwin",
			(_file, _args, options, completed) => {
				execFile(
					process.execPath,
					["-e", "console.error('PRIVATE_FAILURE'); process.exit(1)"],
					keychainOff(options),
					completed,
				);
			},
		),
	).toBe(false);
});

it("cancels and awaits an unresponsive notifier child", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 50);
	try {
		expect(
			await notifyCommunityDraft("pending", 1, controller.signal, "darwin", (_file, _args, options, completed) => {
				execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], keychainOff(options), completed);
			}),
		).toBe(false);
	} finally {
		clearTimeout(timer);
	}
});

it("rejects unsupported desktops and invalid counts before process invocation", async () => {
	let calls = 0;
	for (const [platform, count] of [
		["linux", 1],
		["darwin", -1],
		["darwin", Number.NaN],
		["darwin", 10001],
	] as const) {
		expect(
			await notifyCommunityDraft("pending", count, new AbortController().signal, platform, () => {
				calls++;
			}),
		).toBe(false);
	}
	expect(calls).toBe(0);
});

it("fails closed on a synchronous OS invocation failure", async () => {
	expect(
		await notifyCommunityDraft("pending", 1, new AbortController().signal, "darwin", () => {
			throw new Error("PRIVATE_FAILURE");
		}),
	).toBe(false);
});
