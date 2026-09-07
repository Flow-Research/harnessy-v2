# Harnessy V2 context

This directory is the portable, project-local entrypoint for Harnessy V2. It
contains repository truth only. Personal context, credentials, runtime state,
machine paths, and live scheduler configuration do not belong here.

## Loading order

Read these files at the start of a repository session:

1. `README.md` — this protocol and file map.
2. `AGENTS.md` — context-specific operating rules.
3. `status.md` — the current implementation checkpoint and evidence level.
4. `roadmap.md` — ordered remaining work.
5. `team.md` — ownership and approval boundaries.
6. `technical-debt.md` — unresolved gaps and blockers.
7. `decisions.md` — accepted decisions and open decisions.
8. `projects.md` — repository and product boundaries.

For QA, CI, release, or deployment work, also read:

- `docs/standards/qa-process.md`
- `docs/standards/testing-strategy.md`
- `docs/standards/ci-process.md`
- `docs/standards/skill-feedback-protocol.md`
- `profiles/qa.json`, `profiles/ci.json`, and `profiles/deploy.json`

The repository root `AGENTS.md` remains authoritative for code, test, git, and
release rules. Deeper project instructions override this context when they are
more specific.

## Evidence vocabulary

- **Accepted design:** an ADR or maintainer decision defines the intended
  boundary; it does not prove implementation.
- **Local evidence:** the named command passed in this worktree; it does not
  prove a hosted runner or clean checkout passed.
- **Remote evidence:** a specific hosted workflow run passed. No remote run is
  assumed from workflow YAML alone.
- **Operational evidence:** an authorized backup, one-writer cutover, smoke,
  or rollback was executed against live state. None is inferred from tests.

Generated artifacts have one owner. `qa/features.generated.yaml` is owned by
`npm run qa:catalog`; do not edit it by hand.
