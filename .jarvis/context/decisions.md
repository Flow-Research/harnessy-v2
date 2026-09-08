# Harnessy V2 decisions

## Accepted

- **Reuse-first completion (2026-09-08):** The owner approved using verified
  preserved implementations inside a V2-owned installation instead of requiring
  every workflow to be rewritten in TypeScript/Effect before migration. The
  final installation must not depend on the original V1 checkout or its running
  services. Preserve existing features; replace only the boundaries needed for
  safe packaging, ownership, authorization, and recovery. Source preservation
  alone does not prove runnable packaging or operational safety. This changes
  the native-rewrite completion criterion, not ADR 0006's operational gates.
  V1 remains live until the separately authorized handover passes; a permanent
  V1 community-review service is not the selected outcome.
- **V2 is canonical:** ADR 0004 makes this repository the source for new
  Harnessy runtime, capability, workflow, package, product, QA, and release
  work. V1 remains a compatibility oracle and live-writer owner until cutover.
- **Executor boundary:** Executor owns connector mechanics, credentials,
  policies, approvals, audit, and host/runtime integration. Harnessy owns
  portable contracts and semantic product surfaces.
- **Garden boundary:** Garden is a hosted consumer, not the upstream home of
  reusable Harnessy capabilities.
- **SDK boundary:** ADR 0005 keeps `@harnessy/sdk` private and narrows it to
  Harnessy-owned portable contracts plus scoped Node construction. Its local
  consumer gate is implemented; publication remains a separate decision.
- **Operational authorization boundary:** ADR 0006 keeps the current planning
  receipt permanently inert. Later smoke and production authorizations,
  activation lease, operation-scoped Core grants, rollback, and roll-forward
  remain separate staged implementations and authorizations.
- **One Core runtime:** On 2026-09-05 the maintainer approved ADR 0006's
  packaging amendment: one guarded host-consumed runtime call, internal
  issuance in Core's tarball, and no exported raw issuer or second private
  runtime package. Local development and isolated verification are approved;
  operational activation remains separately authorized and unimplemented.
- **Capability portability:** Local directory packs install and export as
  self-contained verified artifacts. Remote git/npm/URL sources fail closed
  until secure fetching is implemented.
- **QA ownership:** `.jarvis/context/profiles/qa.json` is canonical. The
  repo-owned wrapper verifies the preserved generic runtime digest, and
  `npm run qa:catalog` alone owns generated catalog output.

## Open decisions

- Complete third-party notices, corresponding-source materials, and final
  release evidence for the owner-approved ADR 0007 `AGPL-3.0-only` model.
- Whether and when the private SDK is published after its license/artifact and
  release-cohort gates pass.
- A full Effect cohort upgrade that removes the beta.85 declaration exception.
- Maintainer authorization for branch-protection mutation, publication, and
  operational cutover.
- Meeting review runtime lifetime: option (a) is selected. V2 uses one
  long-running combined review/dispatch owner with revocable authorization, a
  fixed loopback port, and a signed 24-hour maximum. The bounded 15-minute
  mode remains available for manual sessions. Production owner authorization
  and cutover gates remain separate; V1 remains live.

No open decision is resolved by this status document.
