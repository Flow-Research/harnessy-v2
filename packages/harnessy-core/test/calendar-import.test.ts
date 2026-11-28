import {
	chmodSync,
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyEvent, isJarvisBlock, parseMarkers } from "../src/jarvis/calendar-import/classify.ts";
import { type ConsentRecord, readConsent, recordConsent } from "../src/jarvis/calendar-import/consent.ts";
import { assertReadOnlyCall, type CalendarRead, gwsCalendarReader } from "../src/jarvis/calendar-import/gws-reader.ts";
import { importCalendars } from "../src/jarvis/calendar-import/importer.ts";
import { type ActionDescriptor, resolveLink } from "../src/jarvis/calendar-import/match.ts";
import type { LinkDecision, ObservationStore, StoredEvent } from "../src/jarvis/calendar-import/observations.ts";
import { readOwnerFile } from "../src/jarvis/calendar-import/owner-file.ts";
import {
	type CalendarSignal,
	calendarEvidence,
	calendarImportProvider,
} from "../src/jarvis/calendar-import/provider.ts";
import { calendarImportPaths, runCalendarImport } from "../src/jarvis/calendar-import/run.ts";
import { renderCalendarImportPlist } from "../src/jarvis/calendar-import/schedule.ts";

const hour = 3_600_000;
const at = new Date("2026-11-28T12:00:00.000Z");
const iso = (hours: number) => new Date(at.getTime() + hours * hour).toISOString();
const salt = Buffer.alloc(32, 7);

// Local copy of `calendarPoints` from PR #221 (`tasks/priority.ts`), the v3 spec
// buckets. When #221 merges, these tests import the engine function instead.
function calendarPoints(event: CalendarSignal, now: number) {
	const hours = (Date.parse(event.start) - now) / hour;
	if (!(hours >= 0 && hours <= 168)) return 0;
	if (event.relation === "agenda") return 50;
	if (hours <= 24) return 450;
	return hours <= 72 ? 300 : 150;
}
const engineCalendarPoints = (signals: readonly CalendarSignal[] | "unavailable") =>
	signals === "unavailable" ? 0 : Math.max(0, ...signals.map((signal) => calendarPoints(signal, at.getTime())));

const consentFor = (...slugs: string[]): ReadonlyMap<string, ConsentRecord> =>
	new Map(
		slugs.map((slug) => [
			slug,
			{
				slug,
				scope: "calendar.read",
				consentedAt: "2026-11-28T18:47:00+01:00",
				consentedBy: "julian",
				method: "voice",
			},
		]),
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
		accounts: ["work"],
		consent: consentFor("work"),
		readerFor: () => fakeReader("owner@example.test", items),
		salt,
		bindings: {},
		now: at,
		...options,
	});

const providerFor = (store: ObservationStore, decisions: LinkDecision[] = []) =>
	calendarImportProvider({ observations: () => store, decisions: () => decisions });

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

