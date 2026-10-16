import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
	communityProcessLinePattern,
	darwinProcessExecutableFromLsof,
	isNativeCommunityReviewLaunchAgent,
	isNativeCommunityReviewProcess,
	parseCommunityProcessConfirmation,
} from "../src/jarvis/community-briefing/operational-runtime.ts";

it("parses signed OS UIDs without accepting malformed identities or negative PIDs", () => {
	for (const uid of [-2, 0, 501]) {
		const match = communityProcessLinePattern.exec(`   ${uid}   123 /usr/bin/example worker`);
		expect(match?.slice(1)).toEqual([String(uid), "123", "/usr/bin/example worker"]);
	}
	for (const line of ["unknown 123 command", "501 -123 command", "- 123 command", "501 123", "501x 123 command"])
		expect(communityProcessLinePattern.exec(line), line).toBeNull();
});

it("parses the real OS process inventory used by the writer-exclusion guard", () => {
	const observed = spawnSync("/bin/ps", ["-axo", "uid=,pid=,command="], {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 1_000_000,
	});
	expect(observed.status).toBe(0);
	const records = observed.stdout.split("\n").filter((line) => line.trim());
	expect(records.length).toBeGreaterThan(0);
	for (const record of records) expect(communityProcessLinePattern.test(record)).toBe(true);
});

it("parses the newline-terminated single PID confirmation without changing command whitespace", () => {
	const observed = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "uid=,pid=,command="], {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 1_000_000,
	});
	expect(observed.status).toBe(0);
	expect(observed.stdout.endsWith("\n")).toBe(true);
	const match = parseCommunityProcessConfirmation(observed.stdout);
	expect(Number(match?.[1])).toBe(process.geteuid?.());
	expect(Number(match?.[2])).toBe(process.pid);
	expect(match?.[3]).toBe(observed.stdout.slice(0, -1).match(communityProcessLinePattern)?.[3]);

	const trailingSpaces = parseCommunityProcessConfirmation("501 123 /bin/example --value  \n");
	expect(trailingSpaces?.[3]).toBe("/bin/example --value  ");
});

it("rejects ambiguous or malformed PID confirmation output", () => {
	for (const output of [
		"",
		"\n",
		"501 123 /bin/example\n\n",
		"501 123 /bin/example\n501 124 /bin/other\n",
		"501 123 /bin/example\r\n",
		"501 123\n",
	])
		expect(parseCommunityProcessConfirmation(output), JSON.stringify(output)).toBeUndefined();
});

it("recognizes only the byte-identical installed review sibling of the service tree", () => {
	const root = mkdtempSync(join(tmpdir(), "community-installed-identity-"));
	try {
		const relative = "node_modules/@harnessy/core/dist/cli.js";
		const entry = join(root, "service", relative);
		const reviewer = join(root, relative);
		const unrelated = join(root, "other", relative);
		for (const path of [entry, reviewer, unrelated]) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "// Exact installed CLI fixture.\n");
		}
		for (const directory of [root, join(root, "service")]) {
			for (const relative of [
				"dist/jarvis/community-briefing/native-draft.js",
				"dist/jarvis/community-briefing/review-process.js",
				"resources/community-draft-adapter.py",
			]) {
				const path = join(directory, "node_modules/@harnessy/core", relative);
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, "// Matching review implementation.\n");
			}
		}
		const matches = (path: string) =>
			isNativeCommunityReviewProcess(
				`${process.execPath} ${path} jarvis community briefing review serve --port 8872`,
				process.execPath,
				process.execPath,
				process.execPath,
				entry,
			);
		expect(matches(reviewer)).toBe(true);
		expect(matches(unrelated)).toBe(false);
		const adapter = join(root, "node_modules/@harnessy/core/resources/community-draft-adapter.py");
		writeFileSync(adapter, "// Missing native lease fencing.\n");
		expect(matches(reviewer)).toBe(false);
		writeFileSync(adapter, "// Matching review implementation.\n");
		writeFileSync(reviewer, "// Older compatibility reviewer.\n");
		expect(matches(reviewer)).toBe(false);
		rmSync(reviewer);
		symlinkSync(entry, reviewer);
		expect(matches(reviewer)).toBe(true); // Exact realpath identity remains accepted.
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("requires a loaded native review job to own an independently verified process", () => {
	const label = "com.flow-harness.community-review-v2";
	const verified = new Set([process.pid]);
	const output = `gui/501/${label} = {\n\tpid = ${process.pid}\n}\n`;
	expect(isNativeCommunityReviewLaunchAgent(label, output, verified)).toBe(true);
	expect(isNativeCommunityReviewLaunchAgent(label, output, new Set())).toBe(false);
	expect(isNativeCommunityReviewLaunchAgent(label, "state = waiting", verified)).toBe(false);
	expect(isNativeCommunityReviewLaunchAgent("tech.flowresearch.jarvis.briefing-review", output, verified)).toBe(false);
	expect(isNativeCommunityReviewLaunchAgent(label, `${output}\npid = 1\n`, verified)).toBe(false);
});

