# Harnessy project boundaries

| Component | Role | Current state |
|---|---|---|
| Harnessy V2 | Canonical source for new runtime, capability, workflow, package, product, QA, and release work | Active uncommitted cutover work; current operational gates are in the migration execution plan |
| Original Harnessy V1 | Preserved compatibility oracle and rollback source, not the current meeting scheduler owner | Development-frozen; do not reactivate retained writers from historical status text |
| V1 compatibility capability | Public, provenance-verified behavior/source preservation boundary inside V2 | Source reconciliation and dirty-path disposition verified locally; native workflow promotion remains separate |
| Vendored Executor | Engine boundary for credentials, policies, approvals, audit, integrations, and host runtime | Source and packaged local gates exist; hosted matrix evidence remains remote |
| Garden | Hosted consumer of Harnessy and Executor contracts | Parked with local commits/unfinished edits preserved; further work requires an agreed concrete V2 migration dependency |

Private workspace inventory and personal priority data belong outside this
repository context.