describe.runIf(process.platform !== "win32")("gws process boundary", () => {
	let root: string;
	let config: string;
	let executable: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-import-")));
		config = join(root, ".config", "gws-work");
		mkdirSync(config, { recursive: true, mode: 0o700 });
		executable = join(root, "synthetic-gws");
		writeFileSync(
			executable,
			`#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const config = process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
writeFileSync(config + '/request.json', JSON.stringify({ args: process.argv.slice(2), token: Boolean(process.env.GOOGLE_WORKSPACE_CLI_TOKEN), credentials: Boolean(process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE) }));
const fixture = JSON.parse(readFileSync(config + '/fixture.json', 'utf8'));
if (fixture.exit) { console.log(JSON.stringify({ error: { code: fixture.code, message: 'PRIVATE_PROVIDER_DETAIL owner@example.test' } })); console.error('PRIVATE_PROVIDER_DETAIL'); process.exit(fixture.exit); }
console.log(JSON.stringify(process.argv[3] === 'calendars' ? { id: fixture.identity } : { items: fixture.items }));
`,
			{ mode: 0o700 },
		);
		vi.stubEnv("HOME", root);
		vi.stubEnv("GOOGLE_WORKSPACE_CLI_TOKEN", "ambient-token");
		vi.stubEnv("GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE", "/ambient/credentials.json");
		vi.stubEnv(
			"NODE_OPTIONS",
			`--import=${fileURLToPath(new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url))}`,
		);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});
	const fixture = (value: unknown) => writeFileSync(join(config, "fixture.json"), JSON.stringify(value));

	it("strips ambient credentials and asks only for the needed fields", async () => {
		fixture({ identity: "owner@example.test", items: [] });
		const read = gwsCalendarReader(executable, config);
		await read(["calendar", "events", "list", "--params", JSON.stringify({ calendarId: "primary" })]);
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
		const read = gwsCalendarReader(executable, config);
		const failure = await read(["calendar", "calendars", "get", "--params", '{"calendarId":"primary"}']).catch(
			(cause: unknown) => cause,
		);
		expect(failure).toMatchObject({ reason });
		expect(String(failure)).not.toMatch(/PRIVATE_PROVIDER_DETAIL|owner@example/);
	});
	it("refuses the npm launcher, a shared config folder, and a write before any process starts", () => {
		const launcher = join(root, "run.js");
		writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o700 });
		expect(() => gwsCalendarReader(launcher, config)).toThrow(/native gws binary/);
		chmodSync(config, 0o755);
		expect(() => gwsCalendarReader(executable, config)).toThrow(/owner-only/);
		chmodSync(config, 0o700);
		const read = gwsCalendarReader(executable, config);
		return expect(read(["calendar", "events", "insert", "--params", '{"calendarId":"primary"}'])).rejects.toThrow(
			/read-only/,
		);
	});

	it("keeps sentinel titles, descriptions, locations and addresses out of every output and file", async () => {
		const sentinels = [
			"SENTINEL_TITLE_9d1",
			"SENTINEL_DESCRIPTION_4be",
			"SENTINEL_LOCATION_77a",
			"sentinel-attendee@example.test",
			"sentinel-organizer@example.test",
			"owner@example.test",
			"raw-event-id-sentinel",
			"raw-series-sentinel",
			"raw-ical-sentinel",
		];
		fixture({
			identity: "owner@example.test",
			items: [
				{
					id: "raw-event-id-sentinel",
					iCalUID: "raw-ical-sentinel@google.test",
					recurringEventId: "raw-series-sentinel",
					originalStartTime: { dateTime: iso(5) },
					status: "confirmed",
					summary: "SENTINEL_TITLE_9d1 board review",
					description: "SENTINEL_DESCRIPTION_4be\nJarvis-Action: alpha",
					location: "SENTINEL_LOCATION_77a",
					start: { dateTime: iso(5) },
					end: { dateTime: iso(6) },
					organizer: { self: true, email: "sentinel-organizer@example.test" },
					attendees: [
						{ email: "sentinel-attendee@example.test", responseStatus: "accepted" },
						{ email: "owner@example.test", self: true, responseStatus: "accepted" },
					],
				},
			],
		});
		const paths = calendarImportPaths(root);
		recordConsent(paths.consent, [...consentFor("work").values()]);
		writeFileSync(
			join(root, "descriptors.json"),
			JSON.stringify([{ actionId: "beta", deliverable: ["board review"], actorOrProject: ["SENTINEL_TITLE_9d1"] }]),
			{ mode: 0o600 },
		);
		const report = await runCalendarImport({
			home: root,
			googleExecutable: executable,
			dryRun: false,
			descriptorsPath: join(root, "descriptors.json"),
			now: at,
		});
		expect(report.totals).toMatchObject({ accountsRead: 1, events: 1, eligible: 1 });
		expect(report.totals.links).toMatchObject({ verified: 1, candidate: 1 });
		const outputs = [JSON.stringify(report)];
		for (const name of readdirSync(paths.root)) outputs.push(readFileSync(join(paths.root, name), "utf8"));
		for (const output of outputs) for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
		const store = JSON.parse(readOwnerFile(paths.observations) ?? "");
		expect(store.events[0]).toMatchObject({ markers: [{ kind: "action", id: "alpha" }], candidates: ["beta"] });
		const signals = await calendarImportProvider({
			observations: () => store,
			decisions: () => [],
		}).calendar("alpha", at);
		expect(engineCalendarPoints(signals)).toBe(450);
	});

	it("dry run reads and counts but writes no importer state", async () => {
		fixture({ identity: "owner@example.test", items: [event("one", 3)] });
		const paths = calendarImportPaths(root);
		recordConsent(paths.consent, [...consentFor("work").values()]);
		const report = await runCalendarImport({ home: root, googleExecutable: executable, dryRun: true, now: at });
		expect(report.totals).toMatchObject({ accountsRead: 1, events: 1 });
		expect(readdirSync(paths.root)).toEqual(["consent.json"]);
	});
});

