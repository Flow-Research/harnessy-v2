import { existsSync } from "node:fs";
import { chmod, link, mkdir, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HarnessyBenchmarkOptions,
	benchmarkHarnessy as runHarnessyBenchmark,
} from "../src/engineering/benchmark.ts";
import { EvaluationSession } from "../src/engineering/evaluation.ts";
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
function benchmarkHarnessy(options: HarnessyBenchmarkOptions) {
	const result = runHarnessyBenchmark({
		...options,
		signal: options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal,
	});
	pending.push(result);
	return result;
}
async function fixture() {
	const value = await engineeringBenchmarkFixture();
	roots.push(value.root);
	return value;
}

describe.skipIf(process.platform !== "darwin")("protected Harnessy benchmark", () => {
	it("collects ten protected pairs with external CPU/RSS and audit-only inconclusive receipts", async () => {
		const input = await fixture();
		const result = await benchmarkHarnessy({ ...input, candidate: input.baseline });
		expect(result.measurementStatus).toBe("observed");
		expect(result.decision.verdict).toBe("inconclusive");
		const report = JSON.parse(await readFile(result.reportPath, "utf8"));
		for (const side of ["baseline", "candidate"]) {
			expect(report[side].samples).toHaveLength(10);
			expect(report[side].requiredChecks).toEqual([
				{ id: "harnessy-task-preparation-status", passed: true, reason: "protected_cases_passed" },
			]);
			for (const sample of report[side].samples) {
				expect(sample.completedWork).toBe(524_288);
				expect(sample.measurements["cpu.time_per_operation"]).toBeGreaterThan(0);
				expect(sample.measurements["memory.peak_resident"]).toBeGreaterThan(0);
			}
		}
		expect((await new EvaluationSession().compare(report.baseline, report.candidate)).verdict).toBe("inconclusive");
		expect(existsSync(join(input.output, "scratch"))).toBe(false);
	}, 305000);

	it("refuses public, overlapping, existing, linked and hardlinked custody without overwriting data", async () => {
		const input = await fixture();
		await expect(
			benchmarkHarnessy({ ...input, candidate: input.baseline, output: join(input.baseline, "output") }),
		).rejects.toThrow(/outside/);
		await mkdir(input.output);
		await writeFile(join(input.output, "preserve"), "unchanged");
		await expect(benchmarkHarnessy({ ...input, candidate: input.baseline })).rejects.toThrow();
		expect(await readFile(join(input.output, "preserve"), "utf8")).toBe("unchanged");
		await chmod(input.root, 0o755);
		await expect(
			benchmarkHarnessy({ ...input, candidate: input.baseline, output: join(input.root, "public") }),
		).rejects.toThrow(/owner-only/);
		await chmod(input.root, 0o700);
		await symlink(input.baseline, join(input.root, "linked-source"));
		await expect(benchmarkHarnessy({ ...input, candidate: join(input.root, "linked-source") })).rejects.toThrow(
			/canonical/,
		);
		await link(join(input.baseline, "packages/harnessy-core/src/work/logic.ts"), join(input.baseline, "hardlink.ts"));
		await expect(
			benchmarkHarnessy({ ...input, candidate: input.baseline, output: join(input.root, "hardlinked") }),
		).rejects.toThrow(/singly linked|hardlinks/);
	});

	it("refuses oversized dirty source and cancellation before preparation", async () => {
		const input = await fixture();
		const aborted = new AbortController();
		aborted.abort();
		await expect(benchmarkHarnessy({ ...input, candidate: input.baseline, signal: aborted.signal })).rejects.toThrow(
			/cancelled/,
		);
		expect(existsSync(input.output)).toBe(false);
		await writeFile(join(input.baseline, "huge.ts"), "");
		await truncate(join(input.baseline, "huge.ts"), 16 * 1024 * 1024 + 1);
		await expect(benchmarkHarnessy({ ...input, candidate: input.baseline })).rejects.toThrow(/bounded/);
		expect(existsSync(input.output)).toBe(false);
	});

	it("detects changed original source and projection bytes before issuing valid measurements", async () => {
		for (const target of ["original", "projection"] as const) {
			const input = await fixture();
			let changed = false;
			const timer = setInterval(() => {
				const projected = join(input.output, "projections/candidate/packages/harnessy-core/src/work/logic.ts");
				if (!changed && existsSync(projected)) {
					changed = true;
					void writeFile(
						target === "projection"
							? projected
							: join(input.baseline, "packages/harnessy-core/src/work/logic.ts"),
						"// changed bytes\n",
						{ flag: "a" },
					);
				}
			}, 5);
			await expect(benchmarkHarnessy({ ...input, candidate: input.baseline })).rejects.toThrow();
			clearInterval(timer);
			expect(changed).toBe(true);
			expect(
				JSON.parse(await readFile(join(input.output, "reports/benchmark.json"), "utf8")).measurementStatus,
			).toBe("failed");
		}
	}, 60000);

	it("cancels an actual hostile sample and reaps its supervisor-owned process", async () => {
		const input = await fixture();
		const candidate = await input.makeRepo(
			"hostile",
			'\nimport fs from "node:fs";fs.writeFileSync(process.env.TMPDIR+"/fixture.pid",String(process.pid));while(true){}\n',
		);
		const abort = new AbortController();
		let pid: number | undefined;
		const poll = setInterval(() => {
			void readdir(join(input.output, "scratch"))
				.then(async (names) => {
					for (const name of names) {
						const path = join(input.output, "scratch", name, "fixture.pid");
						if (existsSync(path)) {
							pid = Number(await readFile(path, "utf8"));
							abort.abort();
						}
					}
				})
				.catch(() => undefined);
		}, 10);
		await expect(benchmarkHarnessy({ ...input, candidate, signal: abort.signal, timeoutMs: 15000 })).rejects.toThrow(
			/cancelled/,
		);
		clearInterval(poll);
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid!, 0)).toThrow();
		expect(JSON.parse(await readFile(join(input.output, "reports/benchmark.json"), "utf8")).measurementStatus).toBe(
			"failed",
		);
	}, 30000);

	it("enforces the overall preparation deadline", async () => {
		const input = await fixture();
		await expect(benchmarkHarnessy({ ...input, candidate: input.baseline, timeoutMs: 1 })).rejects.toThrow(
			/cancelled|deadline|abort/i,
		);
		await expect(benchmarkHarnessy({ ...input, candidate: input.baseline, timeoutMs: 0 })).rejects.toThrow(
			/deadline/,
		);
	});
});

it.skipIf(process.platform === "darwin")(
	"reports unsupported platforms without launching or fabricating metrics",
	async () => {
		await expect(
			benchmarkHarnessy({ baseline: "/unsupported", candidate: "/unsupported", output: "/unsupported" }),
		).rejects.toThrow(/unsupported/);
	},
);
