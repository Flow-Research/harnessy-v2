import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalCommand } from "../src/runtime/command-runner.ts";
import { initializeWorkspace, registerWorkspaceProject } from "../src/workspace.ts";
import { prepareWorkspaceLifeCommand } from "../src/workspace-life.ts";

const temporary: Array<string> = [];
afterEach(() => {
	for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scripts = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../capability-harnessy-v1-full/resources/flow-install/skills/life-orchestrator/scripts",
);

const fixture = () => {
	const home = mkdtempSync(join(tmpdir(), "workspace-life-home "));
	temporary.push(home);
	const root = join(home, "Code");
	initializeWorkspace(root);
	const context = join(root, "group/project/dev/.jarvis/context");
	mkdirSync(context, { recursive: true });
	writeFileSync(join(context, "status.md"), "# Project progress\nThe relocation sentinel is ready.\n");
	registerWorkspaceProject(root, { id: "project", path: "group/project/dev", contextDir: ".jarvis/context" });
	const privateContext = join(root, ".jarvis/context/private/tester");
	mkdirSync(privateContext, { recursive: true });
	writeFileSync(join(privateContext, "priorities.md"), "# Priorities\nShip the portable workspace.\n");
	const env = {
		HOME: home,
		USER: "tester",
		FLOW_USER: "tester",
		FLOW_PROJECT_ROOT: root,
		AGENTS_LIFE_DIR: join(home, ".agents/life"),
		PYTHONDONTWRITEBYTECODE: "1",
	};
	return { home, root, env };
};

const execute = (command: ExternalCommand) =>
	execFileSync("python3", [...command.args], {
		cwd: command.cwd,
		env: { PATH: process.env.PATH, ...command.env },
		encoding: "utf8",
		stdio: "pipe",
		timeout: 30_000,
		maxBuffer: 2 * 1024 * 1024,
	});

describe("workspace Life adapter", () => {
	it("rejects a registered context that has become a regular file", () => {
		const { home, root, env } = fixture();
		const context = join(root, "group/project/dev/.jarvis/context");
		rmSync(context, { recursive: true });
		writeFileSync(context, "not a vault");
		expect(() =>
			prepareWorkspaceLifeCommand({
				id: "invalid-context",
				label: "daily",
				executable: "python3",
				args: [join(scripts, "daily-brief"), "--prompt-output", join(home, "prompt")],
				cwd: root,
				env,
			}),
		).toThrow("repair");
	});
	it("rejects context files linked outside the workspace before prompt generation", () => {
		const { home, root, env } = fixture();
		const outside = join(home, "external.md");
		writeFileSync(outside, "OUTSIDE_WORKSPACE_SENTINEL");
		const status = join(root, "group/project/dev/.jarvis/context/status.md");
		rmSync(status);
		symlinkSync(outside, status);
		const output = join(home, "prompt.txt");
		const prepared = prepareWorkspaceLifeCommand({
			id: "boundary",
			label: "daily",
			executable: "python3",
			args: [join(scripts, "daily-brief"), "--prompt-output", output],
			cwd: root,
			env,
		});
		expect(() => execute(prepared.command)).toThrow("Workspace context file escapes workspace");
		expect(existsSync(output)).toBe(false);
	});

	it("supplies grouped registered vaults to real preserved collection without crawl-state writes", () => {
		const { home, root, env } = fixture();
		const status = join(root, "group/project/dev/.jarvis/context/status.md");
		renameSync(status, join(root, "status-source.md"));
		symlinkSync(join(root, "status-source.md"), status);
		mkdirSync(env.AGENTS_LIFE_DIR, { recursive: true });
		writeFileSync(join(env.AGENTS_LIFE_DIR, "priorities.md"), "Explicit home-level input");
		const output = join(home, "collected.json");
		writeFileSync(output, "", { mode: 0o600 });
		const prepared = prepareWorkspaceLifeCommand({
			id: "test",
			label: "collect",
			executable: "python3",
			args: ["-B", "-c", "unused", join(scripts, "collect-state"), output],
			cwd: root,
			env,
		});
		execute(prepared.command);
		const state = JSON.parse(readFileSync(output, "utf8"));
		expect(state.project_context_vaults.project.status_md).toContain("relocation sentinel");
		expect(state.project_context_vaults.project.path).toBe("group/project/dev/.jarvis/context");
		expect(state.priorities).toBeTruthy();
		expect(state.priorities.external_exists).toBe(true);
		expect(existsSync(join(home, ".agents/life/.last-crawl.json"))).toBe(false);
	});

	it("collects a workspace with a custom shared context directory", () => {
		const { home, root, env } = fixture();
		renameSync(join(root, ".jarvis/context"), join(root, "shared-context"));
		const manifestPath = join(root, ".harnessy/workspace.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		writeFileSync(manifestPath, JSON.stringify({ ...manifest, contextDir: "shared-context" }));
		const output = join(home, "custom-prompt.txt");
		const prepared = prepareWorkspaceLifeCommand({
			id: "custom",
			label: "daily",
			executable: "python3",
			args: [join(scripts, "daily-brief"), "--prompt-output", output],
			cwd: root,
			env,
		});
		execute(prepared.command);
		expect(readFileSync(output, "utf8")).toContain("Ship the portable workspace");
	});

	it("builds the real daily prompt from shared priorities and sibling project state without AI", () => {
		const { home, root, env } = fixture();
		const output = join(home, "prompt.txt");
		const prepared = prepareWorkspaceLifeCommand({
			id: "test",
			label: "daily",
			executable: "python3",
			args: [join(scripts, "daily-brief"), "--date", "2026-09-24", "--prompt-output", output],
			cwd: root,
			env,
		});
		execute(prepared.command);
		const prompt = readFileSync(output, "utf8");
		expect(prompt).toContain("relocation sentinel");
		expect(prompt).toContain("Ship the portable workspace");
		expect(existsSync(join(home, ".agents/life/.last-crawl.json"))).toBe(false);
	});

	it("leaves standalone and non-collector commands unchanged", () => {
		const { home } = fixture();
		const command = {
			id: "test",
			label: "test",
			executable: "python3",
			args: [join(scripts, "daily-brief")],
			cwd: home,
			env: { HOME: home },
		};
		expect(prepareWorkspaceLifeCommand(command)).toEqual({ command, snapshotPath: null });
		const unrelated = { ...command, args: ["other.py"] };
		expect(prepareWorkspaceLifeCommand(unrelated)).toEqual({ command: unrelated, snapshotPath: null });
	});

	it("rejects unavailable registered projects before running the collector", () => {
		const { home, root, env } = fixture();
		rmSync(join(root, "group"), { recursive: true });
		expect(() =>
			prepareWorkspaceLifeCommand({
				id: "test",
				label: "daily",
				executable: "python3",
				args: [join(scripts, "daily-brief"), "--prompt-output", join(home, "prompt")],
				cwd: root,
				env,
			}),
		).toThrow("repair");
	});
});
