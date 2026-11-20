/**
 * Owner jobs on the Jobs list: the `jobs.json` reader, the rows it adds, and
 * the launchd labels the sources ask about. Every probe here is a fake.
 */
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPortalValue, type JobListData, PortalApiSchemas, type TileResult } from "@harnessy/core/read-model";
import { afterEach, describe, expect, it } from "vitest";
import { FIXED_JOB_IDS, type JobsContext, jobDefinitions, OWNER_JOBS_FAULT_ID, readJobs } from "../src/portal/jobs.ts";
import { OWNER_JOBS_FILE, OWNER_JOBS_MAX, readOwnerJobs } from "../src/portal/owner-jobs.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { cleanupPortalFixtures, FIXTURE_NOW, tempDir } from "./support/portal-fixture.ts";

afterEach(cleanupPortalFixtures);

const LABEL = "com.example.notes-sync";
const at = FIXTURE_NOW.toISOString();
const job = (overrides: Record<string, unknown> = {}) => ({
	id: "notes-sync",
	name: "Notes sync",
	label: LABEL,
	schedule: { hour: 7, minute: 0 },
	notes: ["Copies new notes to the shared list."],
	run: "/usr/bin/python3 -I /home/owner/sync.py",
	...overrides,
});
const write = (value: unknown): string => {
	const path = join(tempDir("owner-jobs"), OWNER_JOBS_FILE);
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
};
const read = (value: unknown) => readOwnerJobs(write(value), FIXED_JOB_IDS);
const context = (overrides: Partial<JobsContext> = {}): JobsContext => ({
	now: FIXTURE_NOW,
	homeRoot: tempDir("owner-jobs-home"),
	health: {},
	probePort: async () => false,
	workspaceRoot: null,
	meetingPort: null,
	meetingStatePath: null,
	communityPort: null,
	communityStatePath: null,
	...overrides,
});

describe("owner jobs file", () => {
	it("reads a valid list and gives none for a missing file", () => {
		expect(readOwnerJobs(join(tempDir("none"), OWNER_JOBS_FILE), FIXED_JOB_IDS)).toEqual({ jobs: [], problem: null });
		expect(
			read({ version: 1, jobs: [job(), job({ id: "b", label: "com.example.b", schedule: { everySeconds: 300 } })] }),
		).toEqual({
			jobs: [
				{
					id: "notes-sync",
					name: "Notes sync",
					label: LABEL,
					schedule: { kind: "calendar", hour: 7, minute: 0, weekday: null },
					notes: ["Copies new notes to the shared list."],
					run: "/usr/bin/python3 -I /home/owner/sync.py",
				},
				{
					id: "b",
					name: "Notes sync",
					label: "com.example.b",
					schedule: { kind: "interval", seconds: 300 },
					notes: ["Copies new notes to the shared list."],
					run: "/usr/bin/python3 -I /home/owner/sync.py",
				},
			],
			problem: null,
		});
		expect(read({ version: 1, jobs: [{ id: "bare", name: "Bare", label: "com.example.bare" }] }).jobs).toEqual([
			{ id: "bare", name: "Bare", label: "com.example.bare", schedule: null, notes: [], run: null },
		]);
	});

	it("refuses the whole file when one entry breaks a rule", () => {
		const refused = (entry: unknown) =>
			read({ version: 1, jobs: [job({ id: "good", label: "com.example.good" }), entry] });
		for (const entry of [
			job({ id: "Daily Brief" }),
			job({ id: "daily-brief" }),
			job({ id: OWNER_JOBS_FAULT_ID }),
			job({ label: "org.harnessy.portal" }),
			job({ label: "com.flow-harness.community-review-v2" }),
			job({ label: "bad label" }),
			job({ name: "" }),
			job({ name: "x".repeat(65) }),
			job({ run: "echo a‮b" }),
			job({ run: 7 }),
			job({ notes: ["a", "b", "c", "d", "e"] }),
			job({ notes: [3] }),
			job({ schedule: { hour: 24, minute: 0 } }),
			job({ schedule: { hour: 7, minute: 0, weekday: 7 } }),
			job({ schedule: { everySeconds: 0 } }),
			job({ schedule: { everySeconds: 60, hour: 1 } }),
			job({ environment: { TOKEN: "x" } }),
			job({ id: "good" }),
			job({ id: "other", label: "com.example.good" }),
			"not a job",
		])
			expect([entry, refused(entry)]).toEqual([entry, { jobs: [], problem: "schema_invalid" }]);
		expect(read({ version: 2, jobs: [] }).problem).toBe("schema_invalid");
		expect(read({ version: 1, jobs: [], extra: true }).problem).toBe("schema_invalid");
		expect(read([job()]).problem).toBe("schema_invalid");
		expect(
			read({
				version: 1,
				jobs: Array.from({ length: OWNER_JOBS_MAX + 1 }, (_, index) =>
					job({ id: `j${index}`, label: `com.example.j${index}` }),
				),
			}).problem,
		).toBe("schema_invalid");
	});

	it("names an unreadable, oversize or unsafe file", () => {
		expect(read("{ not json").problem).toBe("json_invalid");
		expect(read(`{"version":1,"jobs":[],"pad":"${"x".repeat(70 * 1024)}"}`).problem).toBe("file_too_large");
		const dir = tempDir("owner-jobs-link");
		symlinkSync(write({ version: 1, jobs: [job()] }), join(dir, OWNER_JOBS_FILE));
		expect(readOwnerJobs(join(dir, OWNER_JOBS_FILE), FIXED_JOB_IDS)).toEqual({ jobs: [], problem: "file_unsafe" });
	});
});

