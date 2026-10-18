/**
 * Portal sources over real fixtures: databases built with the writer code,
 * then read 50 times through the server to prove nothing changes on disk.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { checkPortalValue, PortalApiSchemas } from "@harnessy/core/read-model";
import { afterEach, describe, expect, it } from "vitest";

import {
	checkedAtOf,
	MAX_CONNECTIONS,
	MAX_GWS_PROFILES,
	MEETING_RECONNECT_NOTE,
	meetingConnections,
} from "../src/portal/connections.ts";
import { PORTAL_ROUTES } from "../src/portal/routes.ts";
import { type PortalServer, startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import {
	buildPortalHome,
	CANARY,
	cleanupPortalFixtures,
	FIXTURE_NOW,
	fileFingerprint,
	tempDir,
	treeListing,
} from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

const servers: PortalServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	cleanupPortalFixtures();
});

const sourcesFor = (homeRoot: string, env: NodeJS.ProcessEnv = {}) =>
	createPortalSources({ homeRoot, env, probe: () => "unsupported", timeoutMs: 250, clock: () => FIXTURE_NOW });

type Tiles = Record<string, { state: string; reason?: string; data?: unknown }>;

describe("portal sources", () => {
	it("leave every database byte, inode and sidecar unchanged and create nothing over 50 reads of every route", async () => {
		const fixture = await buildPortalHome("read-only");
		const databases = Object.values(fixture.databases);
		const before = databases.map(fileFingerprint);
		const tree = treeListing(fixture.home);
		const token = newPortalSecret();
		// TTL 0: every request reads the sources again.
		const server = await startPortalServer({
			installToken: token,
			sources: sourcesFor(fixture.home),
			version: "0.0.3",
			port: 0,
			cacheTtlMs: 0,
		});
		servers.push(server);
		const routes = PORTAL_ROUTES.filter((route) => route.data !== undefined);
		for (let read = 0; read < 50; read += 1)
			for (const route of routes) {
				const response = await rawRequest(server.port, {
					path: route.path,
					headers: await installProof(server.port, token, "GET", route.path),
				});
				expect(response.status).toBe(200);
			}
		expect(databases.map(fileFingerprint)).toEqual(before);
		for (const fingerprint of before) expect(fingerprint.sidecars).toEqual([]);
		expect(treeListing(fixture.home)).toEqual(tree);
	});

	it("reads a populated home into tiles without account names or private text", async () => {
		const fixture = await buildPortalHome("populated");
		const sources = sourcesFor(fixture.home);
		const connections = sources.connections() as Tiles;
		expect(connections.meeting).toEqual({
			state: "ok",
			readAt: FIXTURE_NOW.toISOString(),
			data: {
				omitted: 0,
				connections: [
					{
						id: "meeting.google",
						label: "Meeting publication: Google",
						owner: "meeting-publication",
						status: "attention",
						detail: "authentication",
						checkedAt: FIXTURE_NOW.toISOString(),
						action: { kind: "link", value: "http://127.0.0.1:8770/", note: MEETING_RECONNECT_NOTE },
					},
					expect.objectContaining({ id: "meeting.discord", status: "unknown", detail: "not_checked" }),
				],
			},
		});
		expect((connections.fathom!.data as { connections: unknown[] }).connections).toEqual([
			expect.objectContaining({ id: "fathom.personal", status: "connected", detail: null }),
			expect.objectContaining({ id: "fathom.research", status: "attention", detail: "checkpoint_stale" }),
		]);
		expect((connections.community!.data as { connections: unknown[] }).connections).toEqual([
			expect.objectContaining({ id: "community.google", status: "not_tracked" }),
			expect.objectContaining({
				id: "community.discord",
				status: "not_tracked",
				detail: "configured",
				action: { kind: "link", value: "http://127.0.0.1:8872/", note: null },
			}),
		]);
		expect(
			(connections.googleWorkspace!.data as { connections: Array<{ id: string }> }).connections.map((c) => c.id),
		).toEqual(["gws.flow", "gws.personal"]);
		expect(connections.codex!.data).toMatchObject({
			connections: [{ status: "unknown", detail: "auth_file_present" }],
		});
		expect(connections.cockpit!.data).toMatchObject({
			connections: [{ detail: "held_by_cockpit", action: { kind: "command", value: "harnessy web" } }],
		});
		expect((sources.learning() as Tiles).catalog).toMatchObject({
			state: "ok",
			data: { schemaVersion: 1, sources: { processed: 0, pending: 1, failed: 1, other: 0, total: 2 }, pages: 0 },
		});
		const serialized = JSON.stringify([
			sources.today(),
			connections,
			sources.meetings(),
			sources.community(),
			sources.learning(),
			sources.workspace(),
			sources.health(),
		]);
		expect(serialized).not.toContain(CANARY);
		expect(serialized).not.toContain("owner@example.test");
	});

	it("expands `~/` config paths against the portal home root, not the process HOME", async () => {
		const fixture = await buildPortalHome("tilde");
		writeFileSync(fixture.configPath, readFileSync(fixture.configPath, "utf8").replaceAll(`${fixture.home}/`, "~/"));
		expect(readFileSync(fixture.configPath, "utf8")).toContain("state_path: ~/meeting-state");
		const previous = process.env.HOME;
		process.env.HOME = tempDir("other-home");
		try {
			const sources = sourcesFor(fixture.home);
			const meetings = sources.meetings() as Tiles;
			expect(meetings.queue).toMatchObject({ state: "ok", data: { statusCounts: { pending_review: 2 } } });
			expect(meetings.fathomInbox).toMatchObject({ state: "ok", data: { totals: { pending: 1 } } });
			expect((sources.community() as Tiles).queue).toMatchObject({ state: "ok", data: { total: 2 } });
			expect((sources.today() as Tiles).waiting).toMatchObject({
				state: "ok",
				data: { meetingsPendingReview: 2, communityPendingReview: 1, fathomPendingInbox: 1 },
			});
		} finally {
			process.env.HOME = previous;
		}
	});

	it("reports every tile of an empty home as a degraded state, not a failure", () => {
		const home = tempDir("empty");
		const sources = sourcesFor(home);
		const tree = treeListing(home);
		const today = sources.today() as Tiles;
		expect(today.readings).toMatchObject({ state: "missing", reason: "database_missing" });
		expect(today.waiting).toMatchObject({
			state: "ok",
			data: {
				meetingsPendingReview: null,
				communityPendingReview: null,
				fathomPendingInbox: null,
				weeklyRunsDrafted: null,
			},
		});
		const connections = sources.connections() as Tiles;
		expect(connections.meeting).toMatchObject({ state: "missing", reason: "config_missing" });
		expect(connections.fathom).toMatchObject({ state: "missing" });
		expect(connections.community).toMatchObject({ state: "missing", reason: "config_missing" });
		expect(connections.googleWorkspace).toMatchObject({ state: "missing", reason: "directory_missing" });
		expect(connections.codex).toMatchObject({
			state: "ok",
			data: { connections: [{ status: "not_configured", detail: "auth_file_missing" }] },
		});
		expect((sources.learning() as Tiles).catalog).toMatchObject({ state: "missing", reason: "database_missing" });
		expect((sources.workspace() as Tiles).workspace).toMatchObject({ state: "missing", reason: "workspace_missing" });
		for (const route of PORTAL_ROUTES.filter((candidate) => candidate.data !== undefined)) {
			const value = {
				schema: `harnessy.portal.${route.data!.name}.v1`,
				generatedAt: FIXTURE_NOW.toISOString(),
				tiles: sources[route.data!.source](),
			};
			expect([route.path, checkPortalValue(PortalApiSchemas[route.schema!], value)]).toEqual([route.path, true]);
		}
		expect(treeListing(home)).toEqual(tree);
	});

	it("refuses an unsafe Life config, an invalid workspace and an invalid meeting config as tiles", () => {
		const home = tempDir("unsafe");
		mkdirSync(join(home, ".agents", "life"), { recursive: true });
		execFileSync("mkfifo", [join(home, ".agents", "life", "config.json")]);
		mkdirSync(join(home, ".jarvis"));
		writeFileSync(join(home, ".jarvis", "config.yaml"), "meeting_publication: [\n");
		const today = sourcesFor(home).today() as Tiles;
		for (const tile of ["readings", "brief", "latestPreview", "weeklyRuns", "setup"])
			expect(today[tile]).toMatchObject({ state: "unsafe", reason: "life_config_unsafe" });
		expect((sourcesFor(home).meetings() as Tiles).queue).toMatchObject({ state: "error", reason: "config_invalid" });

		rmSync(join(home, ".agents", "life", "config.json"));
		const workspace = tempDir("bad-workspace");
		mkdirSync(join(workspace, ".harnessy"));
		writeFileSync(join(workspace, ".harnessy", "workspace.json"), "{ not json");
		const broken = createPortalSources({
			homeRoot: home,
			workspaceRoot: workspace,
			env: {},
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => FIXTURE_NOW,
		});
		expect((broken.today() as Tiles).readings).toMatchObject({ state: "error", reason: "life_settings_invalid" });
		expect((broken.workspace() as Tiles).workspace).toMatchObject({ state: "error", reason: "workspace_invalid" });
	});

	it("links only to a loopback review service and degrades connection tiles with their source state", async () => {
		const fixture = await buildPortalHome("links");
		const remote = (env: NodeJS.ProcessEnv) => sourcesFor(fixture.home, env).connections() as Tiles;
		// `JARVIS_*` overrides apply as the Jarvis configuration reader applies them.
		// The meeting schema allows only 127.0.0.1 and ::1; links are made for 127.0.0.1 or localhost only.
		const overridden = remote({ JARVIS_MEETING_PUBLICATION__REVIEW_HOST: "::1" });
		expect(
			(overridden.meeting!.data as { connections: Array<{ action: unknown }> }).connections.map((c) => c.action),
		).toEqual([null, null]);
		expect(remote({ JARVIS_MEETING_PUBLICATION__REVIEW_HOST: "192.0.2.10" }).meeting).toMatchObject({
			state: "error",
			reason: "environment_invalid",
		});
		expect(remote({ JARVIS_MEETING_PUBLICATION__ENABLED: "false" }).meeting).toMatchObject({
			state: "missing",
			reason: "meeting_disabled",
		});
		writeFileSync(join(fixture.home, "meeting-state", "meeting-publication.sqlite3-journal"), "");
		expect(remote({}).meeting).toMatchObject({ state: "busy" });

		writeFileSync(
			fixture.configPath,
			`community_briefing:\n  source_path: ${fixture.home}/private\n  review_host: example.test\n  review_port: 8872\n`,
		);
		const community = remote({}).community!.data as { connections: Array<{ status: string; action: unknown }> };
		expect(community.connections.map((c) => [c.status, c.action])).toEqual([
			["not_tracked", null],
			["not_configured", null],
		]);
		expect(remote({}).fathom).toMatchObject({ state: "ok", data: { connections: [] } });
	});

	it("reports never-polled Fathom accounts, many gws profiles and an unsafe Codex auth path", async () => {
		const fixture = await buildPortalHome("profiles");
		writeFileSync(
			fixture.configPath,
			"fathom:\n  default_account: personal\n  accounts:\n    personal: {}\n    fresh: {}\n",
		);
		for (let index = 0; index < MAX_GWS_PROFILES + 3; index += 1)
			mkdirSync(join(fixture.home, ".config", `gws-extra-${String(index).padStart(2, "0")}`));
		mkdirSync(join(fixture.home, ".config", "gws-.hidden"));
		rmSync(join(fixture.home, ".codex"), { recursive: true });
		mkdirSync(join(fixture.home, ".codex", "auth.json"), { recursive: true });
		const connections = sourcesFor(fixture.home).connections() as Tiles;
		expect((connections.fathom!.data as { connections: unknown[] }).connections).toEqual([
			expect.objectContaining({ id: "fathom.fresh", status: "attention", detail: "never_polled", checkedAt: null }),
			expect.objectContaining({ id: "fathom.personal", status: "connected" }),
		]);
		const gws = connections.googleWorkspace!.data as { connections: unknown[]; omitted: number };
		expect([gws.connections.length, gws.omitted]).toEqual([MAX_GWS_PROFILES, 5]);
		expect(connections.codex).toMatchObject({ state: "unsafe", reason: "file_not_regular" });
	});

	it("caps Fathom connection rows at the schema limit and counts the rest", async () => {
		const fixture = await buildPortalHome("fathom-many");
		const names = Array.from(
			{ length: MAX_CONNECTIONS + 6 },
			(_, index) => `account${String(index).padStart(2, "0")}`,
		);
		writeFileSync(
			fixture.configPath,
			`fathom:\n  default_account: account00\n  accounts:\n${names.map((name) => `    ${name}: {}`).join("\n")}\n`,
		);
		const sources = sourcesFor(fixture.home);
		const fathom = (sources.connections() as Tiles).fathom!.data as { connections: unknown[]; omitted: number };
		expect([fathom.connections.length, fathom.omitted]).toEqual([MAX_CONNECTIONS, 6]);
		const value = {
			schema: "harnessy.portal.connections.v1",
			generatedAt: FIXTURE_NOW.toISOString(),
			tiles: sources.connections(),
		};
		expect(checkPortalValue(PortalApiSchemas.Connections, value)).toBe(true);
	});

	it("degrades the Life tiles when the Life config path cannot be checked", () => {
		const home = tempDir("life-loop");
		mkdirSync(join(home, ".agents", "life"), { recursive: true });
		symlinkSync("config.json", join(home, ".agents", "life", "config.json"));
		const today = sourcesFor(home).today() as Tiles;
		expect(today.readings).toMatchObject({ state: "unsafe", reason: "life_config_unreadable" });
		expect(today.waiting).toMatchObject({ state: "ok" });
	});

	it("degrades the gws tile past the directory scan limit", () => {
		const home = tempDir("scan");
		for (let index = 0; index <= 2_000; index += 1)
			mkdirSync(join(home, ".config", `entry-${index}`), { recursive: true });
		expect((sourcesFor(home).connections() as Tiles).googleWorkspace).toMatchObject({
			state: "unsupported",
			reason: "scan_limit",
		});
	});

	it("reads the learning catalog as unsupported or uninitialized when its schema is not the one it knows", async () => {
		const fixture = await buildPortalHome("wiki-schema");
		const database = new DatabaseSync(fixture.databases.wiki);
		database.exec("PRAGMA user_version = 2");
		database.close();
		expect((sourcesFor(fixture.home).learning() as Tiles).catalog).toMatchObject({
			state: "unsupported",
			reason: "schema_newer",
		});
		const reopened = new DatabaseSync(fixture.databases.wiki);
		reopened.exec("PRAGMA user_version = 0; UPDATE sources SET status = 'archived'");
		reopened.close();
		expect((sourcesFor(fixture.home).learning() as Tiles).catalog).toMatchObject({
			state: "missing",
			reason: "catalog_uninitialized",
		});
		const counted = new DatabaseSync(fixture.databases.wiki);
		counted.exec("PRAGMA user_version = 1");
		counted.close();
		expect((sourcesFor(fixture.home).learning() as Tiles).catalog).toMatchObject({
			state: "ok",
			data: { sources: { processed: 0, pending: 0, failed: 0, other: 2, total: 2 } },
		});
	});

	it("counts nothing waiting when every queue is settled, and passes the Life user from the environment", async () => {
		const fixture = await buildPortalHome("settled");
		const meeting = new DatabaseSync(fixture.databases.meeting);
		meeting.exec("UPDATE publication_items SET status = 'published'");
		meeting.close();
		const community = new DatabaseSync(fixture.databases.community);
		community.exec("UPDATE community_briefings SET status = 'published'");
		community.close();
		const run = join(fixture.home, ".harnessy", "jarvis", "life", "reviews");
		rmSync(run, { recursive: true });
		for (const env of [{ FLOW_USER: "owner" }, { USER: "owner" }]) {
			mkdirSync(join(fixture.home, "context", "private", "owner"), { recursive: true });
			writeFileSync(join(fixture.home, "context", "private", "owner", "learning-research.md"), "steering");
			const today = sourcesFor(fixture.home, env).today() as Tiles;
			expect(today.waiting!.data).toEqual({
				meetingsPendingReview: 0,
				communityPendingReview: 0,
				fathomPendingInbox: 1,
				weeklyRunsDrafted: null,
			});
		}
		mkdirSync(run);
		expect(
			((sourcesFor(fixture.home).today() as Tiles).waiting!.data as { weeklyRunsDrafted: number }).weeklyRunsDrafted,
		).toBe(0);
	});

	it("refuses an oversize Life config and reads a symlinked gws profile by name", async () => {
		const fixture = await buildPortalHome("oversize");
		mkdirSync(join(fixture.home, ".agents", "life"), { recursive: true });
		writeFileSync(join(fixture.home, ".agents", "life", "config.json"), "x".repeat(1024 * 1024 + 1));
		expect((sourcesFor(fixture.home).today() as Tiles).readings).toMatchObject({
			state: "unsafe",
			reason: "life_config_unsafe",
		});
		symlinkSync(join(fixture.home, ".config", "gws-flow"), join(fixture.home, ".config", "gws-linked"));
		const gws = (sourcesFor(fixture.home).connections() as Tiles).googleWorkspace!.data as {
			connections: Array<{ id: string }>;
		};
		expect(gws.connections.map((connection) => connection.id)).toEqual(["gws.flow", "gws.linked", "gws.personal"]);
	});

	it("maps each provider health record to a connection status", () => {
		const at = FIXTURE_NOW.toISOString();
		const ok = <A>(data: A) => ({ state: "ok" as const, data, readAt: at });
		const summary = {
			config: ok({ enabled: true, reviewHost: "127.0.0.1", reviewPort: 8770 }),
			queue: ok({
				schemaVersion: 4,
				schemaState: "current" as const,
				totalItems: 0,
				statusCounts: {},
				failureCounts: {},
				pendingReview: [],
				pendingReviewTruncated: false,
			}),
			providers: ok({
				providers: [
					{ provider: "google" as const, failure: null, checkedAt: at, lastSuccessAt: at, recoveryPending: false },
					{
						provider: "discord" as const,
						failure: "permission" as const,
						checkedAt: at,
						lastSuccessAt: null,
						recoveryPending: true,
					},
				],
			}),
		};
		const tile = meetingConnections(summary, FIXTURE_NOW);
		expect(tile.data!.connections.map((connection) => [connection.id, connection.status, connection.detail])).toEqual(
			[
				["meeting.google", "connected", null],
				["meeting.discord", "attention", "permission"],
			],
		);
	});

	it("keeps only a checked time that is a date of at most 40 characters", () => {
		expect(checkedAtOf(FIXTURE_NOW.toISOString())).toBe(FIXTURE_NOW.toISOString());
		expect(checkedAtOf(`2026-10-17T00:00:00.${"0".repeat(30)}Z`)).toBeNull();
		expect(checkedAtOf("not a date")).toBeNull();
		expect(checkedAtOf(null)).toBeNull();
		expect(checkedAtOf(undefined)).toBeNull();
	});
});
