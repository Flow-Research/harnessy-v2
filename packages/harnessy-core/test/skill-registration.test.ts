import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const source = resolve("../capability-harnessy-v1-full/resources/source");

// Import the real distributed modules in a fresh process: their home constants
// must never resolve to the developer's home, even if an assertion fails.
describe("distributed skill registration ownership", () => {
	for (const variant of ["canonical", "installer", "generated"] as const) {
		it(`${variant} preserves unmanaged paths, rejects collisions and safely repeats registration`, () => {
			const home = mkdtempSync(`${tmpdir()}/hsy-registration-`);
			try {
				const program = `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const home = process.env.HOME;
const source = ${JSON.stringify(source)};
let modulePath = path.join(source, ${JSON.stringify(variant === "installer" ? "tools/flow-install/lib/agents.mjs" : "scripts/flow/agents.mjs")});
if (${JSON.stringify(variant)} === "generated") {
  const generator = await import(${JSON.stringify(pathToFileURL(resolve(source, "tools/flow-install/lib/scripts.mjs")).href)});
  await generator.installProjectScripts(path.join(home, "project"));
  modulePath = path.join(home, "project/scripts/flow/agents.mjs");
}
const api = await import(pathToFileURL(modulePath));
const skillsRoot = path.join(home, ".agents/skills");
const skillDir = path.join(skillsRoot, "ours");
await fs.mkdir(path.join(skillDir, ".claude-plugin"), { recursive: true });
await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\\ndescription: fixture skill\\n---\\nBody\\n");
await fs.writeFile(path.join(skillDir, ".claude-plugin/keep"), "source plugin");
const skills = await api.listActiveSkills(skillsRoot);
assert.equal(skills.length, 1);
const targets = [".claude/skills", ".codex/skills/harnessy", ".agents/claude-marketplace/harnessy/skills"];
for (const target of targets) {
  const dir = path.join(home, target);
  await fs.mkdir(path.join(dir, "unrelated"), { recursive: true });
  await fs.writeFile(path.join(dir, "unrelated/keep"), "independent");
  await fs.symlink(path.join(home, "missing"), path.join(dir, "unrelated-link"));
}
const retained = [".agents/claude-marketplace/skills/keep", ".claude/plugins/cache/harnessy/independent/keep"];
for (const name of retained) {
  await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true });
  await fs.writeFile(path.join(home, name), "retain");
}
await fs.writeFile(path.join(home, ".claude/settings.json"), JSON.stringify({enabledPlugins:{"ours@harnessy":false}, extraKnownMarketplaces:{independent:{source:"keep"}}}));
await fs.writeFile(path.join(home, ".claude/plugins/known_marketplaces.json"), JSON.stringify({independent:{source:"keep"}}));
await fs.writeFile(path.join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({plugins:{"independent@harnessy":{keep:true}}}));
for (let i = 0; i < 2; i++) {
  assert.equal(await api.registerClaudeSkills(skills), 1);
  assert.equal(await api.registerCodexSkills(skills), 1);
}
await api.registerClaudeSkills([]);
await api.registerCodexSkills([]);
for (const target of targets) {
  const dir = path.join(home, target);
  assert.equal(await fs.readFile(path.join(dir, "unrelated/keep"), "utf8"), "independent");
  assert.equal(await fs.readlink(path.join(dir, "unrelated-link")), path.join(home, "missing"));
  assert.equal(await fs.readlink(path.join(dir, "ours")), skillDir);
}
for (const name of retained) assert.equal(await fs.readFile(path.join(home, name), "utf8"), "retain");
assert.equal(await fs.readFile(path.join(skillDir, ".claude-plugin/keep"), "utf8"), "source plugin");
assert.equal(JSON.parse(await fs.readFile(path.join(home, ".claude/settings.json"))).enabledPlugins["ours@harnessy"], false);
assert.ok(JSON.parse(await fs.readFile(path.join(home, ".claude/plugins/known_marketplaces.json"))).independent);
assert.ok(JSON.parse(await fs.readFile(path.join(home, ".claude/plugins/installed_plugins.json"))).plugins["independent@harnessy"]);
for (const kind of ["directory", "file", "symlink", "dangling"]) {
  for (const [register, target] of [[api.registerClaudeSkills, targets[0]], [api.registerCodexSkills, targets[1]]]) {
    const entry = path.join(home, target, kind);
    if (kind === "directory") { await fs.mkdir(entry); await fs.writeFile(path.join(entry,"keep"), "independent"); }
    if (kind === "file") await fs.writeFile(entry, "independent");
    if (kind === "symlink" || kind === "dangling") await fs.symlink(kind === "symlink" ? skillDir : path.join(home,"missing"), entry);
    const before = await fs.lstat(entry);
    await assert.rejects(register([{name:kind, skillDir:path.join(home,"other-source")}]), /registration conflict.*existing entry preserved/);
    assert.equal((await fs.lstat(entry)).ino, before.ino);
    if (kind === "directory") assert.equal(await fs.readFile(path.join(entry,"keep"),"utf8"),"independent");
    if (kind === "file") assert.equal(await fs.readFile(entry,"utf8"),"independent");
  }
}
// A later conflict can leave earlier additive links. Retry must keep them intact.
const partial = [{ name: "first", skillDir }, { name: "directory", skillDir }];
await assert.rejects(api.registerCodexSkills(partial), /registration conflict/);
assert.equal(await fs.readlink(path.join(home,targets[1],"first")),skillDir);
await assert.rejects(api.registerCodexSkills(partial), /registration conflict/);
await assert.rejects(api.registerCodexSkills([{name:"../escape",skillDir}]), /Invalid skill name/);
// Owned installation supports upgrades; matching names and versions alone never authorize replacement.
const owned = path.join(home, "owned");
await api.installOwnedSkill(skillDir, owned, "bundled:ours");
await fs.writeFile(path.join(skillDir, "SKILL.md"), "updated");
await api.installOwnedSkill(skillDir, owned, "bundled:ours");
assert.equal(await fs.readFile(path.join(owned,"SKILL.md"),"utf8"),"updated");
await assert.rejects(api.installOwnedSkill(skillDir, owned, "project:other"), /ownership is unverified/);
await assert.rejects(api.installOwnedSkill(path.join(home,"missing-source"), owned, "bundled:ours"));
assert.equal(await fs.readFile(path.join(owned,"SKILL.md"),"utf8"),"updated");
for (const target of ["directory","file","symlink","dangling"]) {
  await assert.rejects(api.installOwnedSkill(skillDir, path.join(home, targets[0],target), "bundled:ours"), /ownership is unverified/);
}
// Syntax errors and valid non-object JSON must not be replaced with empty configuration.
for (const config of ["{broken", "[]", "null", JSON.stringify("text"), JSON.stringify({enabledPlugins:[]}), JSON.stringify({skills:{paths:42}})]) {
  const configPath = path.join(home,".claude/settings.json");
  await fs.writeFile(configPath,config);
  await assert.rejects(api.registerClaudeSkills(skills), /Invalid registration configuration/);
  assert.equal(await fs.readFile(configPath,"utf8"),config);
}
if (${JSON.stringify(variant)} === "installer") {
  const installer = await import(pathToFileURL(path.join(source,"tools/flow-install/lib/skills.mjs")));
  const fixtureRoot=path.join(home,"bundle");
  const fixtureSkill=path.join(fixtureRoot,"skills/fixture");
  await fs.mkdir(fixtureSkill,{recursive:true});
  await fs.writeFile(path.join(fixtureSkill,"SKILL.md"),"fixture");
  await fs.writeFile(path.join(fixtureSkill,"manifest.yaml"),"name: fixture\\nversion: 1.0.0\\n");
  await installer.installSkills(fixtureRoot);
  await fs.writeFile(path.join(fixtureSkill,"manifest.yaml"),"name: fixture\\nversion: 2.0.0\\n");
  await installer.installSkills(fixtureRoot);
  assert.match(await fs.readFile(path.join(skillsRoot,"fixture/manifest.yaml"),"utf8"),/2.0.0/);
  await fs.rm(path.join(skillsRoot,"fixture/.harnessy-install.json"));
  await assert.rejects(installer.installSkills(fixtureRoot,{force:true}), /ownership is unverified/);
  assert.match(await fs.readFile(path.join(skillsRoot,"fixture/manifest.yaml"),"utf8"),/2.0.0/);
}
if (${JSON.stringify(variant)} === "generated") {
  const local=path.join(home,"project/.agents/skills/collision");
  const global=path.join(skillsRoot,"collision");
  await fs.mkdir(local,{recursive:true});
  await fs.writeFile(path.join(local,"SKILL.md"),"new");
  await fs.mkdir(global);
  await fs.writeFile(path.join(global,"SKILL.md"),"independent");
  const run=spawnSync(process.execPath,[path.join(home,"project/scripts/flow/register-skills.mjs")],{cwd:path.join(home,"project"),env:process.env,encoding:"utf8"});
  assert.equal(run.status,1);
  assert.match(run.stderr,/ownership is unverified/);
  assert.equal(await fs.readFile(path.join(global,"SKILL.md"),"utf8"),"independent");
}
`;
				const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
					env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH },
					encoding: "utf8",
					timeout: 20_000,
				});
				expect(result.error).toBeUndefined();
				expect(result.status, result.stdout + result.stderr).toBe(0);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
});
