import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { benchmarkHarnessy } from "../src/engineering/benchmark.ts";
import { engineeringBenchmarkFixture } from "./fixtures/engineering-benchmark.ts";

const roots: string[] = [];
const pending: Promise<unknown>[] = [];
let lifetime = new AbortController();
beforeEach(() => {
	lifetime = new AbortController();
});
afterEach(async () => {
	lifetime.abort();
	await Promise.allSettled(pending.splice(0));
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function run(options: Parameters<typeof benchmarkHarnessy>[0]) {
	const result = benchmarkHarnessy({ ...options, signal: lifetime.signal });
	pending.push(result);
	return result;
}
describe.skipIf(
	process.platform !== "darwin" || process.versions.node !== "22.22.2" || process.versions.sqlite !== "3.51.2",
)("protected actual command benchmarks", () => {
	for (const profile of ["preparation-plan", "local-status"] as const)
		it(`measures actual ${profile} commands and verifies fresh protected fixtures`, async () => {
			const fixture = await engineeringBenchmarkFixture(true);
			roots.push(fixture.root);
			const result = await run({ ...fixture, candidate: fixture.baseline, profile });
			expect(result.measurementStatus).toBe("observed");
			expect(result.decision.verdict).toBe("inconclusive");
			const report = JSON.parse(await readFile(result.reportPath, "utf8"));
			expect(report.profile).toBe(profile);
			expect(report.scope).toMatch(/Actual/);
			for (const side of ["baseline", "candidate"]) {
				expect(report[side].samples).toHaveLength(10);
				for (const sample of report[side].samples) {
					expect(sample.completedWork).toBe(profile === "preparation-plan" ? 16 : 18);
					expect(sample.measurements["cpu.time_per_operation"]).toBeGreaterThan(0);
					expect(sample.measurements["memory.peak_resident"]).toBeGreaterThan(0);
				}
			}
		}, 305000);
	it("refuses missing imports, candidate status output, and actual database tampering", async () => {
		for (const change of [
			'import "unavailable-command-dependency";\n',
			'process.stdout.write("forged");\n',
			`import { DatabaseSync as FixtureDatabase } from "node:sqlite";
const fixtureDatabase=new FixtureDatabase(process.env.TMPDIR+"/running-status/state.sqlite",{allowExtension:false});fixtureDatabase.prepare("UPDATE runs SET detail='forged task state'").run();fixtureDatabase.close();
`,
		]) {
			const fixture = await engineeringBenchmarkFixture(true);
			roots.push(fixture.root);
			const candidate = await fixture.makeRepo("candidate");
			const path = join(candidate, "packages/harnessy-core/src/cli/engineering.ts");
			await writeFile(path, change + (await readFile(path, "utf8")));
			await expect(run({ ...fixture, candidate, profile: "local-status" })).rejects.toThrow();
			expect(
				JSON.parse(await readFile(join(fixture.output, "reports/benchmark.json"), "utf8")).measurementStatus,
			).toBe("failed");
		}
	}, 305000);
});
