import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	AGENT_RESULT_SCHEMA,
	agentPrompt,
	agentRunLine,
	buildProof,
	checkTool,
	compareVersions,
	EXIT_MARKER_REGEX,
	evaluateStopRule,
	ghArgv,
	gitArgv,
	herdrArgv,
	installHint,
	packetSummary,
	parseAgentResult,
	parseAssignment,
	parseExitMarker,
	parsePreparation,
	parsePrList,
	parsePrUrl,
	parsePrView,
	parseRunList,
	parseState,
	parseVersion,
	splitCli,
	WORK_TOOLS,
	wsArgv,
} from "../src/work/logic.ts";
import { zipSingleFile } from "../src/work/zip.ts";

const TASK = "11111111-2222-4333-8444-555555555555";
const tool = (name: string) => {
	const found = WORK_TOOLS.find((entry) => entry.name === name);
	if (found === undefined) throw new Error(`missing tool ${name}`);
	return found;
};
const result = (body: Record<string, unknown>) => JSON.stringify({ type: "result", total_cost_usd: 1.25, ...body });
const done = result({ is_error: false, structured_output: { outcome: "done", reason: "changed and tested" } });

describe("argv builders", () => {
	const ws = splitCli("workstream-local  --as agent-claude");
	const all: ReadonlyArray<ReadonlyArray<string>> = [
		wsArgv.show(ws, TASK),
		wsArgv.claim(ws, TASK, "k1"),
		wsArgv.start(ws, TASK, "k2"),
		wsArgv.prepare(ws, {
			task: TASK,
			assignment: "a",
			summary: "Fix the thing; rm -rf /",
			attestation: "text with spaces",
			file: "/tmp/proof.zip",
			key: "k3",
		}),
		wsArgv.submit(ws, { task: TASK, assignment: "a", admission: "adm", summary: "s", attestation: "t" }),
		gitArgv.fetch("/repo"),
		gitArgv.worktreeAdd("/repo", "/wt", `work/${TASK}`, "dev"),
		gitArgv.newCommitCount("/wt", "dev"),
		gitArgv.push("/wt", `work/${TASK}`),
		ghArgv.prCreate("dev", `work/${TASK}`, "Title with `backticks` and $(subshell)", "/wt/body.md"),
		ghArgv.checksWatch(7),
		ghArgv.runList("head-sha"),
		ghArgv.prList(`work/${TASK}`),
		ghArgv.prView(7),
		herdrArgv.workspaceCreate("/wt", TASK),
		herdrArgv.waitOutput("w1:p1", 1000),
		herdrArgv.interrupt("w1:p1"),
	];

	it("are argv arrays whose executable is a bare program name", () => {
		for (const argv of all) {
			expect(["workstream-local", "git", "gh", "herdr"]).toContain(argv[0]);
			expect(argv.every((part) => typeof part === "string")).toBe(true);
		}
	});

	it("keep untrusted text as one argument instead of a shell string", () => {
		const prepare = all[3] ?? [];
		expect(prepare.slice(0, 3)).toEqual(["workstream-local", "--as", "agent-claude"]);
		expect(prepare).toContain("Fix the thing; rm -rf /");
		expect(prepare.slice(3, 7)).toEqual(["-o", "json", "task", "prepare"]);
		expect(all[9]).toContain("Title with `backticks` and $(subshell)");
	});

	it("match the documented command shapes", () => {
		expect(wsArgv.claim(["workstream"], TASK, "k1")).toEqual([
			"workstream",
			"-o",
			"json",
			"task",
			"claim",
			TASK,
			"--idempotency-key",
			"k1",
		]);
		expect(gitArgv.worktreeAdd("/repo", "/wt", "work/x", "main")).toEqual([
			"git",
			"-C",
			"/repo",
			"worktree",
			"add",
			"/wt",
			"-b",
			"work/x",
			"origin/main",
		]);
		expect(herdrArgv.workspaceCreate("/wt", TASK)).toEqual([
			"herdr",
			"workspace",
			"create",
			"--cwd",
			"/wt",
			"--label",
			`work-${TASK}`,
			"--no-focus",
		]);
		expect(herdrArgv.interrupt("p")).toEqual(["herdr", "pane", "send-keys", "p", "ctrl+c"]);
	});

	it("rejects an empty WorkStream CLI", () => {
		expect(() => splitCli("   ")).toThrow("--workstream-cli");
	});
});

