---
name: engineering-loop
description: "Prepare or inspect an approved measured engineering task across Harnessy, Garden, and WorkStream. Use existing controller authority and evidence."
disable-model-invocation: true
allowed-tools: Read, Write, Bash, Grep, Glob
argument-hint: "status | events | prepare <approved-task> | cancel <run-id>"
---

# Engineering loop

## Purpose and limits

Use this skill to prepare work or inspect the existing Harnessy engineering controller.
A controller selects and supervises approved work.
This skill creates no scheduler or agent engine.

Harnessy owns execution and evidence. Garden owns client controls and workspace access.
WorkStream owns task policy, submission, review, and acceptance.
GitHub owns source revisions, pull requests, checks, and merge facts.

Existing `autoflow` and `goal-agent` skills retain their own purposes.
Do not start either as a fallback controller for this pilot.
Their autonomy settings cannot replace this task's authority.

## Inputs and paths

Required inputs are the current workspace, repository profile, approved task, and host-owned controller state.
An experiment also requires a primary metric and protected evaluator.
A protected evaluator runs required checks outside worker authority.

Template paths are resolved from `${AGENTS_SKILLS_ROOT}/engineering-loop/`.
Read `${AGENTS_SKILLS_ROOT}/engineering-loop/references/experiment-record.md` for the record fields.
Read `${AGENTS_SKILLS_ROOT}/engineering-loop/references/attribution.md` for research provenance.

## Procedure

1. Read workspace instructions and the project registry.
2. Read the canonical roadmap and each relevant project's current technical context.
3. Inspect current branches, user edits, live processes, and exact source revisions.
4. Run `harnessy engineering --help` to establish installed command support.
5. Run `harnessy engineering status` to read local controller receipts.
6. Run `harnessy engineering events --after 0` to inspect the retained event sequence.
7. Compare receipts with live host observations before reporting availability or completion.
8. Select one unfinished approved task that has no unresolved dependency.
9. Record its required behavior, source revision, workload, evaluator, and primary metric.
10. Obtain a representative baseline before the worker changes source.
11. Make sure that host checks establish isolation, current authority, included allowance, and disabled paid fallback.
12. Use the existing controller and task runner for authorized execution.
13. Collect required checks and output comparisons through the protected evaluator.
14. Record the keep, reject, or inconclusive decision with its evidence.
15. Update the owning implementation record and the canonical roadmap from verified facts.
16. Continue other approved work when one requirement needs an operator.

If the installed command is absent, report the missing version or capability.
Do not substitute the retired V1 runtime, prototype comparison scripts, or a shell-based worker.
Current receipt commands alone do not establish a running dispatcher or enrolled-host connection.

## Authority and admission

Prepare job files from host-controlled profiles and approved task records.
Task prose cannot select paths, executables, credentials, or policy.
Bind source, evaluator, workload, task revision, account, workspace, grant, and launch identities.

When Julian explicitly authorizes an exact job, the local owner can run the approval command:

```text
harnessy engineering approve --job <controller-authored-job.json> --expires-minutes 135
```

The 135-minute lifetime permits a 45-minute worker and up to 90 minutes of verification.
A worker cannot approve itself or renew this lifetime.
An approval receipt does not establish provider allowance, host capacity, or isolation.

Pilot admission permits one active worker across all three repositories.
Use two native slots followed by one maintenance slot.
Security and correctness repairs take priority.
Apply six attempts per rolling 24 hours and three unsuccessful attempts per objective.
Use the existing controller's durable accounting and locks.

If current authority or included allowance is unknown, pause the dependent effects.
Never select metered credentials, another provider, or a paid build as a fallback.
No worker can change evaluator files, required tests, thresholds, grants, or controller state.

## Evidence and review

Preserve equivalent useful outputs and required behavior before comparing measurements.
Treat missing reports, skipped required scenarios, errors, stale results, and invalid bindings as failures or unavailable evidence.
A worker's pass flag and a file checksum do not establish truthful evaluation.

For the initial performance method, use ten alternating baseline and candidate pairs.
Require at least five percent improvement and a justified 95 percent interval that excludes zero.
Use separate declared rules for deterministic counts, zero baselines, rare failures, and feature delivery.
Report noisy or insufficient evidence as inconclusive.

Correctness, authorization, privacy, and required security checks can veto every score.
Protect latency, memory, and useful throughput from regressions above five percent unless a stricter rule applies.
Do not reduce code size through lost behavior, moved complexity, or changed exclusions.

Before a draft pull request, require independent evaluation of the exact candidate revision.
Include review findings from summaries, checks, general comments, and inline threads.
After a source change, repeat affected checks and approvals.
Keep merges, deployments, app publication, and payments under their separate human controls.

## Cancellation and recovery

When Julian authorizes cancellation, record the request with the current run identity:

```text
harnessy engineering cancel --run <run-id>
```

Cancellation receipt does not prove termination.
Observe the same owned process generation until the host confirms termination.
If observation fails, retain occupied capacity and reconcile the existing handle.
Do not launch a replacement because a wait timed out.

After a human merge, use the runner's explicit proof-only successor authority when renewal is required.
Preserve the original source head and authority lineage.
Proof-only resumption cannot start an agent, commit, push, or accept work.
WorkStream's landed-work proof uses the merge commit. Required CI and review remain bound to the source head.

## Deterministic operations and output

The existing `harnessy engineering` commands own job parsing, receipts, cancellation, and persistent state.
The task runner owns process invocation and WorkStream proof handoff.
The protected evaluator owns measurement collection and decisions.
This skill adds no executable logic or second state database.

Write a private report with requirement status, exact revisions, commands, results, evidence locations, and remaining actions.
Distinguish source readiness, operational qualification, awaiting observation, and human-held work.
Record seven real days of pilot evidence before claiming that observation requirement is complete.
Browser tests and simulators cannot replace physical-device qualification.

Autoresearch metadata permits controlled experiments on this skill.
It grants no execution, acceptance, merge, deployment, payment, or policy-changing authority.
