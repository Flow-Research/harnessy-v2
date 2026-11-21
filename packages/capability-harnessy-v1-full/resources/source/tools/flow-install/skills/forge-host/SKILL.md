---
name: forge-host
description: "Install and operate a self-hosted Git forge (Forgejo first) with CI runners on a server, move repositories to it, back it up, and list every install from one register."
disable-model-invocation: false
allowed-tools: Read, Grep, Glob, Bash
argument-hint: "inspect|plan|install|service-account|token|runner add|repo migrate|repo mirror|backup|list|status [--id <install>] [--json] [--dry-run] [--confirm <install>]"
---

# Forge Host

## Purpose

Give a project its own Git forge and its own CI runners on a server that the
user controls, with no dependence on a hosted forge. The skill puts the forge
behind the reverse proxy that the server already has, adds runners on the server
or on the local machine, moves repositories with their pull requests, sets
backups, and records each install in one register.

Forgejo is the first forge adapter. The command name is neutral
(`harness-forge`) because Harnessy keeps forge neutrality.

## Inputs

- A server with SSH key login, Docker, Docker Compose and a supported reverse
  proxy (Traefik with the Docker provider, for example the Coolify proxy).
- A short install id (for example `mustard`). It names the folder on the
  server, the containers and the register entry. It is the first part of the
  name of the secret folder.
- Command intent: `inspect`, `plan`, `install`, `service-account`, `token`,
  `runner add`, `repo migrate`, `repo mirror`, `backup`, `list` or `status`.

- Template paths are resolved from `${AGENTS_SKILLS_ROOT}/forge-host/`.

## Steps

1. Read `${AGENTS_SKILLS_ROOT}/forge-host/commands/forge-host.md`.
2. Run `${AGENTS_SKILLS_ROOT}/forge-host/scripts/harness-forge <command>` for
   deterministic behavior. Do not write to the server by hand.
3. Start with `inspect`. If a check fails, stop and report the failed check.
4. Before `install`, show the output of `install --dry-run` to the user and get
   a clear yes for that server. A server can hold other sites; name them.
5. Pass `--confirm <install-id>` only after that yes. Each command that
   changes the server or the forge refuses to run without it: `install`,
   `service-account`, `token`, `runner add`, `repo migrate`, `repo mirror`
   and `backup`.
6. Never print, copy or ask for a secret value. The command keeps each secret
   in a private file and prints only the file name. When a command needs a
   token of another forge, it reads `FORGE_SOURCE_TOKEN` or asks with a hidden
   prompt; use the first only with a token source that the user named.
7. After `install`, tell the user to sign in, change the initial password and
   turn on two-factor login.
8. Treat DNS changes, billing, deleting an install, and restoring a backup over
   live data as out of scope. Stop and ask the user.
9. A runner executes the code of each pull request with access to Docker on
   its machine. Add a runner only for repositories whose contributors the user
   trusts, and say this before `runner add`.

## Deterministic Logic

- `scripts/harness-forge`
  - Input: command flags; SSH access to the server; the register.
  - Output: a human summary or JSON. Exit 0 = done, 1 = a check failed,
    2 = installed but the web address does not answer yet, 3 = refused.
  - Side effects: `install`, `service-account`, `token`, `runner add`,
    `repo migrate`, `repo mirror` and `backup` change the server or the forge.
    Each writes to the register, and the larger ones write an evidence folder.
    Each reads the register again and saves its change under a lock
    (`register.json.lock`), so commands that run at the same time keep the
    records of each other.

## Records

- Register: `<workspace>/.jarvis/context/forge-hosts/register.json`. One entry
  for each install: server, web address, version, runners, repositories,
  backups, and the names of the secret files. It holds no secret value.
- Evidence: `<workspace>/.jarvis/context/forge-hosts/runs/<run-id>/`.
- Pending: `<workspace>/.jarvis/context/forge-hosts/pending/<install-id>.json`.
  It is the record of an `install` that did not finish. It holds no secret
  value. `install` removes it when the install is in the register.
- Secrets:
  `${XDG_CONFIG_HOME:-~/.config}/harnessy/forge/<install-id>.<install-uid>/`
  (folder mode 0700, files mode 0600). The install uid is a random value in
  the register entry, so two workspaces can use the same install id. An
  install that has no uid in its register entry keeps its secrets in
  `${XDG_CONFIG_HOME:-~/.config}/harnessy/forge/<install-id>/`. The command
  does not move or delete that folder.

`<workspace>` is `HARNESSY_WORKSPACE`, else the nearest parent folder with
`.harnessy/workspace.json`, else the current folder.

## Output

- The inspect report, the install plan, the install result with its evidence
  path, the runner or repository record, the backup record, or the list of
  installs.
