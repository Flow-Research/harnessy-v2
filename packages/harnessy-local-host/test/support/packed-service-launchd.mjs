import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Only the job label/environment are test-specific. Application and OS checks remain real.
export const checkPackedServiceLaunchd = async ({ directory, servicePath, statePath, call, preserveFixture }) => {
	assert.equal(process.platform, "darwin");
	assert(process.env.NODE_OPTIONS?.includes("fixture-network-guard.mjs"), "Missing fixture egress guard");
	const productionLabel = "org.harnessy.meeting-publication";
	const label = `org.harnessy.fixture.${randomUUID()}`;
	const domain = `gui/${process.geteuid()}`;
	const target = `${domain}/${label}`;
	const parsed = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", join(directory, `${productionLabel}.plist`)], { encoding: "utf8" });
	assert.equal(parsed.status, 0, parsed.stderr);
	const job = JSON.parse(parsed.stdout);
	assert.equal(job.Label, productionLabel);
	assert.deepEqual(job.ProgramArguments.slice(2), ["--service", "--input", servicePath]);
	assert.equal(job.KeepAlive, false);
	job.Label = label;
	job.EnvironmentVariables = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_NO_WARNINGS: "1", HOME: directory, PATH: "/usr/bin:/bin" };
	const fixturePlist = join(directory, `${label}.plist`);
	const converted = spawnSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], { input: JSON.stringify(job), encoding: "utf8" });
	assert.equal(converted.status, 0, converted.stderr);
	writeFileSync(fixturePlist, converted.stdout, { mode: 0o600, flag: "wx" });
	const launchctl = (args) => {
		assert(!args.some((arg) => arg.includes(productionLabel)), "Production service target forbidden");
		const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 55_000 });
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		return result;
	};
	const waitAbsent = async () => {
		const deadline = Date.now() + 50_000;
		while (Date.now() < deadline) {
			const result = launchctl(["print", target]);
			if (result.status !== 0 && result.stderr.includes("Could not find service")) return;
			assert.equal(result.status, 0, "Unknown job state during cleanup");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("Isolated installed service did not stop");
	};
	let failure;
	try {
		for (let pass = 0; pass < 2; pass++) {
			writeFileSync(job.StandardOutPath, "");
			writeFileSync(job.StandardErrorPath, "");
			assert.equal(launchctl(["enable", target]).status, 0);
			assert.equal(launchctl(["bootstrap", domain, fixturePlist]).status, 0);
			let ready;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const errors = readFileSync(job.StandardErrorPath, "utf8");
				assert.equal(errors, "", `Installed launchd runtime failed: ${errors}`);
				const line = readFileSync(job.StandardOutPath, "utf8").split("\n").find((value) => value.includes('"harnessy.meeting-publication.full-review-ready"'));
				if (line) { ready = JSON.parse(line); break; }
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (!ready) {
				const observation = launchctl(["print", target]);
				const state = observation.stdout.split("\n").filter((line) => /^\s*(state|pid|runs|last exit code|last terminating signal|reason) =/.test(line));
				const pid = /^\s*pid = (\d+)$/m.exec(observation.stdout)?.[1];
				let sample;
				if (pid) {
					const samplePath = join(directory, "startup.sample.txt");
					const sampled = spawnSync("/usr/bin/sample", [pid, "1", "10", "-file", samplePath], { encoding: "utf8", timeout: 10_000 });
					sample = sampled.status === 0 ? readFileSync(samplePath, "utf8").split("Binary Images:")[0].slice(0, 16000) : "sample unavailable";
				}
				throw new Error(`Installed launchd runtime did not become ready: ${JSON.stringify({
					status: observation.status, state, sample,
					stdout: readFileSync(job.StandardOutPath, "utf8").slice(-4096),
					stderr: readFileSync(job.StandardErrorPath, "utf8").slice(-4096),
				})}`);
			}
			assert.equal(ready.runtimeMode, "service");
			assert.equal(ready.expiresAt, null);
			const token = readFileSync(join(statePath, "meeting-publication-v2-review.token"), "utf8").trim();
			const exchange = await call(ready.origin, `/exchange?token=${encodeURIComponent(token)}`);
			assert.equal(exchange.status, 303);
			const cookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
			assert(cookie);
			assert.equal((await call(ready.origin, "/", { headers: { Cookie: cookie } })).status, 200);
			assert.equal(launchctl(["disable", target]).status, 0);
			assert.equal(launchctl(["bootout", target]).status, 0);
			await waitAbsent();
			const status = spawnSync(job.ProgramArguments[0], [job.ProgramArguments[1], "--service-status", "--input", servicePath], { env: process.env, encoding: "utf8", timeout: 10_000 });
			assert.equal(status.status, 0, status.stderr);
			assert.equal(JSON.parse(status.stdout).activation, "cleanly_stopped");
			assert.notEqual(launchctl(["bootstrap", domain, fixturePlist]).status, 0, "Disabled job restarted");
		}
	} catch (cause) { failure = cause; }
	finally {
		try {
			launchctl(["bootout", target]);
			await waitAbsent();
			assert.equal(launchctl(["enable", target]).status, 0);
		} catch (cause) {
			preserveFixture();
			failure = new Error(`Retain isolated job evidence at ${directory}`, { cause: failure ?? cause });
		}
	}
	if (failure) throw failure;
};
