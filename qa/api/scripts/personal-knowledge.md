# Harnessy V2 personal knowledge regression specification

## WIKI-001 Private capture, evidence, synthesis and retrieval
Layer: api
Status: implemented
Test File: qa/tests/personal-knowledge.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/wiki.test.ts, packages/harnessy-local-host/test/support/packed-wiki.mjs
Expected: A private SQLite vault deduplicates delivered and saved sources, recovers interrupted imports and page writes, extracts bounded evidence, validates version/passage citations, preserves personal edits, retrieves across topics, and writes idempotent dated reviews without journal publication.

- Exercise real SQLite, temporary files, text PDFs, local processes and loopback HTTP.
- Exclude preview/unpublished history and recover publication-marker intake on retry.
- Reject private-network destinations, fabricated evidence references and executable markup.
- Keep read-only questions side-effect free and unchanged sync free of model calls and page churn.
- Run the packed local-host fixture for source-independent command routing, synthesis process execution and crash recovery.
- Verify OpenWiki 0.5.1 separately with `node packages/harnessy-local-host/scripts/wiki-viewer-fixture.mjs <installed-openwiki-directory>`.
- Live scheduler ownership remains governed by the canonical cutover runbook.
