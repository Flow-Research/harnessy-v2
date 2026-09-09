import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveLifeOrchestratorSettings } from "../src/jarvis/life-orchestrator/config.ts";
import { canonicalLifeBriefPath, scanDeliveredLifeBriefs } from "../src/jarvis/life-orchestrator/history.ts";
import { runLifeDaily } from "../src/jarvis/life-orchestrator/service.ts";
import { LifeReadingLedger } from "../src/jarvis/life-orchestrator/store.ts";
import { CommandRunner } from "../src/runtime/command-runner.ts";

const roots: Array<string> = [];
const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-life-service-"));
	roots.push(root);
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const dailyFixture = `import datetime
import json
import os
import pathlib
import shutil
import runpy
import sys

args = sys.argv[1:]
life = pathlib.Path(os.environ["AGENTS_LIFE_DIR"])
today = datetime.date.fromisoformat(args[args.index("--date") + 1])
canonical = life / today.strftime("%Y") / today.strftime("%b") / today.strftime("%d-daily-brief.md")
if "--preview-output" in args:
    path = pathlib.Path(args[args.index("--preview-output") + 1])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# Daily Brief\\n\\n## Worth Reading\\n\\n- [Old](https://example.test/repeated)\\n\\n## Reflection\\n\\nKeep going.\\n")
    raise SystemExit(0)
if "--publish-preview" in args:
    sys.dont_write_bytecode = True
    adapter = runpy.run_path(${JSON.stringify(fileURLToPath(new URL("../../capability-harnessy-v1-full/resources/flow-install/skills/life-orchestrator/scripts/daily-brief", import.meta.url)))})
    boundary = adapter["main"].__globals__
    def hygiene(path):
        raise AssertionError("Reviewed artifact must not be cleaned again")
    def journal(path, today):
        shutil.copy2(path, life / "delivered.md")
        return True
    boundary["clean_text_hygiene"] = hygiene
    boundary["jarvis_journal"] = journal
    boundary["send_notification"] = lambda brief: None
    adapter["main"]()
    raise SystemExit(0)
raise SystemExit(2)
`;

