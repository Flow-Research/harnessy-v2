import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { calendarConsentCommand, calendarImportCommand } from "../src/cli/calendar-import.ts";
import { classifyEvent, isJarvisBlock, parseMarkers } from "../src/jarvis/calendar-import/classify.ts";
import { type ConsentRecord, readConsent, recordConsent } from "../src/jarvis/calendar-import/consent.ts";
import { assertReadOnlyCall, type CalendarRead, gwsCalendarReader } from "../src/jarvis/calendar-import/gws-reader.ts";
import { type ImportAccount, importCalendars } from "../src/jarvis/calendar-import/importer.ts";
import { accountKey, accountLabel, actionKey, identityKey, taskKey } from "../src/jarvis/calendar-import/keys.ts";
import { type ActionDescriptor, keyDecisions, resolveLink } from "../src/jarvis/calendar-import/match.ts";
import type { LinkDecision, ObservationStore, StoredEvent } from "../src/jarvis/calendar-import/observations.ts";
import {
	OWNER_FILE_MAX_BYTES,
	readOwnerFile,
	readSalt,
	writeOwnerFile,
} from "../src/jarvis/calendar-import/owner-file.ts";
import {
	type CalendarSignal,
	calendarEvidence,
	calendarImportProvider,
} from "../src/jarvis/calendar-import/provider.ts";
import { calendarImportPaths, recordAccountConsent, runCalendarImport } from "../src/jarvis/calendar-import/run.ts";
import { renderCalendarImportPlist } from "../src/jarvis/calendar-import/schedule.ts";

const hour = 3_600_000;
const at = new Date("2026-11-28T12:00:00.000Z");
const iso = (hours: number) => new Date(at.getTime() + hours * hour).toISOString();
const salt = Buffer.alloc(32, 7);
const OWNER = "owner@example.test";
const TASK = "0f8fad5b-d9cb-469f-a165-70867728950e";

// Local copy of `calendarPoints` from PR #221 (`tasks/priority.ts`), the v3 spec
// buckets. When #221 merges, these tests import the engine function instead.
function calendarPoints(event: CalendarSignal, now: number) {
	const hours = (Date.parse(event.start) - now) / hour;
	if (!(hours >= 0 && hours <= 168)) return 0;
	if (event.relation === "agenda") return 50;
	if (hours <= 24) return 450;
	return hours <= 72 ? 300 : 150;
}
const points = (signals: readonly CalendarSignal[] | "unavailable") =>
	signals === "unavailable" ? 0 : Math.max(0, ...signals.map((signal) => calendarPoints(signal, at.getTime())));

const account = (slug: string): ImportAccount => ({ key: accountKey(salt, slug), slug });
const consentFor = (bound: Record<string, string | null>): ReadonlyMap<string, ConsentRecord> =>
	new Map(
		Object.entries(bound).map(([slug, identity]) => {
			const key = accountKey(salt, slug);
			return [
				key,
				{
					account: key,
					identity: identity === null ? null : identityKey(salt, identity),
					scope: "calendar.read",
					consentedAt: "2026-11-28T18:47:00+01:00",
					consentedBy: "julian",
					method: "voice",
				},
			];
		}),
	);

type Item = Record<string, unknown>;
const event = (id: string, hours: number, extra: Item = {}): Item => ({
	id,
	iCalUID: `${id}@google.test`,
	status: "confirmed",
	summary: "Planning",
	description: "",
	start: { dateTime: iso(hours) },
	end: { dateTime: iso(hours + 1) },
	organizer: { self: true },
	...extra,
});

const fakeReader =
	(identity: string, items: Item[], calls: string[][] = []): CalendarRead =>
	async (args) => {
		assertReadOnlyCall(args);
		calls.push([...args]);
		if (args[1] === "calendars") return { id: identity };
		return { items };
	};

const importOne = async (
	items: Item[],
	options: { descriptors?: ActionDescriptor[]; decisions?: LinkDecision[] } = {},
) =>
	importCalendars({
		accounts: [account("work")],
		consent: consentFor({ work: OWNER }),
		readerFor: () => fakeReader(OWNER, items),
		salt,
		now: at,
		...options,
	});

const providerFor = (
	store: ObservationStore,
	decisions: LinkDecision[] = [],
	tasksOfAction?: (actionId: string) => readonly string[],
) =>
	calendarImportProvider({
		salt,
		observations: () => store,
		decisions: () => decisions,
		...(tasksOfAction ? { tasksOfAction } : {}),
	});
const evidenceFor = (store: ObservationStore, actionId: string, decisions: LinkDecision[] = []) =>
	calendarEvidence({ salt, observations: () => store, decisions: () => decisions }, actionId, at);
