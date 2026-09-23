import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { correctJarvisPlanningSource } from "../packages/harnessy-core/src/runtime/jarvis-planning-correction.ts";
import { correctJarvisAnytypeSource } from "../packages/harnessy-core/src/runtime/jarvis-anytype-correction.ts";
import { correctJarvisCommunitySource } from "../packages/harnessy-core/src/runtime/jarvis-community-source-correction.ts";

/** Install verified V2-owned reuse into the candidate, never into the user's global tools. */
export const installLocalJarvisRuntime = (sourceRoot, environmentRoot) => {
	if (!isAbsolute(sourceRoot) || !isAbsolute(environmentRoot)) throw new Error("Jarvis installation paths must be absolute");
	if (existsSync(environmentRoot)) throw new Error("Jarvis candidate environment already exists; refusing to replace it");
	// Correct only a disposable build copy. The verified preserved source stays byte-identical.
	const buildRoot = mkdtempSync(join(dirname(environmentRoot), "jarvis-install-source-"));
	try {
		cpSync(sourceRoot, buildRoot, { recursive: true });
		const planner = join(buildRoot, "src/jarvis/services/planning_service.py");
		writeFileSync(planner, correctJarvisPlanningSource(readFileSync(planner, "utf8")));
		const anytype = join(buildRoot, "src/jarvis/anytype_client.py");
		writeFileSync(anytype, correctJarvisAnytypeSource(readFileSync(anytype, "utf8")));
		const collector = join(buildRoot, "src/jarvis/community_briefing/collector.py");
		writeFileSync(collector, correctJarvisCommunitySource(readFileSync(collector, "utf8")));
		const syncCli = join(buildRoot, "src/jarvis/sync/cli.py");
		const syncSource = readFileSync(syncCli, "utf8");
		if (createHash("sha256").update(syncSource).digest("hex") !== "17fe246f2af1869a473ae3244c57a2f5b58ee4d4ef623bec7b67cf5c937fe0a5") {
			throw new Error("Unknown Jarvis sync source; refusing installation correction");
		}
		writeFileSync(syncCli, syncSource
			.replace("        if adapter is None:\n            return", "        if adapter is None:\n            raise SystemExit(1)")
			.replace("            adapter, destination\n        ):\n            return", "            adapter, destination\n        ):\n            raise SystemExit(1)")
			.replace("if not dry_run and result.state is not None and not result.errors:", "if not dry_run and result.state is not None:")
			.replace("State was not written because the sync had errors.", "Partial state saved; errors require reconciliation before retry."));
		const result = spawnSync("uv", ["sync", "--project", buildRoot, "--frozen", "--no-dev", "--no-editable", "--python", "3.11", "--no-python-downloads"], {
			shell: false,
			stdio: "inherit",
			env: { ...process.env, UV_PROJECT_ENVIRONMENT: environmentRoot },
		});
		if (result.error || result.status !== 0) throw new Error("Locked Jarvis runtime installation failed; verify uv and Python 3.11 are available on PATH");
		const python = join(environmentRoot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
		if (!existsSync(python)) throw new Error("Locked Jarvis runtime installation did not produce its interpreter");
		return python;
	} finally {
		rmSync(buildRoot, { recursive: true, force: true });
	}
};
