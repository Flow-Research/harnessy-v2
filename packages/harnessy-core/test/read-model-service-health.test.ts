import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import {
	COMMUNITY_GUARD_LABELS,
	isCommunityCompatibilityWriterCommand,
} from "../src/jarvis/community-briefing/operational-runtime.ts";
import {
	isMeetingPublicationV1WriterCommand,
	MEETING_V1_LABELS,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import {
	createLaunchdProbe,
	type LaunchdProbe,
	PORTAL_SERVICE_LABEL,
	PORTAL_SERVICE_LABELS,
	PortalSchemas,
	parseLaunchctlPrint,
	readServiceHealth,
	redactLogLine,
} from "../src/read-model.ts";
import { cleanupReadModelFixtures, tempHome } from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T12:00:00.000Z");
const SECRET = "planted-secret-value-0123456789";

/** The shape of `launchctl print gui/<uid>/<label>` on macOS, including a job environment. */
const launchctlPrint = (home: string, label: string) => `gui/501/${label} = {
	active count = 1
	path = ${home}/Library/LaunchAgents/${label}.plist
	type = LaunchAgent
	state = running

	program = /usr/local/bin/node
	arguments = {
		/usr/local/bin/node
		${home}/cli.js
		--token=${SECRET}
	}

	stdout path = ${home}/logs/${label}.out.log
	stderr path = ${home}/logs/${label}.err.log
	inherited environment = {
		SSH_AUTH_SOCK => /private/tmp/agent
	}

	default environment = {
		PATH => /usr/bin:/bin
	}

	environment = {
		FATHOM_API_KEY => ${SECRET}
		state = hijacked
		pid = 4242
	}

	domain = gui/501 [100005]
	runs = 3
	pid = 6011
	immediate reason = speculative
	forks = 0
	execs = 1
	last exit code = 78: EX_CONFIG

	spawn type = daemon (3)
	properties = keepalive | runatload
}
`;

describe("launchctl parsing", () => {
	it("keeps five top-level fields and never a value from a nested block", () => {
		const fields = parseLaunchctlPrint(launchctlPrint("/Users/owner", "org.harnessy.portal"));
		expect(fields).toEqual({
			state: "running",
			pid: 6011,
			lastExitCode: 78,
			stdoutPath: "/Users/owner/logs/org.harnessy.portal.out.log",
			stderrPath: "/Users/owner/logs/org.harnessy.portal.err.log",
		});
		expect(JSON.stringify(fields)).not.toContain(SECRET);
		expect(
			parseLaunchctlPrint("gui/501/x = {\n\tlast exit code = (never exited)\n\tpid = 0\n\tstate = 7\n}\n"),
		).toEqual({
			state: null,
			pid: null,
			lastExitCode: null,
			stdoutPath: null,
			stderrPath: null,
		});
		expect(parseLaunchctlPrint("}\n}\nstate = running\n").state).toBeNull();
		expect(
			parseLaunchctlPrint("x = {\n\tstdout path = relative.log\n\tstderr path = relative.log\n}").stdoutPath,
		).toBeNull();
	});

	it("redacts query strings, bearer credentials and secret assignments", () => {
		expect(
			redactLogLine(
				`GET http://127.0.0.1:8872/exchange?token=${SECRET}#frag Authorization: Bearer ${SECRET} review_token=${SECRET} api_key: "${SECRET}" password='${SECRET}'\u0007`,
			),
		).toBe(
			"GET http://127.0.0.1:8872/exchange?[redacted] Authorization: [redacted] [redacted] review_token=[redacted] api_key: [redacted] password=[redacted]",
		);
		expect(redactLogLine(`POST /exchange?code=${SECRET} Bearer ${SECRET}`)).toBe(
			"POST /exchange?[redacted] Bearer [redacted]",
		);
		expect(redactLogLine("is it ready? yes")).toBe("is it ready? yes");
		expect(redactLogLine("x".repeat(400))).toHaveLength(300);
	});
});

describe("service health", () => {
	it("reports each label with redacted last log lines and no raw probe output", () => {
		const home = tempHome("health");
		const logs = join(home, "logs");
		mkdirSync(logs);
		const label = "org.harnessy.portal";
		writeFileSync(join(logs, `${label}.out.log`), `started\nGET /exchange?code=${SECRET}\n\n`);
		writeFileSync(join(logs, `${label}.err.log`), `warning: Bearer ${SECRET}\n`);
		utimesSync(join(logs, `${label}.out.log`), new Date("2026-10-17T10:00:00Z"), new Date("2026-10-17T10:00:00Z"));
		utimesSync(join(logs, `${label}.err.log`), new Date("2026-10-17T11:00:00Z"), new Date("2026-10-17T11:00:00Z"));
		const probed: string[] = [];
		const probe: LaunchdProbe = (name) => {
			probed.push(name);
			if (name === label) return { status: 0, stdout: launchctlPrint(home, name), stderr: "" };
			if (name === "com.flow-harness.meeting-fathom-poll")
				return { status: 113, stdout: "", stderr: `Could not find service "${name}" in domain for user gui: 501` };
			return { status: 5, stdout: "", stderr: "Input/output error" };
		};
		const tiles = readServiceHealth(PORTAL_SERVICE_LABELS, probe, { homeRoot: home, now: NOW });
		expect(probed).toEqual([...PORTAL_SERVICE_LABELS]);
		expect(Value.Check(PortalSchemas.ServiceHealthSummary, tiles)).toBe(true);
		expect(tiles[label]).toEqual({
			state: "ok",
			readAt: NOW.toISOString(),
			data: {
				label,
				state: "running",
				pid: 6011,
				lastExitCode: 78,
				lastLogLine: {
					stream: "stderr",
					text: "warning: Bearer [redacted]",
					modifiedAt: "2026-10-17T11:00:00.000Z",
				},
			},
		});
		expect(tiles["com.flow-harness.meeting-fathom-poll"]).toMatchObject({ state: "missing", reason: "not_loaded" });
		expect(tiles["org.harnessy.meeting-publication"]).toMatchObject({ state: "error", reason: "probe_failed" });
		expect(JSON.stringify(tiles)).not.toContain(SECRET);

		utimesSync(join(logs, `${label}.out.log`), new Date("2026-10-17T11:30:00Z"), new Date("2026-10-17T11:30:00Z"));
		expect(readServiceHealth([label], probe, { homeRoot: home, now: NOW })[label]?.data?.lastLogLine).toEqual({
			stream: "stdout",
			text: "GET /exchange?[redacted]",
			modifiedAt: "2026-10-17T11:30:00.000Z",
		});
	});

	it("reads only regular log files inside the home directory and only their last 4 KiB", () => {
		const home = tempHome("health-logs");
		const outside = tempHome("health-outside");
		const label = "org.harnessy.portal";
		const print = (stdoutPath: string, stderrPath: string) =>
			`gui/501/${label} = {\n\tstate = waiting\n\tstdout path = ${stdoutPath}\n\tstderr path = ${stderrPath}\n}\n`;
		writeFileSync(join(outside, "out.log"), "outside line\n");
		writeFileSync(join(home, "real.log"), "linked line\n");
		symlinkSync(join(home, "real.log"), join(home, "link.log"));
		const read = (stdoutPath: string, stderrPath: string) =>
			readServiceHealth([label], () => ({ status: 0, stdout: print(stdoutPath, stderrPath), stderr: "" }), {
				homeRoot: home,
				now: NOW,
			})[label];
		expect(read(join(outside, "out.log"), join(home, "link.log"))?.data).toEqual({
			label,
			state: "waiting",
			pid: null,
			lastExitCode: null,
			lastLogLine: null,
		});
		expect(
			readServiceHealth([label], () => ({ status: 0, stdout: `x = {\n\tstate = waiting\n}\n`, stderr: "" }), {
				homeRoot: home,
			})[label]?.data?.lastLogLine,
		).toBeNull();
		writeFileSync(join(home, "empty.log"), "\n\n");
		writeFileSync(join(home, "long.log"), `${"a".repeat(5_000)}\n${"b".repeat(500)}\n`);
		expect(read(join(home, "empty.log"), join(home, "missing.log"))?.data?.lastLogLine).toBeNull();
		expect(read(join(home, "long.log"), join(home, "missing.log"))?.data?.lastLogLine?.text).toBe("b".repeat(300));
		writeFileSync(join(home, "cut.log"), `${"c".repeat(5_000)}`);
		expect(read(join(home, "cut.log"), join(home, "missing.log"))?.data?.lastLogLine?.text).toBe("c".repeat(300));
	});

	it("reports unsupported platforms, invalid labels and probe failures as tiles", () => {
		const tiles = readServiceHealth(["bad label", "org.harnessy.portal", "com.example.throws"], (label) => {
			if (label === "com.example.throws") throw new Error("probe exploded");
			return "unsupported";
		});
		expect(tiles["bad label"]).toMatchObject({ state: "error", reason: "invalid_label" });
		expect(tiles["org.harnessy.portal"]).toMatchObject({ state: "unsupported", reason: "platform" });
		expect(tiles["com.example.throws"]).toMatchObject({ state: "error", reason: "read_failed" });
	});
});

describe("launchd probe", () => {
	it("never spawns off macOS and runs only a root-owned executable without a shell", () => {
		const home = tempHome("probe");
		expect(createLaunchdProbe({ platform: "linux", executable: join(home, "absent") })("org.harnessy.portal")).toBe(
			"unsupported",
		);
		// A root-owned stand-in executable shows the exact argv the probe passes to launchctl.
		const echo = createLaunchdProbe({ platform: "darwin", executable: "/bin/echo", uid: 501 });
		expect(echo("org.harnessy.portal")).toEqual({
			status: 0,
			stdout: "print gui/501/org.harnessy.portal\n",
			stderr: "",
		});
		expect(() => echo("org.harnessy.portal; rm -rf /")).toThrow("invalid_label");
		writeFileSync(join(home, "launchctl"), "#!/bin/sh\n", { mode: 0o755 });
		expect(() =>
			createLaunchdProbe({ platform: "darwin", executable: join(home, "launchctl"), uid: 501 })(
				"org.harnessy.portal",
			),
		).toThrow("probe_unsafe");
		// Output beyond the 64 KiB limit fails the probe instead of buffering it.
		expect(() =>
			createLaunchdProbe({ platform: "darwin", executable: "/usr/bin/yes", uid: 501 })("org.harnessy.portal"),
		).toThrow("probe_failed");
	});

	it("uses the real launchctl on macOS and nothing elsewhere", () => {
		const result = createLaunchdProbe()("org.harnessy.read-model-test-absent");
		if (process.platform !== "darwin") expect(result).toBe("unsupported");
		else if (result === "unsupported") expect.fail("launchd probe reported unsupported on macOS");
		else expect(`${result.stdout}${result.stderr}`).toContain("Could not find service");
	});
});

describe("one-writer guards", () => {
	it("treat the portal and every probe it runs as known non-writers", () => {
		expect(COMMUNITY_GUARD_LABELS).not.toContain(PORTAL_SERVICE_LABEL);
		expect(MEETING_V1_LABELS).not.toContain(PORTAL_SERVICE_LABEL);
		const commands = [
			...PORTAL_SERVICE_LABELS.map((label) => `/bin/launchctl print gui/501/${label}`),
			"/usr/local/bin/node /opt/harnessy/node_modules/@harnessy/core/dist/cli.js portal serve --port 8790",
			"/usr/local/bin/node /opt/harnessy/node_modules/@harnessy/local-host/dist/portal-cli.js serve --port 8790",
			"/usr/local/bin/harnessy portal status",
		];
		for (const command of commands) {
			expect(isCommunityCompatibilityWriterCommand(command), command).toBe(false);
			expect(isMeetingPublicationV1WriterCommand(command), command).toBe(false);
		}
		// The same predicates do catch writer-shaped commands, so the assertion above is not vacuous.
		expect(
			isCommunityCompatibilityWriterCommand(
				"/usr/local/bin/node /opt/harnessy/node_modules/@harnessy/core/dist/cli.js jarvis community briefing review serve",
			),
		).toBe(true);
		expect(isMeetingPublicationV1WriterCommand("/opt/jarvis/bin/jarvis meeting publish worker")).toBe(true);
	});
});
