import fs from "node:fs/promises";
import path from "node:path";
import {
  readFileSafe,
  readJsonSafe,
  writeJson,
  ensureDir,
  parseFrontmatter,
  GLOBAL_SKILLS_DIR,
  GLOBAL_CLAUDE_MARKETPLACE,
  GLOBAL_CLAUDE_SETTINGS,
  GLOBAL_CLAUDE_SKILLS_DIR,
  GLOBAL_OPENCODE_CONFIG,
  homeDir,
  log,
} from "./utils.mjs";

const FLOW_CLAUDE_PLUGIN_ID = "harnessy";
const GLOBAL_CLAUDE_KNOWN_MARKETPLACES = path.join(homeDir, ".claude", "plugins", "known_marketplaces.json");
const GLOBAL_CODEX_SKILLS_DIR = path.join(homeDir, ".codex", "skills", "harnessy");

export const AGENT_REGISTRY = [
  {
    id: "claude",
    componentKey: "claude",
    label: "Claude Code",
    cli: "claude",
    registerScript: "register-claude-skills.mjs",
  },
  {
    id: "opencode",
    componentKey: "opencode",
    label: "OpenCode",
    cli: "opencode",
    registerScript: "register-opencode-skills.mjs",
  },
  {
    id: "codex",
    componentKey: "codex",
    label: "Codex",
    cli: "codex",
    registerScript: "register-codex-skills.mjs",
  },
];

