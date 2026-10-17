/** `harnessy-portal` commands, run in-process against a real server and real state files. */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { checkPortalValue, PortalApiSchemas } from "@harnessy/core/read-model";
import { afterEach, describe, expect, it } from "vitest";

import { type PortalCommandIo, runPortalCommand } from "../src/portal/command.ts";
import type { PortalServer } from "../src/portal/server.ts";
import {
	PORTAL_TOKEN_FILE,
	PortalStateError,
	preparePortalStateDir,
	readOrCreatePortalInstallToken,
} from "../src/portal/token-store.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { rawRequest } from "./support/portal-http.ts";

const servers: PortalServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	cleanupPortalFixtures();
});

const io = (homeDir: string, env: NodeJS.ProcessEnv = {}) => {
	const output: string[] = [];
	const opened: string[] = [];
	const value: PortalCommandIo = {
		env,
		homeDir,
		write: (text) => output.push(text),
		version: "0.0.3",
		cliPath: "/opt/harnessy/node_modules/@harnessy/local-host/dist/portal-cli.js",
		nodePath: "/opt/node/bin/node",
		probe: () => "unsupported",
		openUrl: (url) => opened.push(url),
	};
	return { io: value, output, opened };
};

const failure = async (run: Promise<unknown>): Promise<string> => {
	try {
		await run;
	} catch (error) {
		return error instanceof PortalStateError ? error.code : String(error);
	}
	return "no failure";
};

const serve = async (home: string, stateDir: string, env: NodeJS.ProcessEnv = {}) => {
	const harness = io(home, env);
	const result = await runPortalCommand(
		["serve", "--port", "0", "--state-dir", stateDir, "--home-root", home, "--host", "127.0.0.1"],
		harness.io,
	);
	if (result.kind !== "serving") throw new Error("expected a server");
	servers.push(result.server);
	return { ...harness, server: result.server };
};

