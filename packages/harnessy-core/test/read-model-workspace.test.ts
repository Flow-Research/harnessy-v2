import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { PortalSchemas, readSkillsSummary, readWorkspaceSummary } from "../src/read-model.ts";
import { initializeWorkspace, registerWorkspaceProject } from "../src/workspace.ts";
import { cleanupReadModelFixtures, tempHome, treeListing } from "./support/read-model-fixture.ts";

afterEach(cleanupReadModelFixtures);

const NOW = new Date("2026-10-17T12:00:00.000Z");

describe("workspace read model", () => {
	it("lists registered projects and doctor issue codes without updating the manifest", () => {
		const root = tempHome("workspace-ok");
		const workspace = initializeWorkspace(root);
		mkdirSync(join(root, "alpha", ".jarvis", "context"), { recursive: true });
		mkdirSync(join(root, "beta"));
		registerWorkspaceProject(root, { id: "alpha", path: "alpha", contextDir: ".jarvis/context" });
		registerWorkspaceProject(root, { id: "beta", path: "beta", contextDir: ".jarvis/context" });
		const before = treeListing(root);
		const summary = readWorkspaceSummary({ workspaceRoot: root, env: {}, now: NOW });
		expect(treeListing(root)).toEqual(before);
		expect(Value.Check(PortalSchemas.Workspace, summary)).toBe(true);
		expect(summary).toEqual({
			state: "ok",
			readAt: NOW.toISOString(),
			data: {
				id: workspace.manifest.id,
				root,
				projectCount: 2,
				projects: [
					{ id: "alpha", path: "alpha" },
					{ id: "beta", path: "beta" },
				],
				issues: [{ project: "beta", code: "missing_context" }],
			},
		});
		expect(readWorkspaceSummary({ cwd: join(root, "alpha"), env: {}, now: NOW }).data?.id).toBe(
			workspace.manifest.id,
		);
	});

	it("reports a missing or invalid workspace", () => {
		const root = tempHome("workspace-missing");
		expect(readWorkspaceSummary({ cwd: root, env: {}, now: NOW })).toEqual({
			state: "missing",
			reason: "workspace_missing",
			readAt: NOW.toISOString(),
		});
		mkdirSync(join(root, ".harnessy"));
		writeFileSync(join(root, ".harnessy", "workspace.json"), "{");
		expect(readWorkspaceSummary({ env: { HARNESSY_WORKSPACE_ROOT: root }, now: NOW })).toMatchObject({
			state: "error",
			reason: "workspace_invalid",
		});
	});
});

describe("skills read model", () => {
	it("counts installed skill directories and links only", () => {
		const home = tempHome("skills");
		const skills = join(home, ".agents", "skills");
		mkdirSync(join(skills, "alpha"), { recursive: true });
		mkdirSync(join(skills, "beta"));
		mkdirSync(join(skills, ".hidden"));
		mkdirSync(join(home, "linked-skill"));
		symlinkSync(join(home, "linked-skill"), join(skills, "gamma"));
		writeFileSync(join(skills, "_catalog.md"), "");
		const summary = readSkillsSummary({ homeRoot: home, now: NOW });
		expect(Value.Check(PortalSchemas.Skills, summary)).toBe(true);
		expect(summary).toEqual({ state: "ok", readAt: NOW.toISOString(), data: { count: 3, truncated: false } });
		expect(readSkillsSummary({ homeRoot: home, now: NOW, maxEntries: 2 }).data?.truncated).toBe(true);
		expect(readSkillsSummary({ homeRoot: join(home, "absent"), now: NOW })).toMatchObject({
			state: "missing",
			reason: "directory_missing",
		});
	});
});
