import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSingleProcessEvaluation } from "../src/engineering/sandbox.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-sandbox-")));
	roots.push(root);
	const paths = Object.fromEntries(
		["source", "evaluator", "scratch", "private"].map((name) => {
			const path = join(root, name);
			mkdirSync(path, { mode: 0o700 });
			return [name, path];
		}),
	) as Record<"source" | "evaluator" | "scratch" | "private", string>;
	const secret = join(paths.private, "secret");
	writeFileSync(secret, "fixture-private-value");
	const run = (
		script: string,
		options: { timeoutMs?: number; maximumOutputBytes?: number; signal?: AbortSignal } = {},
	) =>
		runSingleProcessEvaluation({
			executable: realpathSync(process.execPath),
			args: ["-e", script],
			sourceRoots: [paths.source],
			evaluatorRoot: paths.evaluator,
			scratch: paths.scratch,
			deniedRoots: [paths.private],
			timeoutMs: 5000,
			...options,
		});
	return { paths, secret, run };
};

describe.skipIf(process.platform !== "darwin")("macOS real single-process evaluator isolation", () => {
	it("refuses scratch directories inside source even when their names start with two dots", async () => {
		const { paths } = setup();
		const nested = join(paths.source, "..scratch");
		mkdirSync(nested, { mode: 0o700 });
		await expect(
			runSingleProcessEvaluation({
				executable: realpathSync(process.execPath),
				args: ["-e", "console.log('refuse')"],
				sourceRoots: [paths.source],
				evaluatorRoot: paths.evaluator,
				scratch: nested,
				deniedRoots: [paths.private],
				timeoutMs: 1000,
			}),
		).rejects.toThrow(/separate/);
	});
	it("runs useful reads while denying secrets, source writes, network and detached children", async () => {
		const { paths, secret, run } = setup();
		const source = join(paths.source, "input.txt");
		writeFileSync(source, "required-input");
		const attempted = join(paths.source, "modified.txt");
		const result = await run(`const fs=require('node:fs'); const cp=require('node:child_process');
const net=require('node:net'); const result={input:fs.readFileSync(${JSON.stringify(source)},'utf8')};
for(const [key,action] of Object.entries({secret:()=>fs.readFileSync(${JSON.stringify(secret)}),
write:()=>fs.writeFileSync(${JSON.stringify(attempted)},'escape'),
child:()=>cp.spawnSync(process.execPath,['-e','setTimeout(()=>{},10000)'],{detached:true})})) {
try { const value=action(); result[key]=value&&value.error ? value.error.code : 'ALLOWED'; } catch(e) { result[key]=e.code; }
}
fs.writeFileSync(${JSON.stringify(join(paths.scratch, "allowed.txt"))},'scratch');
const socket=net.connect(9,'127.0.0.1'); socket.on('connect',()=>{result.network='ALLOWED';socket.destroy();});
socket.on('error',e=>{result.network=e.code;console.log(JSON.stringify(result));});`);
		expect(result.exitCode, result.stderr).toBe(0);
		const observed = JSON.parse(result.stdout);
		expect(observed.input).toBe("required-input");
		for (const key of ["secret", "write", "child", "network"]) expect(observed[key]).toMatch(/^(EPERM|EACCES)$/);
		expect(existsSync(attempted)).toBe(false);
		expect(existsSync(join(paths.scratch, "allowed.txt"))).toBe(true);
	});
	it("terminates a hung evaluator at the actual deadline", async () => {
		const { run } = setup();
		const result = await run("while(true){}", { timeoutMs: 100 });
		expect(result.timedOut).toBe(true);
		expect(result.signal).toBe("SIGKILL");
		expect(result.durationMs).toBeLessThan(3000);
	});
	it("kills excessive output and refuses launch after cancellation", async () => {
		const { run } = setup();
		const result = await run("process.stdout.write('x'.repeat(100000))", { maximumOutputBytes: 100 });
		expect(result.outputExceeded).toBe(true);
		const stop = new AbortController();
		stop.abort();
		await expect(run("console.log('must-not-run')", { signal: stop.signal })).rejects.toThrow(/cancelled/);
	});
});
