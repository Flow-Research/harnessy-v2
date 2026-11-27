import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decodeSupervisorReport,
	isSupervisorResources,
	prepareEvaluatorSupervisor,
	runSupervisedEvaluator,
	type SupervisedEvaluationInput,
} from "../src/engineering/evaluator-supervisor.ts";

const roots: string[] = [];
async function setup(): Promise<SupervisedEvaluationInput> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "evaluator-supervisor-")));
	roots.push(root);
	const supervisor = await prepareEvaluatorSupervisor({ controllerRoot: root });
	return {
		supervisor,
		executable: await realpath(process.execPath),
		args: ["-e", "process.stdout.write('correct')"],
		cwd: root,
		env: { PATH: "/usr/bin:/bin", LANG: "C" },
		timeoutMs: 2000,
	};
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
	"trusted wait4 resource supervisor",
	() => {
		it("cancels or times out actual compiler preparation without issuing or retaining a binary", async () => {
			const root = await realpath(await mkdtemp(join(tmpdir(), "supervisor-preparation-")));
			roots.push(root);
			const cancelled = new AbortController();
			cancelled.abort();
			await expect(prepareEvaluatorSupervisor({ controllerRoot: root, signal: cancelled.signal })).rejects.toThrow(
				/cancelled/,
			);
			expect(await readdir(root)).toEqual([]);
			const active = new AbortController();
			const timer = setTimeout(() => active.abort(), 20);
			await expect(prepareEvaluatorSupervisor({ controllerRoot: root, signal: active.signal })).rejects.toThrow();
			clearTimeout(timer);
			expect(await readdir(root)).toEqual([]);
			await expect(prepareEvaluatorSupervisor({ controllerRoot: root, timeoutMs: 1 })).rejects.toThrow();
			expect(await readdir(root)).toEqual([]);
			for (const timeoutMs of [0, 30001])
				await expect(prepareEvaluatorSupervisor({ controllerRoot: root, timeoutMs })).rejects.toThrow(/deadline/);
		});
		it("measures actual CPU and peak RSS and ignores child-generated resource claims", async () => {
			const input = await setup();
			const result = await runSupervisedEvaluator({
				...input,
				args: [
					"-e",
					`
const fs = require('node:fs');
let reportPipeClosed = false;
try { fs.writeSync(3, '{"peakRssBytes":0}'); } catch { reportPipeClosed = true; }
const memory = Buffer.alloc(24 * 1024 * 1024, 1);
const deadline = Date.now() + 50;
let work = 0;
while (Date.now() < deadline) work += Math.sqrt(work + 1);
process.stdout.write(JSON.stringify({pid:process.pid,peakRssBytes:0,userCpuMicros:0,reportPipeClosed,bytes:memory.length,work}));
`,
				],
			});
			expect(result.exitCode).toBe(0);
			expect(JSON.parse(result.stdout).pid).toBe(result.childPid);
			expect(JSON.parse(result.stdout).reportPipeClosed).toBe(true);
			expect(result.resources.userCpuMicros + result.resources.systemCpuMicros).toBeGreaterThan(10_000);
			expect(result.resources.peakRssBytes).toBeGreaterThan(24 * 1024 * 1024);
			expect(result.resources.peakRssBytes).toBeLessThan(1024 * 1024 * 1024);
			expect(isSupervisorResources(result.resources)).toBe(true);
			expect(isSupervisorResources({ ...result.resources })).toBe(false);
			expect(result.reaped).toBe(true);
			expect(() => process.kill(result.childPid, 0)).toThrow();
		});

		it("kills and reaps the exact timed-out child before returning a receipt", async () => {
			const input = await setup();
			const result = await runSupervisedEvaluator({
				...input,
				timeoutMs: 100,
				args: ["-e", "process.stdout.write(String(process.pid));setInterval(()=>{},1000)"],
			});
			expect(result.timedOut).toBe(true);
			expect(result.signal).toBe(9);
			expect(result.exitCode).toBeUndefined();
			expect(result.reaped).toBe(true);
			expect(Number.isSafeInteger(result.childPid) && result.childPid > 0).toBe(true);
			// A short deadline can expire before Node starts executing JavaScript.
			if (result.stdout !== "") expect(result.childPid).toBe(Number(result.stdout));
			expect(() => process.kill(result.childPid, 0)).toThrow();
		});

		it("cancels and bounds output without orphaning its owned child", async () => {
			const input = await setup();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 100);
			const cancelled = await runSupervisedEvaluator({
				...input,
				signal: controller.signal,
				args: ["-e", "setInterval(()=>{},1000)"],
			});
			clearTimeout(timer);
			expect(cancelled.cancelled).toBe(true);
			expect(() => process.kill(cancelled.childPid, 0)).toThrow();
			const over = await runSupervisedEvaluator({
				...input,
				maximumOutputBytes: 100,
				args: ["-e", "process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"],
			});
			expect(over.outputExceeded).toBe(true);
			expect(Buffer.byteLength(over.stdout)).toBeLessThanOrEqual(100);
			expect(() => process.kill(over.childPid, 0)).toThrow();
		});

		it("refuses copied or changed supervisor artifacts and invalid launch bounds", async () => {
			const input = await setup();
			await expect(runSupervisedEvaluator({ ...input, supervisor: { ...input.supervisor } })).rejects.toThrow(
				"Invalid",
			);
			await expect(runSupervisedEvaluator({ ...input, timeoutMs: 0 })).rejects.toThrow("Invalid");
			await expect(runSupervisedEvaluator({ ...input, maximumOutputBytes: 0 })).rejects.toThrow("output limit");
			const aborted = new AbortController();
			aborted.abort();
			await expect(runSupervisedEvaluator({ ...input, signal: aborted.signal })).rejects.toThrow("cancelled before");
			await chmod(input.supervisor.executable, 0o700);
			await writeFile(input.supervisor.executable, "tampered binary");
			await chmod(input.supervisor.executable, 0o500);
			await expect(runSupervisedEvaluator(input)).rejects.toThrow("artifact changed");
		});

		it("refuses non-private compiler custody", async () => {
			const root = await realpath(await mkdtemp(join(tmpdir(), "public-supervisor-")));
			roots.push(root);
			await chmod(root, 0o755);
			await expect(prepareEvaluatorSupervisor({ controllerRoot: root })).rejects.toThrow("private controller");
		});
	},
);

describe("resource report decoding", () => {
	it("rejects duplicate keys, trailing output, missing reaping, extra fields, and invalid units", () => {
		const valid = {
			schema: "harnessy.engineering.resources.v1",
			childPid: 100,
			reaped: true,
			exitCode: 0,
			signal: 0,
			timedOut: false,
			cancelled: false,
			userCpuMicros: 1,
			systemCpuMicros: 2,
			peakRssBytes: 1024,
		};
		expect(decodeSupervisorReport(JSON.stringify(valid)).peakRssBytes).toBe(1024);
		for (const text of [
			JSON.stringify(valid).replace('"peakRssBytes":1024', '"peakRssBytes":1024,"peakRssBytes":0'),
			`${JSON.stringify(valid)}\nextra`,
			JSON.stringify({ ...valid, reaped: false }),
			JSON.stringify({ ...valid, forged: true }),
			JSON.stringify({ ...valid, peakRssBytes: -1 }),
			JSON.stringify({ ...valid, userCpuMicros: 0.5 }),
			JSON.stringify({ ...valid, exitCode: null, signal: 0 }),
			"x".repeat(4097),
		])
			expect(() => decodeSupervisorReport(text)).toThrow();
		expect(isSupervisorResources(valid)).toBe(false);
	});
});