describe("agent run line", () => {
	const line = agentRunLine(5);

	it("uses the verified Claude Code flags and redirects", () => {
		expect(line).toContain("claude -p --max-budget-usd 5 --output-format json --permission-mode acceptEdits");
		expect(line).toContain("--permission-prompts none");
		expect(line).toContain(`--json-schema '${JSON.stringify(AGENT_RESULT_SCHEMA)}'`);
		expect(line).toContain("--disallowedTools 'Bash(git push *)'");
		expect(line.endsWith("< .harnessy-work/prompt.md > .harnessy-work/result.json; echo HSY_WORK_EXIT=$?")).toBe(
			true,
		);
	});

	it("appends caller tool rules so the agent can run tests", () => {
		expect(agentRunLine(5, "Bash(npm test *)")).toContain(
			"--allowedTools 'Bash(git add *),Bash(git commit *),Bash(git status *),Bash(git diff *),Bash(git log *),Bash(npm test *)'",
		);
		expect(agentRunLine(5, "  ")).toBe(line);
	});

	it("waits on a marker the echoed command line itself cannot match", () => {
		const marker = new RegExp(EXIT_MARKER_REGEX);
		expect(marker.test(line)).toBe(false);
		expect(marker.test("HSY_WORK_EXIT=0")).toBe(true);
		expect(parseExitMarker(JSON.stringify({ result: { matched_line: "HSY_WORK_EXIT=3" } }))).toBe(3);
		expect(parseExitMarker("not json")).toBeUndefined();
	});
});

describe("result.json parsing", () => {
	it("reads cost and structured outcome", () => {
		expect(parseAgentResult(done)).toEqual({
			ok: true,
			costUsd: 1.25,
			outcome: "done",
			reason: "changed and tested",
			isError: false,
		});
	});

	it("falls back to a JSON result string", () => {
		const parsed = parseAgentResult(
			result({ result: JSON.stringify({ outcome: "blocked", reason: "needs creds" }) }),
		);
		expect(parsed).toMatchObject({ ok: true, outcome: "blocked", reason: "needs creds" });
	});

	it.each([
		[undefined, "missing"],
		["", "missing"],
		["{not json", "malformed"],
		["[]", "malformed"],
		[JSON.stringify({ structured_output: { outcome: "done", reason: "x" } }), "malformed"],
		[result({ total_cost_usd: -1, structured_output: { outcome: "done", reason: "x" } }), "malformed"],
		[result({ structured_output: { outcome: "maybe", reason: "x" } }), "malformed"],
		[result({ structured_output: { outcome: "done" } }), "malformed"],
		[result({ result: "plain text answer" }), "malformed"],
	])("rejects %s as %s", (text, problem) => {
		expect(parseAgentResult(text)).toMatchObject({ ok: false, problem });
	});
});

describe("stop rule", () => {
	const base = { timedOut: false, exitCode: 0, resultText: done, budgetUsd: 5, newCommits: 1 };

	it("continues only when every condition holds", () => {
		expect(evaluateStopRule(base)).toEqual({ kind: "continue", costUsd: 1.25, reason: "changed and tested" });
	});

	it.each([
		["timeout", { timedOut: true }],
		["agent_exit_nonzero", { exitCode: 1 }],
		["agent_exit_nonzero", { exitCode: undefined }],
		["result_missing", { resultText: undefined }],
		["result_malformed", { resultText: "{" }],
		["agent_error", { resultText: result({ is_error: true, structured_output: { outcome: "done", reason: "x" } }) }],
		["over_budget", { budgetUsd: 1 }],
		["blocked", { resultText: result({ structured_output: { outcome: "blocked", reason: "no access" } }) }],
		["no_commits", { newCommits: 0 }],
	] as const)("hands off with %s", (reason, change) => {
		expect(evaluateStopRule({ ...base, ...change })).toMatchObject({ kind: "handoff", reason });
	});

	it("checks the wall clock before anything else", () => {
		expect(evaluateStopRule({ ...base, timedOut: true, exitCode: 1, newCommits: 0 })).toMatchObject({
			reason: "timeout",
		});
	});
});

