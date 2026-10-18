/**
 * Writer-shape regression: the real `portal-cli serve` runs as a child process
 * with a recorder that logs every spawn and file open. The test calls every
 * route the child's own OpenAPI document lists, so a new route is covered
 * automatically. No writer-shaped process is ever started: the assertion's
 * ability to catch one is shown with synthetic records only.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PORTAL_SERVICE_LABEL, PORTAL_SERVICE_LABELS } from "@harnessy/core/read-model";
import { afterEach, describe, expect, it } from "vitest";

import {
	COMMUNITY_GUARD_LABELS,
	isCommunityCompatibilityWriterCommand,
} from "../../harnessy-core/src/jarvis/community-briefing/operational-runtime.ts";
import {
	isMeetingPublicationV1WriterCommand,
	MEETING_V1_LABELS,
} from "../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import { renderPortalLaunchAgent } from "../src/portal/launchd-plan.ts";
import { PORTAL_PAGE_SCRIPTS } from "../src/portal/page-assets.ts";
import { PORTAL_TOKEN_FILE } from "../src/portal/token-store.ts";
import { buildPortalHome, CANARY, cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const recorder = fileURLToPath(new URL("./support/portal-recorder.mjs", import.meta.url));
const coreSource = fileURLToPath(new URL("../../harnessy-core/src", import.meta.url));
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	cleanupPortalFixtures();
});

const PORTAL_PAGE_PATHS = ["/", "/app.css", ...PORTAL_PAGE_SCRIPTS.map((name) => `/${name}.js`)];

type RecordEntry = { kind: "spawn"; file: string; args: string[] } | { kind: "open"; path: string };

const LAUNCHCTL_PRINT = new RegExp(
	`^/bin/launchctl print gui/\\d+/(?:${PORTAL_SERVICE_LABELS.map((label) => label.replaceAll(".", "\\.")).join("|")})$`,
	"u",
);

const isWriterShaped = (commandLine: string): boolean =>
	isCommunityCompatibilityWriterCommand(commandLine) || isMeetingPublicationV1WriterCommand(commandLine);

/** Every spawn is an allow-listed launchd read; no opened path is another service's secret. */
const assertNonWriterRecords = (records: ReadonlyArray<RecordEntry>, canaries: ReadonlyArray<string>): void => {
	for (const entry of records) {
		if (entry.kind === "spawn") {
			const commandLine = [entry.file, ...entry.args].join(" ");
			if (isWriterShaped(commandLine)) throw new Error(`writer-shaped spawn: ${commandLine}`);
			if (!LAUNCHCTL_PRINT.test(commandLine)) throw new Error(`spawn outside the allowlist: ${commandLine}`);
		} else if (canaries.includes(entry.path) || entry.path.includes(CANARY)) {
			throw new Error(`opened a secret file: ${entry.path}`);
		}
	}
};

const readRecords = (path: string): RecordEntry[] =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as RecordEntry);