const accept = (actionId: string, key: string, kind: "accept" | "reject" = "accept"): LinkDecision => ({
	actionId,
	target: { kind: "event", key },
	decision: kind,
	decidedBy: "julian",
	decidedAt: iso(-1),
	closedOccurrences: [],
});
const subject = (actionId: string, tasks: string[] = []) => ({
	action: actionKey(salt, actionId),
	tasks: tasks.map((task) => taskKey(salt, task)),
});

describe("read-only boundary", () => {
	it.each([
		["events", "insert"],
		["events", "patch"],
		["events", "update"],
		["events", "delete"],
		["events", "move"],
		["events", "quickAdd"],
		["events", "watch"],
		["events", "import"],
		["acl", "insert"],
		["settings", "watch"],
		["calendarList", "list"],
		["calendars", "update"],
	])("refuses calendar %s %s", (resource, method) => {
		expect(() =>
			assertReadOnlyCall(["calendar", resource, method, "--params", JSON.stringify({ calendarId: "primary" })]),
		).toThrow(/read-only/);
	});
	it("refuses another calendar and extra arguments", () => {
		expect(() => assertReadOnlyCall(["calendar", "events", "list", "--params", '{"calendarId":"x@y"}'])).toThrow(
			/primary/,
		);
		expect(() =>
			assertReadOnlyCall(["calendar", "events", "list", "--params", '{"calendarId":"primary"}', "--json", "{}"]),
		).toThrow(/read-only/);
		expect(() =>
			assertReadOnlyCall(["calendar", "events", "list", "--params", '{"calendarId":"primary"}']),
		).not.toThrow();
	});
});

// The fake gws is the native Node binary with a preloaded script, so the reader's
// native-binary and digest checks run against a real executable.
const nodeBinary = realpathSync(process.execPath);
const nodeDigest = createHash("sha256").update(readFileSync(nodeBinary)).digest("hex");
const networkGuard = fileURLToPath(
	new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url),
);
const FAKE_GWS = `import { readFileSync, writeFileSync } from 'node:fs';
const args = ['calendar', ...process.argv.slice(2)];
const config = process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
writeFileSync(config + '/request.json', JSON.stringify({ args, token: Boolean(process.env.GOOGLE_WORKSPACE_CLI_TOKEN), credentials: Boolean(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) }));
const fixture = JSON.parse(readFileSync(config + '/fixture.json', 'utf8'));
if (fixture.exit) { console.log(JSON.stringify({ error: { code: fixture.code, message: 'PRIVATE_PROVIDER_DETAIL ${OWNER}' } })); console.error('PRIVATE_PROVIDER_DETAIL'); process.exit(fixture.exit); }
console.log(JSON.stringify(args[1] === 'calendars' ? { id: fixture.identity } : { items: fixture.items }));
process.exit(0);
`;

