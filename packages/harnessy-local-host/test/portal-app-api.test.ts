/**
 * The one app's read routes (Phase A): route matching and parameters, the
 * Inbox derivation, the Jobs table, loopback liveness, and each new route over
 * a real server with a populated fixture home. Every liveness probe in these
 * tests is a fake or targets a server the test itself started.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";

import {
	checkPortalValue,
	type InboxItemData,
	type JobData,
	PortalApiSchemas,
	type ServiceHealthData,
	type TileResult,
} from "@harnessy/core/read-model";
import { afterEach, describe, expect, it } from "vitest";

import { isCommunityCompatibilityWriterCommand } from "../../harnessy-core/src/jarvis/community-briefing/operational-runtime.ts";
import { isMeetingPublicationV1WriterCommand } from "../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import { deriveInbox, type InboxInputs } from "../src/portal/inbox.ts";
import { type JobsContext, jobDefinitions, readJobs, readProgramArguments, shellPath } from "../src/portal/jobs.ts";
import { tcpPortProbe } from "../src/portal/liveness.ts";
import { buildPortalOpenApi } from "../src/portal/openapi.ts";
import { matchPortalRoute, PORTAL_APP_ROUTES, PORTAL_ROUTES } from "../src/portal/routes.ts";
import { PORTAL_CSP, type PortalServer, startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import {
	buildPortalHome,
	CANARY,
	cleanupPortalFixtures,
	FIXTURE_NOW,
	FIXTURE_USER,
	OWNER_BRIEF_TEXT,
	OWNER_DRAFT_TEXT,
	tempDir,
} from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

const servers: PortalServer[] = [];
const listeners: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	await Promise.all(listeners.splice(0).map((server) => new Promise((done) => server.close(done))));
	cleanupPortalFixtures();
});

const NOW = FIXTURE_NOW;
const at = NOW.toISOString();
const ok = <A>(data: A): TileResult<A> => ({ state: "ok", data, readAt: at });
const missing = <A>(reason = "file_missing"): TileResult<A> => ({ state: "missing", reason, readAt: at });
const HASH = "a".repeat(64);

describe("app routes", () => {
	it("match a parameter only when the whole segment matches its pattern", () => {
		expect(matchPortalRoute(PORTAL_ROUTES, "/v1/inbox")?.route.operationId).toBe("getInbox");
		expect(matchPortalRoute(PORTAL_ROUTES, "/v1/life/brief/2026-10-17")).toMatchObject({
			route: { operationId: "getLifeBriefForDate" },
			params: { date: "2026-10-17" },
		});
		expect(matchPortalRoute(PORTAL_ROUTES, `/v1/life/weekly/${HASH}/draft`)?.params).toEqual({ runId: HASH });
		for (const path of [
			"/v1/life/brief/2026-10-17x",
			"/v1/life/brief/..",
			`/v1/life/weekly/${HASH.toUpperCase()}/draft`,
			"/v1/life/weekly/../draft",
			`/v1/life/weekly/${HASH}/draft/extra`,
			"/v1/inbox/",
		])
			expect([path, matchPortalRoute(PORTAL_ROUTES, path)]).toEqual([path, undefined]);
	});

	it("are read routes in the OpenAPI document, with documented path parameters", () => {
		const document = buildPortalOpenApi(PORTAL_ROUTES, "0.0.3") as {
			paths: Record<
				string,
				Record<string, { security?: unknown; parameters?: unknown; responses: Record<string, unknown> }>
			>;
		};
		for (const route of PORTAL_APP_ROUTES) {
			expect(route).toMatchObject({ method: "GET", auth: "read" });
			const operation = document.paths[route.path]!.get!;
			expect(operation.security).toEqual([{ bearer: [] }, { installProof: [] }]);
			expect(Object.keys(operation.responses)).toContain("401");
		}
		expect(document.paths["/v1/life/weekly/{runId}/draft"]!.get!.parameters).toEqual([
			{
				name: "runId",
				in: "path",
				required: true,
				description: "The weekly run hash, as `weekly-reconcile --run` takes it",
				example: HASH,
				schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
			},
		]);
		expect(Object.keys(document.paths["/v1/life/brief/{date}"]!.get!.responses)).toContain("404");
	});
});

const job = (overrides: Partial<JobData>): JobData => ({
	id: "daily-brief",
	name: "Daily brief",
	label: "com.flow-harness.life-orchestrator.daily-brief",
	kind: "timed",
	schedule: "05:30 daily",
	nextRun: "2026-10-18T04:30:00.000Z",
	lastActivity: null,
	loaded: true,
	state: "not running",
	stateReason: null,
	pid: null,
	lastExitCode: 0,
	lastLogCode: null,
	port: null,
	liveness: [],
	health: "ok",
	healthReason: "waiting for next run",
	programArguments: null,
	notes: [],
	controls: [],
	neverPause: false,
	...overrides,
});

const baseInputs = (): InboxInputs => ({
	now: NOW,
	weeklyRuns: missing("directory_missing"),
	briefDecisions: null,
	meetingConfig: ok({ enabled: true, reviewHost: "127.0.0.1", reviewPort: 8770 }),
	meetingQueue: missing(),
	meetingStatePath: "/home/owner/meeting state",
	communityConfig: ok({
		configured: true,
		reviewHost: "127.0.0.1",
		reviewPort: 8872,
		discordChannelConfigured: true,
		sourceConfigured: true,
		draftConfigured: true,
	}),
	communityQueue: missing(),
	communityGeneration: missing("generation_unrecorded"),
	communityStatePath: "/home/owner/community",
	fathomAccounts: missing("config_unavailable"),
	workspaceRoot: "/home/owner/Code",
	jobs: { jobs: [job({})], timezone: "Africa/Lagos", errorCount: 0 },
	connections: {},
});

const keys = (items: ReadonlyArray<InboxItemData>) => items.map((item) => `${item.severity} ${item.key}`);

describe("inbox derivation", () => {
	it("is empty, with the next job, when nothing needs Julian", () => {
		expect(deriveInbox(baseInputs())).toEqual({
			items: [],
			counts: { action_required: 0, attention: 0, info: 0 },
			nextJob: { name: "Daily brief", at: "2026-10-18T04:30:00.000Z" },
			unreadable: [],
		});
	});

	it("ranks every source by severity, then oldest first, with stable keys and owner hand-offs", () => {
		const inputs: InboxInputs = {
			...baseInputs(),
			weeklyRuns: ok({
				runs: [
					{ periodId: "2026-W42", runHash: "c".repeat(64), state: "drafted", incompleteReconciliation: false },
					{ periodId: "2026-W41", runHash: "b".repeat(64), state: "drafted", incompleteReconciliation: false },
					{ periodId: "2026-W40", runHash: HASH, state: "failed", incompleteReconciliation: false },
					{ periodId: "2026-W39", runHash: "d".repeat(64), state: "unrecorded", incompleteReconciliation: false },
					{ periodId: "2026-W38", runHash: "e".repeat(64), state: "reconciled", incompleteReconciliation: false },
					{ periodId: "2026-W37", runHash: "f".repeat(64), state: "drafted", incompleteReconciliation: true },
				],
				counts: {},
				total: 6,
			}),
			briefDecisions: { date: "2026-10-17", count: 2 },
			meetingQueue: ok({
				schemaVersion: 1,
				schemaState: "current",
				totalItems: 2,
				statusCounts: { pending_review: 2 },
				failureCounts: {},
				pendingReview: [
					{ itemId: "i2", meetingDate: "2026-10-03", updatedAt: "2026-10-04T00:00:00.000Z" },
					{ itemId: "i1", meetingDate: "2026-10-01", updatedAt: "2026-10-02T00:00:00.000Z" },
				],
				pendingReviewTruncated: false,
			}),
			communityQueue: ok({
				counts: { pending_review: 4, published: 1 },
				total: 5,
				recent: [
					{
						weekStart: "2026-09-07",
						weekEnd: "2026-09-13",
						status: "pending_review",
						attempts: 0,
						errorStage: null,
						updatedAt: "x",
					},
					{
						weekStart: "2026-08-31",
						weekEnd: "2026-09-06",
						status: "pending_review",
						attempts: 0,
						errorStage: null,
						updatedAt: "x",
					},
					{
						weekStart: "2026-08-24",
						weekEnd: "2026-08-30",
						status: "pending_review",
						attempts: 0,
						errorStage: null,
						updatedAt: "x",
					},
				],
			}),
			communityGeneration: ok({
				schedule: { weekday: 0, hour: 23, minute: 0, timezone: "Africa/Lagos" },
				updatedAt: "2026-10-12T22:10:00.000Z",
				nextRun: "2026-10-18T22:00:00.000Z",
				lastFailure: {
					weekStart: "2026-09-28",
					at: "2026-10-05T22:30:00.000Z",
					code: "model_retired",
					attempts: 3,
				},
				standingFault: { code: "queue_unreadable", since: "2026-10-16T22:00:00.000Z" },
				weeks: [
					{
						weekStart: "2026-09-28",
						status: "failed",
						attempts: 3,
						lastAttemptAt: "x",
						code: "model_retired",
						gaveUp: true,
						recovered: false,
					},
				],
			}),
			fathomAccounts: ok({
				intervalSeconds: 300,
				accounts: [
					{
						account: "personal",
						pending: 2,
						processed: 1,
						invalid: 0,
						updatedAt: "2026-10-17T07:58:00.000Z",
						ageSeconds: 120,
						stale: false,
					},
					{
						account: "research",
						pending: null,
						processed: null,
						invalid: 1,
						updatedAt: "2026-10-16T07:00:00.000Z",
						ageSeconds: 90_000,
						stale: true,
					},
				],
			}),
			jobs: {
				jobs: [
					job({
						id: "fathom-poll",
						name: "Fathom poll",
						label: "com.flow-harness.meeting-fathom-poll",
						nextRun: null,
					}),
					job({
						id: "community-review",
						name: "Community review",
						kind: "service",
						label: "com.flow-harness.community-review-v2",
						health: "error",
						healthReason: "loaded without a process",
						neverPause: true,
						nextRun: null,
					}),
					job({
						id: "meeting-publication",
						name: "Meeting publication",
						label: "org.harnessy.meeting-publication",
						kind: "service",
						loaded: false,
						health: "error",
						healthReason: "not loaded",
						nextRun: null,
						lastActivity: { at: "2026-10-15T00:00:00.000Z", evidence: "log-mtime" },
					}),
				],
				timezone: "Africa/Lagos",
				errorCount: 2,
			},
			connections: {
				meeting: ok({
					omitted: 0,
					connections: [
						{
							id: "meeting.google",
							label: "Meeting publication: Google",
							owner: "meeting-publication",
							status: "attention",
							detail: "authentication",
							checkedAt: "2026-10-17T07:00:00.000Z",
							action: { kind: "link", value: "http://127.0.0.1:8770/", note: "Reconnect Google." },
						},
						{
							id: "meeting.discord",
							label: "Meeting publication: Discord",
							owner: "meeting-publication",
							status: "connected",
							detail: null,
							checkedAt: null,
							action: null,
						},
					],
				}),
				codex: ok({
					omitted: 0,
					connections: [
						{
							id: "codex",
							label: "Codex",
							owner: "codex",
							status: "attention",
							detail: null,
							checkedAt: null,
							action: { kind: "command", value: "codex login", note: null },
						},
					],
				}),
				gws: ok({
					omitted: 0,
					connections: [
						{
							id: "gws.x",
							label: "gws x",
							owner: "gws",
							status: "attention",
							detail: "x",
							checkedAt: "bad date",
							action: null,
						},
					],
				}),
				broken: { state: "busy", reason: "database_busy", readAt: at },
			},
		};
		const inbox = deriveInbox(inputs);
		expect(checkPortalValue(PortalApiSchemas.Inbox.properties.tiles.properties.inbox, ok(inbox))).toBe(true);
		expect(keys(inbox.items)).toEqual([
			"action_required community:pending",
			"action_required meetings:pending",
			"action_required job:org.harnessy.meeting-publication:missing",
			"action_required fathom:research:stale",
			"action_required community-generation:fault",
			"action_required job:com.flow-harness.community-review-v2:failing",
			"action_required life-weekly:2026-W37",
			"action_required life-weekly:2026-W40",
			"action_required life-weekly:2026-W41",
			"attention connection:meeting.google",
			"attention connection:codex",
			"attention connection:gws.x",
			"attention fathom:research:invalid",
			"attention life-brief:2026-10-17:decisions",
			"attention life-weekly:2026-W39",
			"attention life-weekly:2026-W42:draft",
			"info fathom:inbox",
		]);
		// The standing fault covers its failed week: one item, not a second one per week.
		expect(inbox.counts).toEqual({ action_required: 9, attention: 7, info: 1 });
		expect(inbox.unreadable).toEqual(["connections.broken:database_busy"]);
		const byKey = new Map(inbox.items.map((item) => [item.key, item]));
		expect(byKey.get("community:pending")).toMatchObject({
			title: "4 community briefings waiting",
			context: "Weeks of 24 Aug, 31 Aug, 7 Sep and older",
			owner: { service: "community-review", port: 8872 },
			actions: [
				{ kind: "handoff", target: "http://127.0.0.1:8872/" },
				{ kind: "copy", target: "harnessy-community-review-open --state-path /home/owner/community" },
			],
		});
		expect(byKey.get("meetings:pending")!.actions[1]!.target).toBe(
			"harnessy-meeting-review-open --state-path '/home/owner/meeting state'",
		);
		expect(byKey.get("life-weekly:2026-W42:draft")!.actions).toEqual([
			{ kind: "handoff", label: "Read draft", target: `#/today/draft/${"c".repeat(64)}`, note: null },
			expect.objectContaining({
				kind: "copy",
				target: `harnessy jarvis life weekly-reconcile --run ${"c".repeat(64)} --reason "…"`,
			}),
		]);
		expect(byKey.get("fathom:research:stale")!.actions[0]!.target).toBe(
			"harnessy jarvis meeting fathom poll --target /home/owner/Code --json",
		);
		expect(byKey.get("connection:codex")!.actions).toEqual([
			expect.objectContaining({ kind: "copy", target: "codex login" }),
		]);
		expect(byKey.get("connection:gws.x")!.actions).toEqual([
			expect.objectContaining({ kind: "handoff", target: "#/connections" }),
		]);
		// Same inputs, same keys: the list is a pure function.
		expect(keys(deriveInbox(inputs).items)).toEqual(keys(inbox.items));
		// No action is ever a run, and no copied command is writer-shaped.
		for (const item of inbox.items)
			for (const action of item.actions) {
				expect(["handoff", "copy"]).toContain(action.kind);
				expect(isCommunityCompatibilityWriterCommand(action.target)).toBe(false);
				expect(isMeetingPublicationV1WriterCommand(action.target)).toBe(false);
			}
		// Readings are never called unread.
		expect(JSON.stringify(inbox.items).toLowerCase()).not.toMatch(/\bunread\b/u);
	});

	it("raises a failed generation week as attention only without a standing fault", () => {
		const generation = (standingFault: { code: string; since: string } | null) =>
			keys(
				deriveInbox({
					...baseInputs(),
					communityGeneration: ok({
						schedule: null,
						updatedAt: null,
						nextRun: null,
						lastFailure: { weekStart: "2026-09-28", at: "2026-10-05T22:30:00.000Z", code: "c", attempts: 3 },
						standingFault,
						weeks: [],
					}),
				}).items,
			);
		expect(generation(null)).toEqual(["attention community-generation:2026-09-28"]);
		expect(generation({ code: "c", since: "2026-10-16T22:00:00.000Z" })).toEqual([
			"action_required community-generation:fault",
		]);
	});

	it("links and probes a review service on the host it is configured for, including ::1", () => {
		const inbox = deriveInbox({
			...baseInputs(),
			meetingConfig: ok({ enabled: true, reviewHost: "::1", reviewPort: 8770 }),
			meetingQueue: ok({
				schemaVersion: 1,
				schemaState: "current",
				totalItems: 1,
				statusCounts: { pending_review: 1 },
				failureCounts: {},
				pendingReview: [],
				pendingReviewTruncated: false,
			}),
		});
		expect(inbox.items[0]!.actions[0]).toMatchObject({ kind: "handoff", target: "http://[::1]:8770/" });
		const context = (meetingHost: string | null): JobsContext => ({
			now: NOW,
			homeRoot: tempDir("jobs-host"),
			health: {},
			probePort: async () => false,
			workspaceRoot: null,
			meetingPort: 8770,
			meetingHost,
			meetingStatePath: null,
			communityPort: 8872,
			communityHost: "localhost",
			communityStatePath: null,
		});
		const meeting = (host: string | null) =>
			jobDefinitions(context(host)).find((entry) => entry.id === "meeting-publication")!;
		const shape = (definition: ReturnType<typeof meeting>) => [definition.hosts, definition.controls[0]!.target];
		expect(shape(meeting("::1"))).toEqual([["::1"], "http://[::1]:8770/"]);
		expect(shape(meeting("127.0.0.1"))).toEqual([["127.0.0.1"], "http://127.0.0.1:8770/"]);
		expect(shape(meeting(null))).toEqual([["127.0.0.1"], "http://127.0.0.1:8770/"]);
		expect(shape(jobDefinitions(context(null)).find((entry) => entry.id === "community-review")!)).toEqual([
			["127.0.0.1", "::1"],
			"http://localhost:8872/",
		]);
	});

	it("reports a job whose launchd probe failed as unreadable, and promises no run for an unloaded job", () => {
		const inbox = deriveInbox({
			...baseInputs(),
			jobs: {
				jobs: [
					job({ id: "weekly-plan", name: "Weekly plan", loaded: false, nextRun: "2026-10-18T17:00:00.000Z" }),
					job({ id: "daily-brief", health: "unknown", healthReason: "launchd probe_failed", loaded: null }),
					job({
						id: "fathom-poll",
						health: "unknown",
						healthReason: "launchd not available",
						loaded: null,
						nextRun: null,
					}),
					job({ id: "executor", kind: "on-demand", health: "unknown", healthReason: "x", nextRun: null }),
				],
				timezone: "Africa/Lagos",
				errorCount: 0,
			},
		});
		expect(inbox.items).toEqual([]);
		expect(inbox.unreadable).toEqual(["jobs.daily-brief:launchd probe_failed"]);
		expect(inbox.nextJob).toEqual({ name: "Daily brief", at: "2026-10-18T04:30:00.000Z" });
	});

	it("never offers a copy whose text hides characters", () => {
		const bidi = "/home/owner/\u202Eevil";
		const inbox = deriveInbox({
			...baseInputs(),
			communityStatePath: bidi,
			communityQueue: ok({ counts: { pending_review: 1 }, total: 1, recent: [] }),
			connections: {
				codex: ok({
					omitted: 0,
					connections: [
						{
							id: "codex",
							label: "Codex",
							owner: "codex",
							status: "attention",
							detail: null,
							checkedAt: null,
							action: { kind: "command", value: "codex login\u2066 --evil", note: null },
						},
					],
				}),
			},
		});
		const targets = inbox.items.flatMap((item) => item.actions.map((action) => action.target));
		expect(targets).toContain("harnessy-community-review-open --state-path <state path>");
		expect(targets).toContain("#/connections");
		expect(targets.some((target) => /[\u202A-\u202E\u2066-\u2069]/u.test(target))).toBe(false);
		expect(shellPath("/a/\u200Bb", "<p>")).toBe("<p>");
		expect(shellPath("/a\nb")).toBe("<path>");
		// A line or paragraph separator breaks a pasted line like a newline does.
		expect(shellPath("/a\u2028b")).toBe("<path>");
		expect(shellPath("/a\u2029b")).toBe("<path>");
	});

	it("keeps singular wording and drops a recovered generation failure", () => {
		const inbox = deriveInbox({
			...baseInputs(),
			communityConfig: missing("config_missing"),
			communityQueue: ok({ counts: { pending_review: 1 }, total: 1, recent: [] }),
			communityGeneration: ok({
				schedule: null,
				updatedAt: null,
				nextRun: null,
				lastFailure: { weekStart: "2026-09-28", at: "x", code: "c", attempts: 1 },
				standingFault: null,
				weeks: [
					{
						weekStart: "2026-09-28",
						status: "failed",
						attempts: 1,
						lastAttemptAt: "x",
						code: null,
						gaveUp: false,
						recovered: true,
					},
				],
			}),
			communityStatePath: null,
			meetingQueue: ok({
				schemaVersion: 1,
				schemaState: "current",
				totalItems: 1,
				statusCounts: { pending_review: 1 },
				failureCounts: {},
				pendingReview: [],
				pendingReviewTruncated: false,
			}),
			meetingConfig: missing("config_missing"),
			meetingStatePath: null,
			briefDecisions: { date: "2026-10-17", count: 1 },
			fathomAccounts: ok({
				intervalSeconds: 300,
				accounts: [
					{ account: "a", pending: 1, processed: 0, invalid: 1, updatedAt: null, ageSeconds: null, stale: true },
				],
			}),
			workspaceRoot: null,
		});
		const titles = inbox.items.map((item) => item.title);
		expect(titles).toEqual([
			"1 community briefing waiting",
			"Fathom (a) has not polled recently",
			"1 meeting note waiting",
			"Fathom (a) has 1 invalid recording",
			"1 decision in today's brief",
			"1 Fathom recording in the inbox",
		]);
		expect(inbox.items[0]!.actions).toEqual([
			expect.objectContaining({ kind: "copy", target: "harnessy-community-review-open --state-path <state path>" }),
		]);
		expect(inbox.items[1]).toMatchObject({ context: "No successful poll recorded" });
	});
});

describe("inbox problems", () => {
	const fathomConnection = (account: string, detail: string | null) => ({
		id: `fathom.${account}`,
		label: `Fathom: ${account}`,
		owner: "fathom-poll",
		status: "attention" as const,
		detail,
		checkedAt: null,
		action: { kind: "command" as const, value: "harnessy jarvis meeting fathom status", note: null },
	});
	const account = (name: string, updatedAt: string | null) => ({
		account: name,
		pending: 0,
		processed: 0,
		invalid: 0,
		updatedAt,
		ageSeconds: updatedAt === null ? null : 90_000,
		stale: true,
	});

	it("shows one item per Fathom account problem, at the highest severity, in plain words", () => {
		const inbox = deriveInbox({
			...baseInputs(),
			fathomAccounts: ok({ intervalSeconds: 300, accounts: [account("aa", null)] }),
			connections: {
				fathom: ok({
					omitted: 0,
					connections: [fathomConnection("aa", "never_polled"), fathomConnection("bb", "checkpoint_stale")],
				}),
				gws: ok({
					omitted: 0,
					connections: [
						{ ...fathomConnection("x", "token_expired"), id: "gws.x", label: "gws x", owner: "gws" },
						{ ...fathomConnection("y", "Signed out."), id: "gws.y", label: "gws y", owner: "gws" },
					],
				}),
			},
		});
		// The poll checkpoint and Connections both see account aa: one item, the action_required one.
		expect(keys(inbox.items)).toEqual([
			"action_required fathom:aa:stale",
			"attention connection:fathom.bb",
			"attention connection:gws.x",
			"attention connection:gws.y",
		]);
		expect(inbox.counts).toEqual({ action_required: 1, attention: 3, info: 0 });
		expect(inbox.items.map((item) => [item.title, item.context])).toEqual([
			["Fathom (aa) has not polled recently", "No successful poll recorded"],
			["Fathom: bb needs attention", "No successful poll recently"],
			["gws x needs attention", "Token expired"],
			["gws y needs attention", "Signed out."],
		]);
		// No raw reason code reaches the inbox.
		expect(JSON.stringify(inbox.items)).not.toMatch(/never_polled|checkpoint_stale|token_expired/u);
	});
});

describe("jobs", () => {
	const context = (overrides: Partial<JobsContext> = {}): JobsContext => ({
		now: NOW,
		homeRoot: tempDir("jobs-home"),
		health: {},
		probePort: async () => false,
		workspaceRoot: "/home/owner/Code",
		meetingPort: 8770,
		meetingStatePath: "/home/owner/meeting",
		communityPort: 8872,
		communityStatePath: "/home/owner/community",
		...overrides,
	});
	const health = (data: Partial<ServiceHealthData>): TileResult<ServiceHealthData> =>
		ok({ label: "x", state: "running", pid: null, lastExitCode: null, lastLog: null, ...data });

	it("never offers to pause, stop or restart community review, and copies no writer-shaped command", () => {
		const definitions = jobDefinitions(context());
		expect(definitions.filter((definition) => definition.neverPause).map((definition) => definition.id)).toEqual([
			"community-review",
		]);
		for (const definition of definitions)
			for (const control of definition.controls) {
				expect(["copy", "handoff"]).toContain(control.kind);
				expect([control.target, isCommunityCompatibilityWriterCommand(control.target)]).toEqual([
					control.target,
					false,
				]);
				expect([control.target, isMeetingPublicationV1WriterCommand(control.target)]).toEqual([
					control.target,
					false,
				]);
				expect(control.target).not.toMatch(/community briefing|launchctl|bootout|kickstart/u);
			}
		const community = definitions.find((definition) => definition.id === "community-review")!;
		expect(community.controls.map((control) => control.label)).not.toEqual(
			expect.arrayContaining([expect.stringMatching(/pause|stop|restart|disable/iu)]),
		);
		expect(shellPath("/a b/c'd")).toBe("'/a b/c'\\''d'");
		expect(
			jobDefinitions(
				context({
					workspaceRoot: null,
					meetingStatePath: null,
					communityStatePath: null,
					meetingPort: null,
					communityPort: null,
				}),
			).find((definition) => definition.id === "fathom-poll")!.controls[0]!.target,
		).toBe("harnessy jarvis meeting fathom poll --target <workspace> --json");
	});

	it("derives health from launchd, logs and liveness, with next runs in Lagos and last activity as log mtime", async () => {
		const probes: string[] = [];
		const list = await readJobs(
			context({
				probePort: async (host, port) => {
					probes.push(`${host}:${port}`);
					return port === 8770 || (port === 4788 && host === "::1");
				},
				health: {
					"com.flow-harness.meeting-fathom-poll": health({
						lastLog: { stream: "stderr", modifiedAt: "2026-10-17T07:58:00.000Z", code: "poll_failed" },
					}),
					"com.flow-harness.life-orchestrator.learning-research": health({ lastExitCode: 2 }),
					"com.flow-harness.life-orchestrator.daily-brief": health({ pid: 41 }),
					"com.flow-harness.life-orchestrator.weekly-plan": missing("not_loaded"),
					"com.flow-harness.community-review-v2": health({ pid: null }),
					"org.harnessy.meeting-publication": health({ pid: 7 }),
					"org.harnessy.portal": { state: "unsupported", reason: "platform", readAt: at },
					"tech.flowresearch.learning-wiki": health({ pid: 9 }),
				},
			}),
		);
		expect(checkPortalValue(PortalApiSchemas.Jobs.properties.tiles.properties.jobs, ok(list))).toBe(true);
		const byId = new Map(list.jobs.map((entry) => [entry.id, entry]));
		expect(list.jobs.map((entry) => [entry.id, entry.health, entry.healthReason])).toEqual([
			["fathom-poll", "attention", "last log: poll_failed"],
			["learning-research", "error", "last exit 2"],
			["daily-brief", "ok", "running"],
			["weekly-plan", "error", "not loaded"],
			["community-review", "error", "loaded without a process"],
			["meeting-publication", "ok", "running"],
			["portal", "unknown", "launchd not available"],
			["learning-wiki", "error", "port not answering"],
			["executor", "ok", "running"],
		]);
		expect(list.errorCount).toBe(4);
		expect(byId.get("fathom-poll")).toMatchObject({
			schedule: "every 5 min",
			nextRun: "2026-10-17T08:03:00.000Z",
			lastActivity: { at: "2026-10-17T07:58:00.000Z", evidence: "log-mtime" },
		});
		expect(byId.get("daily-brief")).toMatchObject({
			schedule: "05:30 daily",
			nextRun: "2026-10-18T04:30:00.000Z",
			pid: 41,
		});
		// launchd will not start an unloaded label: no next run is promised for it.
		expect(byId.get("weekly-plan")).toMatchObject({
			schedule: "Sun 18:00",
			nextRun: null,
			loaded: false,
			stateReason: "not_loaded",
		});
		expect(byId.get("portal")).toMatchObject({ loaded: null, stateReason: "platform" });
		expect(byId.get("executor")).toMatchObject({
			label: null,
			schedule: "port 4788",
			liveness: [
				{ host: "::1", port: 4788, open: true },
				{ host: "127.0.0.1", port: 4788, open: false },
			],
		});
		expect(byId.get("community-review")).toMatchObject({
			schedule: "Sun 23:00 drafts",
			neverPause: true,
			port: 8872,
		});
		expect(probes.sort()).toEqual([
			"127.0.0.1:4321",
			"127.0.0.1:4788",
			"127.0.0.1:8770",
			"127.0.0.1:8872",
			"::1:4788",
		]);
		const idle = await readJobs(context());
		expect(idle.jobs.find((entry) => entry.id === "executor")).toMatchObject({
			health: "idle",
			healthReason: "not running",
		});
		expect(idle.jobs.find((entry) => entry.id === "daily-brief")).toMatchObject({ health: "unknown", loaded: null });
		const busy = await readJobs(
			context({ health: { "org.harnessy.portal": { state: "error", reason: "probe_failed", readAt: at } } }),
		);
		expect(busy.jobs.find((entry) => entry.id === "portal")).toMatchObject({
			health: "unknown",
			healthReason: "launchd probe_failed",
		});
	});

	it("shows a LaunchAgent's ProgramArguments and never its environment", () => {
		const home = tempDir("plist");
		const dir = join(home, "Library", "LaunchAgents");
		expect(readProgramArguments(home, "x.label")).toBeNull();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "x.label.plist"),
			`<plist><dict><key>ProgramArguments</key><array><string>/bin/a &amp; b</string><string>&lt;c&gt;</string></array><key>EnvironmentVariables</key><dict><key>T</key><string>${CANARY}</string></dict></dict></plist>`,
		);
		expect(readProgramArguments(home, "x.label")).toEqual(["/bin/a & b", "<c>"]);
		// Values that may be secrets are redacted wherever they appear in the argv.
		writeFileSync(
			join(dir, "s.label.plist"),
			`<plist><dict><key>ProgramArguments</key><array>${[
				"/bin/sh",
				"-c",
				`FOO_TOKEN=${CANARY} exec tool --api-key ${CANARY} --state-path /x`,
				"--api-key",
				CANARY,
				`--password=${CANARY}`,
				`SECRET=${CANARY}`,
				"--state-path",
				"/home/owner/state",
			]
				.map((arg) => `<string>${arg}</string>`)
				.join("")}</array></dict></plist>`,
		);
		const redacted = readProgramArguments(home, "s.label")!;
		expect(JSON.stringify(redacted)).not.toContain(CANARY);
		expect(redacted).toEqual([
			"/bin/sh",
			"-c",
			"FOO_TOKEN=<redacted> exec tool --api-key <redacted> --state-path /x",
			"--api-key",
			"<redacted>",
			"--password=<redacted>",
			"SECRET=<redacted>",
			"--state-path",
			"/home/owner/state",
		]);
		writeFileSync(join(dir, "y.label.plist"), "<plist><dict></dict></plist>");
		expect(readProgramArguments(home, "y.label")).toBeNull();
		writeFileSync(join(dir, "z.label.plist"), "x".repeat(70 * 1024));
		expect(readProgramArguments(home, "z.label")).toBeNull();
	});
});

describe("loopback liveness", () => {
	it("is true for a listening port and false for a closed one, and never rejects", async () => {
		const server = createServer((socket) => socket.destroy());
		listeners.push(server);
		const port = await new Promise<number>((ready) =>
			server.listen(0, "127.0.0.1", () => ready((server.address() as { port: number }).port)),
		);
		const probe = tcpPortProbe(300);
		expect(await probe("127.0.0.1", port)).toBe(true);
		await new Promise((done) => server.close(done));
		listeners.splice(0);
		expect(await probe("127.0.0.1", port)).toBe(false);
	});

	it("gives up after its time limit, settles once and always closes the socket", async () => {
		const destroyed: string[] = [];
		const families: number[] = [];
		const silent = tcpPortProbe(5, (options) => {
			families.push(options.family);
			const listeners = new Map<string, () => void>();
			return {
				setTimeout: ((_ms: number, onTimeout: () => void) => {
					setTimeout(() => {
						onTimeout();
						// A late error after the timeout must not settle the probe again.
						listeners.get("error")?.();
					}, 1);
				}) as never,
				once: ((event: string, listener: () => void) => {
					listeners.set(event, listener);
				}) as never,
				destroy: (() => {
					destroyed.push("x");
				}) as never,
			};
		});
		expect(await silent("::1", 4788)).toBe(false);
		expect(families).toEqual([6]);
		expect(destroyed).toEqual(["x"]);
	});
});

describe("server reads for the app routes", () => {
	it("shares one read among concurrent requests and keeps the parameter cache bounded", async () => {
		const token = newPortalSecret();
		let reads = 0;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((done) => {
			release = done;
		});
		const base = createPortalSources({
			homeRoot: tempDir("dedupe"),
			env: {},
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => FIXTURE_NOW,
			probePort: async () => false,
		});
		let briefReads = 0;
		const server = await startPortalServer({
			installToken: token,
			sources: {
				...base,
				jobs: async () => {
					reads += 1;
					await gate;
					return base.jobs();
				},
				lifeBrief: (params) => {
					briefReads += 1;
					return base.lifeBrief(params);
				},
			},
			version: "0.0.3",
			port: 0,
			clock: () => FIXTURE_NOW.getTime(),
		});
		servers.push(server);
		const get = async (path: string) =>
			rawRequest(server.port, { path, headers: await installProof(server.port, token, "GET", path) });
		const pending = [get("/v1/jobs"), get("/v1/jobs"), get("/v1/jobs")];
		await new Promise((done) => setTimeout(done, 50));
		release();
		const responses = await Promise.all(pending);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
		expect(reads).toBe(1);
		for (let day = 1; day <= 65; day += 1) {
			const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
			expect((await get(`/v1/life/brief/${date}`)).status).toBe(200);
		}
		expect(briefReads).toBe(65);
		// The first path's cached value was dropped when the cache reached its bound.
		await get("/v1/life/brief/2026-01-01");
		expect(briefReads).toBe(66);
	});
});

describe("app routes over a real server", () => {
	const start = async (home: string) => {
		const token = newPortalSecret();
		const sources = createPortalSources({
			homeRoot: home,
			env: { USER: FIXTURE_USER },
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => FIXTURE_NOW,
			probePort: async () => false,
		});
		const server = await startPortalServer({
			installToken: token,
			sources,
			version: "0.0.3",
			port: 0,
			cacheTtlMs: 0,
		});
		servers.push(server);
		const get = async (path: string) =>
			rawRequest(server.port, { path, headers: await installProof(server.port, token, "GET", path) });
		return { server, get };
	};

	it("derives the inbox, tasks and jobs from a populated home without leaking secrets", async () => {
		const fixture = await buildPortalHome("app-routes");
		const { get } = await start(fixture.home);
		const inbox = await get("/v1/inbox");
		expect(checkPortalValue(PortalApiSchemas.Inbox, inbox.json)).toBe(true);
		const items = (inbox.json as { tiles: { inbox: { data: { items: InboxItemData[] } } } }).tiles.inbox.data.items;
		expect(keys(items)).toEqual(
			expect.arrayContaining([
				"action_required community:pending",
				"action_required meetings:pending",
				"action_required fathom:research:stale",
				"attention connection:meeting.google",
				"attention life-brief:2026-10-17:decisions",
				"attention life-weekly:2026-W42:draft",
				"attention community-generation:2026-09-28",
			]),
		);
		// The research account's stale checkpoint is one item, not a second "needs attention" one from Connections.
		expect(items.map((item) => item.key)).not.toContain("connection:fathom.research");
		const tasks = await get("/v1/tasks");
		expect(checkPortalValue(PortalApiSchemas.Tasks, tasks.json)).toBe(true);
		const taskList = (
			tasks.json as {
				tiles: {
					tasks: {
						data: {
							tasks: Array<{ title: string; mine: boolean; sourceChanged: boolean; source: { kind: string } }>;
						};
					};
				};
			}
		).tiles.tasks.data.tasks;
		expect(taskList.map((task) => [task.source.kind, task.title, task.mine])).toEqual([
			["reminders", "Call the bank by 2026-10-19", true],
			["reminders", "Send the deck", true],
			["reminders", "Loose note line", true],
			["brief", "Settle the mandate", true],
			["brief", "Approve the budget", true],
			["brief", "Garden delivery", false],
			["register", "Approve the mandate", true],
			["register", "Publish the register", false],
			["status-md", "ship the alpha", true],
			["status-md", "Wait on legal", true],
		]);
		const jobs = await get("/v1/jobs");
		expect(checkPortalValue(PortalApiSchemas.Jobs, jobs.json)).toBe(true);
		const jobList = (jobs.json as { tiles: { jobs: { data: { jobs: JobData[] } } } }).tiles.jobs.data.jobs;
		expect(jobList.find((entry) => entry.id === "daily-brief")!.programArguments).toEqual([
			"/opt/node/bin/node",
			"/opt/harnessy/cli.js",
			"jarvis",
			"life",
			"daily",
			"--max-output-bytes",
			"1048576",
		]);
		for (const response of [inbox, tasks, jobs]) {
			expect(response.text).not.toContain(CANARY);
			expect(response.text).not.toContain("owner@example.test");
			expect(response.headers["content-security-policy"]).toBe(PORTAL_CSP);
		}
	});

	it("flags a task whose source line changed between reads instead of silently replacing it", async () => {
		const fixture = await buildPortalHome("task-changed");
		const { get } = await start(fixture.home);
		type Row = { id: string; title: string; sourceChanged: boolean; previousTitle: string | null };
		const read = async () =>
			((await get("/v1/tasks")).json as { tiles: { tasks: { data: { tasks: Row[] } } } }).tiles.tasks.data.tasks;
		const changed = async () =>
			(await read()).filter((task) => task.sourceChanged).map((task) => [task.title, task.previousTitle]);
		expect(await changed()).toEqual([]);
		const reminders = join(fixture.home, ".agents", "life", "reminders.md");
		writeFileSync(reminders, readFileSync(reminders, "utf8").replace("Call the bank", "Call the other bank"));
		const edited = [["Call the other bank by 2026-10-19", "Call the bank by 2026-10-19"]];
		expect(await changed()).toEqual(edited);
		// The flag survives later reads (a refetch or the palette's own read cannot use it up).
		expect(await changed()).toEqual(edited);
		expect(await changed()).toEqual(edited);
		// A line inserted above shifts every line below it: neither the new item nor the shifted ones are edits.
		writeFileSync(
			reminders,
			readFileSync(reminders, "utf8").replace(
				"## Current Follow-Ups\n\n",
				"## Current Follow-Ups\n\n- [ ] New first item\n",
			),
		);
		expect(await changed()).toEqual(edited);
		expect((await read()).map((task) => task.title)).toContain("New first item");
		// A deleted line is not an edit either.
		writeFileSync(reminders, readFileSync(reminders, "utf8").replace("- [x] Send the deck\n", ""));
		expect(await changed()).toEqual(edited);
	});

	it("gives two identical task lines two ids", async () => {
		const fixture = await buildPortalHome("task-duplicates");
		const reminders = join(fixture.home, ".agents", "life", "reminders.md");
		writeFileSync(
			reminders,
			readFileSync(reminders, "utf8").replace("- [x] Send the deck", "- [ ] Same\n- [ ] Same\n- [ ] same"),
		);
		const { get } = await start(fixture.home);
		const tasks = (
			(await get("/v1/tasks")).json as {
				tiles: { tasks: { data: { tasks: Array<{ id: string; title: string }> } } };
			}
		).tiles.tasks.data.tasks;
		const same = tasks.filter((task) => task.title.toLowerCase() === "same");
		expect(same).toHaveLength(3);
		expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
	});

	it("serves the owner's brief, recent dates and a weekly draft as bounded text, and refuses other dates", async () => {
		const fixture = await buildPortalHome("brief-routes");
		const { get } = await start(fixture.home);
		const brief = await get("/v1/life/brief");
		expect(checkPortalValue(PortalApiSchemas.LifeBrief, brief.json)).toBe(true);
		expect(brief.json).toMatchObject({
			tiles: {
				brief: { state: "ok", data: { date: "2026-10-17", journaled: false, truncated: false } },
				dates: { state: "ok", data: { dates: [{ date: "2026-10-17", journaled: false }] } },
			},
		});
		expect(brief.text).toContain(OWNER_BRIEF_TEXT);
		const dated = await get("/v1/life/brief/2026-10-17");
		expect((dated.json as { tiles: unknown }).tiles).toEqual((brief.json as { tiles: unknown }).tiles);
		expect((await get("/v1/life/brief/2026-10-15")).json).toMatchObject({
			tiles: { brief: { state: "missing", reason: "file_missing" } },
		});
		expect((await get("/v1/life/brief/2026-10-01")).json).toMatchObject({
			tiles: { brief: { state: "error", reason: "date_out_of_range" } },
		});
		const runs = (await get("/v1/today")).json as {
			tiles: { weeklyRuns: { data: { runs: Array<{ runHash: string }> } } };
		};
		const runHash = runs.tiles.weeklyRuns.data.runs[0]!.runHash;
		const draft = await get(`/v1/life/weekly/${runHash}/draft`);
		expect(checkPortalValue(PortalApiSchemas.LifeWeeklyDraft, draft.json)).toBe(true);
		expect(draft.json).toMatchObject({ tiles: { draft: { state: "ok", data: { periodId: "2026-W42", runHash } } } });
		expect(draft.text).toContain(OWNER_DRAFT_TEXT);
		expect((await get(`/v1/life/weekly/${"9".repeat(64)}/draft`)).json).toMatchObject({
			tiles: { draft: { state: "missing", reason: "run_missing" } },
		});
		const refused = await get("/v1/life/weekly/not-a-hash/draft");
		expect(refused.status).toBe(404);
		expect(refused.headers["content-security-policy"]).toBe(PORTAL_CSP);
	});

	it("degrades every new route for an unsafe Life config and an empty home", async () => {
		const { get } = await start(tempDir("empty-app"));
		for (const path of ["/v1/inbox", "/v1/life/brief", `/v1/life/weekly/${HASH}/draft`, "/v1/tasks", "/v1/jobs"]) {
			const response = await get(path);
			expect([path, response.status]).toEqual([path, 200]);
		}
		expect((await get("/v1/tasks")).json).toMatchObject({ tiles: { tasks: { state: "ok" } } });
		const unsafeHome = tempDir("unsafe-app");
		mkdirSync(join(unsafeHome, ".agents", "life", "config.json"), { recursive: true });
		const unsafe = await start(unsafeHome);
		expect((await unsafe.get("/v1/inbox")).json).toMatchObject({ tiles: { inbox: { state: "ok" } } });
		expect((await unsafe.get("/v1/jobs")).json).toMatchObject({ tiles: { jobs: { state: "ok" } } });
		for (const [path, tile] of [
			["/v1/life/brief", "brief"],
			[`/v1/life/weekly/${HASH}/draft`, "draft"],
			["/v1/tasks", "tasks"],
		] as const)
			expect((await unsafe.get(path)).json).toMatchObject({
				tiles: { [tile]: { state: "unsafe", reason: "life_config_unsafe" } },
			});
	});
});
