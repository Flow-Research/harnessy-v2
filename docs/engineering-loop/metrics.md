# Engineering measurements

The versioned registry defines 97 metrics across 16 domains. The source is `packages/harnessy-core/src/engineering/metrics.ts`.
The [JSON catalog](metrics-registry.json) records each definition, unit, direction, workload, source, owner, environment, collection window, and acceptance rule.
Catalog membership does not establish that a collector exists or that a target passed qualification.

An observation is one reported measurement with its status. Status values are `observed`, `unavailable`, `unsupported`, `failed`, and `inconclusive`.
Observed values need a finite number and an executed sample count. Ratio observations also need a positive denominator.
Other statuses need a reason and cannot contain a numerical value. Missing data cannot become a successful zero.

## Collection and ownership

`observeCommand` uses the existing Harnessy work runner. It records wall time, process outcome, timeout, and output digests.
A digest identifies exact bytes. It does not establish whether the bytes contain truthful measurements.
This collector does not measure child CPU time, child memory, battery use, browser interaction, or native lifecycle behavior.

The host adapter must collect each additional metric through its declared detector. The detector must retain its version and measurement limits.
Use existing repository tests and OpenTelemetry signals before adding another tool. Do not infer unknown defects from a scanner without findings.
Keep unavailable metrics visible until an actual collector and representative workload supply evidence.

WorkStream owns acceptance and contribution facts. GitHub owns source checks, reviews, and merge facts.
Garden owns client authority and client qualification. Harnessy owns execution measurements and the records of each attempt.
One owner receipt cannot establish another product's decision or an actual payment.

## Trusted evaluation boundary

`EvaluationSession.collectPair` accepts two controller-approved plans, a trusted executor, and a live identity observer.
The plans bind the run, grant, source revision, source tree, workload, evaluator, and environment.
The executor must enforce the actual host sandbox and pin evaluator artifacts outside worker write authority.
Do not pass a task-selected shell, mutable evaluator, worker report parser, or unrestricted process adapter as the trusted executor.

The identity observer must recompute identities from the actual sources. It must not echo the expected plan.
The session calls this observer before and after each invocation. Its asynchronous `compare` operation repeats identity observations before returning a decision.
Before a later privileged effect, the controller must also establish current authority and source identity.

Required checks need the exact expected output digest and the complete required scenario identities.
Missing, duplicate, skipped, replaced, or failed scenarios refuse qualification. A faster workload with fewer or incorrect outputs also refuses qualification.
Expected semantic outputs must come from protected evaluator logic. Worker-generated pass flags cannot define those expectations.

The session issues immutable receipts through private process memory. Copies, forged JSON, foreign sessions, and mixed receipt pairs cannot qualify a change.
Persist receipt JSON as audit evidence under controller ownership. After restart, run evaluation again before a new decision.
The receipt mechanism does not replace OS isolation, a protected controller, or durable scheduling.

`evaluator-host.ts` copies approved evaluator and workload bytes into private controller custody. It validates digests and read-only permissions on every use.
Its source observer hashes actual maintained bytes, including untracked files. Git index flags cannot conceal changed tracked bytes.
The observer rejects symlinked source, deleted tracked files, oversized sources, and a directory that differs from the registered Git root.

Stop worker writes before evaluation. Keep source and evaluator artifacts read-only while collecting results.
The environment observer must include relevant ignored dependencies, toolchain artifacts, and host conditions. The maintained-source digest excludes Git-ignored dependency trees.
The default executor refuses execution without an isolation adapter. A process runner and a Boolean isolation claim cannot satisfy this requirement.

The Harnessy workload exercises existing task, preparation, saved-run status, actor, and assignment parsers. It uses synthetic inputs and complete expected outputs.
The controller keeps those expectations outside candidate execution. The macOS adapter runs the candidate operation driver through the enforced single-process sandbox.
The controller measures wall time and useful throughput. It does not accept a candidate-generated pass report or candidate-generated resource measurements.

The optional POSIX supervisor obtains CPU time and peak resident memory from `wait4`. The supervisor closes its control descriptor before candidate execution.
The host accepts resource observations only from that supervisor. A copied observation or a JSON object cannot establish resource authority.
On macOS, peak resident memory uses bytes. On Linux, the supervisor converts kernel kilobytes to bytes.

The supervisor acknowledges installed signal handlers before it creates a child. The host queues cancellation until that acknowledgment.
The supervisor retains the exact unreaped child identity through cancellation or timeout. It issues a resource receipt only after it reaps that child.
The sandbox must deny child creation. These measurements describe the qualified single-process workload, not an unrestricted process tree.

The supervisor does not enforce a hard resident-memory limit on macOS. Measurement does not establish resource containment.
The host must retain this readiness limit before allowing unattended arbitrary workloads. A successful narrow workload does not qualify a general coding sandbox.

## Comparison rules

The session collects ten baseline/candidate pairs. Even pairs run baseline first. Odd pairs run candidate first.
This order reduces systematic ordering bias. It does not remove thermal drift, cache differences, load contention, or observer overhead.
Declare and control these conditions in the workload before collecting samples.

For performance, the session uses a two-sided 95 percent paired Student t interval with nine degrees of freedom.
This method requires independent pairs and approximately normal paired relative differences. The controller must justify both assumptions before execution.
The session refuses a statistical conclusion when the plan does not support those assumptions.

The primary metric needs at least 5 percent mean improvement and an interval that excludes zero improvement.
Each protected metric needs an interval that excludes regression above its declared limit. The maximum permitted limit is 5 percent.
Uncertain protected regressions produce `inconclusive`. These are per-metric intervals, without a simultaneous confidence claim across metrics.

For deterministic counts, repeated values must agree exactly and use safe integers. The relative improvement threshold still applies.
A zero primary baseline requires a separately declared absolute rule. This implementation returns `inconclusive` for that case.
A lower-is-better protected metric cannot increase from zero. Mixed zero baselines require an explicit absolute rule before qualification.

Correctness, authorization, privacy, and required security failures veto numerical gains. A failed baseline requires repair.
Code size and complexity remain supporting measurements. Preserve required behavior and fixed source boundaries when comparing them.
Do not qualify an apparent gain from moved branches, changed exclusions, extra hidden work, or reclassified generated source.

## Test command

From `packages/harnessy-core`, run the focused tests:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/engineering-metrics.test.ts test/engineering-evaluation.test.ts test/engineering-evaluator-host.test.ts test/engineering-harnessy-workload.test.ts test/engineering-evaluator-supervisor.test.ts
```

Use the Node version declared by the repository. The tests cover forged evidence, stale identities, omitted work, interval rules, and real child-process output.
These tests do not qualify signed devices, provider allowances, a seven-day pilot, or the complete cross-product journey.
