/** The portal API contract (response schemas) and the read-only meeting configuration loader. */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { portalCommand, portalHostArgs, runPortalHost } from "../src/cli/portal.ts";
import { rootCommand } from "../src/commands.ts";
import * as core from "../src/index.ts";
import {
	checkPortalValue,
	PortalApiSchemas,
	portalResponseSchemaId,
	readMeetingPublicationConfig,
	repairPortalTiles,
} from "../src/read-model.ts";
import { cleanupReadModelFixtures, tempHome, treeListing } from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T12:00:00.000Z");
const at = NOW.toISOString();

describe("portal API schemas", () => {
	it("are closed JSON Schema objects, checked with the TypeBox version that built them", () => {
		const encoded = JSON.parse(JSON.stringify(PortalApiSchemas)) as Record<
			string,
			{ additionalProperties?: boolean }
		>;
		for (const [name, schema] of Object.entries(encoded))
			expect([name, schema.additionalProperties]).toEqual([name, false]);
		const today = {
			schema: portalResponseSchemaId("today"),
			generatedAt: at,
			tiles: {
				readings: { state: "missing", reason: "database_missing", readAt: at },
				brief: { state: "missing", reason: "file_missing", readAt: at },
				latestPreview: { state: "missing", reason: "no_preview", readAt: at },
				weeklyRuns: { state: "missing", reason: "directory_missing", readAt: at },
				setup: { state: "ok", data: { steeringReady: false, compatibilityReady: true }, readAt: at },
				waiting: {
					state: "ok",
					data: {
						meetingsPendingReview: 2,
						communityPendingReview: null,
						fathomPendingInbox: 0,
						weeklyRunsDrafted: null,
					},
					readAt: at,
				},
			},
		};
		expect(checkPortalValue(PortalApiSchemas.Today, today)).toBe(true);
		expect(Value.Check(PortalApiSchemas.Today, today)).toBe(true);
		// An extra field, a wrong envelope name or a missing tile fails.
		expect(checkPortalValue(PortalApiSchemas.Today, { ...today, leaked: "x" })).toBe(false);
		expect(checkPortalValue(PortalApiSchemas.Today, { ...today, schema: portalResponseSchemaId("health") })).toBe(
			false,
		);
		const { waiting: _waiting, ...partial } = today.tiles;
		expect(checkPortalValue(PortalApiSchemas.Today, { ...today, tiles: partial })).toBe(false);
	});

	it("describe connections as status plus a hand-off, never a secret", () => {
		const connection = {
			id: "meeting.google",
			label: "Meeting publication: Google",
			owner: "meeting-publication",
			status: "attention",
			detail: "authentication",
			checkedAt: at,
			action: { kind: "link", value: "http://127.0.0.1:8770/", note: null },
		};
		expect(checkPortalValue(PortalApiSchemas.Connection, connection)).toBe(true);
		expect(checkPortalValue(PortalApiSchemas.Connection, { ...connection, status: "ok" })).toBe(false);
		expect(checkPortalValue(PortalApiSchemas.Connection, { ...connection, account: "owner@example.test" })).toBe(
			false,
		);
		expect(
			checkPortalValue(PortalApiSchemas.Connection, {
				...connection,
				action: { kind: "run", value: "x", note: null },
			}),
		).toBe(false);
		expect(checkPortalValue(PortalApiSchemas.SessionCode, { code: "a".repeat(43), expiresAt: at })).toBe(true);
		expect(checkPortalValue(PortalApiSchemas.SessionCode, { code: "short", expiresAt: at })).toBe(false);
		expect(checkPortalValue(PortalApiSchemas.Healthz, { ok: true, version: "0.0.3", schemaVersion: 1 })).toBe(true);
		expect(checkPortalValue(PortalApiSchemas.Error, { error: "unauthorized" })).toBe(true);
	});

	it("are exported from the package root", () => {
		for (const name of [
			"PortalApiSchemas",
			"checkPortalValue",
			"portalResponseSchemaId",
			"readMeetingPublicationConfig",
		])
			expect(core, name).toHaveProperty(name);
	});
});