describe("harnessy-portal commands", () => {
	it("serve creates a named state directory and token, and status reads health with that token", async () => {
		const home = tempDir("serve");
		const stateDir = join(tempDir("state"), "portal");
		const served = await serve(home, stateDir);
		expect(readFileSync(join(stateDir, PORTAL_TOKEN_FILE), "utf8")).toMatch(/^[A-Za-z0-9_-]{43}\n$/u);
		expect(JSON.parse(served.output[0]!)).toEqual({ kind: "ready", port: served.server.port });
		const healthz = await rawRequest(served.server.port, { path: "/v1/healthz" });
		expect(healthz.json).toEqual({ ok: true, version: "0.0.3", schemaVersion: 1 });

		const status = io(home);
		await runPortalCommand(["status", "--port", String(served.server.port), "--state-dir", stateDir], status.io);
		const printed = JSON.parse(status.output.join("")) as { ok: boolean; health: unknown; healthz: unknown };
		expect(printed.ok).toBe(true);
		expect(printed.healthz).toEqual(healthz.json);
		expect(checkPortalValue(PortalApiSchemas.Health, printed.health)).toBe(true);
		const token = readFileSync(join(stateDir, PORTAL_TOKEN_FILE), "utf8").trim();
		expect(status.output.join("")).not.toContain(token);
	});

	it("open mints a one-time code into a URL fragment, printed or handed to the opener", async () => {
		const home = tempDir("open");
		const stateDir = join(tempDir("state"), "portal");
		const served = await serve(home, stateDir);
		const port = String(served.server.port);
		const printed = io(home, { HARNESSY_PORTAL_STATE_DIR: stateDir });
		await runPortalCommand(["open", "--port", port, "--print"], printed.io);
		const url = printed.output.join("").trim();
		expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#code=[A-Za-z0-9_-]{43}$`, "u"));
		const exchanged = await rawRequest(served.server.port, {
			method: "POST",
			path: "/v1/session/exchange",
			headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
			body: JSON.stringify({ code: url.split("#code=")[1] }),
		});
		expect(exchanged.status).toBe(200);
		const opened = io(home);
		await runPortalCommand(["open", "--port", port, "--state-dir", stateDir], opened.io);
		expect(opened.opened).toHaveLength(1);
		expect(opened.output).toEqual([]);
	});

	it("service-plan prints the LaunchAgent and creates nothing", async () => {
		const home = tempDir("plan");
		const plan = io(home);
		await runPortalCommand(["service-plan", "--port", "8791"], plan.io);
		const plist = plan.output.join("");
		const stateDir = join(home, ".harnessy", "portal");
		expect(plist).toContain("<key>Label</key><string>org.harnessy.portal</string>");
		expect(plist).toContain(
			[
				"<string>/opt/node/bin/node</string>",
				"<string>/opt/harnessy/node_modules/@harnessy/local-host/dist/portal-cli.js</string>",
				"<string>serve</string>",
				"<string>--port</string>",
				"<string>8791</string>",
				"<string>--state-dir</string>",
				`<string>${stateDir}</string>`,
			].join("\n"),
		);
		expect(plist).toContain("<key>KeepAlive</key><true/>");
		expect(plist).toContain("<key>RunAtLoad</key><true/>");
		expect(plist).toContain(`<key>StandardOutPath</key><string>${join(stateDir, "logs", "stdout.log")}</string>`);
		expect(existsSync(join(home, ".harnessy"))).toBe(false);
		const escaped = io(home);
		await runPortalCommand(["service-plan", "--state-dir", "/tmp/a&b<c>"], escaped.io);
		expect(escaped.output.join("")).toContain("<string>/tmp/a&amp;b&lt;c&gt;</string>");
	});

	it("never creates the default state directory and refuses unsafe arguments", async () => {
		const home = tempDir("refusals");
		const { io: commandIo } = io(home);
		const cases: ReadonlyArray<[ReadonlyArray<string>, string]> = [
			[["serve", "--port", "0"], "state_dir_missing"],
			[["serve", "--host", "0.0.0.0", "--state-dir", join(home, "s")], "host_refused"],
			[["serve", "--port", "70000", "--state-dir", join(home, "s")], "invalid_port"],
			[["serve", "--state-dir", "relative/portal"], "path_not_absolute"],
			[["serve", "--state-dir", join(home, "s"), "--home-root", "relative"], "path_not_absolute"],
			[["status", "--port", "0"], "invalid_port"],
			[["status", "--port", "http"], "invalid_port"],
			[["status", "--print"], "invalid_arguments"],
			[["status", "--unknown"], "invalid_arguments"],
			[["status", "extra"], "invalid_command"],
			[["publish"], "invalid_command"],
			[[], "invalid_command"],
			[["status", "--port", "8790"], "state_dir_missing"],
		];
		for (const [args, expected] of cases)
			expect([args.join(" "), await failure(runPortalCommand(args, commandIo))]).toEqual([args.join(" "), expected]);
		expect(existsSync(join(home, ".harnessy"))).toBe(false);
	});

	it("reports an unreachable portal and a token the portal does not know", async () => {
		const home = tempDir("unreachable");
		const stateDir = join(tempDir("state"), "portal");
		const served = await serve(home, stateDir);
		const port = served.server.port;
		const otherState = join(tempDir("other"), "portal");
		const other = io(home);
		// A second state directory has its own token, which this portal does not accept.
		const second = await runPortalCommand(["serve", "--port", "0", "--state-dir", otherState], other.io);
		if (second.kind === "serving") servers.push(second.server);
		expect(
			await failure(runPortalCommand(["status", "--port", String(port), "--state-dir", otherState], other.io)),
		).toBe("portal_unauthorized");
		await served.server.close();
		servers.splice(servers.indexOf(served.server), 1);
		expect(
			await failure(runPortalCommand(["status", "--port", String(port), "--state-dir", stateDir], other.io)),
		).toBe("portal_unreachable");
	});
});

describe("harnessy-portal client errors", () => {
	const listen = async (handler: Parameters<typeof createServer>[1]): Promise<Server> => {
		const server = createServer(handler);
		await new Promise<void>((ready) => server.listen({ host: "127.0.0.1", port: 0 }, ready));
		return server;
	};

	it("reports a failed request, a response that is not JSON and a request that times out", async () => {
		const home = tempDir("client");
		const stateDir = preparePortalStateDir(join(tempDir("state"), "portal"), { create: true });
		readOrCreatePortalInstallToken(stateDir);
		const responders: ReadonlyArray<[Parameters<typeof createServer>[1], string]> = [
			[(_request, response) => response.writeHead(500).end('{"error":"internal_error"}'), "portal_request_failed"],
			[(_request, response) => response.writeHead(200).end("<html>"), "portal_response_invalid"],
			[
				(_request, response) =>
					response.writeHead(200).end(JSON.stringify({ padding: "z".repeat(1024 * 1024 + 10) })),
				"portal_response_invalid",
			],
			[() => undefined, "portal_unreachable"],
		];
		for (const [handler, expected] of responders) {
			const server = await listen(handler);
			const port = String((server.address() as { port: number }).port);
			const { io: commandIo } = io(home);
			try {
				expect(
					await failure(
						runPortalCommand(["status", "--port", port, "--state-dir", stateDir], {
							...commandIo,
							requestTimeoutMs: 100,
						}),
					),
				).toBe(expected);
			} finally {
				server.closeAllConnections();
				await new Promise<void>((closed) => server.close(() => closed()));
			}
		}
	});
});
