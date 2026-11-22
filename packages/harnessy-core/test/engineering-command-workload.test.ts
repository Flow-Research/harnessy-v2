import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createHarnessyCommandWorkload } from "../src/engineering/command-workload.ts";
import { EngineeringStore } from "../src/engineering/store.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.skipIf(process.versions.node !== "22.22.2" || process.versions.sqlite !== "3.51.2")(
	"constructs actual CLI preparation fixtures with protected successes and refusals",
	async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "command-fixtures-")));
		roots.push(root);
		const workload = await createHarnessyCommandWorkload("preparation-plan", join(root, "fixtures"));
		expect(workload.completedWork).toBe(16);
		expect(JSON.parse(workload.input).cases).toHaveLength(16);
		expect(workload.scope).toMatch(/Not live tool admission/);
		expect(workload.input).not.toContain('"expected"');
		expect(() =>
			workload.validateOutput(
				'{"operations":[]}',
				{ kind: "sample", argv: [], side: "baseline" },
				{
					runId: "",
					grantId: "",
					sourceRevision: "",
					sourceTreeDigest: "",
					workloadDigest: "",
					evaluatorDigest: "",
					environmentDigest: "",
				},
			),
		).toThrow(/protected fixture/);
	},
);
it.skipIf(process.versions.node !== "22.22.2" || process.versions.sqlite !== "3.51.2")(
	"uses fresh real SQLite seeds and detects modified scratch state and controller seeds",
	async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "status-fixtures-")));
		roots.push(root);
		const fixtureRoot = join(root, "fixtures");
		const workload = await createHarnessyCommandWorkload("local-status", fixtureRoot);
		expect(workload.completedWork).toBe(18);
		const scratch = join(root, "scratch");
		await mkdir(scratch, { mode: 0o700 });
		await workload.prepareScratch(scratch);
		await expect(workload.validateScratch(scratch)).rejects.toThrow(/modified/);
		for (const name of await readdir(scratch)) new EngineeringStore(join(scratch, name, "state.sqlite")).close();
		await workload.validateScratch(scratch);
		await workload.observeFixtures();
		expect(await readdir(scratch)).toHaveLength(18);
		const database = join(scratch, "running-status/state.sqlite");
		const altered = new DatabaseSync(database, { allowExtension: false });
		altered.prepare("UPDATE runs SET detail='forged task state'").run();
		altered.close();
		await expect(workload.validateScratch(scratch)).rejects.toThrow(/modified/);
		await writeFile(join(fixtureRoot, "unexpected"), "untrusted");
		await expect(workload.observeFixtures()).rejects.toThrow(/inventory changed/);
	},
);
it("refuses cancelled fixture construction without creating a seed", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "cancelled-fixture-")));
	roots.push(root);
	const controller = new AbortController();
	controller.abort();
	await expect(
		createHarnessyCommandWorkload("local-status", join(root, "fixtures"), controller.signal),
	).rejects.toThrow(/cancelled/);
	expect(await readdir(root)).toEqual([]);
});