describe("Life Orchestrator daily service", () => {
	it("backfills only briefs with confirmed journal delivery markers", () => {
		const root = makeRoot();
		const brief = join(root, "2026", "Sep", "08-daily-brief.md");
		mkdirSync(dirname(brief), { recursive: true });
		writeFileSync(brief, "# Daily Brief\n\n## Worth Reading\n\n- [Old](https://example.test/delivered)\n");

		expect(scanDeliveredLifeBriefs(root)).toMatchObject({
			result: { briefsScanned: 1, linksFound: 0 },
			entries: [],
		});

		writeFileSync(`${brief}.journaled`, "{}");
		expect(scanDeliveredLifeBriefs(root)).toMatchObject({
			result: { briefsScanned: 1, linksFound: 1 },
			entries: [{ url: "https://example.test/delivered", briefPath: brief }],
		});
	});

	it("publishes exactly the V2-reserved reading and consumes it only after the journal marker", async () => {
		const root = makeRoot();
		const project = join(root, "project");
		const scripts = join(root, "compatibility");
		mkdirSync(project, { recursive: true });
		mkdirSync(scripts, { recursive: true });
		writeFileSync(join(scripts, "daily-brief"), dailyFixture);
		const settings = resolveLifeOrchestratorSettings({
			projectRoot: project,
			homeRoot: root,
			compatibilityRoot: scripts,
			user: "test",
		});
		const ledger = await Effect.runPromise(LifeReadingLedger.open(settings.paths.databasePath));
		try {
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						{
							url: "https://doi.org/10.1000/unlocking-ai",
							title: "Brand new paper",
							topic: "Systems",
							publishedAt: "2026-09-01T00:00:00.000Z",
							sourceName: "Research Press",
							sourceKind: "crossref",
							sourceId: "doi:10.1000/brand-new",
						},
					],
					new Date().toISOString(),
				),
			);
		} finally {
			ledger.close();
		}

		const now = new Date("2026-09-08T04:30:00.000Z");
		const exited = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
		expect(exited.status).toBe(0);
		mkdirSync(settings.paths.stateDirectory, { recursive: true });
		writeFileSync(join(settings.paths.stateDirectory, "daily-2026-09-08.lock"), JSON.stringify({ pid: exited.pid }));
		const result = await Effect.runPromise(
			runLifeDaily(settings, { now }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
		);
		const canonical = canonicalLifeBriefPath(settings.paths.lifeDirectory, now);
		const markdown = readFileSync(canonical, "utf8");
		expect(result).toMatchObject({ published: true, selected: 1, shortage: true, briefPath: canonical });
		expect(markdown).toContain("[Brand new paper](<https://doi.org/10.1000/unlocking-ai>)");
		expect(readFileSync(join(settings.paths.lifeDirectory, "delivered.md"), "utf8")).toBe(markdown);
		expect(markdown).not.toContain("example.test/repeated");

		const reopened = await Effect.runPromise(LifeReadingLedger.open(settings.paths.databasePath));
		try {
			expect(await Effect.runPromise(reopened.counts())).toMatchObject({ delivered: 1, available: 0, reserved: 0 });
		} finally {
			reopened.close();
		}
	});

	it("regenerates a journaled brief only when V2 force is explicit", async () => {
		const root = makeRoot();
		const project = join(root, "project");
		const scripts = join(root, "compatibility");
		mkdirSync(project, { recursive: true });
		mkdirSync(scripts, { recursive: true });
		writeFileSync(join(scripts, "daily-brief"), dailyFixture);
		const settings = resolveLifeOrchestratorSettings({
			projectRoot: project,
			homeRoot: root,
			compatibilityRoot: scripts,
			user: "test",
		});
		const now = new Date("2026-09-08T04:30:00.000Z");
		const canonical = canonicalLifeBriefPath(settings.paths.lifeDirectory, now);
		mkdirSync(dirname(canonical), { recursive: true });
		writeFileSync(canonical, "# Existing brief\n\n## Worth Reading\n");
		writeFileSync(`${canonical}.journaled`, "{}");

		const ledger = await Effect.runPromise(LifeReadingLedger.open(settings.paths.databasePath));
		try {
			await Effect.runPromise(
				ledger.upsertCandidates(
					[
						{
							url: "https://doi.org/10.1000/forced-refresh",
							title: "Forced refresh paper",
							topic: "Systems",
							publishedAt: "2026-09-02T00:00:00.000Z",
							sourceName: "Research Press",
							sourceKind: "crossref",
							sourceId: "doi:10.1000/forced-refresh",
						},
					],
					new Date().toISOString(),
				),
			);
		} finally {
			ledger.close();
		}

		const skipped = await Effect.runPromise(
			runLifeDaily(settings, { now }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer)),
		);
		expect(skipped).toMatchObject({ published: true, selected: 0, briefPath: canonical });
		expect(readFileSync(canonical, "utf8")).toContain("Existing brief");

		const refreshed = await Effect.runPromise(
			runLifeDaily(settings, { now, force: true }).pipe(
				Effect.provide(CommandRunner.layer),
				Effect.provide(NodeServices.layer),
			),
		);
		expect(refreshed).toMatchObject({ published: true, selected: 1, briefPath: canonical });
		expect(readFileSync(canonical, "utf8")).toContain(
			"[Forced refresh paper](<https://doi.org/10.1000/forced-refresh>)",
		);
	});

	it.each(["active", "incomplete", "recovery"])(
		"preserves the %s lock when another daily run is rejected",
		async (state) => {
			const root = makeRoot();
			const project = join(root, "project");
			const scripts = join(root, "compatibility");
			mkdirSync(project, { recursive: true });
			mkdirSync(scripts, { recursive: true });
			writeFileSync(join(scripts, "daily-brief"), dailyFixture);
			const settings = resolveLifeOrchestratorSettings({
				projectRoot: project,
				homeRoot: root,
				compatibilityRoot: scripts,
			});
			mkdirSync(settings.paths.stateDirectory, { recursive: true });
			const path = join(settings.paths.stateDirectory, "daily-2026-09-08.lock");
			const owner = state === "active" ? JSON.stringify({ pid: process.pid }) : "{}";
			writeFileSync(path, owner);
			if (state === "recovery") writeFileSync(`${path}.recovery`, "another recovery owns this guard\n");

			await expect(
				Effect.runPromise(
					runLifeDaily(settings, { now: new Date("2026-09-08T04:30:00.000Z") }).pipe(
						Effect.provide(CommandRunner.layer),
						Effect.provide(NodeServices.layer),
					),
				),
			).rejects.toThrow(state === "active" ? "already active" : "Unable to acquire");
			expect(readFileSync(path, "utf8")).toBe(owner);
			if (state === "recovery")
				expect(readFileSync(`${path}.recovery`, "utf8")).toBe("another recovery owns this guard\n");
		},
	);
});