const startChild = async (home: string, stateDir: string, log: string) => {
	const child = spawn(
		process.execPath,
		[
			"--no-warnings",
			"--import",
			recorder,
			join(packageRoot, "src", "portal-cli.ts"),
			"serve",
			"--port",
			"0",
			"--state-dir",
			stateDir,
			"--home-root",
			home,
		],
		{
			cwd: packageRoot,
			env: {
				// Never reach the OS keychain from a test child.
				PI_AUTH_ENCRYPTION: "off",
				HOME: home,
				PATH: process.env.PATH,
				USER: "owner",
				PORTAL_RECORDER_LOG: log,
				// launchctl is answered by the recorder, so no live launchd state is read.
				PORTAL_RECORDER_STUB_LAUNCHCTL: "1",
				PORTAL_RECORDER_CORE_SOURCE: coreSource,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	children.push(child);
	const port = await new Promise<number>((ready, failed) => {
		let output = "";
		const timer = setTimeout(() => failed(new Error(`portal did not start: ${output}`)), 20_000);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += String(chunk);
			const match = /\{"kind":"ready","port":(\d+)\}/u.exec(output);
			if (match !== null) {
				clearTimeout(timer);
				ready(Number(match[1]));
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			output += String(chunk);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			failed(new Error(`portal exited ${code}: ${output}`));
		});
	});
	return { child, port };
};

describe("portal non-writer regression", () => {
	it("spawns only allow-listed launchd reads and opens no secret file across every documented route and page file", async () => {
		const fixture = await buildPortalHome("non-writer");
		const stateDir = join(tempDir("state"), "portal");
		const log = join(tempDir("recorder"), "records.jsonl");
		const { child, port } = await startChild(fixture.home, stateDir, log);
		const token = readFileSync(join(stateDir, PORTAL_TOKEN_FILE), "utf8").trim();

		const openApi = await rawRequest(port, { path: "/v1/openapi.json" });
		const paths = (openApi.json as { paths: Record<string, Record<string, unknown>> }).paths;
		const called: string[] = [];
		let code = "";
		// Session routes first, so the exchange has a fresh code.
		const operations = Object.entries(paths)
			.flatMap(([path, methods]) => Object.keys(methods).map((method) => [method.toUpperCase(), path] as const))
			.sort(([, a], [, b]) => Number(b === "/v1/session/code") - Number(a === "/v1/session/code"));
		for (const [method, path] of operations) {
			const response =
				path === "/v1/session/exchange"
					? await rawRequest(port, {
							method,
							path,
							headers: { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
							body: JSON.stringify({ code }),
						})
					: await rawRequest(port, {
							method,
							path,
							...(path === "/v1/session/challenge"
								? {
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify({ nonce: "n".repeat(43) }),
									}
								: { headers: await installProof(port, token, method, path) }),
						});
			expect([method, path, response.status]).toEqual([method, path, 200]);
			expect(response.text).not.toContain(CANARY);
			if (path === "/v1/session/code") code = (response.json as { code: string }).code;
			called.push(`${method} ${path}`);
		}
		expect(called).toHaveLength(12);
		// The page files are served from memory: they spawn nothing and open nothing per request.
		for (const path of PORTAL_PAGE_PATHS) {
			const response = await rawRequest(port, { path });
			expect([path, response.status]).toEqual([path, 200]);
			expect(response.text).not.toContain(CANARY);
		}
		const health = await rawRequest(port, {
			path: "/v1/health",
			headers: await installProof(port, token, "GET", "/v1/health"),
		});
		// Every probe got the recorder's "not found" answer: the live launchd jobs were never read.
		const reasons = Object.values((health.json as { tiles: Record<string, { reason?: string }> }).tiles).map(
			(tile) => tile.reason,
		);
		expect(new Set(reasons)).toEqual(new Set([process.platform === "darwin" ? "not_loaded" : "platform"]));

		const ps = spawnSync("/bin/ps", ["-p", String(child.pid), "-o", "command="], { encoding: "utf8" });
		expect(ps.status).toBe(0);
		expect(ps.stdout).toContain("portal-cli.ts serve");
		expect(isWriterShaped(ps.stdout.trim())).toBe(false);

		await new Promise<void>((exited) => {
			child.once("exit", () => exited());
			child.kill("SIGTERM");
		});
		const records = readRecords(log);
		const canaries = fixture.canaries.map((path) => realpathSync(path));
		expect(() => assertNonWriterRecords(records, canaries)).not.toThrow();
		const spawns = records.filter((entry) => entry.kind === "spawn");
		// The health route probes each fixed label once (answered by the recorder, never run); elsewhere
		// launchd does not exist and nothing spawns.
		expect(spawns).toHaveLength(process.platform === "darwin" ? PORTAL_SERVICE_LABELS.length : 0);
		// The recorder did see file opens, so an empty spawn list is not a recorder failure.
		expect(records.some((entry) => entry.kind === "open" && entry.path.includes("config.yaml"))).toBe(true);
	});

	it("catches a writer-shaped spawn, an unlisted spawn and a secret read in synthetic records", () => {
		const canary = "/home/owner/state/review.token";
		const cases: ReadonlyArray<[RecordEntry, RegExp]> = [
			[
				{
					kind: "spawn",
					file: "/usr/bin/node",
					args: [
						"/opt/harnessy/node_modules/@harnessy/core/dist/cli.js",
						"jarvis",
						"community",
						"briefing",
						"review",
						"serve",
					],
				},
				/writer-shaped/u,
			],
			[{ kind: "spawn", file: "jarvis", args: ["meeting", "publish", "worker"] }, /writer-shaped/u],
			[{ kind: "spawn", file: "/bin/launchctl", args: ["bootout", "gui/501/org.harnessy.portal"] }, /allowlist/u],
			[{ kind: "spawn", file: "/bin/launchctl", args: ["print", "gui/501/com.example.other"] }, /allowlist/u],
			[{ kind: "open", path: canary }, /secret/u],
		];
		for (const [entry, message] of cases) expect(() => assertNonWriterRecords([entry], [canary])).toThrow(message);
		expect(() =>
			assertNonWriterRecords(
				[{ kind: "spawn", file: "/bin/launchctl", args: ["print", `gui/501/${PORTAL_SERVICE_LABEL}`] }],
				[canary],
			),
		).not.toThrow();
	});

	it("is absent from both one-writer guard label lists, and its launch argv matches neither guard", () => {
		expect(COMMUNITY_GUARD_LABELS).not.toContain(PORTAL_SERVICE_LABEL);
		expect(MEETING_V1_LABELS).not.toContain(PORTAL_SERVICE_LABEL);
		const plist = renderPortalLaunchAgent({
			nodePath: "/opt/node/bin/node",
			cliPath: "/opt/harnessy/node_modules/@harnessy/local-host/dist/portal-cli.js",
			port: 8790,
			stateDir: "/Users/owner/.harnessy/portal",
		});
		const programArguments = [...plist.matchAll(/<string>([^<]*)<\/string>/gu)].map((match) => match[1]).slice(1, 8);
		for (const commandLine of [
			programArguments.join(" "),
			"/opt/node/bin/node /opt/harnessy/node_modules/@harnessy/core/dist/cli.js portal serve --port 8790",
			"/opt/node/bin/node /opt/harnessy/node_modules/@harnessy/local-host/dist/portal-cli.js status",
		])
			expect([commandLine, isWriterShaped(commandLine)]).toEqual([commandLine, false]);
	});
});