describe.runIf(process.platform !== "win32")("gws process boundary", () => {
	let root: string;
	let config: string;
	const slug = "sentinel.owner@example.test";
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-import-")));
		config = join(root, ".config", `gws-${slug}`);
		mkdirSync(config, { recursive: true, mode: 0o700 });
		mkdirSync(join(root, ".config", "gws---help"), { mode: 0o755 });
		writeFileSync(join(root, "fake-gws.mjs"), FAKE_GWS);
		vi.stubEnv("HOME", root);
		vi.stubEnv("GOOGLE_WORKSPACE_CLI_TOKEN", "ambient-token");
		vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", "/ambient/credentials.json");
		vi.stubEnv("NODE_OPTIONS", `--import=${networkGuard} --import=${join(root, "fake-gws.mjs")}`);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});
	const fixture = (value: unknown) => writeFileSync(join(config, "fixture.json"), JSON.stringify(value));
	const reader = () => gwsCalendarReader(nodeBinary, nodeDigest, config);
	const bind = () =>
		recordAccountConsent(
			root,
			slug,
			{ consentedAt: "2026-11-28T18:47:00+01:00", consentedBy: "julian", method: "voice" },
			{ read: reader(), approvedIdentityPrefix: createHash("sha256").update(OWNER).digest("hex").slice(0, 8) },
		);
	/** Run one CLI command and capture everything it writes to stdout and stderr. */
	const cli = async (run: (args: string[]) => Effect.Effect<void, unknown, never>, args: string[]) => {
		const output: string[] = [];
		const capture = (...values: unknown[]) => {
			output.push(values.map(String).join(" "));
			return true;
		};
		vi.spyOn(console, "log").mockImplementation(capture);
		vi.spyOn(console, "error").mockImplementation(capture);
		vi.spyOn(console, "warn").mockImplementation(capture);
		vi.spyOn(process.stdout, "write").mockImplementation(capture);
		vi.spyOn(process.stderr, "write").mockImplementation(capture);
		let failure: unknown;
		try {
			await Effect.runPromise(run(args));
		} catch (cause) {
			failure = cause;
		}
		vi.restoreAllMocks();
		return { output: output.join("\n"), failure: failure === undefined ? "" : String(failure) };
	};
	const importCli = (args: string[]) =>
		Command.runWith(calendarImportCommand, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer));
	const consentCli = (args: string[]) =>
		Command.runWith(calendarConsentCommand, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer));
	const importArgs = ["--google-executable", nodeBinary, "--google-executable-sha256", nodeDigest];

	it("strips ambient credentials and asks for JSON output", async () => {
		fixture({ identity: OWNER, items: [] });
		await reader()(["calendar", "events", "list", "--params", JSON.stringify({ calendarId: "primary" })]);
		const request = JSON.parse(readFileSync(join(config, "request.json"), "utf8"));
		expect(request).toMatchObject({ token: false, credentials: false });
		expect(request.args.slice(-2)).toEqual(["--format", "json"]);
	});
	it.each([
		[401, "auth"],
		[403, "scope"],
		[500, "failed"],
	])("maps provider error %i to %s and withholds the output", async (code, reason) => {
		fixture({ exit: 2, code });
		const failure = await reader()(["calendar", "calendars", "get", "--params", '{"calendarId":"primary"}']).catch(
			(cause: unknown) => cause,
		);
		expect(failure).toMatchObject({ reason });
		expect(String(failure)).not.toMatch(/PRIVATE_PROVIDER_DETAIL|owner@example/);
	});
	it("refuses scripts of any interpreter, a wrong digest, a shared folder and a write", () => {
		for (const line of ["#!/usr/bin/env node\n", `#!${process.execPath}\n`, "#!/bin/sh\n"]) {
			const script = join(root, "script");
			writeFileSync(script, line, { mode: 0o700 });
			const digest = createHash("sha256").update(line).digest("hex");
			expect(() => gwsCalendarReader(script, digest, config)).toThrow(/native gws binary/);
		}
		expect(() => gwsCalendarReader(nodeBinary, "0".repeat(64), config)).toThrow(/approved SHA-256/);
		chmodSync(config, 0o755);
		expect(() => reader()).toThrow(/owner-only/);
		chmodSync(config, 0o700);
		return expect(reader()(["calendar", "events", "insert", "--params", '{"calendarId":"primary"}'])).rejects.toThrow(
			/read-only/,
		);
	});
	it("refuses a binary replaced between two runs before it executes", async () => {
		fixture({ identity: OWNER, items: [] });
		const copy = join(root, "gws-copy");
		copyFileSync(nodeBinary, copy);
		chmodSync(copy, 0o700);
		const first = gwsCalendarReader(copy, nodeDigest, config);
		await first(["calendar", "calendars", "get", "--params", '{"calendarId":"primary"}']);
		rmSync(join(config, "request.json"));
		appendFileSync(copy, Buffer.from([0]));
		await expect(first(["calendar", "calendars", "get", "--params", '{"calendarId":"primary"}'])).rejects.toThrow(
			/approved SHA-256/,
		);
		expect(() => gwsCalendarReader(copy, nodeDigest, config)).toThrow(/approved SHA-256/);
		expect(existsSync(join(config, "request.json"))).toBe(false);
	});

	it("keeps sentinels and the address-shaped folder name out of CLI streams, reports and files", async () => {
		const sentinels = [
			slug,
			OWNER,
			"SENTINEL_TITLE_9d1",
			"SENTINEL_DESCRIPTION_4be",
			"SENTINEL_LOCATION_77a",
			"sentinel-attendee@example.test",
			"sentinel-organizer@example.test",
			"PRIVATE_DESCRIPTION_123",
			"PRIVATE_TITLE_MARKER_456",
			"raw-event-id-sentinel",
			"raw-series-sentinel",
			"raw-ical-sentinel",
		];
		// The CLI runs on the real clock, so these events are placed relative to it.
		const live = Date.now();
		const soon = (hours: number) => new Date(live + hours * hour).toISOString();
		fixture({ identity: OWNER, items: [] });
		const consentRun = await cli(consentCli, [
			"--slug",
			slug,
			"--consented-at",
			"2026-11-28T18:47:00+01:00",
			"--consented-by",
			"julian",
			"--method",
			"voice",
			"--approved-identity-sha256-prefix",
			createHash("sha256").update(OWNER).digest("hex").slice(0, 8),
			...importArgs,
		]);
		expect(consentRun.failure).toBe("");
		expect(consentRun.output).toContain('"bound": true');
		fixture({
			identity: OWNER,
			items: [
				{
					id: "raw-event-id-sentinel",
					iCalUID: "raw-ical-sentinel@google.test",
					recurringEventId: "raw-series-sentinel",
					originalStartTime: { dateTime: soon(5) },
					status: "confirmed",
					summary: "SENTINEL_TITLE_9d1 board review Action ID: PRIVATE_TITLE_MARKER_456",
					description: "SENTINEL_DESCRIPTION_4be\nJarvis-Action: alpha\nAction ID: PRIVATE_DESCRIPTION_123",
					location: "SENTINEL_LOCATION_77a",
					start: { dateTime: soon(5) },
					end: { dateTime: soon(6) },
					organizer: { self: true, email: "sentinel-organizer@example.test" },
					attendees: [
						{ email: "sentinel-attendee@example.test", responseStatus: "accepted" },
						{ email: OWNER, self: true, responseStatus: "accepted" },
					],
				},
				event("external-invite", 0, {
					start: { dateTime: soon(7) },
					end: { dateTime: soon(8) },
					organizer: { self: false, email: "sentinel-organizer@example.test" },
					attendees: [{ self: true, responseStatus: "accepted" }],
					description: "Action ID: PRIVATE_DESCRIPTION_123",
				}),
			],
		});
		writeFileSync(
			join(root, "descriptors.json"),
			JSON.stringify([{ actionId: "beta", deliverable: ["board review"], actorOrProject: ["SENTINEL_TITLE_9d1"] }]),
			{ mode: 0o600 },
		);
		const dry = await cli(importCli, [...importArgs, "--dry-run", "--actions", join(root, "descriptors.json")]);
		const real = await cli(importCli, [...importArgs, "--actions", join(root, "descriptors.json")]);
		expect(real.failure).toBe("");
		const report = JSON.parse(real.output);
		expect(report.totals).toMatchObject({ accountsRead: 1, events: 2, eligible: 2 });
		expect(report.totals.links).toMatchObject({ verified: 3, candidate: 2 });
		const paths = calendarImportPaths(root);
		const outputs = [consentRun.output, dry.output, dry.failure, real.output, real.failure];
		for (const name of readdirSync(paths.root)) outputs.push(readFileSync(join(paths.root, name), "utf8"));
		for (const output of outputs) for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
		const store = JSON.parse(readOwnerFile(paths.observations, "observations file") ?? "");
		const provider = calendarImportProvider({
			salt: readSalt(paths.salt) ?? Buffer.alloc(0),
			observations: () => store,
			decisions: () => [],
		});
		const queried = new Date();
		const livePoints = (signals: readonly CalendarSignal[] | "unavailable") =>
			signals === "unavailable"
				? -1
				: Math.max(0, ...signals.map((signal) => calendarPoints(signal, queried.getTime())));
		expect(livePoints(await provider.calendar("alpha", queried))).toBe(450);
		expect(livePoints(await provider.calendar("PRIVATE_DESCRIPTION_123", queried))).toBe(450);
	});

	it("prints fixed messages for malformed consent and decision files", async () => {
		const paths = calendarImportPaths(root);
		fixture({ identity: OWNER, items: [] });
		await bind();
		const consent = readFileSync(paths.consent, "utf8");
		writeFileSync(paths.consent, `{"SECRET_FRAGMENT_31": ${consent}`, { mode: 0o600 });
		const brokenConsent = await cli(importCli, [...importArgs, "--dry-run"]);
		expect(brokenConsent.failure).toContain("consent file is not valid");
		writeFileSync(paths.consent, consent, { mode: 0o600 });
		writeFileSync(paths.decisions, '{"version":1,"decisions":[{"SECRET_FRAGMENT_32":', { mode: 0o600 });
		const brokenDecisions = await cli(importCli, [...importArgs, "--dry-run"]);
		expect(brokenDecisions.failure).toContain("decisions file is not valid");
		for (const run of [brokenConsent, brokenDecisions])
			expect(`${run.output}\n${run.failure}`).not.toMatch(/SECRET_FRAGMENT|owner@example|sentinel\.owner/);
	});

	it("dry run reads and counts but writes no importer state; a stored partial import is refused", async () => {
		fixture({ identity: OWNER, items: [event("one", 3)] });
		await bind();
		const paths = calendarImportPaths(root);
		const options = { home: root, googleExecutable: nodeBinary, googleExecutableSha256: nodeDigest, now: at };
		const report = await runCalendarImport({ ...options, dryRun: true });
		expect(report.totals).toMatchObject({ accountsRead: 1, events: 1 });
		expect(readdirSync(paths.root).sort()).toEqual(["consent.json", "salt"]);
		const label = report.accounts.find((summary) => summary.state === "read")?.account ?? "";
		expect(label).toMatch(/^[a-f0-9]{12}$/);
		await expect(runCalendarImport({ ...options, dryRun: false, accounts: [label] })).rejects.toThrow(/--dry-run/);
		expect((await runCalendarImport({ ...options, dryRun: true, accounts: [label] })).totals.accountsRead).toBe(1);
	});

	it("binds the approved identity only when the step-1 prefix matches, and reads nothing else", async () => {
		fixture({ identity: "someone-else@example.test", items: [] });
		await expect(bind()).rejects.toThrow(/does not match the approved identity/);
		expect(readConsent(calendarImportPaths(root).consent).size).toBe(0);
		expect(JSON.parse(readFileSync(join(config, "request.json"), "utf8")).args.slice(0, 3)).toEqual([
			"calendar",
			"calendars",
			"get",
		]);
		fixture({ identity: OWNER, items: [] });
		expect(await bind()).toMatchObject({ bound: true });
	});

	it("recovers from an oversized earlier store", async () => {
		fixture({ identity: OWNER, items: [event("one", 3)] });
		await bind();
		const paths = calendarImportPaths(root);
		writeFileSync(paths.observations, "x".repeat(OWNER_FILE_MAX_BYTES + 1), { mode: 0o600 });
		const report = await runCalendarImport({
			home: root,
			googleExecutable: nodeBinary,
			googleExecutableSha256: nodeDigest,
			dryRun: false,
			now: at,
		});
		expect(report.totals.events).toBe(1);
		expect(readOwnerFile(paths.observations, "observations file")?.length).toBeLessThan(OWNER_FILE_MAX_BYTES);
	});
});