describe("owner jobs on the Jobs list", () => {
	const ownerJobs = read({
		version: 1,
		jobs: [job(), job({ id: "bare", label: "com.example.bare", schedule: null, run: null })],
	});
	const health = (lastExitCode: number | null): TileResult<never> =>
		({
			state: "ok",
			data: { label: LABEL, state: "not running", pid: null, lastExitCode, lastLog: null },
			readAt: at,
		}) as unknown as TileResult<never>;
	const list = async (overrides: Partial<JobsContext>): Promise<JobListData> => {
		const jobs = await readJobs(context(overrides));
		expect(
			checkPortalValue(PortalApiSchemas.Jobs.properties.tiles.properties.jobs, {
				state: "ok",
				data: jobs,
				readAt: at,
			}),
		).toBe(true);
		return jobs;
	};

	it("keeps every fixed row and its id, and adds owner rows after them", () => {
		const fixed = jobDefinitions(context()).map((definition) => definition.id);
		expect([...FIXED_JOB_IDS].filter((id) => id !== OWNER_JOBS_FAULT_ID)).toEqual(fixed);
		expect(jobDefinitions(context({ ownerJobs })).map((definition) => definition.id)).toEqual([
			...fixed,
			"notes-sync",
			"bare",
		]);
	});

	it("reports a passing, a failing and an unloaded owner job", async () => {
		const passing = await list({ ownerJobs, health: { [LABEL]: health(0) } });
		expect(passing.jobs.find((entry) => entry.id === "notes-sync")).toMatchObject({
			name: "Notes sync",
			label: LABEL,
			kind: "timed",
			schedule: "07:00 daily",
			nextRun: "2026-10-18T06:00:00.000Z",
			health: "ok",
			healthReason: "waiting for next run",
			neverPause: false,
			controls: [{ kind: "copy", label: "Run now", target: "/usr/bin/python3 -I /home/owner/sync.py", note: null }],
		});
		expect(passing.jobs.find((entry) => entry.id === "notes-sync")!.notes).toEqual([
			"Copies new notes to the shared list.",
			"Your own job, listed in jobs.json. Harnessy only reports it.",
		]);
		expect(passing.jobs.find((entry) => entry.id === "bare")).toMatchObject({
			schedule: null,
			nextRun: null,
			controls: [],
			health: "unknown",
		});
		const failing = await list({ ownerJobs, health: { [LABEL]: health(1) } });
		expect(failing.jobs.find((entry) => entry.id === "notes-sync")).toMatchObject({
			health: "error",
			healthReason: "last exit 1",
		});
		expect(failing.errorCount).toBe(passing.errorCount + 1);
		const unloaded = await list({
			ownerJobs,
			health: { [LABEL]: { state: "missing", reason: "not_loaded", readAt: at } },
		});
		expect(unloaded.jobs.find((entry) => entry.id === "notes-sync")).toMatchObject({
			health: "error",
			healthReason: "not loaded",
			nextRun: null,
		});
	});

	it("shows one failing row when the file cannot be used", async () => {
		const broken = await list({ ownerJobs: { jobs: [], problem: "schema_invalid" } });
		expect(broken.jobs.at(-1)).toMatchObject({
			id: OWNER_JOBS_FAULT_ID,
			label: null,
			health: "error",
			healthReason: "schema_invalid",
			controls: [],
			programArguments: null,
		});
		expect(broken.errorCount).toBe((await list({})).errorCount + 1);
	});

	it("asks launchd about owner labels only when the sources are given the file", async () => {
		const sources = (ownerJobsPath?: string) => {
			const asked: string[] = [];
			return {
				asked,
				sources: createPortalSources({
					homeRoot: tempDir("owner-jobs-sources"),
					env: {},
					probe: (label) => {
						asked.push(label);
						return label === LABEL
							? {
									status: 0,
									stdout: `gui/501/${LABEL} = {\n\tstate = not running\n\tlast exit code = 1\n}\n`,
									stderr: "",
								}
							: { status: 113, stdout: "", stderr: "Could not find service" };
					},
					timeoutMs: 250,
					clock: () => FIXTURE_NOW,
					probePort: async () => false,
					...(ownerJobsPath === undefined ? {} : { ownerJobsPath }),
				}),
			};
		};
		const without = sources();
		const plain = (await without.sources.jobs()).jobs as TileResult<JobListData>;
		expect(without.asked).not.toContain(LABEL);
		expect(plain.data!.jobs.map((entry) => entry.id)).not.toContain("notes-sync");
		const withFile = sources(write({ version: 1, jobs: [job()] }));
		const owned = (await withFile.sources.jobs()).jobs as TileResult<JobListData>;
		expect(withFile.asked).toContain(LABEL);
		expect(owned.data!.jobs.find((entry) => entry.id === "notes-sync")).toMatchObject({
			health: "error",
			healthReason: "last exit 1",
			lastExitCode: 1,
		});
	});
});
