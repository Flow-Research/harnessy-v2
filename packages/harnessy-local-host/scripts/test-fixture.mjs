import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const coreSourceRoot = join(repoRoot, "packages", "harnessy-core", "src");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		encoding: options.encoding ?? "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `${command} ${args.join(" ")} failed:\n${output}` : `${command} ${args.join(" ")} failed`);
	}
	return result.stdout ?? "";
};

const digest = (value) => createHash("sha256").update(value).digest("hex");

const snapshot = () => ({
	tracked: digest(run("git", ["diff", "--binary", "--no-ext-diff"], { capture: true, encoding: null })),
	staged: digest(run("git", ["diff", "--cached", "--binary", "--no-ext-diff"], { capture: true, encoding: null })),
	status: run("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
		capture: true,
	}),
});

const emittedCoreSourceArtifacts = () => {
	const artifacts = [];
	const visit = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) artifacts.push(path);
		}
	};
	visit(coreSourceRoot);
	return artifacts.sort();
};

const assertNoCoreSourceEmit = () => {
	const artifacts = emittedCoreSourceArtifacts();
	if (artifacts.length !== 0) {
		throw new Error(`Core source contains emitted JavaScript/declarations: ${artifacts.join(", ")}`);
	}
};

const before = snapshot();
assertNoCoreSourceEmit();
let executionError;
try {
	run(npmCommand, ["exec", "--", "tsgo", "-p", "packages/harnessy-core/tsconfig.build.json"]);
	run(npmCommand, ["run", "build", "--workspace", "@harnessy/sdk"]);
	run(npmCommand, ["run", "build"], { cwd: packageRoot });
	run(process.execPath, [join(packageRoot, "scripts", "fixture-smoke.mjs")], { cwd: packageRoot });
} catch (cause) {
	executionError = cause;
}
const after = snapshot();
assertNoCoreSourceEmit();
if (before.tracked !== after.tracked || before.staged !== after.staged || before.status !== after.status) {
	throw new Error("The local-host fixture changed tracked or untracked worktree state");
}
if (executionError !== undefined) throw executionError;
