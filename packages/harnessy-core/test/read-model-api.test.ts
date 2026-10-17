/** The portal API contract (response schemas) and the read-only meeting configuration loader. */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { portalHostArgs } from "../src/cli/portal.ts";
import { rootCommand } from "../src/commands.ts";
import * as core from "../src/index.ts";
import {
	checkPortalValue,
	PortalApiSchemas,
	portalResponseSchemaId,
	readMeetingPublicationConfig,
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