describe("preflight", () => {
	it("parses versions from tool banners", () => {
		expect(parseVersion("herdr 0.9.1\n")).toBe("0.9.1");
		expect(parseVersion("2.1.304 (Claude Code)")).toBe("2.1.304");
		expect(parseVersion("gh version 2.74.0 (2025-06-01)")).toBe("2.74.0");
		expect(parseVersion("no version")).toBeUndefined();
		expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
		expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
		expect(compareVersions("0.8.2", "0.9.0")).toBeLessThan(0);
	});

	it("enforces the herdr minimum version", () => {
		const herdr = tool("herdr");
		expect(checkTool(herdr, { exitCode: 0, stdout: "herdr 0.9.0", stderr: "" }, "darwin")).toEqual({
			name: "herdr",
			ok: true,
			version: "0.9.0",
		});
		expect(checkTool(herdr, { exitCode: 0, stdout: "herdr 0.8.2", stderr: "" }, "darwin")).toMatchObject({
			ok: false,
			version: "0.8.2",
			problem: "version 0.8.2 is older than 0.9.0",
			hint: "brew install herdr",
		});
		expect(checkTool(herdr, { exitCode: 0, stdout: "herdr", stderr: "" }, "linux")).toMatchObject({
			ok: false,
			hint: "curl -fsSL https://herdr.dev/install.sh | sh",
		});
	});

	it("reports missing tools with platform hints", () => {
		expect(checkTool(tool("gh"), { exitCode: undefined, stdout: "", stderr: "" }, "darwin")).toMatchObject({
			ok: false,
			problem: "not found on PATH",
			hint: "brew install gh",
		});
		expect(checkTool(tool("claude"), { exitCode: 127, stdout: "", stderr: "" }, "linux")).toMatchObject({
			ok: false,
			hint: "npm i -g @anthropic-ai/claude-code",
		});
		expect(installHint(tool("gh"), "win32")).toContain("cli/cli");
	});

	it("lists every required tool once", () => {
		expect(WORK_TOOLS.map((entry) => entry.name)).toEqual(["herdr", "claude", "gh", "git", "workstream"]);
	});
});

