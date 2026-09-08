# Harnessy V2 context instructions

- Load the context files in the order defined by `README.md`.
- Harnessy V2 is canonical for all new runtime, capability, package, workflow,
  connector-contract, product, QA, and release work.
- Treat the original Harnessy repository as a frozen compatibility oracle and
  the current live scheduler owner. Changes there are limited to urgent
  operations, state export, migration, rollback, deprecation, and reviewed
  compatibility correction.
- Do not stop, redirect, or duplicate V1 schedulers until the backup,
  one-writer, smoke-test, and rollback gates in the migration plan pass.
- Continue migration implementation only in the declared branch worktree or a
  clean successor based on the reviewed V2 integration branch.
- Never record credentials, personal context, tenant data, live databases,
  schedule definitions, tokens, logs, or machine-specific paths in this vault.
- Distinguish accepted design, local evidence, remote evidence, and operational
  evidence. Do not claim a push, PR, merge, hosted matrix, publication, deploy,
  or cutover without direct evidence.
- Use `.jarvis/context/profiles/qa.json` as the canonical QA profile. Run the
  repo-owned QA commands; the globally installed `qa` command is compatibility
  evidence only.
- Do not hand-edit generated QA catalog output.
- Track deferred work in `technical-debt.md` and decisions in `decisions.md`.
