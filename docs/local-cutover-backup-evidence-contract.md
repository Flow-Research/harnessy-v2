# Local cutover backup evidence contract

Status: fixture-only design and test harness; not operational evidence  
Scope: Harnessy V1-to-V2 local cutover mechanics

## Boundary

This contract validates backup and isolated-restore mechanics against temporary
fixtures only. Every request and receipt contains literal `fixtureOnly: true`
and `operationalEvidence: false`. A passing fixture does not prove that live V1
state was inventoried or backed up and cannot satisfy the operational-cutover
gate (migration Phase 5, roadmap Phase 7).

The harness is test support under `packages/harnessy-local-host/test/`. It is
absent from package exports, bins, packed files, release descriptors, and the
six-command local-host allowlist. It performs no live discovery and has no
scheduler, process, provider, credential, review-token, authority, or
activation integration.

## Request

A request binds one test-created canonical fixture root, source boundary, and
output parent. Sources are explicitly enumerated regular files; directories,
globs, recursion, default paths, and `$HOME` resolution are forbidden.
An ordinary-role source whose bytes carry the SQLite file header is rejected,
so a caller cannot bypass online backup by relabeling a main database file.

The request scope contains every role exactly once in this order:

1. `meeting_publication_sqlite`
2. `community_briefing_sqlite`
3. `meeting_review_log`
4. `community_briefing_draft`
5. `community_briefing_provenance`
6. `jarvis_config`
7. `jarvis_environment`
8. `life_state`
9. `cron_state`
10. `scheduler_definition`

Each role is exactly `included` or `not_configured`. Included roles have at
least one matching entry; a non-configured role has none. SQLite roles have at
most one entry. Entry identifiers and source/archive paths are unique, and
entries are sorted by safe relative POSIX archive path.

The review token is not an entry role. Its source path is validated lexically
but is never opened, stated, hashed, or copied. Its only disposition is
`exclude_and_regenerate_after_authorized_activation` with
`accessAllowed: false`.

The canonical request envelope contains a SHA-256 digest of the exact request
object. Unknown or missing keys, duplicate JSON keys, noncanonical bytes, a
UTF-8 BOM, or anything other than one final LF fail closed.

## Filesystem policy

The fixture harness supports only Darwin/Linux with `process.getuid` and a
local POSIX filesystem. Windows fails before source or output I/O; a future
implementation requires separately reviewed ACL owner, reparse-point,
hard-link, no-follow, and replacement handling.

The fixture, source, and output roots are absolute, already canonical, not
filesystem roots, non-overlapping, owned by the effective UID, and private.
Every source ancestor down from the declared boundary is a real owner-only
directory. Sources are regular, single-link, owner-only files. Symlinks,
symlinked ancestors, special files, aliases, duplicate device/inode identities,
group/world permissions, and path replacement fail closed.

The fixture limits are 128 entries, 256 MiB per file, and 1 GiB total. Those
limits are test choices, not accepted production limits.

## Capture

Ordinary files are copied through stable no-follow descriptors into exclusive
candidates. Device, inode, owner, mode, link count, size, and nanosecond time
metadata are compared between path and descriptor before and after bounded
copying. Bytes are hashed while copying; output is mode `0600` and fsynced.

SQLite uses `node:sqlite`'s online `backup()` API from a read-only source
connection. Journal, WAL, and SHM files are never copied directly. The
standalone candidate must pass bounded `PRAGMA quick_check(1)`, and the receipt
records only the safe result, user version, and page count. Concurrent
committed writes may cause SQLite's backup to restart; bounded progress prevents
continuous churn from hanging indefinitely.

These checks detect observed replacement and do not claim protection from an
arbitrary malicious same-UID ABA swap.

## Isolated restore and publication

Before publication, every payload is restored into a newly created, empty,
owner-only temporary directory with exclusive no-follow creation. Restored
hashes, sizes, modes, and SQLite checks are independently reread from that
directory. The actual directory tree is enumerated and must exactly match the
requested archive inventory, including the absence of extra paths. Its
independently observed inventory digest must match the payload digest. The
temporary restore is removed only after verification.

The backup is assembled in a uniquely named owner-only staging directory under
the final output parent while an exclusive owner-only sidecar lock is held.
Payload files are fsynced as written, then every nested payload directory is
fsynced child-first. Canonical `evidence.json` and the staging directory are
also fsynced. The harness then revalidates the lock, staging identity, exact
inventory, payload identities, and absence of the final path before one
same-parent atomic rename and parent-directory fsync. Existing final paths are
never overwritten and stale locks are never broken automatically.

Before rename, fixture cleanup first requires the staging root's recorded
identity to match, then removes that private test subtree under the cooperative
same-UID fixture threat model. This is not an exact-tree or adversarial cleanup
primitive and must not be promoted into operational code. After rename, a
later fsync or lock-cleanup error never deletes the final bundle; it reports
uncertain publication for strict verification.

## Receipt

The private owner-only receipt binds:

- request digest, deterministic backup identity, times, OS/architecture/Node
  and owner identity;
- exact fixture/source/output/final boundaries and complete canonical scope;
- the review-token exclusion and proof that it was not accessed or copied;
- each source observation, capture method, archive path, backup hash/size/mode,
  safe SQLite validation, and isolated-restore result;
- a digest of the sorted payload inventory;
- completed isolated restore and removal;
- atomic publication strategy, private modes, staging absence, and parent fsync.

It contains no file bytes, environment values, note content, database rows or
schema SQL, credentials, tokens, provider responses, or raw errors. The receipt
digest proves integrity only and grants no authority. Backup bundles must never
be committed or uploaded.

The persisted publication field records that parent-directory fsync is
`required_before_success`; it does not claim the fsync was already complete
when the pre-rename evidence file was created. The harness returns success only
after the rename, strict reread, lock removal, and a final parent fsync. Strict
reread requires the reviewed request digest and binds receipt owner evidence to
the executing POSIX UID. A bundle recovered from an interrupted run still
requires external operational adjudication and is never operational evidence.

## Evidence matrix

The complete fixture contract requires tests for malformed/noncanonical
envelopes, role and entry mismatch, unsafe or overlapping paths,
symlinks/hard links/special files/modes/owners, attempted token inclusion or
access, existing outputs and lock contention, source and candidate
replacement/tampering, mislabeled SQLite sidecars, WAL and rollback-journal
SQLite snapshots, concurrent SQLite writes, corruption/churn, restore
mismatch, failures around creation/fsync/rename boundaries, Windows rejection
before I/O, forbidden runtime/package surfaces, and a worktree snapshot.

The initial implementation stages this matrix across focused follow-ups and
must report exactly which controls ran. It must not weaken `fixtureOnly`,
`operationalEvidence`, token exclusion, no-overwrite, atomic publication, or
absence from runtime surfaces.
