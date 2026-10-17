# Harnessy V2 portal API regression specification

H-10 Phase 1, second slice: the read-only portal API served by `harnessy-portal` in `@harnessy/local-host`, with its sessions, OpenAPI document and response schemas from `@harnessy/core/read-model`. Every case runs a real server on an ephemeral loopback port with an isolated home and state directory; nothing is installed, and no live service, token or database is touched. Passing these scenarios shows that the API answers only loopback, same-origin, credentialed requests, never changes a database, degrades one tile at a time and never starts a writer-shaped process. It does not show anything about the later page or the Phase 2 service install.

## PRTA-001 The API answers only exact-Host, same-origin loopback requests
Layer: api
Status: implemented
Test File: qa/tests/portal-api.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-server.test.ts, packages/harnessy-local-host/src/portal/server.ts
Expected: A wrong or missing `Host` gets 400; a foreign or `null` `Origin` and a `cross-site` or `same-site` `Sec-Fetch-Site` get 403; a preflight gets 405; no response carries an `Access-Control-*` header or `Set-Cookie`; every response sends `no-store`, `nosniff`, `no-referrer`, `DENY` and the strict CSP; a body over 1 KiB gets 413 and a URL over 2 KiB gets 414; the server binds 127.0.0.1 only and keeps serving after a client aborts mid-body.

- Execute the request-check and listener cases against a real server.

## PRTA-002 Sessions use the portal's own tokens and expire
Layer: api
Status: implemented
Test File: qa/tests/portal-api.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-server.test.ts, packages/harnessy-local-host/test/portal-token-store.test.ts, packages/harnessy-local-host/test/portal-command.test.ts, packages/harnessy-local-host/src/portal/auth.ts, packages/harnessy-local-host/src/portal/token-store.ts
Expected: Data routes refuse a missing, malformed or unknown bearer, the raw install token and a review cookie alone with 401, and never echo the cookie; the install token never crosses the wire: the server proves it holds the token for the client's nonce and its own origin, and each client proof works once, for one origin, method and path, within 60 s; the CLI sends nothing reusable to a listener that cannot prove it holds the token; a one-time code needs an install proof, works once and expires after 60 s; the exchange needs the exact `Origin` and JSON; a page token is read-only and expires after 8 h; the state directory must be a private, non-symlinked directory; the install token file is created once with mode 0600 and a symlinked, shared, hard-linked, oversize or malformed token file is refused.

- Execute the session and token-store cases.

## PRTA-003 Every response follows the versioned contract
Layer: api
Status: implemented
Test File: qa/tests/portal-api.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-server.test.ts, packages/harnessy-core/test/read-model-api.test.ts, packages/harnessy-core/src/read-model/api-schemas.ts, packages/harnessy-local-host/src/portal/openapi.ts
Expected: The OpenAPI 3.1 paths equal the route table and its components equal `PortalApiSchemas`; each data route returns `harnessy.portal.<name>.v1` that validates against its closed schema with no private text or account names; a response that fails its schema is refused with 500 and only a fixed code is logged, with no secret or URL in the log.

- Execute the contract and schema cases.

## PRTA-004 Reads never change a database and degrade one tile at a time
Layer: api
Status: implemented
Test File: qa/tests/portal-api.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-sources.test.ts, packages/harnessy-local-host/test/portal-server.test.ts, packages/harnessy-local-host/src/portal/sources.ts
Expected: After 50 reads of every data route, databases built with the real writer code keep the same bytes, inode and modification time, with no sidecar file and no new file in the home directory; an empty home gives degraded tiles that still validate; an unsafe Life config or an invalid workspace is a tile, not a failure; a real writer holding the Life ledger gives a `busy` tile in a 200 response within one second.

- Execute the read-only proof, empty-home, unsafe-input and busy-writer cases.

## PRTA-005 The portal is a known non-writer
Layer: api
Status: implemented
Test File: qa/tests/portal-api.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-non-writer.test.ts, packages/harnessy-local-host/test/support/portal-recorder.mjs, packages/harnessy-core/src/jarvis/community-briefing/operational-runtime.ts, packages/harnessy-core/src/jarvis/meeting-publication/operational-input.ts
Expected: The real `portal-cli serve`, run under a recorder, answers every route in its own OpenAPI document; every process it starts is `/bin/launchctl print gui/<uid>/<fixed label>` and matches neither one-writer guard; it opens none of the planted token, rendezvous, auth or env files; its own command line passes both guards; the assertion is shown to catch writer-shaped, unlisted and secret-reading records with synthetic records only; `org.harnessy.portal` is in neither guard label list.

- Execute the non-writer regression cases.

## PRTA-006 Connections report status and hand off to the owning service
Layer: api
Status: implemented
Test File: qa/tests/portal-api.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-sources.test.ts, packages/harnessy-local-host/src/portal/connections.ts
Expected: Meeting Google and Discord health maps to connected or attention with a link to the loopback review page only; Fathom accounts report checkpoint freshness; community, cockpit, `gws-<slug>` profiles and Codex report presence only, with a command to copy; no account name, credential or file content appears.

- Execute the connection mapping cases.
