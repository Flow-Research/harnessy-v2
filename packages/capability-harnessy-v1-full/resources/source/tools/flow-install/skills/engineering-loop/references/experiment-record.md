# Experiment record

Store this record under the owning project's private implementation folder.
Keep source facts separate from assumptions and decisions.
Use exact units, sample counts, time windows, and evidence identities.

| Field | Required content |
| --- | --- |
| Task | Task identity, locked revision, workspace, repository, and approved requirement |
| Launch | Stable launch identity, grant identity, account, expiry, and process generation |
| Source | Baseline and candidate revisions, source snapshots, and artifact digests |
| Evaluator | Protected artifact, digest, workload, environment, and collection window |
| Objective | One primary metric, unit, direction, workload, and acceptance rule |
| Baseline | Required behavior, useful outputs, errors, measurements, and existing exceptions |
| Change | One hypothesis and bounded source change |
| Decision | Keep, reject, or inconclusive, with the declared statistical or deterministic rule |
| Guardrails | Correctness, security, privacy, latency, memory, throughput, and unavailable reports |
| Review | Exact candidate, independent findings, dispositions, and required rechecks |
| Recovery | Current handle, last acknowledgment, event cursor, cancellation, and orphan uncertainty |
| Delivery | Draft pull request, human merge, deployment, WorkStream submission, and acceptance receipts |
| Continuation | Remaining requirements, live monitoring, next safe action, and exact operator dependency |

A successful command establishes only that command's stated result.
A completed run does not establish merge, deployment, acceptance, or payment.
If evidence is missing, retain the missing status.
