/** Starter AGENTS.md content for the project-local Harnessy context vault. */
export const contextTemplate = `# Harnessy Context

This directory is the project-local Harnessy context vault.

Use it for durable guidance that should be loaded into agent sessions: operating rules, project conventions, capability notes, and links to source-of-truth docs. Keep transient chat logs and one-off scratch work out of this vault.

Profiles in ".harnessy/profiles/" decide which context files and scoped memory files are loaded by default. Capability packs may also contribute their own context; keep that capability context scoped to what the capability needs to operate and verify.

Scoped memory lives in ".harnessy/memory/". Memory should contain stable facts, decisions, preferences, and events that agents can verify later.

Garden can read Harnessy profile labels and layer organization workspace policy, access control, and connectors on top. Garden does not own or replace this local context boundary.
`;

/** Default profile template that points agents at starter context and scoped memory files. */
export const profileTemplate = `{
	"name": "default",
	"description": "Default project-local Harnessy runtime profile.",
	"context": [".harnessy/context/AGENTS.md"],
	"memory": [
		".harnessy/memory/org.md",
		".harnessy/memory/project.md",
		".harnessy/memory/decisions.md",
		".harnessy/memory/events.md"
	],
	"capabilities": [],
	"defaultOutputMode": "text",
	"labels": ["scope:project", "boundary:local"]
}
`;

/** README content for the capability artifact directory. */
export const capabilitiesReadmeTemplate = `# Harnessy Capabilities

Capability install records live in the lockfile.
This directory is reserved for local manifests, generated adapters, and verification artifacts.

Capability context should describe how the capability is used, verified, and bounded. Shared project guidance belongs in ".harnessy/context/"; stable cross-session facts belong in ".harnessy/memory/".
`;

/** README content for scoped memory files. */
export const memoryReadmeTemplate = `# Harnessy Memory

Use these files for stable, scoped knowledge that should survive agent sessions.
Profiles reference memory files explicitly, so deleting or renaming them should be reflected in the active profile.

- org.md: organization-level facts and preferences that are safe for this project.
- project.md: project facts, architecture, and conventions.
- decisions.md: durable technical/product decisions and their rationale.
- events.md: dated milestones and operational events.

Memory is not a transcript store. Prefer concise, verifiable entries over raw chat history.
`;

/** V1-style scoped memory registry used by agents to understand available memory scopes. */
export const memoryScopesRegistryTemplate = `# Harnessy scoped memory registry

scopes:
  org:
    description: Organization-level facts and preferences safe for this project.
    files:
      - org.md
  project:
    description: Project facts, architecture, decisions, and operational events.
    files:
      - project.md
      - decisions.md
      - events.md

rules:
  - Keep memory concise and verifiable.
  - Do not store secrets or raw private transcripts.
  - Prefer dated entries when chronology matters.
`;

/** Starter scoped memory file content. */
export const memoryScopeTemplate = (title: string): string =>
	`# ${title}\n\nRecord stable facts here. Keep entries concise, dated when useful, and easy for agents to verify.\n`;
