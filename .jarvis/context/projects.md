# Harnessy project boundaries

| Component | Role | Current state |
|---|---|---|
| Harnessy V2 | Canonical source for new runtime, capability, workflow, package, product, QA, and release work | Active uncommitted migration checkpoint based on `origin/dev` `7782ac8635754b15c008f41b3b828557f68e75c2` |
| Original Harnessy V1 | Compatibility oracle and current live Jarvis/scheduler owner | Development-frozen except urgent operations, migration, rollback, deprecation, and reviewed compatibility correction |
| V1 compatibility capability | Public, provenance-verified behavior/source preservation boundary inside V2 | Source reconciliation and dirty-path disposition verified locally; native workflow promotion remains separate |
| Vendored Executor | Engine boundary for credentials, policies, approvals, audit, integrations, and host runtime | Source and packaged local gates exist; hosted matrix evidence remains remote |
| Garden | Hosted consumer of Harnessy and Executor contracts | Parked with local commits/unfinished edits preserved; further work requires an agreed concrete V2 migration dependency |

Private workspace inventory and personal priority data belong outside this
repository context.