describe("consent and identity", () => {
	it("refuses an account without consent, and an unbound account, before any call", async () => {
		const calls: string[][] = [];
		const result = await importCalendars({
			accounts: [account("work"), account("other"), account("unbound")],
			consent: consentFor({ work: OWNER, unbound: null }),
			readerFor: () => fakeReader(OWNER, [], calls),
			salt,
			now: at,
		});
		expect(result.accounts.map((summary) => [summary.state, summary.reason])).toEqual([
			["read", undefined],
			["unavailable", "no-consent"],
			["unavailable", "unbound"],
		]);
		expect(calls.map((call) => call[1])).toEqual(["calendars", "events"]);
		expect(result.accounts[1]?.account).toBe(accountLabel(accountKey(salt, "other")));
	});
	it("makes only the metadata call when the primary calendar does not match the approved identity", async () => {
		const calls: string[][] = [];
		const result = await importCalendars({
			accounts: [account("work")],
			consent: consentFor({ work: OWNER }),
			readerFor: () => fakeReader("someone-else@example.test", [event("x", 3)], calls),
			salt,
			now: at,
		});
		expect(result.accounts[0]).toMatchObject({ state: "unavailable", reason: "identity-changed", events: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.slice(0, 3)).toEqual(["calendar", "calendars", "get"]);
	});
	it("skips a second folder for the same account", async () => {
		const result = await importCalendars({
			accounts: [account("work"), account("copy")],
			consent: consentFor({ work: OWNER, copy: OWNER }),
			readerFor: () => fakeReader(OWNER, []),
			salt,
			now: at,
		});
		expect(result.accounts.map((summary) => summary.reason)).toEqual([undefined, "duplicate-account"]);
	});
	it("stores consent owner-only with opaque keys and reads it back", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-consent-")));
		try {
			const path = join(root, "state", "consent.json");
			recordConsent(path, [...consentFor({ "julian.duru@example.test": OWNER }).values()]);
			expect(readFileSync(path, "utf8")).not.toContain("@");
			expect(readConsent(path).size).toBe(1);
			chmodSync(path, 0o644);
			expect(() => readConsent(path)).toThrow(/owner-only/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("local classification", () => {
	it("hashes complete marker tokens from plain or HTML text", () => {
		expect(parseMarkers(`Notes<br>Jarvis-Prep: alpha<br>Task ID: ${TASK}<br>Action ID: beta.`, salt)).toEqual([
			{ kind: "action", key: actionKey(salt, "alpha"), relation: "preparation" },
			{ kind: "task", key: taskKey(salt, TASK) },
			{ kind: "action", key: actionKey(salt, "beta") },
		]);
		expect(parseMarkers("Task ID: not-a-uuid, xAction ID: glued, Action ID: half/token", salt)).toEqual([]);
	});
	it("does not store a marker value from a title or an outside invite", async () => {
		const { store } = await importOne([
			event("title", 5, { summary: "Action ID: PRIVATE_DESCRIPTION_123" }),
			event("invite", 6, { organizer: { self: false }, description: "Action ID: PRIVATE_DESCRIPTION_123" }),
		]);
		expect(JSON.stringify(store)).not.toContain("PRIVATE_DESCRIPTION_123");
		expect(store.events.map((stored) => stored.markers.length)).toEqual([1, 1]);
	});
	it("classifies natural-language text only, not marker values", async () => {
		expect(classifyEvent("Investor demo", "")).toBe("preparation");
		expect(classifyEvent("Weekly sync", "")).toBe("agenda");
		expect(classifyEvent("Lunch", "Action ID: board-report")).toBe("none");
		expect(isJarvisBlock("Jarvis: Plan", `Task ID: ${TASK}\nReason: Focus`)).toBe(true);
		const { store } = await importOne([
			event("a", 10, { summary: "Weekly sync", description: "Action ID: board-report" }),
			event("b", 10, { summary: "Weekly sync", description: "Action ID: zz-plain" }),
		]);
		expect(points(await providerFor(store).calendar("board-report", at))).toBe(50);
		expect(points(await providerFor(store).calendar("zz-plain", at))).toBe(50);
	});
});

describe("matcher states", () => {
	const descriptors: ActionDescriptor[] = [
		{ actionId: "cand", deliverable: ["budget"], actorOrProject: ["acme"] },
		{ actionId: "weak", deliverable: ["roadmap"], actorOrProject: ["globex"] },
	];
	it("proposes a candidate only on a deliverable and an actor or project, with exact words", async () => {
		const { store } = await importOne(
			[
				event("both", 10, { summary: "Acme budget review" }),
				event("deliverable-only", 11, { summary: "Roadmap review" }),
				event("similar", 12, { summary: "Acme budgets" }),
			],
			{ descriptors },
		);
		expect(store.events.map((stored) => stored.candidates)).toEqual([[actionKey(salt, "cand")], [], []]);
		expect(evidenceFor(store, "cand")).toEqual({ state: "candidate", signals: [] });
		expect(evidenceFor(store, "weak")).toEqual({ state: "checked_no_match", signals: [] });
	});
	it("verifies an accepted candidate and flags a rejected explicit link as a conflict", async () => {
		const { store } = await importOne(
			[
				event("both", 10, { summary: "Acme budget review" }),
				event("marked", 20, { description: "Action ID: gamma" }),
			],
			{ descriptors },
		);
		const [both, marked] = store.events as [StoredEvent, StoredEvent];
		expect(resolveLink(both, subject("cand"), keyDecisions(salt, [accept("cand", both.key)]))).toEqual({
			state: "verified",
			relation: "preparation",
		});
		expect(
			resolveLink(marked, subject("gamma"), keyDecisions(salt, [accept("gamma", marked.key, "reject")])),
		).toEqual({
			state: "conflict",
		});
		const twoRelations = {
			...marked,
			markers: [
				{ kind: "action" as const, key: actionKey(salt, "gamma"), relation: "agenda" as const },
				{ kind: "action" as const, key: actionKey(salt, "gamma"), relation: "preparation" as const },
			],
		};
		expect(resolveLink(twoRelations, subject("gamma"), [])).toEqual({ state: "conflict" });
	});
	it("keys a recurring series by hashed series and original start; closing one occurrence leaves later ones open", async () => {
		const series = (id: string, hours: number) =>
			event(id, hours, {
				recurringEventId: "series-1",
				originalStartTime: { dateTime: iso(hours) },
				summary: "Weekly sync",
			});
		const { store } = await importOne([series("s1", 10), series("s2", 34)]);
		const [first, second] = store.events as [StoredEvent, StoredEvent];
		expect(first.series).toBe(second.series);
		expect(first.series).toMatch(/^[a-f0-9]{64}$/);
		const accepted: LinkDecision = {
			...accept("delta", ""),
			target: { kind: "series", key: first.series ?? "" },
			closedOccurrences: [first.occurrence ?? ""],
		};
		const keyed = keyDecisions(salt, [accepted]);
		expect(resolveLink(first, subject("delta"), keyed).state).toBe("checked_no_match");
		expect(resolveLink(second, subject("delta"), keyed)).toEqual({ state: "verified", relation: "agenda" });
		expect(await providerFor(store, [accepted]).calendar("delta", at)).toEqual([
			{ start: second.start, relation: "agenda" },
		]);
	});
	it("gives the summary and the provider the same task lookup", async () => {
		const item = event("task", 30, { description: `Task ID: ${TASK}`, summary: "Pitch" });
		const descriptorsWithTask: ActionDescriptor[] = [
			{ actionId: "epsilon", taskIds: [TASK], deliverable: [], actorOrProject: [] },
		];
		const result = await importOne([item], { descriptors: descriptorsWithTask });
		expect(result.accounts[0]?.links).toMatchObject({ verified: 1, checked_no_match: 0 });
		const provider = providerFor(result.store, [], (actionId) => (actionId === "epsilon" ? [TASK] : []));
		expect(points(await provider.calendar("epsilon", at))).toBe(300);
		const unknown = await importOne([item]);
		expect(unknown.accounts[0]?.links).toMatchObject({ verified: 0, checked_no_match: 1 });
		expect(await providerFor(unknown.store).calendar("epsilon", at)).toEqual([]);
	});
});

describe("exact points through the v3 calendar buckets", () => {
	const marked = (id: string, hours: number, marker: string, extra: Item = {}) =>
		event(id, hours, { description: `${marker}: ${id}`, ...extra });
	it.each([
		["prep-24h", marked("prep-24h", 24, "Jarvis-Prep"), 450],
		["prep-24h-01", marked("prep-24h-01", 24.01, "Jarvis-Prep"), 300],
		["prep-72h", marked("prep-72h", 72, "Jarvis-Prep"), 300],
		["prep-72h-01", marked("prep-72h-01", 72.01, "Jarvis-Prep"), 150],
		["prep-168h", marked("prep-168h", 168, "Jarvis-Prep"), 150],
		["agenda-100h", marked("agenda-100h", 100, "Jarvis-Agenda"), 50],
		["agenda-168h", marked("agenda-168h", 168, "Jarvis-Agenda"), 50],
		["prep-169h", marked("prep-169h", 169, "Jarvis-Prep"), 0],
		["past", marked("past", -2, "Jarvis-Prep"), 0],
		["canceled", marked("canceled", 5, "Jarvis-Prep", { status: "cancelled" }), 0],
		["tentative-event", marked("tentative-event", 5, "Jarvis-Prep", { status: "tentative" }), 0],
		[
			"jarvis-block",
			event("jarvis-block", 5, {
				summary: "Jarvis: Plan",
				description: `Task ID: ${TASK}\nReason: Focus\nJarvis-Prep: jarvis-block`,
			}),
			0,
		],
	] as const)("%s gives %i", async (actionId, item, expected) => {
		const { store } = await importOne([item]);
		expect(points(await providerFor(store).calendar(actionId, at))).toBe(expected);
	});
	it.each([
		["accepted", 450],
		["declined", 0],
		["tentative", 0],
		["needsAction", 0],
	] as const)("an accepted link on an invitation with reply %s gives %i", async (reply, expected) => {
		const { store } = await importOne([
			event("invite", 5, {
				organizer: { self: false },
				summary: "Board review",
				attendees: [{ self: true, responseStatus: reply }],
			}),
		]);
		const key = store.events[0]?.key ?? "";
		expect(points(await providerFor(store, [accept("linked", key)]).calendar("linked", at))).toBe(expected);
	});
	it("treats a marker in someone else's invite as a candidate scored 0", async () => {
		const { store } = await importOne([
			event("invite", 5, { organizer: { self: false }, description: "Jarvis-Prep: outside" }),
		]);
		expect(evidenceFor(store, "outside")).toEqual({ state: "candidate", signals: [] });
		expect(points(await providerFor(store).calendar("outside", at))).toBe(0);
	});
	it("gives a heuristic candidate 0 until accepted", async () => {
		const { store } = await importOne([event("x", 5, { summary: "Acme budget review" })], {
			descriptors: [{ actionId: "cand", deliverable: ["budget"], actorOrProject: ["acme"] }],
		});
		expect(await providerFor(store).calendar("cand", at)).toEqual([]);
	});
	it("uses the classifier when the marker names no relation", async () => {
		const { store } = await importOne([
			event("a", 30, { summary: "Investor demo", description: "Action ID: classified" }),
			event("b", 10, { summary: "Lunch", description: "Action ID: plain" }),
		]);
		expect(points(await providerFor(store).calendar("classified", at))).toBe(300);
		expect(points(await providerFor(store).calendar("plain", at))).toBe(50);
	});
	it.each([
		["declined copy first", ["a", "b"]],
		["organised copy first", ["b", "a"]],
	])("keeps one signal per meeting copy after matching (%s)", async (_label, order) => {
		const copies: Record<string, Item> = {
			a: event("a-copy", 5, {
				iCalUID: "same@google.test",
				organizer: { self: false },
				attendees: [{ self: true, responseStatus: "declined" }],
			}),
			b: event("b-copy", 5, { iCalUID: "same@google.test", description: "Jarvis-Prep: dup" }),
		};
		const result = await importCalendars({
			accounts: order.map((slug) => account(slug)),
			consent: consentFor({ a: "a@example.test", b: "b@example.test" }),
			readerFor: (slug) => fakeReader(`${slug}@example.test`, [copies[slug] ?? {}]),
			salt,
			now: at,
		});
		expect(new Set(result.store.events.map((stored) => stored.copyGroup)).size).toBe(1);
		expect(result.accounts.reduce((sum, summary) => sum + summary.flags.copies, 0)).toBe(1);
		const signals = await providerFor(result.store).calendar("dup", at);
		expect(signals).toHaveLength(1);
		expect(points(signals)).toBe(450);
	});
});

describe("availability", () => {
	it("is unavailable when stale, missing, from the future, or when an unread account could hide a match", async () => {
		const { store } = await importOne([]);
		expect(await providerFor(store).calendar("none", at)).toEqual([]);
		expect(await providerFor(store).calendar("none", new Date(at.getTime() + 3 * hour))).toBe("unavailable");
		expect(await providerFor(store).calendar("none", new Date(at.getTime() - hour))).toBe("unavailable");
		expect(
			await calendarImportProvider({ salt, observations: () => undefined, decisions: () => [] }).calendar("x", at),
		).toBe("unavailable");
		const partial = await importCalendars({
			accounts: [account("work"), account("blocked")],
			consent: consentFor({ work: OWNER, blocked: "blocked@example.test" }),
			readerFor: (slug) =>
				slug === "work"
					? fakeReader(OWNER, [event("e", 5, { description: "Jarvis-Prep: seen" })])
					: () => Promise.reject(new Error("no login")),
			salt,
			now: at,
		});
		expect(partial.accounts.map((summary) => summary.reason)).toEqual([undefined, "failed"]);
		expect(await providerFor(partial.store).calendar("unseen", at)).toBe("unavailable");
		expect(points(await providerFor(partial.store).calendar("seen", at))).toBe(450);
	});
	it("is unavailable when no account was checked", async () => {
		const empty = await importCalendars({
			accounts: [],
			consent: new Map(),
			readerFor: () => fakeReader(OWNER, []),
			salt,
			now: at,
		});
		expect(evidenceFor(empty.store, "x").state).toBe("unavailable");
		const refused = await importCalendars({
			accounts: [account("work")],
			consent: new Map(),
			readerFor: () => fakeReader(OWNER, []),
			salt,
			now: at,
		});
		expect(evidenceFor(refused.store, "x").state).toBe("unavailable");
	});
	it("reports a change only when the opaque observations change", async () => {
		const first = await importOne([event("a", 5)]);
		const same = await importCalendars({
			accounts: [account("work")],
			consent: consentFor({ work: OWNER }),
			readerFor: () => fakeReader(OWNER, [event("a", 5)]),
			salt,
			previousFingerprint: first.store.fingerprint,
			now: at,
		});
		expect(same.changed).toBe(false);
	});
});

describe("owner files", () => {
	let root: string;
	beforeAll(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-files-")));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	it("writes and reads a file at the limit and refuses one byte more, keeping the previous file", () => {
		const path = join(root, "state", "observations.json");
		writeOwnerFile(path, "x".repeat(OWNER_FILE_MAX_BYTES), "observations file");
		expect(readOwnerFile(path, "observations file")?.length).toBe(OWNER_FILE_MAX_BYTES);
		writeOwnerFile(path, "small", "observations file");
		expect(() => writeOwnerFile(path, "x".repeat(OWNER_FILE_MAX_BYTES + 1), "observations file")).toThrow(
			/too large; the previous file is kept/,
		);
		expect(readOwnerFile(path, "observations file")).toBe("small");
	});
});

describe("schedule definition", () => {
	it("renders a launchd job that runs the importer every 30 minutes with the approved digest", () => {
		const plist = renderCalendarImportPlist({
			nodePath: "/opt/node",
			cliPath: "/opt/cli.js",
			googleExecutable: "/opt/gws",
			googleExecutableSha256: "a".repeat(64),
			home: "/Users/someone",
		});
		expect(plist).toContain("<string>com.flow-harness.calendar-import</string>");
		expect(plist).toContain("<string>import</string>");
		expect(plist).toContain(`<string>--google-executable-sha256</string>\n\t\t<string>${"a".repeat(64)}</string>`);
		expect(plist).toContain("<integer>1800</integer>");
		expect(plist).toContain("<key>Umask</key>\n\t<integer>63</integer>");
		expect(plist).not.toContain("--dry-run");
		expect(() =>
			renderCalendarImportPlist({
				nodePath: "node",
				cliPath: "/c",
				googleExecutable: "/g",
				googleExecutableSha256: "a".repeat(64),
				home: "/h",
			}),
		).toThrow(/absolute/);
	});
});
