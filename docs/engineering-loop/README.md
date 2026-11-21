# Engineering loop

The local benchmark measures the fixed Harnessy pure-task-operation profile. A profile defines the operations that the benchmark measures. This profile runs task selection, preparation decisions, and status parsing. It does not measure application startup, network requests, full repository performance, or native applications.

## Run the protected benchmark

Use macOS with a supported Node runtime, the installed project dependencies, `/usr/bin/cc`, and `/usr/bin/sandbox-exec`. The command refuses other platforms. Both source paths must identify canonical, absolute Harnessy Git roots. The default pure-task-operation profile requires the same installed Effect directory for both sources and the controller. Command profiles also admit separate installations with identical complete package contents, modes, and resolution structure.

Create an owner-only parent directory outside both source roots. Then run the command with a new output directory. Substitute your absolute paths in this example:

```sh
mkdir -m 700 /absolute/private-measurements
harnessy engineering benchmark harnessy \
  --baseline /absolute/baseline-harnessy \
  --candidate /absolute/candidate-harnessy \
  --output /absolute/private-measurements/new-run \
  --timeout-seconds 300
```

Use the CLI built from this checkout. An older installed release does not contain this command. The default time limit is 300 seconds. The maximum time limit is 600 seconds. The limit covers source observation, artifact preparation, compiler execution, and measurement. Cancellation stops and reaps the owned evaluator process.

The output directory must not exist. The command refuses source and output overlap, source symlinks, hardlinks, oversized files, and changed source identities. A failed run retains a failed report when the output directory exists. Do not reuse that directory for another run.

## Select a command profile

The default `--profile pure-task-operations` keeps the fixed parser and decision workload. Two additional profiles use actual command handlers.

`--profile preparation-plan` runs the actual `work` command and `runWork --dry-run` path. Each sample completes 16 requests, including eight successful plans and eight required refusals. Fixed tool transcripts replace external tool processes. This profile does not read real tasks, verify installed providers, claim work, or complete repository preparation.

`--profile local-status` runs actual `engineering status` and `engineering events` commands. Each sample completes 18 reads across six disposable database scenarios. Scenarios include empty, approved, reserved, running, cancellation-requested, and reconciliation states. The controller creates fresh database copies before each child and checks their complete expected state afterward.

Pass one of these values with `--profile` in the command above. These profiles measure direct command construction, dispatch, and local behavior. They do not measure full root CLI startup. Full startup and full task preparation remain required, open workloads.

The command profiles require Node 22.22.2 with SQLite 3.51.2. Other runtime versions remain unsupported until qualification. A checked-in manifest pins the reviewed semantic sources and their emitted JavaScript forms. The collector refuses changed or missing files before it creates any fixture. It binds the manifest digest into the fixed evaluator and workload. No command option can replace these identities.

The status profile uses `status-open-oracle.v1`. The current store opens the disposable ledger and updates SQLite bookkeeping. The controller creates each expected post-open image with the trusted store outside candidate authority. It binds the store sources, schema contracts, and SQLite runtime. It checks logical rows, schema, event order, and command output against fixed criteria. It compares each resulting database with the entire expected image and ignores no byte ranges. A candidate that changes bookkeeping requires an explicit reviewed profile and manifest revision before qualification. The runtime does not compile or approve new evaluator code automatically. This profile does not claim immutable or read-only SQLite I/O.

The command profiles freeze the actual installed Effect, platform-node, and Zod dependency graph. They preserve package exports, file bytes, file modes, directory modes, and importer-relative nested versions. The freezer refuses unavailable required packages, unexpected mappings, native bindings, workspace build outputs, sensitive filenames, and changed dependencies. Each dependency graph has limits of 64 packages, 20,000 entries, 128 MiB total bytes, and 16 MiB per file. The collector admits at most three original graphs and one frozen graph. It preserves separate loaded copies of the same package. It rehashes each distinct physical package during every observation. It does not reuse file metadata or content across observations. Optional missing dependencies remain explicit in the bound graph. A required runtime import that cannot resolve fails the measurement. The collector records a runtime lock only when package and layout metadata identify the controller workspace. Normal installed packages can lack that workspace lock. The report then records the lock as unavailable. It still requires the full dependency bytes and resolution graph. Lock status and bytes must remain unchanged throughout the run. The reviewed build-lock identity remains separate and fixed in the evaluator manifest.

Command wall time covers the protected invocation, including fixed fixture setup, driver startup, commands, fixture readback, and cleanup. CPU time and peak resident memory cover the supervised child. Source and dependency copying occur outside samples. Their time still counts against the overall run limit. The driver sets `XDG_STATE_HOME` only to disposable scratch before command import. It does not change `HOME` or read the operator's controller state.

## Read the result

The CLI prints a JSON summary and the path to `reports/benchmark.json`. The report contains ten paired samples for each source. In the default pure-task-operation profile, each sample completes 1,024 useful operations across 16 required cases. The evaluator alternates the execution order between baseline and candidate. A separate process measures CPU time and peak resident memory, which is the maximum physical memory in use.

The report binds measurements to maintained source bytes and modes, Git revisions, the fixed evaluator, the workload, and the host environment. The command copies maintained source bytes without rewriting code or imports. The sandbox reads these copies and a frozen Effect dependency. It cannot read the original source roots, measurement reports, or the supervisor. The supervisor controls process execution and measures its resources.

The command rechecks original sources, copied sources, dependencies, and host tools around each measurement. It rejects missing operations, changed identities, invalid output, and unavailable resource measurements. Each default-profile child has a five-second time limit. Command-profile children have a 15-second time limit. All children have bounded output. Source and dependency preparation also has file and byte limits.

The default comparison result is `inconclusive`. Ten samples alone do not establish the statistical assumptions for a reliable performance claim. No CLI option accepts a policy file, a worker result, arbitrary commands, or a claim that these assumptions hold. Saved JSON is an audit record. It cannot recreate the trusted measurement objects from the current process.

## Execution boundaries

The engineering controller uses the existing task runner and private SQLite state. Remote host delivery retains launch identities, pending operations, acknowledgments, and event sequence numbers in that state. It requires a confirmed acknowledgment and fresh central authority before remote execution. A lost reply keeps the reservation held until reconciliation. Local controller state alone does not qualify a multi-host pilot.

Owner commands can approve an exact job, inspect local state, request cancellation, and revoke authority. These commands do not enable a daemon. Provider admission still requires trusted evidence of available included allowance and disabled additional paid usage. Login or a subscription name does not supply that evidence.

The benchmark has no provider, model, merge, deployment, or job-approval capability. It does not authorize a task or release. The retired command-measurement and JSON-comparison prototypes are no longer public entrypoints. Earlier prototype smoke reports remain historical evidence only.

## Remaining qualification

Full Harnessy startup, preparation, and status workloads remain open. Garden and WorkStream collectors remain unsupported. Native mobile, web, and device measurements also remain open. The functional host qualification uses real authentication, signatures, HTTP, and database state, with synthetic provider and execution ports. It does not prove a live provider, the full task runner, WorkStream proof acceptance, or a device journey.

Do not activate unattended work from this benchmark alone. The full loop still needs the missing provider, execution, measurement, and device evidence. No command in this document merges or deploys a change.
