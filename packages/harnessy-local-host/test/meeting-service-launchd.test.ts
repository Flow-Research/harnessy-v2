import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderMeetingServiceLaunchAgent } from "../src/meeting-full-review-command.ts";
import {
	controlMeetingServiceFiles,
	installMeetingServiceFiles,
	waitMeetingServiceStopped,
} from "../src/meeting-service-enrollment.ts";

// Explicit opt-in: this exercises the real OS manager with a unique, inert job.
// It is not application-runtime or production readiness acceptance.
it.runIf(process.platform === "darwin" && process.env.HARNESSY_TEST_LAUNCHD === "1")(
	"real launchd starts, drains, disables and re-enables only the isolated job",
	async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-launchd-")));
		chmodSync(root, 0o700);
		const directory = join(root, "service");
		mkdirSync(directory, { mode: 0o700 });
		const label = `org.harnessy.fixture.${randomUUID()}`;
		const target = `gui/${process.geteuid?.()}/${label}`;
		const productionTarget = `gui/${process.geteuid?.()}/org.harnessy.meeting-publication`;
		const ready = join(root, "ready");
		const stopped = join(root, "stopped");
		const cli = join(root, "inert-owner.mjs");
		writeFileSync(
			cli,
			`import { writeFileSync } from "node:fs";
const timer = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  setTimeout(() => { writeFileSync(${JSON.stringify(stopped)}, "drained", { mode: 0o600 }); clearInterval(timer); }, 150);
});
writeFileSync(${JSON.stringify(ready)}, String(process.pid), { mode: 0o600 });
`,
			{ mode: 0o600 },
		);
		const plist = renderMeetingServiceLaunchAgent(
			process.execPath,
			cli,
			join(root, "unused.json"),
			directory,
		).replace("<string>org.harnessy.meeting-publication</string>", `<string>${label}</string>`);
		installMeetingServiceFiles(directory, plist);
		const calls: string[][] = [];
		const launchctl = (args: ReadonlyArray<string>) => {
			const isolated = args.map((arg) => (arg === productionTarget ? target : arg));
			expect(isolated).not.toContain(productionTarget);
			calls.push(isolated);
			const result = spawnSync("/bin/launchctl", isolated, { encoding: "utf8", timeout: 55_000 });
			if (result.error || result.signal) throw result.error ?? new Error("launchctl interrupted");
			return result;
		};
		const waitFor = async (path: string) => {
			const deadline = Date.now() + 10_000;
			while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
			expect(existsSync(path), `Expected isolated marker ${path}`).toBe(true);
		};
		let cleanupConfirmed = false;
		let failure: unknown;
		try {
			expect(controlMeetingServiceFiles(directory, plist, launchctl).kind).toBe(
				"harnessy.meeting-publication.service-start-submitted",
			);
			await waitFor(ready);
			const firstPid = readFileSync(ready, "utf8");
			expect(controlMeetingServiceFiles(directory, plist, launchctl, "disable").kind).toBe(
				"harnessy.meeting-publication.service-stop-submitted",
			);
			await waitMeetingServiceStopped(launchctl);
			await waitFor(stopped);
			expect(readFileSync(stopped, "utf8")).toBe("drained");
			expect(
				launchctl([
					"bootstrap",
					`gui/${process.geteuid?.()}`,
					join(directory, "org.harnessy.meeting-publication.plist"),
				]).status,
			).not.toBe(0);
			rmSync(ready);
			rmSync(stopped);
			controlMeetingServiceFiles(directory, plist, launchctl);
			await waitFor(ready);
			expect(readFileSync(ready, "utf8")).not.toBe(firstPid);
			controlMeetingServiceFiles(directory, plist, launchctl, "disable");
			await waitMeetingServiceStopped(launchctl);
			await waitFor(stopped);
			expect(calls.some((args) => args[0] === "bootout" && args[1] === target)).toBe(true);
			// A crash must not become an automatic restart or a fabricated clean drain.
			rmSync(ready);
			rmSync(stopped);
			controlMeetingServiceFiles(directory, plist, launchctl);
			await waitFor(ready);
			const crashPid = Number(readFileSync(ready, "utf8"));
			expect(Number.isSafeInteger(crashPid) && crashPid > 0).toBe(true);
			const loaded = launchctl(["print", target]);
			expect(loaded.status).toBe(0);
			expect(loaded.stdout).toMatch(new RegExp(`\\bpid = ${crashPid}\\b`));
			process.kill(crashPid, "SIGKILL");
			const crashDeadline = Date.now() + 10_000;
			let exited = false;
			while (Date.now() < crashDeadline) {
				const observation = launchctl(["print", target]);
				expect(observation.status).toBe(0);
				if (observation.stdout.includes("state = not running")) {
					exited = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(exited).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(launchctl(["print", target]).stdout).toContain("state = not running");
			expect(readFileSync(ready, "utf8")).toBe(String(crashPid));
			expect(existsSync(stopped)).toBe(false);
			controlMeetingServiceFiles(directory, plist, launchctl, "disable");
			await waitMeetingServiceStopped(launchctl);
		} catch (cause) {
			failure = cause;
		} finally {
			launchctl(["bootout", target]);
			const deadline = Date.now() + 10_000;
			do {
				const absent = launchctl(["print", target]);
				cleanupConfirmed = absent.status !== 0 && absent.stderr.includes("Could not find service");
				if (cleanupConfirmed) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			} while (Date.now() < deadline);
			// Remove the fixture's disabled override without loading the job again.
			const enabled = launchctl(["enable", target]);
			if (cleanupConfirmed && enabled.status === 0) rmSync(root, { recursive: true, force: true });
			else failure = new Error(`Isolated launchd cleanup needs inspection: ${root}`, { cause: failure });
		}
		if (failure !== undefined) throw failure;
		expect(cleanupConfirmed).toBe(true);
	},
	30_000,
);
