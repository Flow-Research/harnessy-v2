# Testing strategy

- Prefer real production boundaries: SQLite, filesystem, local processes,
  sockets, loopback HTTP, and workerd are the current integration surfaces.
- Use unit tests for pure parsers, transforms, argument construction, and
  failure controls. A mock must not replace the implementation under test.
- The fd regression uses an injected executable only to inspect real production
  argv and process-exit handling; it does not implement a replacement glob.
- The SDK fixture uses a real npm pack/install consumer and real loopback HTTP.
  Its public package-registry access is an explicit external boundary.
- Use Testcontainers when a real external database is introduced. Adding a
  container for SQLite or local process behavior would reduce fidelity.
- Required tests do not become green through missing credentials or tools.
  Credential-dependent provider tests belong in an explicit optional lane.
