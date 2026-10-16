import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { inspectCalendarPlan } from "../src/jarvis/calendar/plan.ts";

const suppliedCli = process.env.HARNESSY_CALENDAR_TEST_CLI;
if (suppliedCli !== undefined && (!isAbsolute(suppliedCli) || !statSync(suppliedCli).isFile()))
	throw new Error("HARNESSY_CALENDAR_TEST_CLI must be an existing absolute CLI file");

let root: string;
let path: string;
const block = {
	block_id: "block-1",
	task_id: "task-1",
	task_title: "Owner task",
	start: "2026-10-01T09:00:00+01:00",
	end: "2026-10-01T09:30:00+01:00",
	estimated_minutes: 30,
	reason: "Reviewed plan",
};
const plan = { version: 1, plan_id: "plan-1", backend: "anytype", space_id: "space-1", blocks: [block] };
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-plan-")));
	path = join(root, "plan-1.json");
	writeFileSync(path, JSON.stringify(plan), { mode: 0o600 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("fingerprints exact saved bytes without changing the plan or granting publication", () => {
	const bytes = readFileSync(path);
	const result = inspectCalendarPlan(path);
	expect(result.plan).toEqual(plan);
	expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
	expect(result.publicationAuthorized).toBe(false);
	expect(result.legacyApplyReportPresent).toBe(false);
	expect(readFileSync(path)).toEqual(bytes);
	writeFileSync(join(root, "plan-1.apply.json"), "historical receipt remains untouched");
	expect(inspectCalendarPlan(path).legacyApplyReportPresent).toBe(true);
});

it.each([
	{ ...plan, version: 2 },
	{ ...plan, plan_id: "../escape" },
	{ ...plan, blocks: [block, block] },
	{ ...plan, blocks: [{ ...block, end: block.start }] },
	{ ...plan, blocks: [{ ...block, start: "2026-10-01T09:00:00" }] },
	{ ...plan, blocks: [{ ...block, estimated_minutes: "30" }] },
	{ ...plan, blocks: [{ ...block, task_title: "" }] },
])("rejects malformed plans before publication", (invalid) => {
	writeFileSync(path, JSON.stringify(invalid));
	expect(() => inspectCalendarPlan(path)).toThrow();
});

it.runIf(process.platform !== "win32")("rejects symlink and writable-by-other plan files", () => {
	const link = join(root, "link.json");
	symlinkSync(path, link);
	expect(() => inspectCalendarPlan(link)).toThrow(/non-symlink/);
	chmodSync(path, 0o666);
	expect(() => inspectCalendarPlan(path)).toThrow(/Unsafe/);
});

it("runs the real read-only CLI with external traffic denied and rejects bad input", () => {
	const cli =
		suppliedCli === undefined ? fileURLToPath(new URL("../src/cli.ts", import.meta.url)) : realpathSync(suppliedCli);
	const guard = fileURLToPath(
		new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url),
	);
	const run = () =>
		spawnSync(
			process.execPath,
			["--experimental-strip-types", "--import", guard, cli, "jarvis", "calendar", "inspect", "--plan", path],
			{
				cwd: root,
				env: { HOME: root, NODE_NO_WARNINGS: "1" },
				encoding: "utf8",
				timeout: 15_000,
			},
		);
	const good = run();
	expect(good.status, good.stderr).toBe(0);
	expect(JSON.parse(good.stdout).plan).toEqual(plan);
	writeFileSync(path, "{}");
	const bad = run();
	expect(bad.status).not.toBe(0);
	expect(bad.stdout).not.toContain('"publicationAuthorized"');
});
