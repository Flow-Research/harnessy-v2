import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installReleaseLaunchers } from "./install-release.mjs";

assert.equal(process.platform, "darwin", "Installed skill isolation requires macOS sandbox-exec");
const cli = realpathSync(process.argv[2]);
const qa = realpathSync(process.argv[3]);
const python = resolve(process.argv[4]);
const review = resolve(dirname(qa), "../../code-review/scripts/harness-code-review");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(!cli.startsWith(`${repo}/`), "Acceptance requires an independently installed CLI");
assert(!qa.startsWith(`${repo}/`), "Acceptance requires a distributed QA entrypoint");
const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-installed-skills-"));
const project = join(root, "project");
const home = join(root, "home");
const traces = join(root, "traces");
const skills = join(project, ".harnessy", "skills");
mkdirSync(project);
mkdirSync(home);
const sandbox = join(root, "isolation.sb");
const fixtureNode = join(root, "node");
cpSync(realpathSync(process.execPath), fixtureNode);
assert.deepEqual(readFileSync(fixtureNode), readFileSync(process.execPath));
writeFileSync(sandbox, `(version 1)
(allow default)
(deny network*)
(deny file-read* (subpath ${JSON.stringify(repo)}))
(deny file-read* (subpath ${JSON.stringify(realpathSync(homedir()))}))
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
`);
const run = (args, status = 0, entry = cli, executable = fixtureNode) => {
	const result = spawnSync("/usr/bin/sandbox-exec", ["-f", sandbox, executable, ...(entry ? [entry] : []), ...args], {
		cwd: project, encoding: "utf8", timeout: 30_000,
		env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: root, NODE_NO_WARNINGS: "1", HSY_CODING_AGENT_DIR: join(home, "agent") },
	});
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, status, result.stderr || result.stdout);
	return result;
};
try {
	// Exercise newly generated launchers against the already installed packages,
	// without overwriting the retained candidate or substituting fake entrypoints.
	const launcherTarget = join(root, "launcher-install");
	mkdirSync(launcherTarget);
	const modules = resolve(dirname(cli), "../../..");
	symlinkSync(modules, join(launcherTarget, "node_modules"));
	symlinkSync(join(dirname(modules), "service"), join(launcherTarget, "service"));
	symlinkSync(dirname(dirname(python)), join(launcherTarget, "jarvis-runtime"));
	const launchers = installReleaseLaunchers(launcherTarget);
	const jarvisHelp = run(["--help"], 0, null, join(launchers.commands, "jarvis")).stdout;
	for (const command of ["task", "journal", "reading-list", "wiki", "meeting", "community"])
		assert(jarvisHelp.includes(command), `Installed Jarvis launcher omitted ${command}`);
	assert.match(run(["--help"], 0, null, join(launchers.commands, "harnessy")).stdout, /Harnessy/);
	assert.match(run(["--help"], 0, null, join(launchers.commands, "hsy")).stdout, /Harnessy agent-first context engine/);
	const host = join(dirname(modules), "service/node_modules/@harnessy/local-host");
	const hostCommands = JSON.parse(readFileSync(join(host, "package.json"), "utf8")).bin;
	assert.equal(Object.keys(hostCommands).length, 9);
	for (const [name, entry] of Object.entries(hostCommands)) {
		assert(readFileSync(join(launchers.commands, name), "utf8").includes("/service/node_modules/@harnessy/local-host/"), name);
		const args = ["--fixture-invalid-option"];
		const launched = run(args, 1, null, join(launchers.commands, name));
		const direct = run(args, 1, join(host, entry));
		assert.equal(launched.stdout, direct.stdout, name);
		assert.equal(launched.stderr, direct.stderr, name);
		if (name === "harnessy-meeting-review-open") {
			assert.deepEqual(JSON.parse(launched.stderr), { error: "meeting_review_open_failed" });
		} else if (name === "harnessy-meeting-setup") {
			assert.deepEqual(JSON.parse(launched.stderr), {
				error: "meeting_setup_failed", next: "Inspect preserved setup state before retrying; no activation occurred.",
			});
		} else assert.match(launched.stderr, /invalid|usage|expected|unknown/i, name);
		assert.doesNotMatch(launched.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/, name);
	}
	run(["skill", "create", "portable-skill", "--target", project, "--owner", "fixture"]);
	const manifest = join(skills, "portable-skill", "manifest.yaml");
	const skillFile = join(skills, "portable-skill", "SKILL.md");
	assert(existsSync(manifest));
	assert(existsSync(skillFile));
	const validate = () => run(["skill", "validate", "--target", project, "--json"]);
	const valid = JSON.parse(validate().stdout);
	assert.equal(valid.ok, true);
	assert.equal(valid.skills.length, 1);
	assert.equal(valid.skills[0].name, "portable-skill");
	const original = readFileSync(manifest, "utf8");
	writeFileSync(skillFile, `${readFileSync(skillFile, "utf8")}\nOwner fixture edit.\n`);
	const edited = readFileSync(skillFile, "utf8");
	run(["skill", "create", "portable-skill", "--target", project]);
	assert.equal(readFileSync(skillFile, "utf8"), edited);
	assert.equal(readFileSync(manifest, "utf8"), original);
	writeFileSync(manifest, original.split("\n").filter(line => !line.startsWith("egress:")).join("\n"));
	const invalid = run(["skill", "validate", "--target", project, "--json"], 1);
	assert.equal(JSON.parse(invalid.stdout).ok, false);
	assert.match(invalid.stdout, /egress/);
	writeFileSync(manifest, original);
	assert.equal(JSON.parse(validate().stdout).ok, true);
	for (const text of ["first fixture feedback", "second fixture feedback"]) {
		const result = JSON.parse(run(["skill", "feedback", "portable-skill", "--installed-root", skills,
			"--traces-root", traces, "--text", text, "--json"]).stdout);
		assert.equal(result.ok, true);
		assert.equal(result.file, join(traces, "portable-skill", "traces.ndjson"));
	}
	const records = readFileSync(join(traces, "portable-skill", "traces.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	assert.equal(records.length, 2);
	assert.deepEqual(records.map(record => record.feedback.unstructured), [["first fixture feedback"], ["second fixture feedback"]]);
	run(["skill", "create", "../escape", "--target", project], 1);
	assert.equal(existsSync(join(project, ".harnessy", "escape")), false);
	assert.equal(readFileSync(skillFile, "utf8"), edited);
	const profileDir = join(project, ".jarvis/context/profiles");
	mkdirSync(profileDir, { recursive: true });
	mkdirSync(join(project, "qa/tests"), { recursive: true });
	writeFileSync(join(profileDir, "qa.json"), JSON.stringify({
		version: 1,
		specs: [{ path: "qa/spec.md", app: "fixture", layer: "api" }],
		apps: [{ id: "fixture", tests: { api: ["qa/tests"], browser: [] } }],
		output: { coverage: "qa/coverage.md" },
	}));
	writeFileSync(join(project, "qa/spec.md"), "# Fixture\n\n## QA-001 Portable inventory\nLayer: api\nStatus: implemented\nTest File: qa/tests/portable.api.test.mjs\nExpected: The inventory contains this scenario.\n");
	const testPath = join(project, "qa/tests/portable.api.test.mjs");
	const testText = "// @qa-spec: qa/spec.md\n// @qa-suite: portable\nimport test from 'node:test';\ntest('QA-001 Portable inventory', () => {});\n";
	writeFileSync(testPath, testText);
	const ids = JSON.parse(run(["ids", "--json"], 0, qa).stdout);
	assert.deepEqual(ids.records.map(record => record.id), ["QA-001"]);
	assert.deepEqual(ids.errors, []);
	const inventory = JSON.parse(run(["tests", "--json"], 0, qa).stdout);
	assert.equal(inventory.filesScanned, 1);
	assert.deepEqual(inventory.records.map(record => record.extractedId), ["QA-001"]);
	assert.equal(JSON.parse(run(["drift", "--json"], 0, qa).stdout).ok, true);
	const installArgs = ["install", "--target", project, "--step", "runtime-assets", "--apply-global", "--global-root", home];
	const installedQa = join(home, ".local/bin/qa");
	const installedReview = join(home, ".local/bin/harness-code-review");
	mkdirSync(dirname(installedQa), { recursive: true });
	// Reproduce the old installer's standalone copy. Repair is an explicit,
	// byte-verified backup followed by ordinary install, not blind overwriting.
	cpSync(qa, installedQa);
	run(installArgs);
	assert.equal(lstatSync(installedQa).isSymbolicLink(), false);
	assert.deepEqual(readFileSync(installedQa), readFileSync(qa));
	assert.match(run(["drift", "--json"], 1, installedQa).stderr, /ERR_MODULE_NOT_FOUND/);
	const previousQa = join(root, "previous-qa");
	renameSync(installedQa, previousQa);
	run(installArgs);
	assert.equal(lstatSync(installedQa).isSymbolicLink(), true);
	assert.deepEqual(readFileSync(previousQa), readFileSync(qa));
	assert(existsSync(installedQa), "Installer must expose the QA command");
	assert(existsSync(installedReview), "Installer must expose the code-review command");
	assert.equal(JSON.parse(run(["drift", "--json"], 0, installedQa).stdout).ok, true);
	const installedSkill = join(home, ".agents/skills/code-review/SKILL.md");
	const ownerSkill = `${readFileSync(installedSkill, "utf8")}\nOwner installation fixture edit.\n`;
	writeFileSync(installedSkill, ownerSkill);
	const hooks = join(project, ".jarvis/hooks.yaml");
	const ownerHooks = `${readFileSync(hooks, "utf8")}\n# Owner fixture configuration\n`;
	writeFileSync(hooks, ownerHooks);
	run(installArgs);
	assert.equal(readFileSync(installedSkill, "utf8"), ownerSkill, "Reinstall must preserve same-version owner edits");
	assert.equal(readFileSync(hooks, "utf8"), ownerHooks);
	const deps = join(home, ".local/bin/flow-deps");
	const dependencyManifest = join(project, "dependency-fixture.yaml");
	writeFileSync(dependencyManifest, "name: dependency-fixture\ndependencies:\n  - tool: harnessy-fixture-tool-not-installed\n    required: true\n");
	const dependencyResult = run(["check", "--manifest", dependencyManifest, "--json"], 1, deps);
	assert(dependencyResult.stdout.trim(), dependencyResult.stderr);
	const dependencyCheck = JSON.parse(dependencyResult.stdout);
	assert.equal(dependencyCheck.length, 1);
	assert.equal(dependencyCheck[0].missingRequired.length, 1);
	assert.equal(dependencyCheck[0].missingRequired[0].name, "harnessy-fixture-tool-not-installed");
	writeFileSync(dependencyManifest, "name: dependency-fixture\ndependencies:\n  - tool: git\n    required: true\n");
	const availableDependencies = JSON.parse(run(["check", "--manifest", dependencyManifest, "--json"], 0, deps).stdout);
	assert.equal(availableDependencies[0].missingRequired.length, 0);
	// The synthetic repository exercises actual Git discovery, not a canned inventory.
	run(["init", "--quiet"], 0, null, "/usr/bin/git");
	writeFileSync(join(project, "review-fixture.txt"), "before\n");
	run(["add", "review-fixture.txt"], 0, null, "/usr/bin/git");
	const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m"];
	run([...commit, "Before"], 0, null, "/usr/bin/git");
	writeFileSync(join(project, "review-fixture.txt"), "after\n");
	run(["add", "review-fixture.txt"], 0, null, "/usr/bin/git");
	run([...commit, "After"], 0, null, "/usr/bin/git");
	assert.deepEqual(readFileSync(installedReview), readFileSync(review));
	const reviewArgs = ["-I", "-B", installedReview, "ci", "--base", "HEAD~1", "--head", "HEAD", "--json"];
	const reviewed = JSON.parse(run([...reviewArgs, "--run-id", "fixture-review"], 0, null, python).stdout);
	assert.equal(reviewed.ok, true);
	assert.equal(reviewed.mode, "deterministic_only");
	assert.equal(reviewed.review_status, "skipped");
	assert.equal(reviewed.evidence_validation.ok, true);
	for (const key of ["discovery", "review_json", "markdown_report", "sarif_report", "evidence"]) {
		assert(readFileSync(resolve(project, reviewed.artifacts[key])).length > 0, key);
	}
	const discovery = JSON.parse(readFileSync(resolve(project, reviewed.artifacts.discovery), "utf8"));
	assert.deepEqual(discovery.files.map(file => file.path), ["review-fixture.txt"]);
	assert.equal(discovery.files[0].additions, 1);
	assert.equal(discovery.files[0].deletions, 1);
	const required = JSON.parse(run([...reviewArgs, "--run-id", "fixture-required", "--require-ai"], 3, null, python).stdout);
	assert.equal(required.ok, false);
	assert.equal(required.gate_result, "fail");
	assert.equal(required.review_status, "skipped");
	const failedProvider = JSON.parse(run([...reviewArgs, "--run-id", "fixture-provider", "--review-command", "/usr/bin/false"], 3, null, python).stdout);
	assert.equal(failedProvider.ok, false);
	assert.match(failedProvider.error, /review command failed/);
	const deploy = join(home, ".local/bin/harness-deploy");
	const ciProfile = { version: 1, gates: [{ name: "fixture", required: true, command: "/usr/bin/true" }] };
	writeFileSync(join(profileDir, "ci.json"), JSON.stringify(ciProfile));
	writeFileSync(join(profileDir, "deploy.json"), JSON.stringify({
		version: 1, defaultEnvironment: "fixture", apps: [{ id: "fixture", root: "fixture-app", runtime: { mode: "static" } }],
		environments: { fixture: { provider: "hostinger", adapter: "mock" } },
	}));
	const deploymentPlan = JSON.parse(run(["-I", "-B", deploy, "plan", "--json"], 0, null, python).stdout);
	assert.equal(deploymentPlan.environment, "fixture");
	assert.deepEqual(deploymentPlan.runtimeModes, ["static"]);
	assert.equal(JSON.parse(run(["-I", "-B", deploy, "check", "--json"], 0, null, python).stdout).ok, true);
	ciProfile.gates[0].command = "/usr/bin/false";
	writeFileSync(join(profileDir, "ci.json"), JSON.stringify(ciProfile));
	const failedGate = JSON.parse(run(["-I", "-B", deploy, "check", "--json"], 1, null, python).stdout);
	assert.equal(failedGate.ok, false);
	assert.equal(failedGate.gates[0].exitCode, 1);
	const application = join(project, "fixture-app");
	mkdirSync(join(application, "node_modules/dependency"), { recursive: true });
	mkdirSync(join(application, ".jarvis/context/profiles/local"), { recursive: true });
	writeFileSync(join(application, "index.html"), "<h1>Fixture application</h1>\n");
	writeFileSync(join(application, ".env"), "SYNTHETIC_SECRET=never-package\n");
	writeFileSync(join(application, "node_modules/dependency/index.js"), "// excluded fixture dependency\n");
	writeFileSync(join(application, ".jarvis/context/profiles/local/provider.env"), "SYNTHETIC_TOKEN=never-package\n");
	const packaged = JSON.parse(run(["-I", "-B", deploy, "package", "--run-id", "fixture-package", "--json"], 0, null, python).stdout);
	assert.equal(packaged.ok, true);
	const archive = resolve(project, packaged.package);
	assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"), packaged.sha256);
	const archivePaths = run(["-tzf", archive], 0, null, "/usr/bin/tar").stdout.trim().split("\n");
	assert.deepEqual(archivePaths, ["fixture-app/index.html"]);
	assert.equal(run(["-xOzf", archive, "fixture-app/index.html"], 0, null, "/usr/bin/tar").stdout, "<h1>Fixture application</h1>\n");
	run(["coverage"], 0, qa);
	assert.match(readFileSync(join(project, "qa/coverage.md"), "utf8"), /\| fixture \| api \| 1 \| 1 \| 1 \|/);
	writeFileSync(testPath, testText.replace("QA-001", "QA-999"));
	const drift = JSON.parse(run(["drift", "--json"], 1, qa).stdout);
	assert.equal(drift.ok, false);
	assert.deepEqual(drift.issues.map(issue => issue.rule).sort(), ["implemented-without-test", "test-references-nonexistent-spec"]);
	writeFileSync(testPath, testText.split("\n").filter(line => !line.startsWith("// @qa-")).join("\n"));
	const headerDrift = JSON.parse(run(["drift", "--json"], 1, qa).stdout);
	assert.deepEqual(headerDrift.issues.map(issue => issue.rule), ["test-missing-header"]);
	writeFileSync(testPath, testText);
	assert.equal(JSON.parse(run(["drift", "--json"], 0, qa).stdout).ok, true);
	console.log("Installed release launchers passed: two real CLI help journeys and nine operational argument rejections matching direct entrypoints, with real home/source reads and network denied.");
	console.log("Installed skill lifecycle passed: create, validate, edit preservation, invalid manifest rejection, feedback append, and traversal rejection with real home/source reads and network denied.");
	console.log("Distributed QA runtime passed: nonempty spec/test inventories, coverage output, missing/orphan test and missing-header rejection. Inventory coverage is not test execution evidence.");
	console.log("Distributed code-review passed: real Git diff and validated artifacts; missing required AI and failed provider reject. Deterministic success is not AI review approval.");
	console.log("Installed upgrade passed: existing command preserved, explicit byte-verified backup/repair, and owner skill/hook edits retained.");
	console.log("Installed deployment packaging passed: exact application bytes, archive hash, and exclusion of environment, dependency and provider-local files. No deployment performed.");
} finally {
	rmSync(root, { recursive: true, force: true });
}
