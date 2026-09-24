# Harnessy Core

Harnessy Core provides the `harnessy` capability CLI and the `hsy` agent host.

## Portable workspaces

A workspace contains independent checkouts and a versioned
`.harnessy/workspace.json` registry. Registry paths are relative to the workspace.
Shared context lives in `.jarvis/context`; projects retain their technical context
and agent rules. Credentials, runtime databases and managed releases stay in their
existing home-level locations.

```sh
harnessy workspace init ./Code
harnessy workspace add ./Code/example/dev --workspace-root ./Code --id example --worktrees-dir ./Code/example/worktrees --integration-branch dev
harnessy workspace list --workspace-root ./Code --json
harnessy workspace doctor --workspace-root ./Code --json
```

`add` registers an existing checkout without moving files or changing branches.
Grouped paths, non-Git projects and existing alternative layouts are supported.
`worktrees-dir` is optional and need not exist. CLI input paths resolve from the
current directory; stored paths are workspace-relative. Membership grants no trust.

Resolution uses an explicit root, then `HARNESSY_WORKSPACE_ROOT`, then the nearest
ancestor manifest. An invalid explicit manifest fails. Without a manifest,
standalone behavior continues. Start `hsy` below the workspace to provide its
registry and shared-context location; resumed sessions refresh changed locations.
The agent receives references, not every project's private contents.

Life collection uses registered project vaults and shared personal priorities,
including grouped projects. Provider, approval and delivery behavior is preserved.
Missing projects fail collection; missing optional project context is reported.
Initialization preserves existing instructions and README files. Keep private
context and machine-specific configuration out of shared release packages.

## Offline migration

Stop affected writers before operational planning and application. Inventory
scheduled jobs, working directories, Git metadata, config and service bindings.
The filesystem operation does not update those references automatically.

A move list contains disjoint workspace-relative paths:

```json
[{"from":"legacy/projects/example","to":"example/dev"}]
```

```sh
harnessy workspace migrate plan --root ./Code --moves moves.json --output plan.json
harnessy workspace migrate apply --plan plan.json --backups backups.json
harnessy workspace migrate rollback --plan plan.json
```

Backups are an array of `{ "from": "legacy/projects/example", "backupPath":
"/path/to/independent/backup" }`. Content and permissions must match the plan;
ignored/untracked files and symlink text are included. Moves stay on one filesystem
and preserve directory identity. Nested layout changes require separate phases.
Existing destinations and edits since planning cause failure. Git worktree repair
is a separate step: preserve original pointer files before repairing them.

The durable journal is `.harnessy/migrations/<id>.json`. Repeating `apply`
reconciles interrupted renames; rollback refuses to overwrite new edits. A surviving
`relocation.lock` requires confirming the prior process exited and inspecting its
journal before removing that lock. Finish interrupted rollback before replanning.

Meeting/community stores have a path-only migration operation:

```sh
harnessy workspace migrate state-plan --database /path/to/store.sqlite3 --kind meeting --from /old/private --to /new/private --output state-plan.json
harnessy workspace migrate state-apply --plan state-plan.json --backup /path/to/verified.sqlite3
harnessy workspace migrate state-apply --plan state-plan.json --backup /path/to/verified.sqlite3 --rollback
```

Use `--kind community` for briefings. Create a consistent independent SQLite backup
while writers are stopped and rehearse restoration. Planning needs original
artifacts; applying needs relocated artifacts with identical contents. Restore
original artifact paths before database rollback. Transactions verify every table
value and schema; only declared path columns can change. Approvals, receipts,
retries, timestamps and provenance bytes remain intact. Signed grants are not
rewritten; create fresh service enrollments through the existing owner workflow.
Smoke-test services and observe scheduled delivery before retiring recovery data.
