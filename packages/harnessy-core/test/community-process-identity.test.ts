import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
	communityProcessLinePattern,
	communityReviewIdentityDigests,
	darwinProcessExecutableFromLsof,
	isNativeCommunityReviewLaunchAgent,
	isNativeCommunityReviewProcess,
	parseCommunityProcessConfirmation,
} from "../src/jarvis/community-briefing/operational-runtime.ts";

/** Files the reviewer must be compared on: the #125 set and the four #127 found missing. */
const REVIEWER_IDENTITY_FILES = [
	"dist/cli.js",
	"dist/cli/community-draft.js",
	"dist/cli/jarvis.js",
	"dist/jarvis/community-briefing/native-draft.js",
	"dist/jarvis/community-briefing/review-process.js",
	"dist/jarvis/community-briefing/draft-process.js",
	"dist/jarvis/community-briefing/notification.js",
	"dist/jarvis/community-briefing/weekly-generation.js",
	"resources/community-draft-adapter.py",
	"dist/jarvis/life-orchestrator/codex-provider.js",
	"dist/jarvis/life-orchestrator/local-credential.js",
	"dist/jarvis/paths.js",
	"dist/jarvis/meeting-publication/operational-input.js",
] as const;

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

/** A Core tree whose entry loads a small import graph, in the shapes tsc emits. */
const IDENTITY_FIXTURE: Readonly<Record<string, string>> = {
	"dist/cli.js": '#!/usr/bin/env node\nimport "./main.js";\n',
	"dist/main.js":
		'import { Effect } from "effect";\nimport { jarvis } from "./cli/jarvis.js";\nexport * from "./jarvis/paths.js";\n',
	"dist/cli/jarvis.js":
		'import {\n\tprovider,\n\tcredential,\n} from "../jarvis/life-orchestrator/codex-provider.js";\nimport { draft } from "./community-draft.js";\n',
	"dist/cli/community-draft.js":
		'export { review } from "../jarvis/community-briefing/review-process.js";\nimport { generate } from "../jarvis/community-briefing/weekly-generation.js";\n',
	"dist/jarvis/community-briefing/review-process.js":
		'import { draft } from "./draft-process.js";\nimport { native } from "./native-draft.js";\n',
	"dist/jarvis/community-briefing/draft-process.js": "// Draft process.\n",
	"dist/jarvis/community-briefing/native-draft.js": "// Native draft.\n",
	"dist/jarvis/community-briefing/weekly-generation.js": 'import { notify } from "./notification.js";\n',
	"dist/jarvis/community-briefing/notification.js": "// Notification.\n",
	"dist/jarvis/life-orchestrator/codex-provider.js":
		'export { credential } from "./local-credential.js";\nimport { input } from "../meeting-publication/operational-input.js";\n',
	"dist/jarvis/life-orchestrator/local-credential.js": "// Credential reads.\n",
	"dist/jarvis/meeting-publication/operational-input.js": "// File reads.\n",
	"dist/jarvis/paths.js": "// Path resolution.\n",
	"resources/community-draft-adapter.py": "# Review adapter.\n",
};

const writeCoreTree = (core: string, files: Readonly<Record<string, string>>) => {
	for (const [relative, content] of Object.entries(files)) {
		mkdirSync(dirname(join(core, relative)), { recursive: true });
		writeFileSync(join(core, relative), content);
	}
};

it("derives the reviewer identity set from the entry's static import graph", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "community-identity-graph-")));
	try {
		writeCoreTree(root, { ...IDENTITY_FIXTURE, "dist/unrelated.js": "// Not loaded by the reviewer.\n" });
		const uid = BigInt(process.geteuid?.() ?? 0);
		expect([...communityReviewIdentityDigests(root, uid).keys()].sort()).toEqual(
			Object.keys(IDENTITY_FIXTURE).sort(),
		);
		// An import that leaves dist/ fails closed.
		writeFileSync(join(root, "dist/jarvis/paths.js"), 'import "../../outside.js";\n');
		expect(() => communityReviewIdentityDigests(root, uid)).toThrow("probe_failed");
		// So does an imported module that is missing.
		writeFileSync(join(root, "dist/jarvis/paths.js"), 'import "./missing.js";\n');
		expect(() => communityReviewIdentityDigests(root, uid)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.skipIf(!existsSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url))))(
	"compares every module the built reviewer loads, including credentials, providers, paths and file reads",
	() => {
		const core = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
		const digests = communityReviewIdentityDigests(core, BigInt(process.geteuid?.() ?? 0));
		for (const relative of REVIEWER_IDENTITY_FILES) expect(digests.has(relative), relative).toBe(true);
		expect(digests.size).toBeGreaterThan(REVIEWER_IDENTITY_FILES.length);
	},
);

