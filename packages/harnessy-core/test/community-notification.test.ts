import { execFile } from "node:child_process";
import { expect, it } from "vitest";
import { notifyCommunityDraft } from "../src/jarvis/community-briefing/notification.ts";

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
					env: { PATH: "/usr/bin:/bin" },
				});
				// Real process execution with the OS executable replaced, not a desktop alert.
				execFile(
					process.execPath,
					["-e", "if (Object.keys(process.env).some(k => /TOKEN|SECRET|AUTH/.test(k))) process.exit(9);"],
					options,
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
				execFile(process.execPath, ["-e", "console.error('PRIVATE_FAILURE'); process.exit(1)"], options, completed);
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
				execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, completed);
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