describe("portal tile repair", () => {
	const connections = (meeting: unknown) => ({
		schema: portalResponseSchemaId("connections"),
		generatedAt: at,
		tiles: {
			meeting,
			fathom: { state: "missing", reason: "file_missing", readAt: at },
			community: { state: "missing", reason: "config_missing", readAt: at },
			cockpit: { state: "ok", data: { connections: [], omitted: 0 }, readAt: at },
			googleWorkspace: { state: "ok", data: { connections: [], omitted: 0 }, readAt: at },
			codex: { state: "ok", data: { connections: [], omitted: 0 }, readAt: at },
		},
	});
	const row = (checkedAt: string) => ({
		id: "meeting.google",
		label: "Meeting publication: Google",
		owner: "meeting-publication",
		status: "connected",
		detail: null,
		checkedAt,
		action: null,
	});

	it("keeps a valid response as it is", () => {
		const value = connections({ state: "ok", data: { connections: [row(at)], omitted: 0 }, readAt: at });
		expect(repairPortalTiles(PortalApiSchemas.Connections, value)).toEqual({ value, replaced: [] });
	});

	it("degrades only the tile that fails its own schema", () => {
		const value = connections({ state: "ok", data: { connections: [row("x".repeat(41))], omitted: 0 }, readAt: at });
		expect(checkPortalValue(PortalApiSchemas.Connections, value)).toBe(false);
		const repaired = repairPortalTiles(PortalApiSchemas.Connections, value);
		expect(repaired?.replaced).toEqual(["meeting"]);
		expect(repaired?.value).toEqual({
			...value,
			tiles: { ...value.tiles, meeting: { state: "error", reason: "tile_invalid", readAt: at } },
		});
		expect(checkPortalValue(PortalApiSchemas.Connections, repaired?.value)).toBe(true);
	});

	it("degrades one service in the health record", () => {
		const health = {
			schema: portalResponseSchemaId("health"),
			generatedAt: at,
			tiles: {
				good: { state: "missing", reason: "not_loaded", readAt: at },
				bad: { state: "ok", data: { unexpected: true }, readAt: at },
			},
		};
		const repaired = repairPortalTiles(PortalApiSchemas.Health, health);
		expect(repaired?.replaced).toEqual(["bad"]);
		expect(checkPortalValue(PortalApiSchemas.Health, repaired?.value)).toBe(true);
	});

	it("gives up when the envelope itself is wrong or the schema has no tiles", () => {
		const value = connections({ state: "missing", reason: "config_missing", readAt: at });
		expect(repairPortalTiles(PortalApiSchemas.Connections, { ...value, schema: "other" })).toBeUndefined();
		expect(
			repairPortalTiles(PortalApiSchemas.Connections, { ...value, tiles: { ...value.tiles, leaked: {} } }),
		).toBeUndefined();
		expect(repairPortalTiles(PortalApiSchemas.Healthz, value)).toBeUndefined();
		const open = Type.Object({ schema: Type.String(), generatedAt: Type.String(), tiles: Type.Number() });
		expect(repairPortalTiles(open, value)).toBeUndefined();
	});
});

describe("meeting publication configuration", () => {
	const write = (home: string, text: string) => {
		mkdirSync(join(home, ".jarvis"), { recursive: true });
		writeFileSync(join(home, ".jarvis", "config.yaml"), text);
	};

	it("resolves the meeting section with defaults and JARVIS_ overrides, and creates nothing", () => {
		const home = tempHome("meeting-config");
		write(home, "meeting_publication:\n  enabled: true\n  state_path: /srv/state\n  review_port: 8771\n");
		const tree = treeListing(home);
		const tile = readMeetingPublicationConfig({ homeRoot: home, now: NOW });
		expect(tile.state).toBe("ok");
		expect(tile.data).toMatchObject({
			enabled: true,
			statePath: "/srv/state",
			reviewHost: "127.0.0.1",
			reviewPort: 8771,
		});
		const overridden = readMeetingPublicationConfig({
			configPath: join(home, ".jarvis", "config.yaml"),
			env: { JARVIS_MEETING_PUBLICATION__REVIEW_PORT: "8775", OTHER: "ignored", UNSET: undefined },
			now: NOW,
		});
		expect(overridden.data?.reviewPort).toBe(8775);
		expect(treeListing(home)).toEqual(tree);
		write(home, "");
		expect(readMeetingPublicationConfig({ homeRoot: home, now: NOW }).data).toMatchObject({
			enabled: false,
			statePath: null,
		});
	});

	it("returns absolute source and state paths, expanding `~` against homeRoot rather than HOME", () => {
		const home = tempHome("meeting-config-tilde");
		write(home, "meeting_publication:\n  source_path: ~/notes\n  state_path: ~/.jarvis/state/meeting-publication\n");
		const previous = process.env.HOME;
		process.env.HOME = tempHome("meeting-config-other-home");
		try {
			expect(readMeetingPublicationConfig({ homeRoot: home, now: NOW }).data).toMatchObject({
				sourcePath: join(home, "notes"),
				statePath: join(home, ".jarvis", "state", "meeting-publication"),
			});
			write(home, "meeting_publication:\n  source_path: '~'\n  state_path: state/../meeting\n");
			expect(readMeetingPublicationConfig({ homeRoot: home, now: NOW }).data).toMatchObject({
				sourcePath: home,
				statePath: join(home, ".jarvis", "meeting"),
			});
		} finally {
			process.env.HOME = previous;
		}
	});

	it("defaults to the configuration under the home directory", () => {
		const home = tempHome("meeting-config-home");
		write(home, "meeting_publication:\n  enabled: true\n");
		const previous = process.env.HOME;
		process.env.HOME = home;
		try {
			expect(readMeetingPublicationConfig({ now: NOW }).data?.enabled).toBe(true);
		} finally {
			process.env.HOME = previous;
		}
	});

	it("reports a missing, invalid or unsafe configuration as a tile with a fixed reason", () => {
		const home = tempHome("meeting-config-bad");
		expect(readMeetingPublicationConfig({ homeRoot: home, now: NOW })).toEqual({
			state: "missing",
			reason: "config_missing",
			readAt: at,
		});
		write(home, "meeting_publication: [\n");
		expect(readMeetingPublicationConfig({ homeRoot: home, now: NOW })).toMatchObject({
			state: "error",
			reason: "config_invalid",
		});
		write(home, "meeting_publication:\n  review_port: not-a-port\n");
		expect(readMeetingPublicationConfig({ homeRoot: home, now: NOW })).toMatchObject({
			state: "error",
			reason: "config_invalid",
		});
		write(home, "meeting_publication:\n  enabled: true\n");
		expect(
			readMeetingPublicationConfig({
				homeRoot: home,
				env: { JARVIS_MEETING_PUBLICATION__REVIEW_HOST: "192.0.2.10" },
				now: NOW,
			}),
		).toMatchObject({ state: "error", reason: "environment_invalid" });
		write(home, `# ${"x".repeat(1024 * 1024)}\n`);
		expect(readMeetingPublicationConfig({ homeRoot: home, now: NOW })).toMatchObject({
			state: "unsafe",
			reason: "file_oversize",
		});
		const fifoHome = tempHome("meeting-config-fifo");
		mkdirSync(join(fifoHome, ".jarvis"));
		execFileSync("mkfifo", [join(fifoHome, ".jarvis", "config.yaml")]);
		expect(readMeetingPublicationConfig({ homeRoot: fifoHome, now: NOW })).toMatchObject({
			state: "unsafe",
			reason: "file_not_regular",
		});
	});
});

