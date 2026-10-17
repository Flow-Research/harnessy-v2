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
	classifyLogLine,
	createLaunchdProbe,
	type LaunchdProbe,
	PORTAL_SERVICE_LABEL,
	PORTAL_SERVICE_LABELS,
	PortalSchemas,
	parseLaunchctlPrint,
	readServiceHealth,
	SERVICE_LOG_CODES,
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

	it("classifies a log line by allow-listed code only", () => {
		expect(classifyLogLine("started worker 12")).toBeNull();
		expect(classifyLogLine("42")).toBeNull();
		expect(classifyLogLine("null")).toBeNull();
		expect(classifyLogLine('{"kind":"poll_completed","title":"x"}')).toBe("poll_completed");
		expect(classifyLogLine('{"error":"rate_limited"}')).toBe("rate_limited");
		expect(classifyLogLine('{"code":"database_busy"}')).toBe("database_busy");
		// `kind` wins over `error` and `code`; an unknown `kind` falls through to the next key.
		expect(classifyLogLine('{"kind":"warn","error":"timeout"}')).toBe("warn");
		expect(classifyLogLine('{"kind":"custom","code":"timeout"}')).toBe("timeout");
		expect(classifyLogLine('{"error":"Token expired for owner@example.test"}')).toBe("other");
		expect(classifyLogLine('{"code":503}')).toBe("other");
		expect(classifyLogLine('{"message":"hello"}')).toBe("other");
		expect(classifyLogLine('["error"]')).toBe("other");
		for (const code of SERVICE_LOG_CODES) expect(classifyLogLine(JSON.stringify({ code }))).toBe(code);
	});
});

describe("service health", () => {
	it("reports each label with the newest log's stream, time and code, and no log text or probe output", () => {
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
				lastLog: { stream: "stderr", modifiedAt: "2026-10-17T11:00:00.000Z", code: null },
			},
		});
		expect(tiles["com.flow-harness.meeting-fathom-poll"]).toMatchObject({ state: "missing", reason: "not_loaded" });
		expect(tiles["org.harnessy.meeting-publication"]).toMatchObject({ state: "error", reason: "probe_failed" });
		expect(JSON.stringify(tiles)).not.toContain(SECRET);

		utimesSync(join(logs, `${label}.out.log`), new Date("2026-10-17T11:30:00Z"), new Date("2026-10-17T11:30:00Z"));
		expect(readServiceHealth([label], probe, { homeRoot: home, now: NOW })[label]?.data?.lastLog).toEqual({
			stream: "stdout",
			modifiedAt: "2026-10-17T11:30:00.000Z",
			code: null,
		});
	});

	it("never returns any text from a hostile log line", () => {
		const home = tempHome("health-hostile");
		const label = "org.harnessy.portal";
		const title = "Board meeting: Acme acquisition terms";
		const path = "/Users/someone/Private/meetings/2026-10-16-acme.md";
		const email = "founder@example.test";
		// Token-shaped, assembled at run time so the repository secret scanner does not match the source.
		const token = ["gh", "p_", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("");
		const lines = [
			`published "${title}" from ${path} for ${email} with ${token}`,
			JSON.stringify({ kind: title, error: `${email} ${token}`, code: path, title, path, email, token }),
			JSON.stringify({ error: "authentication", title, path, email, token }),
		];
		const expected = [null, "other", "authentication"];
		const logs = join(home, "logs");
		mkdirSync(logs);
		for (const [index, line] of lines.entries()) {
			writeFileSync(join(logs, `${label}.err.log`), `${line}\n`);
			const tiles = readServiceHealth(
				[label],
				() => ({ status: 0, stdout: launchctlPrint(home, label), stderr: "" }),
				{
					homeRoot: home,
					now: NOW,
				},
			);
			expect(tiles[label]?.data?.lastLog).toMatchObject({ stream: "stderr", code: expected[index] });
			expect(Value.Check(PortalSchemas.ServiceHealthSummary, tiles)).toBe(true);
			const serialized = JSON.stringify(tiles);
			for (const value of [title, "Acme", path, "Private", email, "founder", token, "AbCdEfGh", SECRET])
				expect(serialized).not.toContain(value);
		}
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
			lastLog: null,
		});
		expect(
			readServiceHealth([label], () => ({ status: 0, stdout: `x = {\n\tstate = waiting\n}\n`, stderr: "" }), {
				homeRoot: home,
			})[label]?.data?.lastLog,
		).toBeNull();
		// A directory symlink inside home that points outside it does not widen the boundary.
		symlinkSync(outside, join(home, "linked-dir"));
		expect(read(join(home, "linked-dir", "out.log"), join(home, "absent-dir", "err.log"))?.data?.lastLog).toBeNull();
		writeFileSync(join(home, "empty.log"), "\n\n");
		expect(read(join(home, "empty.log"), join(home, "missing.log"))?.data?.lastLog).toBeNull();
		writeFileSync(join(home, "long.log"), `${"a".repeat(5_000)}\n{"error":"timeout","pad":"${"b".repeat(500)}"}\n`);
		expect(read(join(home, "long.log"), join(home, "missing.log"))?.data?.lastLog?.code).toBe("timeout");
		// A JSON line cut by the 4 KiB tail is not JSON, so it gives no code.
		writeFileSync(join(home, "cut.log"), `{"error":"timeout","pad":"${"c".repeat(5_000)}"}`);
		expect(read(join(home, "cut.log"), join(home, "missing.log"))?.data?.lastLog).toMatchObject({ code: null });
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
