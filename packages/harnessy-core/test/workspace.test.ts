import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	initializeWorkspace,
	inspectWorkspace,
	parseWorkspaceManifest,
	readWorkspace,
	registerWorkspaceProject,
	resolveWorkspace,
	resolveWorkspacePath,
	WORKSPACE_MANIFEST,
	workspaceAgentContext,
	workspaceRelativePath,
} from "../src/workspace.ts";

const roots: Array<string> = [];
const root = () => {
	const directory = mkdtempSync(join(tmpdir(), "workspace other home "));
	roots.push(directory);
	return directory;
};
afterEach(() => {
	for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("portable workspace", () => {
	it("initializes and registers without changing existing user instructions", () => {
		const directory = root();
		writeFileSync(join(directory, "AGENTS.md"), "User policy\n");
		const first = initializeWorkspace(directory);
		expect(initializeWorkspace(directory).manifest).toEqual(first.manifest);
		expect(readFileSync(join(directory, "AGENTS.md"), "utf8")).toBe("User policy\n");
		mkdirSync(join(directory, "group/app/dev/.jarvis/context"), { recursive: true });
		const project = {
			id: "app",
			path: "group/app/dev",
			contextDir: ".jarvis/context",
			worktreesDir: "group/app/worktrees",
			integrationBranch: "main",
		};
		const registered = registerWorkspaceProject(directory, project);
		expect(registerWorkspaceProject(directory, project).manifest).toEqual(registered.manifest);
		expect(inspectWorkspace(registered)).toEqual([]);
		expect(readFileSync(join(directory, WORKSPACE_MANIFEST), "utf8")).not.toContain(directory);
		expect(resolveWorkspace({ cwd: join(directory, project.path), env: {} })?.manifest.id).toBe(first.manifest.id);
		const context = workspaceAgentContext(registered, join(directory, project.path));
		expect(context).toContain("Current registered project: app");
		expect(context).toContain("group/app/dev");
	});

	it("keeps identity and discovery when the whole workspace moves", () => {
		const home = root();
		const before = join(home, "before");
		const after = join(home, "after");
		initializeWorkspace(before);
		mkdirSync(join(before, "app/dev"), { recursive: true });
		const original = registerWorkspaceProject(before, { id: "app", path: "app/dev", contextDir: ".jarvis/context" });
		renameSync(before, after);
		expect(resolveWorkspace({ cwd: join(after, "app/dev"), env: {} })?.manifest).toEqual(original.manifest);
		expect(inspectWorkspace(readWorkspace(after)).map((issue) => issue.code)).toEqual(["missing_context"]);
	});

	it("selects explicit root, environment, and nearest ancestor in that order", () => {
		const outer = root();
		const inner = join(outer, "nested");
		initializeWorkspace(outer);
		initializeWorkspace(inner);
		expect(resolveWorkspace({ cwd: inner, env: {} })?.root).toBe(readWorkspace(inner).root);
		expect(resolveWorkspace({ cwd: inner, env: { HARNESSY_WORKSPACE_ROOT: outer } })?.root).toBe(
			readWorkspace(outer).root,
		);
		expect(
			resolveWorkspace({ cwd: inner, workspaceRoot: inner, env: { HARNESSY_WORKSPACE_ROOT: outer } })?.root,
		).toBe(readWorkspace(inner).root);
		expect(() => resolveWorkspace({ workspaceRoot: join(outer, "missing") })).toThrow();
		expect(resolveWorkspace({ cwd: root(), env: {} })).toBeNull();
	});

	it.each(["../outside", "/absolute", "C:/work", "a\\b", "a/../b", "a//b", "a/./b", "", "x\n"])(
		"rejects nonportable path %j",
		(path) => {
			expect(() => workspaceRelativePath(path)).toThrow();
		},
	);

	it("rejects escaped or broken symlinks before writes", () => {
		const directory = root();
		const outside = root();
		symlinkSync(outside, join(directory, "escape"), "dir");
		expect(() => resolveWorkspacePath(directory, "escape/context")).toThrow("escapes");
		symlinkSync(join(outside, "missing"), join(directory, "broken"), "dir");
		expect(() => resolveWorkspacePath(directory, "broken/context")).toThrow("Broken");
	});

	it("rejects unsupported schema, duplicate IDs and duplicate checkout registration", () => {
		const directory = root();
		const initial = initializeWorkspace(directory);
		mkdirSync(join(directory, "app"));
		const project = { id: "app", path: "app", contextDir: ".jarvis/context" };
		registerWorkspaceProject(directory, project);
		expect(() => registerWorkspaceProject(directory, { ...project, id: "other" })).toThrow("registered");
		expect(() => parseWorkspaceManifest({ ...initial.manifest, version: 2 })).toThrow("Unsupported");
		expect(() => parseWorkspaceManifest({ ...initial.manifest, projects: [project, project] })).toThrow("Duplicate");
		expect(() => parseWorkspaceManifest({ ...initial.manifest, projects: [{ ...project, id: "Bad ID" }] })).toThrow(
			"Invalid",
		);
		expect(() => parseWorkspaceManifest(null)).toThrow();
	});

	it("reports missing projects and fails on malformed manifest without overwriting it", () => {
		const directory = root();
		initializeWorkspace(directory);
		mkdirSync(join(directory, "app"));
		registerWorkspaceProject(directory, { id: "app", path: "app", contextDir: ".jarvis/context" });
		rmSync(join(directory, "app"), { recursive: true });
		expect(inspectWorkspace(readWorkspace(directory))[0]?.code).toBe("missing_project");
		writeFileSync(join(directory, WORKSPACE_MANIFEST), "broken");
		expect(() => initializeWorkspace(directory)).toThrow();
		expect(readFileSync(join(directory, WORKSPACE_MANIFEST), "utf8")).toBe("broken");
	});

	it("refuses concurrent mutation and never removes another writer's lock", () => {
		const directory = root();
		initializeWorkspace(directory);
		const lock = join(directory, `${WORKSPACE_MANIFEST}.lock`);
		writeFileSync(lock, "other writer");
		expect(() => initializeWorkspace(directory)).toThrow();
		expect(readFileSync(lock, "utf8")).toBe("other writer");
	});
});