describe("harnessy portal", () => {
	it("is a root subcommand that forwards only the options that are set", () => {
		expect(rootCommand.subcommands.flatMap((group) => group.commands.map((command) => command.name))).toContain(
			"portal",
		);
		expect(
			portalHostArgs("serve", {
				port: Option.some("8791"),
				"state-dir": Option.none(),
				"home-root": Option.some("/home/owner"),
			}),
		).toEqual(["serve", "--port", "8791", "--home-root", "/home/owner"]);
		expect(portalHostArgs("open", { print: true, port: Option.none() })).toEqual(["open", "--print"]);
		expect(portalHostArgs("open", { print: false })).toEqual(["open"]);
	});
});

describe("portal host forwarding", () => {
	const hostScript = (name: string, body: string) => {
		const home = tempHome(name);
		const script = join(home, "host.mjs");
		writeFileSync(script, body);
		return { home, script };
	};

	it("runs the host as a child with the forwarded argv and returns its exit code", async () => {
		const { home, script } = hostScript(
			"portal-forward",
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join("HOME_DIR", "argv.json"))}.replace("HOME_DIR", process.argv[3]), JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n`,
		);
		const signals = new EventEmitter();
		const code = await runPortalHost(["service-plan", home], { resolveHost: () => script, signals });
		expect(code).toBe(3);
		expect(JSON.parse(readFileSync(join(home, "argv.json"), "utf8"))).toEqual(["service-plan", home]);
		expect([signals.listenerCount("SIGINT"), signals.listenerCount("SIGTERM")]).toEqual([0, 0]);
	});

	it("stops the host on SIGTERM and reports a signal exit as 1", async () => {
		const { script } = hostScript("portal-forward-signal", "setInterval(() => undefined, 1000);\n");
		const signals = new EventEmitter();
		const running = runPortalHost(["serve"], { resolveHost: () => script, signals });
		signals.emit("SIGTERM");
		await expect(running).resolves.toBe(1);
		expect(signals.listenerCount("SIGINT")).toBe(0);
	});

	it("refuses to run when the host package is not installed", async () => {
		await expect(
			runPortalHost(["status"], {
				resolveHost: () => {
					throw new Error("Cannot find module '@harnessy/local-host/portal-cli'");
				},
			}),
		).rejects.toThrow("requires the V2 @harnessy/local-host package");
	});
});

describe("harnessy portal through the installed host", () => {
	// The workspace links `@harnessy/local-host`; CI builds its `dist/portal-cli.js` before the tests run.
	const run = (args: ReadonlyArray<string>) =>
		Effect.runPromiseExit(
			Command.runWith(portalCommand, { version: "0.0.0-test" })(args).pipe(Effect.provide(NodeServices.layer)),
		);

	it("prints the LaunchAgent plan through the real host and installs nothing", async () => {
		const home = tempHome("portal-plan");
		const tree = treeListing(home);
		const exit = await run(["service-plan", "--state-dir", join(home, "state"), "--port", "8799"]);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(treeListing(home)).toEqual(tree);
	});

	it("fails when the host exits with an error, for every subcommand", async () => {
		const state = join(tempHome("portal-bad-port"), "state");
		for (const args of [
			["service-plan", "--port", "not-a-port"],
			["serve", "--port", "not-a-port", "--state-dir", state, "--home-root", state, "--workspace-root", state],
			["status", "--port", "not-a-port", "--state-dir", state],
			["open", "--print", "--port", "not-a-port", "--state-dir", state],
		]) {
			const exit = await run(args);
			expect([args[0], Exit.isFailure(exit)]).toEqual([args[0], true]);
			expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("Portal host exited");
		}
	});
});
