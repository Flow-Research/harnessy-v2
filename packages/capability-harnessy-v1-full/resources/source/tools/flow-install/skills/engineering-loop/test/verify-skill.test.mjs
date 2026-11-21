import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const skillRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(skillRoot, "../../../..");

test("manifest and single catalog entry preserve measured execution limits", () => {
	const manifest = parse(readFileSync(join(skillRoot, "manifest.yaml"), "utf8"));
	for (const key of ["name", "type", "version", "owner", "status", "blast_radius", "description", "permissions", "data_categories", "egress", "invoke", "location"])
		assert.notEqual(manifest[key], undefined, key);
	assert.equal(manifest.name, "engineering-loop");
	assert.equal(manifest.install_scope, "global");
	assert.equal(manifest.blast_radius, "medium");
	assert.equal(manifest.autoresearch.enabled, true);
	assert.equal(manifest.autoresearch.time_budget_seconds, 1200);
	assert.equal(manifest.autoresearch.constraints.paid_fallback, "forbidden");
	assert.equal(manifest.autoresearch.constraints.authority_and_privacy, "veto");
	const catalog = readFileSync(join(sourceRoot, ".jarvis/context/skills/_catalog.md"), "utf8");
	assert.equal(catalog.match(/^name: engineering-loop$/gm)?.length, 1);
	const document = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
	assert.ok(document.includes("${AGENTS_SKILLS_ROOT}/engineering-loop/"));
	assert.ok(document.includes("harnessy engineering status"));
	assert.ok(document.includes("This skill creates no scheduler or agent engine."));
});

test("existing registration installs and refreshes all supported agents in an isolated test root", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-skill-registration-")));
	try {
		const preload = join(root, "fixture-home.cjs");
		// This fixture changes only the child process's OS home lookup. HOME stays untouched.
		writeFileSync(preload, 'require("node:os").homedir = () => process.env.HARNESSY_SKILL_TEST_ROOT;\n');
		const registration = pathToFileURL(join(sourceRoot, "scripts/flow/agents.mjs")).href;
		const script = join(root, "registration.mjs");
		writeFileSync(script, `import assert from "node:assert/strict";
import { readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { GLOBAL_CLAUDE_SETTINGS, GLOBAL_CODEX_SKILLS_DIR, GLOBAL_OPENCODE_CONFIG, installOwnedSkill, registerAllAgentSkills } from ${JSON.stringify(registration)};
const root = process.env.HARNESSY_SKILL_TEST_ROOT;
for (const target of [GLOBAL_CLAUDE_SETTINGS, GLOBAL_CODEX_SKILLS_DIR, GLOBAL_OPENCODE_CONFIG]) assert.ok(target.startsWith(root + "/"));
const skills = join(root,"agents","skills");
const target = join(skills,"engineering-loop");
await installOwnedSkill(process.env.HARNESSY_SKILL_SOURCE,target,"engineering-loop-fixture");
const first = await registerAllAgentSkills(skills);
assert.equal(first.claudeCount,1); assert.equal(first.codexCount,1);
assert.equal(await readlink(join(root,".claude","skills","engineering-loop")),target);
assert.equal(await readlink(join(GLOBAL_CODEX_SKILLS_DIR,"engineering-loop")),target);
const config = JSON.parse(await readFile(GLOBAL_OPENCODE_CONFIG,"utf8"));
assert.deepEqual(config.skills.paths,[skills]);
await installOwnedSkill(process.env.HARNESSY_SKILL_SOURCE,target,"engineering-loop-fixture");
const again = await registerAllAgentSkills(skills);
assert.equal(again.skills.length,1);
process.stdout.write("Isolated install and agent registration passed.\\n");
`);
		const result = spawnSync(process.execPath, ["--require", preload, script], {
			cwd: root,
			env: { ...process.env, HARNESSY_SKILL_TEST_ROOT: root, HARNESSY_SKILL_SOURCE: skillRoot, AGENTS_SKILLS_ROOT: join(root,"agents","skills") },
			encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
		writeFileSync(join(root,"harnessy.lock.json"), JSON.stringify({ installPaths: { skillsDir: "agents/skills" } }));
		const validation = spawnSync(process.execPath,[join(sourceRoot,"scripts/flow/validate-skills.mjs")],{ cwd: root, encoding:"utf8", timeout: 15_000 });
		assert.equal(validation.status,0,validation.stderr);
		assert.match(validation.stdout,/Skill validation passed/);
	} finally {
		rmSync(root,{recursive:true,force:true});
	}
});