export const normalizePath = async (candidate) => {
  try {
    return await fs.realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
};

export const listSkillDirectories = async (skillsRoot = GLOBAL_SKILLS_DIR) => {
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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
    skills.push({
      name: entry.name,
      description,
      skillDir,
      body: frontmatter?.body || skillMd,
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
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

const updateClaudeSettings = async (skills, { dryRun = false } = {}) => {
  if (dryRun) return;

  const existing = await readRegistrationJson(GLOBAL_CLAUDE_SETTINGS) || {};

  if (!existing.extraKnownMarketplaces) existing.extraKnownMarketplaces = {};
  existing.extraKnownMarketplaces.harnessy = {
    source: { source: "directory", path: GLOBAL_CLAUDE_MARKETPLACE },
  };

  if (!existing.enabledPlugins) existing.enabledPlugins = {};
  existing.enabledPlugins[`${FLOW_CLAUDE_PLUGIN_ID}@harnessy`] = true;

  await writeJson(GLOBAL_CLAUDE_SETTINGS, existing);
};

const updateClaudeKnownMarketplaces = async ({ dryRun = false } = {}) => {
  if (dryRun) return;

  const known = await readRegistrationJson(GLOBAL_CLAUDE_KNOWN_MARKETPLACES) || {};
  known.harnessy = {
    source: { source: "directory", path: GLOBAL_CLAUDE_MARKETPLACE },
    installLocation: GLOBAL_CLAUDE_MARKETPLACE,
    lastUpdated: new Date().toISOString(),
  };
  await ensureDir(path.dirname(GLOBAL_CLAUDE_KNOWN_MARKETPLACES));
  await writeJson(GLOBAL_CLAUDE_KNOWN_MARKETPLACES, known);
};

export const registerClaudeSkills = async (skills, { dryRun = false } = {}) => {
  if (skills.length === 0) {
    log.warn("No skills with description frontmatter found.");
    return 0;
  }

  if (dryRun) {
    log.dryRun(`Would register ${skills.length} skills with Claude Code`);
    return skills.length;
  }

  await syncSkillDirectory(skills, GLOBAL_CLAUDE_SKILLS_DIR, { dryRun });

  const marketplaceDir = path.join(GLOBAL_CLAUDE_MARKETPLACE, ".claude-plugin");
  const pluginRoot = path.join(GLOBAL_CLAUDE_MARKETPLACE, FLOW_CLAUDE_PLUGIN_ID);
  const pluginManifestDir = path.join(pluginRoot, ".claude-plugin");
  const pluginSkillsDir = path.join(pluginRoot, "skills");
  await ensureDir(marketplaceDir);
  await ensureDir(pluginManifestDir);
  await ensureDir(pluginSkillsDir);

  await syncSkillDirectory(skills, pluginSkillsDir, { dryRun });

  await writeJson(path.join(pluginManifestDir, "plugin.json"), {
    name: FLOW_CLAUDE_PLUGIN_ID,
    version: "1.0.0",
    description: "Harnessy skills bundle",
  });

  await writeJson(path.join(marketplaceDir, "marketplace.json"), {
    name: "harnessy",
    owner: {
      name: "Harnessy",
    },
    plugins: [
      {
        name: FLOW_CLAUDE_PLUGIN_ID,
        description: "Harnessy skills bundle",
        version: "1.0.0",
        category: "productivity",
        source: `./${FLOW_CLAUDE_PLUGIN_ID}`,
      },
    ],
  });

  await updateClaudeSettings(skills, { dryRun });
  await updateClaudeKnownMarketplaces({ dryRun });
  // Destructive legacy migrations belong to the explicit cleanup command.

  log.ok(`Registered ${skills.length} skills with Claude Code`);
  return skills.length;
};

export const registerOpenCodeSkills = async (skillsRoot = GLOBAL_SKILLS_DIR, { dryRun = false } = {}) => {
  const config = await readRegistrationJson(GLOBAL_OPENCODE_CONFIG);
  if (!config) {
    if (!dryRun) log.skip("No OpenCode config found at ~/.config/opencode/opencode.json");
    return 0;
  }

  if (!config.skills) config.skills = {};
  if (!Array.isArray(config.skills.paths)) config.skills.paths = [];

  const normalizedPaths = [];
  for (const existingPath of config.skills.paths) {
    const normalized = await normalizePath(existingPath);
    if (!normalizedPaths.includes(normalized)) normalizedPaths.push(normalized);
  }

  const normalizedSkillsRoot = await normalizePath(skillsRoot);
  if (!normalizedPaths.includes(normalizedSkillsRoot)) {
    if (dryRun) {
      log.dryRun(`Would add ${normalizedSkillsRoot} to OpenCode skills.paths`);
    } else {
      normalizedPaths.push(normalizedSkillsRoot);
    }
  }

  if (!dryRun) {
    config.skills.paths = normalizedPaths;
    await writeJson(GLOBAL_OPENCODE_CONFIG, config);
    log.ok(`OpenCode skills.paths updated (${normalizedPaths.length} path(s))`);
  }

  return normalizedPaths.length;
};

export const registerCodexSkills = async (skills, { dryRun = false } = {}) => {
  if (skills.length === 0) {
    if (!dryRun) log.warn("No skills with description frontmatter found for Codex.");
    return 0;
  }

  if (dryRun) {
    log.dryRun(`Would register ${skills.length} skills with Codex`);
    return skills.length;
  }

  await syncSkillDirectory(skills, GLOBAL_CODEX_SKILLS_DIR, { dryRun });
  log.ok(`Registered ${skills.length} skills with Codex`);
  return skills.length;
};

export const registerAllAgentSkills = async (skillsRoot = GLOBAL_SKILLS_DIR, { dryRun = false } = {}) => {
  const skills = await listActiveSkills(skillsRoot);
  const claudeCount = await registerClaudeSkills(skills, { dryRun });
  const opencodePathCount = await registerOpenCodeSkills(skillsRoot, { dryRun });
  const codexCount = await registerCodexSkills(skills, { dryRun });

  return {
    skills,
    claudeCount,
    opencodePathCount,
    codexCount,
  };
};

export const AGENT_PATHS = {
  claude: {
    skillsDir: GLOBAL_CLAUDE_SKILLS_DIR,
    marketplace: path.join(GLOBAL_CLAUDE_MARKETPLACE, ".claude-plugin", "marketplace.json"),
    settings: GLOBAL_CLAUDE_SETTINGS,
  },
  opencode: {
    config: GLOBAL_OPENCODE_CONFIG,
  },
  codex: {
    skillsDir: GLOBAL_CODEX_SKILLS_DIR,
  },
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
