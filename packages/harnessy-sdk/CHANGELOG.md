# Changelog

## [Unreleased]

### Fixed

- Scoped meeting-provider HTTP requests so rejected and oversized responses are
  cancelled on completion without waiting for garbage collection.

### Changed

- Narrowed the stable SDK to Harnessy-owned semantic contracts and moved
  in-process engine construction to the Node-specific export.
- Kept the SDK private while making its bundle and declaration audits strictly
  read-only and aligning package contents with the built exports.

### Added

- Added built JavaScript and declaration outputs plus a packed-consumer smoke
  test for the private SDK package.
- Added a Harnessy-owned connection-provisioning boundary and a real isolated
  loopback AnyType spaces consumer with a typed authentication failure control,
  positive and negative public typing checks, internal-subpath rejection,
  single-Effect resolution checks, and scoped temporary credential cleanup.
- Added Node-only production-shaped Google Drive/Docs and Discord meeting
  publication adapters plus a content-free scoped local notifier. Executor
  retains credentials, connection lifecycle, approvals, policies, and audit;
  loopback/provider failure, restart/idempotency, redaction, and bounded process
  behavior are covered without live credentials.
- Documented the pinned Effect beta.85 declaration defect that requires a
  narrowly asserted `skipLibCheck` exception in the packed-consumer fixture.