it("recognizes only the byte-identical installed review sibling of the service tree", () => {
	const root = mkdtempSync(join(tmpdir(), "community-installed-identity-"));
	try {
		const relative = "node_modules/@harnessy/core/dist/cli.js";
		const entry = join(root, "service", relative);
		const reviewer = join(root, relative);
		const unrelated = join(root, "other", relative);
		for (const directory of [root, join(root, "service"), join(root, "other")])
			writeCoreTree(join(directory, "node_modules/@harnessy/core"), IDENTITY_FIXTURE);
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
		// Every file the reviewer loads must match, however deep in its import graph (#127).
		for (const file of Object.keys(IDENTITY_FIXTURE)) {
			const sibling = join(root, "node_modules/@harnessy/core", file);
			writeFileSync(sibling, "// Older or modified reviewer code.\n");
			expect(matches(reviewer), file).toBe(false);
			writeFileSync(sibling, IDENTITY_FIXTURE[file]!);
		}
		// A file the reviewer does not load may differ.
		writeFileSync(join(root, "node_modules/@harnessy/core/dist/unrelated.js"), "// Not loaded.\n");
		expect(matches(reviewer)).toBe(true);
		// A module the service tree's reviewer newly loads is compared with no list to update.
		for (const directory of [join(root, "service"), root])
			writeFileSync(
				join(directory, "node_modules/@harnessy/core/dist/jarvis/paths.js"),
				'import "./new-module.js";\n',
			);
		writeFileSync(join(root, "service/node_modules/@harnessy/core/dist/jarvis/new-module.js"), "// New.\n");
		writeFileSync(join(root, "node_modules/@harnessy/core/dist/jarvis/new-module.js"), "// Stale.\n");
		expect(matches(reviewer)).toBe(false);
		writeFileSync(join(root, "node_modules/@harnessy/core/dist/jarvis/new-module.js"), "// New.\n");
		expect(matches(reviewer)).toBe(true);
		// The sibling lacks a file the reviewer loads: the exemption fails closed.
		rmSync(join(root, "node_modules/@harnessy/core/dist/jarvis/new-module.js"));
		expect(() => matches(reviewer)).toThrow();
		writeFileSync(join(root, "node_modules/@harnessy/core/dist/jarvis/new-module.js"), "// New.\n");
		writeFileSync(reviewer, "// Older compatibility reviewer.\n");
		expect(matches(reviewer)).toBe(false);
		rmSync(reviewer);
		symlinkSync(entry, reviewer);
		expect(matches(reviewer)).toBe(true); // Exact realpath identity remains accepted.
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.skipIf(process.env.HARNESSY_COMMUNITY_TEST_RELEASE === undefined)(
	"accepts the general CLI reviewer of a packed release beside its service tree",
	() => {
		const release = realpathSync(process.env.HARNESSY_COMMUNITY_TEST_RELEASE!);
		const relative = "node_modules/@harnessy/core/dist/cli.js";
		// Every identity file exists in the packed release's service tree and matches the general CLI.
		const digests = communityReviewIdentityDigests(
			join(release, "service/node_modules/@harnessy/core"),
			BigInt(process.geteuid?.() ?? 0),
		);
		for (const file of REVIEWER_IDENTITY_FILES) expect(digests.has(file), file).toBe(true);
		expect(
			isNativeCommunityReviewProcess(
				`${process.execPath} ${join(release, relative)} jarvis community briefing review serve --port 8872`,
				process.execPath,
				process.execPath,
				process.execPath,
				join(release, "service", relative),
			),
		).toBe(true);
	},
);

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
