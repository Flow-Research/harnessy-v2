#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export const resolveHome = (p) => p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
export const resolveGlobalSkillsDir = () => {
  const configured = (process.env.AGENTS_SKILLS_ROOT || "").trim();
  return configured ? path.resolve(resolveHome(configured)) : path.join(HOME, ".agents", "skills");
};

export const GLOBAL_SKILLS_DIR = resolveGlobalSkillsDir();
export const GLOBAL_CLAUDE_MARKETPLACE = path.join(HOME, ".agents", "claude-marketplace");
export const GLOBAL_CLAUDE_SKILLS_DIR = path.join(HOME, ".claude", "skills");
export const GLOBAL_CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");
export const GLOBAL_CLAUDE_INSTALLED_PLUGINS = path.join(HOME, ".claude", "plugins", "installed_plugins.json");
export const GLOBAL_CLAUDE_PLUGIN_CACHE = path.join(HOME, ".claude", "plugins", "cache", "harnessy");
export const GLOBAL_OPENCODE_CONFIG = path.join(HOME, ".config", "opencode", "opencode.json");
export const GLOBAL_CODEX_SKILLS_DIR = path.join(HOME, ".codex", "skills", "harnessy");
export const AGENT_REGISTRY = [
  { id: "claude", componentKey: "claude", label: "Claude Code", cli: "claude", registerScript: "register-claude-skills.mjs" },
  { id: "opencode", componentKey: "opencode", label: "OpenCode", cli: "opencode", registerScript: "register-opencode-skills.mjs" },
  { id: "codex", componentKey: "codex", label: "Codex", cli: "codex", registerScript: "register-codex-skills.mjs" },
];

const FLOW_CLAUDE_PLUGIN_ID = "harnessy";
const GLOBAL_CLAUDE_KNOWN_MARKETPLACES = path.join(HOME, ".claude", "plugins", "known_marketplaces.json");

export const pathExists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

export const readFileSafe = async (p) => {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};

export const readJsonSafe = async (p) => {
  const raw = await readFileSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const writeJson = async (p, data) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2) + "\n", "utf8");
};

export const parseSimpleYaml = (content) => {
  const data = {};
  if (!content) return data;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) continue;
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[trimmed.slice(0, idx).trim()] = value;
  }
  return data;
};

export const parseFrontmatter = (content) => {
  if (!content || !content.startsWith("---")) return null;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return null;
  return { data: parseSimpleYaml(content.slice(4, endIdx)), body: content.slice(endIdx + 4).trim() };
};

export const normalizePath = async (candidate) => {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
};