it("uses the first program-text record without confusing later library mappings", () => {
	const output = "p42\0\nftxt\0n/releases/old/bin/node\0\nftxt\0n/releases/old/native-addon.node\0\n";
	expect(darwinProcessExecutableFromLsof(output, 42)).toBe("/releases/old/bin/node");
	expect(darwinProcessExecutableFromLsof(output, 43)).toBeUndefined();
	expect(darwinProcessExecutableFromLsof("p42\0\nftxt\0relative\0\n", 42)).toBeUndefined();
});

it.skipIf(process.platform !== "darwin")(
	"keeps executable identity bound to a living PID when its launch symlink is retargeted",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "community-pid-identity-"));
		const current = join(root, "current-node");
		const future = join(root, "future-node");
		const entry = join(root, "cli.js");
		symlinkSync(process.execPath, current);
		writeFileSync(future, "future executable identity\n");
		writeFileSync(entry, "// Native review fixture.\n");
		const child = spawn(current, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
		try {
			await once(child, "spawn");
			const observeExecutable = () => {
				const observed = spawnSync("/usr/sbin/lsof", ["-a", "-p", String(child.pid), "-d", "txt", "-F0pfn"], {
					encoding: "utf8",
					timeout: 2_000,
					maxBuffer: 1_000_000,
				});
				expect(observed.status, observed.stderr).toBe(0);
				return darwinProcessExecutableFromLsof(observed.stdout, child.pid!);
			};
			expect(observeExecutable()).toBe(realpathSync(process.execPath));

			rmSync(current);
			symlinkSync(future, current);
			expect(realpathSync(current)).toBe(realpathSync(future));
			const pidExecutable = observeExecutable();
			expect(pidExecutable).toBe(realpathSync(process.execPath));
			const commandLine = `${current} ${entry} jarvis community briefing review serve --port 8872`;
			expect(isNativeCommunityReviewProcess(commandLine, current, pidExecutable!, future, entry)).toBe(false);
			expect(isNativeCommunityReviewProcess(commandLine, current, pidExecutable!, process.execPath, entry)).toBe(
				true,
			);
		} finally {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await once(child, "exit");
			}
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("accepts a verified release symlink but rejects other executables and Node options", () => {
	const root = mkdtempSync(join(tmpdir(), "community-release-identity-"));
	try {
		const executable = join(root, "current node");
		const entry = join(root, "cli.js");
		const other = join(root, "other-node");
		symlinkSync(process.execPath, executable);
		writeFileSync(entry, "// Native review fixture.\n");
		writeFileSync(other, "// Not the expected executable.\n");
		const route = "jarvis community briefing review serve --port 8872";
		expect(
			isNativeCommunityReviewProcess(
				`${executable} ${entry} ${route}`,
				executable,
				process.execPath,
				process.execPath,
				entry,
			),
		).toBe(true);
		expect(isNativeCommunityReviewProcess(`${other} ${entry} ${route}`, other, other, process.execPath, entry)).toBe(
			false,
		);
		expect(
			isNativeCommunityReviewProcess(
				`${executable} --require ${other} ${entry} ${route}`,
				executable,
				process.execPath,
				process.execPath,
				entry,
			),
		).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("requires the exact native review entry and independently observed Node executable", () => {
	const root = mkdtempSync(join(tmpdir(), "community-process-identity-"));
	try {
		const entry = join(root, "cli with spaces.js");
		const other = join(root, "legacy.js");
		const alias = join(root, "harnessy");
		writeFileSync(entry, "// Identity fixture; never executed.\n");
		writeFileSync(other, "// Different installation.\n");
		symlinkSync(entry, alias);
		const probe = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "comm="], {
			encoding: "utf8",
			timeout: 2000,
		});
		expect(probe.status).toBe(0);
		const observed = process.platform === "linux" ? `/proc/${process.pid}/exe` : probe.stdout.trim();
		const route = "jarvis community briefing review serve";
		for (const executable of [process.execPath, "node"]) {
			for (const script of [entry, alias]) {
				for (const suffix of ["", " --port 8872 --config /private/config.yaml"]) {
					expect(
						isNativeCommunityReviewProcess(
							`${executable} ${script} ${route}${suffix}`,
							observed,
							process.execPath,
							process.execPath,
							entry,
						),
					).toBe(true);
				}
			}
		}
		for (const line of [
			`${process.execPath} ${other} ${route}`,
			`${process.execPath} --require ${other} ${entry} ${route}`,
			`python ${entry} ${route}`,
			`${process.execPath} ${entry} ${route}-other`,
			`${process.execPath} ${entry} jarvis community briefing worker`,
			`${process.execPath} ${entry} jarvis community briefing generate`,
			`${process.execPath} ${entry} jarvis meeting review serve`,
		]) {
			expect(isNativeCommunityReviewProcess(line, observed, process.execPath, process.execPath, entry), line).toBe(
				false,
			);
		}
		expect(isNativeCommunityReviewProcess(`node ${entry} ${route}`, "node", "/bin/sh", process.execPath, entry)).toBe(
			false,
		);
		expect(() =>
			isNativeCommunityReviewProcess(
				`node ${entry} ${route}`,
				"node",
				join(root, "missing"),
				process.execPath,
				entry,
			),
		).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