describe("consent and identity", () => {
	it("refuses an account without consent before any call", async () => {
		const calls: string[][] = [];
		const result = await importCalendars({
			accounts: ["work", "other"],
			consent: consentFor("work"),
			readerFor: (slug) =>
				slug === "work" ? fakeReader("owner@example.test", [], calls) : fakeReader("x@y", [], calls),
			salt,
			bindings: {},
			now: at,
		});
		expect(result.accounts.map((account) => [account.slug, account.state, account.reason])).toEqual([
			["work", "read", undefined],
			["other", "unavailable", "no-consent"],
		]);
		expect(calls).toHaveLength(2);
	});
	it("refuses a changed primary calendar and a second slug for the same account", async () => {
		const first = await importOne([]);
		const result = await importCalendars({
			accounts: ["work", "copy"],
			consent: consentFor("work", "copy"),
			readerFor: (slug) => fakeReader(slug === "work" ? "someone-else@example.test" : "owner@example.test", []),
			salt,
			bindings: first.bindings,
			now: at,
		});
		expect(result.accounts.map((account) => account.reason)).toEqual(["identity-changed", undefined]);
		const twice = await importCalendars({
			accounts: ["work", "copy"],
			consent: consentFor("work", "copy"),
			readerFor: () => fakeReader("owner@example.test", []),
			salt,
			bindings: {},
			now: at,
		});
		expect(twice.accounts.map((account) => account.reason)).toEqual([undefined, "duplicate-account"]);
	});
	it("stores consent owner-only and reads it back", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-consent-")));
		try {
			const path = join(root, "state", "consent.json");
			recordConsent(path, [...consentFor("work").values()]);
			expect([...readConsent(path).keys()]).toEqual(["work"]);
			chmodSync(path, 0o644);
			expect(() => readConsent(path)).toThrow(/owner-only/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("local classification", () => {
	it("parses explicit Jarvis markers from plain or HTML descriptions", () => {
		expect(
			parseMarkers(
				"Notes<br>Jarvis-Prep: alpha<br>Task ID: 0f8fad5b-d9cb-469f-a165-70867728950e<br>Action ID: beta.",
			),
		).toEqual([
			{ kind: "action", id: "alpha", relation: "preparation" },
			{ kind: "task", id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
			{ kind: "action", id: "beta" },
		]);
		expect(parseMarkers("Task ID: not-a-uuid and taskid: x")).toEqual([]);
	});
	it("classifies preparation, agenda and none deterministically", () => {
		expect(classifyEvent("Investor demo", "")).toBe("preparation");
		expect(classifyEvent("Weekly sync", "")).toBe("agenda");
		expect(classifyEvent("Lunch", "")).toBe("none");
		expect(isJarvisBlock("Jarvis: Plan", "Task ID: 0f8fad5b-d9cb-469f-a165-70867728950e\nReason: Focus")).toBe(true);
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
		expect(store.events.map((stored) => stored.candidates)).toEqual([["cand"], [], []]);
		const evidence = (actionId: string) =>
			calendarEvidence({ observations: () => store, decisions: () => [] }, actionId, at);
		expect(evidence("cand")).toEqual({ state: "candidate", signals: [] });
		expect(evidence("weak")).toEqual({ state: "checked_no_match", signals: [] });
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
		const decision = (actionId: string, key: string, kind: "accept" | "reject"): LinkDecision => ({
			actionId,
			target: { kind: "event", key },
			decision: kind,
			decidedBy: "julian",
			decidedAt: iso(-1),
			closedOccurrences: [],
		});
		expect(resolveLink(both, "cand", [decision("cand", both.key, "accept")])).toEqual({
			state: "verified",
			relation: "preparation",
		});
		expect(resolveLink(marked, "gamma", [decision("gamma", marked.key, "reject")])).toEqual({ state: "conflict" });
		expect(
			resolveLink(
				{
					...marked,
					markers: [
						{ kind: "action", id: "gamma", relation: "agenda" },
						{ kind: "action", id: "gamma", relation: "preparation" },
					],
				},
				"gamma",
				[],
			),
		).toEqual({ state: "conflict" });
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
			actionId: "delta",
			target: { kind: "series", key: first.series ?? "" },
			decision: "accept",
			decidedBy: "julian",
			decidedAt: iso(-1),
			closedOccurrences: [first.occurrence ?? ""],
		};
		expect(resolveLink(first, "delta", [accepted]).state).toBe("checked_no_match");
		expect(resolveLink(second, "delta", [accepted])).toEqual({ state: "verified", relation: "agenda" });
		expect(await providerFor(store, [accepted]).calendar("delta", at)).toEqual([
			{ start: second.start, relation: "agenda" },
		]);
	});
	it("resolves a task marker through the task's actions", async () => {
		const { store } = await importOne([
			event("task", 30, { description: "Task ID: 0f8fad5b-d9cb-469f-a165-70867728950e", summary: "Pitch" }),
		]);
		const provider = calendarImportProvider({
			observations: () => store,
			decisions: () => [],
			actionsOfTask: (taskId) => (taskId === "0f8fad5b-d9cb-469f-a165-70867728950e" ? ["epsilon"] : []),
		});
		expect(engineCalendarPoints(await provider.calendar("epsilon", at))).toBe(300);
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
			"declined",
			marked("declined", 5, "Jarvis-Prep", {
				organizer: { self: false },
				attendees: [{ self: true, responseStatus: "declined" }],
			}),
			0,
		],
		[
			"tentative-reply",
			marked("tentative-reply", 5, "Jarvis-Prep", {
				organizer: { self: false },
				attendees: [{ self: true, responseStatus: "tentative" }],
			}),
			0,
		],
		[
			"unanswered",
			marked("unanswered", 5, "Jarvis-Prep", {
				organizer: { self: false },
				attendees: [{ self: true, responseStatus: "needsAction" }],
			}),
			0,
		],
		[
			"jarvis-block",
			event("jarvis-block", 5, {
				summary: "Jarvis: Plan",
				description: "Task ID: 0f8fad5b-d9cb-469f-a165-70867728950e\nReason: Focus\nJarvis-Prep: jarvis-block",
			}),
			0,
		],
	] as const)("%s gives %i", async (actionId, item, points) => {
		const { store } = await importOne([item]);
		expect(engineCalendarPoints(await providerFor(store).calendar(actionId, at))).toBe(points);
	});
	it("treats a marker in someone else's invite as a candidate scored 0", async () => {
		const { store } = await importOne([
			event("invite", 5, { organizer: { self: false }, description: "Jarvis-Prep: outside" }),
		]);
		const evidence = calendarEvidence({ observations: () => store, decisions: () => [] }, "outside", at);
		expect(evidence).toEqual({ state: "candidate", signals: [] });
		expect(engineCalendarPoints(await providerFor(store).calendar("outside", at))).toBe(0);
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
		expect(engineCalendarPoints(await providerFor(store).calendar("classified", at))).toBe(300);
		expect(engineCalendarPoints(await providerFor(store).calendar("plain", at))).toBe(50);
	});
	it("drops a duplicate copy of the same event seen through two accounts", async () => {
		const item = event("shared", 5, { iCalUID: "same@google.test", description: "Jarvis-Prep: dup" });
		const result = await importCalendars({
			accounts: ["a", "b"],
			consent: consentFor("a", "b"),
			readerFor: (slug) => fakeReader(`${slug}@example.test`, [{ ...item, id: `${slug}-copy` }]),
			salt,
			bindings: {},
			now: at,
		});
		expect(result.store.events.filter((stored) => stored.duplicateOf !== null)).toHaveLength(1);
		expect(await providerFor(result.store).calendar("dup", at)).toHaveLength(1);
	});
});

describe("availability", () => {
	it("is unavailable when stale, missing, from the future, or when an unread account could hide a match", async () => {
		const { store } = await importOne([]);
		expect(await providerFor(store).calendar("none", at)).toEqual([]);
		const later = new Date(at.getTime() + 3 * hour);
		expect(await providerFor(store).calendar("none", later)).toBe("unavailable");
		expect(await providerFor(store).calendar("none", new Date(at.getTime() - hour))).toBe("unavailable");
		expect(
			await calendarImportProvider({ observations: () => undefined, decisions: () => [] }).calendar("x", at),
		).toBe("unavailable");
		const partial = await importCalendars({
			accounts: ["work", "blocked"],
			consent: consentFor("work", "blocked"),
			readerFor: (slug) =>
				slug === "work"
					? fakeReader("owner@example.test", [event("e", 5, { description: "Jarvis-Prep: seen" })])
					: () => Promise.reject(new Error("no login")),
			salt,
			bindings: {},
			now: at,
		});
		expect(partial.accounts.map((account) => account.reason)).toEqual([undefined, "failed"]);
		expect(await providerFor(partial.store).calendar("unseen", at)).toBe("unavailable");
		expect(engineCalendarPoints(await providerFor(partial.store).calendar("seen", at))).toBe(450);
	});
	it("reports a change only when the opaque observations change", async () => {
		const first = await importOne([event("a", 5)]);
		const same = await importCalendars({
			accounts: ["work"],
			consent: consentFor("work"),
			readerFor: () => fakeReader("owner@example.test", [event("a", 5)]),
			salt,
			bindings: {},
			previousFingerprint: first.store.fingerprint,
			now: at,
		});
		expect(same.changed).toBe(false);
	});
});

describe("schedule definition", () => {
	it("renders a launchd job that runs the importer every 30 minutes with a private umask", () => {
		const plist = renderCalendarImportPlist({
			nodePath: "/opt/node",
			cliPath: "/opt/cli.js",
			googleExecutable: "/opt/gws",
			home: "/Users/someone",
		});
		expect(plist).toContain("<string>com.flow-harness.calendar-import</string>");
		expect(plist).toContain("<string>import</string>");
		expect(plist).toContain("<integer>1800</integer>");
		expect(plist).toContain("<key>Umask</key>\n\t<integer>63</integer>");
		expect(plist).not.toContain("--dry-run");
		expect(() =>
			renderCalendarImportPlist({ nodePath: "node", cliPath: "/c", googleExecutable: "/g", home: "/h" }),
		).toThrow(/absolute/);
	});
});
