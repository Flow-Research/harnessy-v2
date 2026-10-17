# Harnessy V2 portal read model regression specification

H-10 Phase 1, first slice: read-only readers in `@harnessy/core` that report Life, Fathom, community, meeting publication, workspace, skills and service state as tiles, with versioned JSON schemas. No HTTP server, page, launchd job or provider call is involved. Passing these scenarios shows that the readers create nothing, never change a database, degrade one tile at a time and return no secrets. It does not show anything about the later portal API or page.

## PRTL-001 Readers create nothing and never change a database
Layer: api
Status: implemented
Test File: qa/tests/portal-read-model.api.test.mjs
Linked Refs: packages/harnessy-core/test/read-model-sqlite-snapshot.test.ts, packages/harnessy-core/test/read-model-life.test.ts, packages/harnessy-core/test/read-model-community.test.ts, packages/harnessy-core/test/read-model-meetings.test.ts, packages/harnessy-core/src/read-model/sqlite-snapshot.ts
Expected: Databases built by the real writer code keep the same SHA-256, size, modification time and inode after 50 reads, with no `-journal`, `-wal` or `-shm` file created; a missing database or state directory is reported as `missing` and nothing is created; a write attempted inside a read is refused; the existing Life status is shown to create the ledger while the Life reader leaves the home directory unchanged.

- Execute the read-only proof cases for the snapshot helper and the Life, community and meeting readers.

## PRTL-002 A busy or crashed writer degrades one tile within the timeout
Layer: api
Status: implemented
Test File: qa/tests/portal-read-model.api.test.mjs
Linked Refs: packages/harnessy-core/test/read-model-sqlite-snapshot.test.ts, packages/harnessy-core/test/read-model-life.test.ts, packages/harnessy-core/test/read-model-community.test.ts, packages/harnessy-core/test/read-model-meetings.test.ts, packages/harnessy-core/src/jarvis/community-briefing/status.ts
Expected: While a real child process holds an exclusive lock, each reader returns a `busy` tile in under one second and the other tiles stay readable; a hot journal left by a SIGKILLed writer is reported as `recovering` (or `busy` for meeting publication) and the journal and database bytes are unchanged; the community status honours `timeoutMs`, reports the busy queue as an issue instead of throwing, and closes its database handle on the error path.

- Execute the busy-lock and hot-journal cases with real writer child processes.

## PRTL-003 Fathom status sees the V2 poll checkpoint
Layer: api
Status: implemented
Test File: qa/tests/portal-read-model.api.test.mjs
Linked Refs: packages/harnessy-core/test/read-model-fathom.test.ts, packages/harnessy-core/src/read-model/fathom.ts, packages/harnessy-core/src/jarvis/fathom/file-store.ts
Expected: A checkpoint written by the real V2 Fathom store under `.harnessy/jarvis/state/fathom/poll-state-v2.json` is reported per configured account with its age and staleness, while the existing status (which reads the V1 file) reports no poll state; envelope contents are never read or returned.

- Execute the Fathom V2 checkpoint case.

## PRTL-004 Service health and summaries return no secrets
Layer: api
Status: implemented
Test File: qa/tests/portal-read-model.api.test.mjs
Linked Refs: packages/harnessy-core/test/read-model-service-health.test.ts, packages/harnessy-core/src/read-model/service-health.ts
Expected: The `launchctl print` parser keeps only the top-level state, pid, last exit code and log paths, so values in environment blocks never appear; the last log line is redacted (query strings, URL user information, whole authorization and cookie values, secret-named key values, known token shapes and long mixed letter-and-digit runs) and bounded to 300 characters; only regular log files inside the home directory are read, and only their last 4 KiB.

- Execute the launchctl parsing, redaction and log-bound cases.

## PRTL-005 The portal and its probes are known non-writers
Layer: api
Status: implemented
Test File: qa/tests/portal-read-model.api.test.mjs
Linked Refs: packages/harnessy-core/test/read-model-service-health.test.ts, packages/harnessy-core/src/jarvis/community-briefing/operational-runtime.ts, packages/harnessy-core/src/jarvis/meeting-publication/operational-input.ts
Expected: The `org.harnessy.portal` label is absent from the community and meeting guard label lists; the probe argv and the planned portal command lines match neither writer-command predicate, while known writer commands still do; the default probe never spawns off macOS and runs only a root-owned executable without a shell.

- Execute the one-writer guard and probe cases.