// Registration is additive. A name alone is not proof of ownership.
// Retain unmatched entries and refuse collisions, including dangling symlinks.
// If a later entry conflicts, earlier links remain valid and rerunning is safe.
const syncSkillDirectory = async (skills, targetDir, { dryRun = false } = {}) => {
  if (dryRun || skills.length === 0) return skills.length;
  await fs.mkdir(targetDir, { recursive: true });
  for (const skill of skills) {
    if (!skill.name || skill.name === "." || skill.name === ".." || /[/\\]/.test(skill.name)) {
      throw new Error(`Invalid skill name: ${skill.name}`);
    }
    const targetPath = path.join(targetDir, skill.name);
    const sourcePath = path.resolve(skill.skillDir);
    try {
      await fs.symlink(sourcePath, targetPath, "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existingTarget = await fs.readlink(targetPath).catch(() => null);
      if (existingTarget !== null && path.resolve(path.dirname(targetPath), existingTarget) === sourcePath) continue;
      throw new Error(`Skill registration conflict at ${targetPath}; existing entry preserved. Move or rename it explicitly, then retry.`, { cause: error });
    }
  }
  return skills.length;
};
export const listActiveSkills = async (skillsRoot = GLOBAL_SKILLS_DIR) => {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const skillMd = await readFileSafe(path.join(skillDir, "SKILL.md"));
    if (!skillMd) continue;
    const frontmatter = parseFrontmatter(skillMd);
    const description = frontmatter?.data?.description || "";
    if (!description) continue;
    skills.push({ name: entry.name, description, skillDir, body: frontmatter?.body || skillMd });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
};

export const registerClaudeSkills = async (skills) => {
  if (skills.length === 0) return 0;
  await syncSkillDirectory(skills, GLOBAL_CLAUDE_SKILLS_DIR);

  const pluginRoot = path.join(GLOBAL_CLAUDE_MARKETPLACE, FLOW_CLAUDE_PLUGIN_ID);
  const pluginManifestDir = path.join(pluginRoot, ".claude-plugin");
  const pluginSkillsDir = path.join(pluginRoot, "skills");
  await fs.mkdir(path.join(GLOBAL_CLAUDE_MARKETPLACE, ".claude-plugin"), { recursive: true });
  await fs.mkdir(pluginManifestDir, { recursive: true });
  await fs.mkdir(pluginSkillsDir, { recursive: true });
  await syncSkillDirectory(skills, pluginSkillsDir);

  await writeJson(path.join(pluginManifestDir, "plugin.json"), {
    name: FLOW_CLAUDE_PLUGIN_ID,
    version: "1.0.0",
    description: "Harnessy skills bundle",
  });

  await writeJson(path.join(GLOBAL_CLAUDE_MARKETPLACE, ".claude-plugin", "marketplace.json"), {
    name: "harnessy",
    owner: { name: "Harnessy" },
    plugins: [{
      name: FLOW_CLAUDE_PLUGIN_ID,
      description: "Harnessy skills bundle",
      version: "1.0.0",
      category: "productivity",
      source: `./${FLOW_CLAUDE_PLUGIN_ID}`,
    }],
  });

  const settings = (await readRegistrationJson(GLOBAL_CLAUDE_SETTINGS)) || {};
  if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {};
  settings.extraKnownMarketplaces.harnessy = {
    source: { source: "directory", path: GLOBAL_CLAUDE_MARKETPLACE },
  };
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins[`${FLOW_CLAUDE_PLUGIN_ID}@harnessy`] = true;
  await writeJson(GLOBAL_CLAUDE_SETTINGS, settings);

  const known = (await readRegistrationJson(GLOBAL_CLAUDE_KNOWN_MARKETPLACES)) || {};
  known.harnessy = {
    source: { source: "directory", path: GLOBAL_CLAUDE_MARKETPLACE },
    installLocation: GLOBAL_CLAUDE_MARKETPLACE,
    lastUpdated: new Date().toISOString(),
  };
  await writeJson(GLOBAL_CLAUDE_KNOWN_MARKETPLACES, known);

  // Destructive legacy migrations belong to the explicit cleanup command.

  return skills.length;
};

export const registerOpenCodeSkills = async (skillsRoot = GLOBAL_SKILLS_DIR) => {
  const config = (await readRegistrationJson(GLOBAL_OPENCODE_CONFIG)) || { $schema: "https://opencode.ai/config.json" };
  if (!config.skills) config.skills = {};
  if (!Array.isArray(config.skills.paths)) config.skills.paths = [];
  const normalizedPaths = [];
  for (const existingPath of config.skills.paths) {
    const normalized = await normalizePath(existingPath);
    if (!normalizedPaths.includes(normalized)) normalizedPaths.push(normalized);
  }
  const normalizedSkillsRoot = await normalizePath(skillsRoot);
  if (!normalizedPaths.includes(normalizedSkillsRoot)) normalizedPaths.push(normalizedSkillsRoot);
  config.skills.paths = normalizedPaths;
  await writeJson(GLOBAL_OPENCODE_CONFIG, config);
  return normalizedPaths.length;
};

export const registerCodexSkills = async (skills) => {
  await syncSkillDirectory(skills, GLOBAL_CODEX_SKILLS_DIR);
  return skills.length;
};

export const registerAllAgentSkills = async (skillsRoot = GLOBAL_SKILLS_DIR) => {
  const skills = await listActiveSkills(skillsRoot);
  const claudeCount = await registerClaudeSkills(skills);
  const opencodePathCount = await registerOpenCodeSkills(skillsRoot);
  const codexCount = await registerCodexSkills(skills);
  return { skills, claudeCount, opencodePathCount, codexCount };
};

// Ownership is explicit. Existing names, versions and --force do not prove it.
export const installOwnedSkill = async (source, target, sourceId, { dryRun = false } = {}) => {
  const markerName = ".harnessy-install.json";
  const owner = { version: 1, owner: "harnessy", sourceId };
  const existing = await fs.lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    const markerPath = path.join(target, markerName);
    const markerInfo = await fs.lstat(markerPath).catch(() => null);
    let marker = null;
    if (existing.isDirectory() && !existing.isSymbolicLink() && markerInfo?.isFile() && !markerInfo.isSymbolicLink()) {
      try { marker = JSON.parse(await fs.readFile(markerPath, "utf8")); } catch {}
    }
    if (marker?.version !== owner.version || marker?.owner !== owner.owner || marker?.sourceId !== sourceId) {
      throw new Error(`Skill install conflict at ${target}; ownership is unverified. Existing entry preserved. Move or rename it explicitly, then retry.`);
    }
  }
  if (dryRun) return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(target), ".harnessy-stage-"));
  const next = path.join(staging, "next");
  const previous = path.join(staging, "previous");
  let moved = false;
  let completed = false;
  try {
    await fs.cp(source, next, { recursive: true, dereference: false });
    const copiedMarker = path.join(next, markerName);
    await fs.rm(copiedMarker, { force: true });
    await fs.writeFile(copiedMarker, JSON.stringify(owner) + "\n", { flag: "wx" });
    if (existing) { await fs.rename(target, previous); moved = true; }
    else await fs.mkdir(target); // Claim only an absent target; never replace a racing install.
    try { await fs.rename(next, target); completed = true; }
    catch (error) {
      if (moved) { await fs.rename(previous, target); moved = false; }
      else await fs.rmdir(target);
      throw error;
    }
  } finally {
    // If rollback itself fails, keep the previous directory for recovery.
    if (!moved || completed) await fs.rm(staging, { recursive: true, force: true });
  }
};

const readRegistrationJson = async (file) => {
  const raw = await readFileSafe(file);
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); }
  catch (cause) { throw new Error(`Invalid registration configuration at ${file}; existing file preserved. Repair the JSON, then retry.`, { cause }); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid registration configuration at ${file}; expected an object. Existing file preserved.`);
  }
  for (const key of ["enabledPlugins", "extraKnownMarketplaces", "skills"]) {
    if (key in value && (value[key] === null || typeof value[key] !== "object" || Array.isArray(value[key]))) {
      throw new Error(`Invalid registration configuration at ${file}; ${key} must be an object. Existing file preserved.`);
    }
  }
  if (value.skills && "paths" in value.skills && (!Array.isArray(value.skills.paths) || value.skills.paths.some((entry) => typeof entry !== "string"))) {
    throw new Error(`Invalid registration configuration at ${file}; skills.paths must contain paths. Existing file preserved.`);
  }
  return value;
};
