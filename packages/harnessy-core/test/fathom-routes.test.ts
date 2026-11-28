import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadMeetingRouteRules, projectMeetingsRoot, routeMeeting } from "../src/jarvis/fathom/routes.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A private root shaped like the real one, with synthetic projects and keywords. */
const privateRoot = (routes = ROUTES) => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-meeting-routes-"));
	roots.push(root);
	for (const project of ["flow", "garden", "acme-health", "hiring"])
		mkdirSync(join(root, project, "meetings"), { recursive: true });
	// A folder with status.md but no meetings/ is still a route.
	mkdirSync(join(root, "orchard"));
	writeFileSync(join(root, "orchard", "status.md"), "# Orchard\n");
	// Not project folders.
	for (const folder of ["notes", "meeting-inbox", "drafts"]) mkdirSync(join(root, folder));
	writeFileSync(join(root, "meeting-routes.yaml"), routes);
	return root;
};

const ROUTES = `project_aliases:
  garden: flow
  infrastructure: flow
routes:
  - project: flow
    keywords: [flow research, fellowship]
  - project: garden
    keywords: [coach agent]
  - project: infrastructure
    keywords: [gpu compute]
  - project: acme-health
    keywords: [acme, health hub]
  - project: ghost-project
    keywords: [ghost keyword]
`;

describe("meeting routes", () => {
	it("loads keywords from the file and project folders, and skips non-project folders", () => {
		const rules = loadMeetingRouteRules(privateRoot(), "flow");
		expect([...rules.routes.keys()].sort()).toEqual(
			["acme-health", "flow", "garden", "ghost-project", "hiring", "infrastructure", "orchard"].sort(),
		);
		expect(rules.routes.get("acme-health")).toEqual(["acme health", "acme", "health hub"]);
		expect(rules.aliases.get("garden")).toBe("flow");
		expect(rules.routes.has("notes")).toBe(false);
	});

	it("routes a keyword hit to its project and its meetings folder", () => {
		const root = privateRoot();
		const rules = loadMeetingRouteRules(root, "flow");
		const route = routeMeeting(rules, { title: "Acme Health Hub Demo", participants: ["Ada"] });
		expect(route).toMatchObject({ project: "acme-health", defaulted: false, aliasTags: [] });
		expect(projectMeetingsRoot(rules, route.project)).toBe(join(root, "acme-health", "meetings"));
		expect(routeMeeting(rules, { title: "Orchard planning" }).project).toBe("orchard");
	});

	it("folds aliased projects into Flow and keeps the alias as a tag", () => {
		const rules = loadMeetingRouteRules(privateRoot(), "flow");
		expect(routeMeeting(rules, { title: "Coach agent review" })).toMatchObject({
			project: "flow",
			aliasTags: ["garden"],
			defaulted: false,
		});
		expect(routeMeeting(rules, { title: "Weekly", summary: "We priced GPU compute." })).toMatchObject({
			project: "flow",
			aliasTags: ["infrastructure"],
		});
	});

	it("defaults to Flow when nothing matches, on a tie, or when the winner has no folder", () => {
		const rules = loadMeetingRouteRules(privateRoot(), "flow");
		expect(routeMeeting(rules, { title: "Impromptu Google Meet Meeting" })).toMatchObject({
			project: "flow",
			defaulted: true,
		});
		// acme-health scores 3 ("acme health", "acme"); flow scores 3 ("flow", "flow research"): a tie stays in Flow.
		expect(routeMeeting(rules, { title: "Acme Health x Flow Research" })).toMatchObject({
			project: "flow",
			defaulted: true,
		});
		// A configured route without a project folder never invents a slug.
		expect(routeMeeting(rules, { title: "Ghost keyword sync" })).toMatchObject({ project: "flow", defaulted: true });
	});

	it("matches whole words only and scores multi-word keywords higher", () => {
		const rules = loadMeetingRouteRules(privateRoot(), "flow");
		expect(routeMeeting(rules, { title: "Overflow review" }).defaulted).toBe(true);
		expect(routeMeeting(rules, { title: "Hiring sync", summary: "Fellowship cohort intake" }).defaulted).toBe(true);
		expect(
			routeMeeting(rules, { title: "Hiring sync", summary: "Acme health hub intake", actionItems: ["Email acme"] })
				.project,
		).toBe("acme-health");
	});

	it("uses only project folders when the routes file is missing or unreadable", () => {
		const root = privateRoot("routes: [unclosed");
		const rules = loadMeetingRouteRules(root, "flow");
		expect(rules.aliases.size).toBe(0);
		expect(routeMeeting(rules, { title: "Hiring panel" }).project).toBe("hiring");
		expect(routeMeeting(rules, { title: "Garden walkthrough" }).project).toBe("garden");
	});
});
