import { spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderMeetingServiceLaunchAgent } from "../src/meeting-full-review-command.ts";
import {
	controlMeetingServiceFiles,
	installMeetingServiceFiles,
	waitMeetingServiceStopped,
} from "../src/meeting-service-enrollment.ts";

const roots: string[] = [];
// launchctl is injected below, so the service-control contract can run on the
// Linux coverage runner without invoking a host process. Restore the real
// platform after every case; the plutil assertion remains macOS-only.
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const fixture = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-service-files-")));
	roots.push(root);
	chmodSync(root, 0o700);
	return root;
};
beforeEach(() => Object.defineProperty(process, "platform", { ...platformDescriptor, value: "darwin" }));
afterEach(() => {
	Object.defineProperty(process, "platform", platformDescriptor);
	vi.useRealTimers();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("disable binds the loaded path and submits stop after blocking relaunch", () => {
	const root = fixture();
	const plist = renderMeetingServiceLaunchAgent("/fixture/node", "/fixture/cli.js", "/fixture/service.json", root);
	installMeetingServiceFiles(root, plist);
	const calls: Array<ReadonlyArray<string>> = [];
	let loaded = true;
	const result = controlMeetingServiceFiles(
		root,
		plist,
		(args) => {
			calls.push(args);
			if (args[0] === "print")
				return loaded
					? {
							status: 0,
							stderr: "",
							stdout: `\tpath = ${join(root, "org.harnessy.meeting-publication.plist")}\n`,
						}
					: { status: 113, stderr: "Could not find service" };
			if (args[0] === "bootout") loaded = false;
			return { status: 0, stderr: "" };
		},
		"disable",
	);
	expect(result.kind).toBe("harnessy.meeting-publication.service-stop-submitted");
	const target = `gui/${process.geteuid?.()}/org.harnessy.meeting-publication`;
	expect(calls).toEqual([
		["print", target],
		["disable", target],
		["bootout", target],
	]);
	expect(readFileSync(join(root, "org.harnessy.meeting-publication.plist"), "utf8")).toBe(plist);
});

it("disable rejects another installation and propagates failed stop without retries", () => {
	const root = fixture();
	const plist = renderMeetingServiceLaunchAgent("/fixture/node", "/fixture/cli.js", "/fixture/service.json", root);
	installMeetingServiceFiles(root, plist);
	for (const failure of ["different-path", "disable", "bootout"]) {
		const calls: string[] = [];
		expect(() =>
			controlMeetingServiceFiles(
				root,
				plist,
				(args) => {
					const action = args[0]!;
					calls.push(action);
					if (action === "print")
						return {
							status: 0,
							stderr: "",
							stdout: `path = ${failure === "different-path" ? "/other/owner.plist" : join(root, "org.harnessy.meeting-publication.plist")}`,
						};
					return { status: action === failure ? 1 : 0, stderr: "" };
				},
				"disable",
			),
		).toThrow();
		expect(calls).toEqual(
			failure === "different-path"
				? ["print"]
				: failure === "disable"
					? ["print", "disable"]
					: ["print", "disable", "bootout"],
		);
	}
});

it("disable an absent service without pretending to stop a process", () => {
	const root = fixture();
	const plist = renderMeetingServiceLaunchAgent("/fixture/node", "/fixture/cli.js", "/fixture/service.json", root);
	installMeetingServiceFiles(root, plist);
	const calls: string[] = [];
	controlMeetingServiceFiles(
		root,
		plist,
		(args) => {
			calls.push(args[0]!);
			return args[0] === "print" ? { status: 113, stderr: "Could not find service" } : { status: 0, stderr: "" };
		},
		"disable",
	);
	expect(calls).toEqual(["print", "disable"]);
});

it("waits for asynchronous removal but rejects unknown state and a stuck service", async () => {
	vi.useFakeTimers();
	let checks = 0;
	const stopped = waitMeetingServiceStopped(() =>
		++checks < 3 ? { status: 0, stderr: "" } : { status: 113, stderr: "Could not find service" },
	);
	await vi.advanceTimersByTimeAsync(200);
	await stopped;
	expect(checks).toBe(3);
	await expect(waitMeetingServiceStopped(() => ({ status: 1, stderr: "Permission denied" }))).rejects.toThrow(
		"service_stop_unconfirmed",
	);
	const stuck = expect(waitMeetingServiceStopped(() => ({ status: 0, stderr: "" }))).rejects.toThrow(
		"service_stop_unconfirmed",
	);
	await vi.advanceTimersByTimeAsync(50_000);
	await stuck;
});

it("enable validates exact files before submitting bounded service control", () => {
	const root = fixture();
	const plist = renderMeetingServiceLaunchAgent("/fixture/node", "/fixture/cli.js", "/fixture/service.json", root);
	installMeetingServiceFiles(root, plist);
	const calls: Array<ReadonlyArray<string>> = [];
	const boundary = (args: ReadonlyArray<string>) => {
		calls.push(args);
		return args[0] === "print" ? { status: 113, stderr: "Could not find service" } : { status: 0, stderr: "" };
	};
	expect(controlMeetingServiceFiles(root, plist, boundary)).toEqual({
		kind: "harnessy.meeting-publication.service-start-submitted",
		runtimeHealth: "not_assessed",
	});
	const domain = `gui/${process.geteuid?.()}`;
	const target = `${domain}/org.harnessy.meeting-publication`;
	expect(calls).toEqual([
		["print", target],
		["enable", target],
		["bootstrap", domain, join(root, "org.harnessy.meeting-publication.plist")],
	]);
	calls.length = 0;
	expect(() => controlMeetingServiceFiles(root, `${plist}changed`, boundary)).toThrow("service_configuration_changed");
	expect(calls).toEqual([]);
	chmodSync(join(root, "stdout.log"), 0o644);
	expect(() => controlMeetingServiceFiles(root, plist, boundary)).toThrow("unsafe_output");
	expect(calls).toEqual([]);
});

it("enable refuses existing or unknown owners and never retries a failed submission", () => {
	const root = fixture();
	const plist = renderMeetingServiceLaunchAgent("/fixture/node", "/fixture/cli.js", "/fixture/service.json", root);
	installMeetingServiceFiles(root, plist);
	for (const failure of ["print-loaded", "print-unknown", "enable", "bootstrap"]) {
		const calls: string[] = [];
		expect(() =>
			controlMeetingServiceFiles(
				root,
				plist,
				(args) => {
					const action = args[0]!;
					calls.push(action);
					if (action === "print")
						return failure === "print-loaded"
							? { status: 0, stderr: "" }
							: {
									status: 113,
									stderr: failure === "print-unknown" ? "Permission denied" : "Could not find service",
								};
					return { status: action === failure ? 1 : 0, stderr: "" };
				},
				"enable",
			),
		).toThrow();
		expect(calls).toEqual(
			failure.startsWith("print-")
				? ["print"]
				: failure === "enable"
					? ["print", "enable"]
					: ["print", "enable", "bootstrap"],
		);
		expect(readFileSync(join(root, "org.harnessy.meeting-publication.plist"), "utf8")).toBe(plist);
	}
});

it("stages a valid private launch agent and logs without activating or overwriting", () => {
	const root = fixture();
	const plist = renderMeetingServiceLaunchAgent("/fixture/node", "/fixture/cli.js", "/fixture/service.json", root);
	expect(installMeetingServiceFiles(root, plist)).toEqual({
		kind: "harnessy.meeting-publication.service-files-installed",
		activated: false,
	});
	const files = ["org.harnessy.meeting-publication.plist", "stderr.log", "stdout.log"];
	expect(readdirSync(root).sort()).toEqual(files);
	for (const name of files) {
		const stat = lstatSync(join(root, name));
		expect(stat.mode & 0o7777).toBe(0o600);
		expect(stat.uid).toBe(process.geteuid?.());
		expect(stat.isFile()).toBe(true);
	}
	if (platformDescriptor.value === "darwin") {
		const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", join(root, files[0]!)], {
			encoding: "utf8",
		});
		expect(parsed.status, parsed.stderr).toBe(0);
		expect(JSON.parse(parsed.stdout)).toMatchObject({
			StandardOutPath: join(root, "stdout.log"),
			StandardErrorPath: join(root, "stderr.log"),
			KeepAlive: false,
		});
	}
	expect(readFileSync(join(root, "stderr.log"), "utf8")).toBe("");
	writeFileSync(join(root, "stdout.log"), "preserve operational evidence");
	expect(() => installMeetingServiceFiles(root, "replacement")).toThrow();
	expect(readFileSync(join(root, files[0]!), "utf8")).toBe(plist);
	expect(readFileSync(join(root, "stdout.log"), "utf8")).toBe("preserve operational evidence");
});

it("rejects shared, nonempty, absent and symlink directories without touching existing data", () => {
	const root = fixture();
	const shared = join(root, "shared");
	mkdirSync(shared, { mode: 0o755 });
	expect(() => installMeetingServiceFiles(shared, "fixture")).toThrow();
	expect(readdirSync(shared)).toEqual([]);
	const target = join(root, "target");
	mkdirSync(target, { mode: 0o700 });
	const link = join(root, "link");
	symlinkSync(target, link);
	expect(() => installMeetingServiceFiles(link, "fixture")).toThrow();
	expect(readdirSync(target)).toEqual([]);
	writeFileSync(join(target, "owner-note"), "preserved");
	expect(() => installMeetingServiceFiles(target, "fixture")).toThrow();
	expect(readdirSync(target)).toEqual(["owner-note"]);
	expect(readFileSync(join(target, "owner-note"), "utf8")).toBe("preserved");
	expect(() => installMeetingServiceFiles(join(root, "absent"), "fixture")).toThrow();
	expect(() => installMeetingServiceFiles("relative", "fixture")).toThrow();
});