describe("WorkStream and GitHub parsing", () => {
	it("reads the assignment id and preparation receipt", () => {
		expect(parseAssignment(JSON.stringify({ task: {}, assignment: { id: "a-1" } }))).toBe("a-1");
		expect(() => parseAssignment("{}")).toThrow("assignment id");
		expect(
			parsePreparation(JSON.stringify({ submission_bundle_preparation_status: "ready", admission_id: "adm" })),
		).toEqual({ status: "ready", admissionId: "adm" });
		expect(
			parsePreparation(JSON.stringify({ submission_bundle_preparation_status: "prepared", admission_id: null })),
		).toEqual({ status: "prepared" });
	});

	it("reads PR, run and merge state", () => {
		expect(parsePrUrl("https://github.com/o/r/pull/42\n")).toEqual({
			url: "https://github.com/o/r/pull/42",
			number: 42,
		});
		expect(() => parsePrUrl("nothing")).toThrow();
		expect(parseRunList(JSON.stringify([{ url: "u", conclusion: "success", headSha: "h" }]), "h")).toEqual({
			url: "u",
			conclusion: "success",
		});
		expect(parseRunList(JSON.stringify([{ url: "u", conclusion: "", headSha: "h" }]), "h")).toEqual({
			url: "u",
			conclusion: "",
		});
		expect(parseRunList(JSON.stringify([{ url: "u", conclusion: "success", headSha: "old" }]), "h")).toBeUndefined();
		expect(parseRunList("[]", "h")).toBeUndefined();
		expect(ghArgv.runList("h")).toEqual([
			"gh",
			"run",
			"list",
			"--commit",
			"h",
			"--json",
			"url,conclusion,headSha",
			"--limit",
			"1",
		]);
		expect(parsePrList(JSON.stringify([{ number: 3, url: "https://github.com/o/r/pull/3" }]))).toEqual({
			number: 3,
			url: "https://github.com/o/r/pull/3",
		});
		expect(parsePrList("[]")).toBeUndefined();
		expect(
			parsePrView(JSON.stringify({ state: "MERGED", mergeCommit: { oid: "m" }, headRefOid: "h", mergedAt: "t" })),
		).toEqual({ state: "MERGED", mergeCommitSha: "m", headSha: "h" });
	});

	it("keeps the packet summary printable ASCII", () => {
		expect(packetSummary("  Fix — the\tthing  ", TASK)).toBe("Fix the thing");
		expect(packetSummary("日本語", TASK)).toBe(`Harnessy work for task ${TASK}`);
	});

	it("rejects foreign or partial state files", () => {
		const state = {
			schema: "harnessy.work.state.v1",
			taskId: TASK,
			startedAt: 1,
			summary: "s",
			keys: { claim: "a", start: "b", prepare: "c" },
		};
		expect(parseState(JSON.stringify(state), TASK)).toEqual(state);
		expect(parseState(JSON.stringify({ ...state, taskId: "other" }), TASK)).toBeUndefined();
		expect(parseState(JSON.stringify({ ...state, keys: { claim: "a" } }), TASK)).toBeUndefined();
		expect(parseState("{", TASK)).toBeUndefined();
	});

	it("puts task text and the no-push rule in the prompt", () => {
		const prompt = agentPrompt({ id: TASK, title: "T", description: "D", acceptanceCriteria: "A" });
		expect(prompt).toContain("# T");
		expect(prompt).toContain("D");
		expect(prompt).toContain("## Acceptance criteria");
		expect(prompt).toContain("Do not push");
	});
});

describe("proof", () => {
	it("has the v1 shape with merged fixed to true", () => {
		const proof = buildProof({
			task_id: TASK,
			repo: "o/r",
			commit_sha: "h",
			merge_commit_sha: "m",
			pr_url: "https://github.com/o/r/pull/1",
			ci_run_url: "https://github.com/o/r/actions/runs/1",
			ci_conclusion: "success",
			cost_usd: 1.25,
			duration_seconds: 90,
		});
		expect(Object.keys(proof)).toEqual([
			"schema",
			"task_id",
			"repo",
			"commit_sha",
			"merge_commit_sha",
			"pr_url",
			"ci_run_url",
			"ci_conclusion",
			"merged",
			"cost_usd",
			"duration_seconds",
		]);
		expect(proof.schema).toBe("harnessy.work.proof.v1");
		expect(proof.merged).toBe(true);
	});

	it("zips proof.json at the archive root with deterministic bytes", () => {
		const content = Buffer.from('{"schema":"harnessy.work.proof.v1"}\n');
		const zip = zipSingleFile("proof.json", content);
		expect(zipSingleFile("proof.json", content).equals(zip)).toBe(true);
		expect(zip.readUInt32LE(0)).toBe(0x04034b50);
		expect(zip.readUInt16LE(8)).toBe(0);
		expect(zip.readUInt32LE(14)).toBe(crc32(content));
		const nameLength = zip.readUInt16LE(26);
		expect(zip.subarray(30, 30 + nameLength).toString()).toBe("proof.json");
		expect(zip.subarray(30 + nameLength, 30 + nameLength + content.length).equals(content)).toBe(true);
		const end = zip.subarray(zip.length - 22);
		expect(end.readUInt32LE(0)).toBe(0x06054b50);
		expect(end.readUInt16LE(10)).toBe(1);
		const centralOffset = end.readUInt32LE(16);
		expect(zip.readUInt32LE(centralOffset)).toBe(0x02014b50);
		expect(centralOffset + end.readUInt32LE(12) + 22).toBe(zip.length);
		expect(() => zipSingleFile("/abs", content)).toThrow();
	});
});
