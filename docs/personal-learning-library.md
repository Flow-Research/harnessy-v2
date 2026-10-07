# Personal learning library

The V2 Core CLI delegates `harnessy jarvis wiki` to the installed V2 local host.
The host owns downloads, SQLite, model subprocesses and the optional viewer;
Core owns typed source, version, citation and synthesis contracts plus the
existing reading identity and provider-resolution rules. No connector credential
store, MCP server, paid extraction service or discovery scheduler is added.

Install Core and local-host together using the existing V2 local release process.
The packaged-host fixture exercises their tarballs outside the monorepo, including
the actual model subprocess adapter and Core-to-host route. `hsy` loads the bundled
personal-knowledge skill. Codex can install the same skill directory from the
Core package; resolve its entry with
`node -p 'require.resolve("@harnessy/core/skills/personal-knowledge")'` in the
installation, then copy its containing directory into the selected Codex skills
directory. This does not install OpenWiki ingestion or integrations.

| Command | Result |
| --- | --- |
| `harnessy jarvis wiki ingest <url-or-file> [--topic label] [--note text]` | Register source and saved appearance; preserve a separate personal note |
| `harnessy jarvis wiki sync` | Reconcile delivery history, extract a bounded batch, compile changed evidence |
| `harnessy jarvis wiki sync --capture-only` | Reconcile without downloads or model calls |
| `harnessy jarvis wiki sync --refresh` | Explicitly check up to ten existing sources for new versions |
| `harnessy jarvis wiki search '<query>'` | Matching source versions, passages and generated pages |
| `harnessy jarvis wiki ask '<question>' --context` | Bounded evidence for the current agent session, without a model call |
| `harnessy jarvis wiki ask '<question>'` | Standalone answer with validated source-version and passage citations |
| `harnessy jarvis wiki status` | Capture/extraction/synthesis status and failures |
| `harnessy jarvis wiki review --week YYYY-Www` | Idempotent dated review |
| `harnessy jarvis wiki open` | Optional OpenWiki 0.5.1 local viewer, stopped when the command exits |

Commands return JSON. Use `--home-root`, `--vault`, and `--target` for isolated
fixtures or explicit alternate roots. Keep private vaults outside Git. Repeated
`--topic` flags assign multiple labels; later explicit corrections replace the
source's topic set.

The default vault is `~/.harnessy/jarvis/wiki/learning/`:

- `catalog.sqlite3`: sources, immutable versions, appearances, FTS5 passage/page
  indexes and compilation checkpoints.
- `snapshots/`: content-addressed source bytes. Repeated appearances reuse a
  source; changed bytes or extracted passages create a new version.
- `wiki/`: OKF v0.2 pages, relative citation links, source passages, topics,
  concepts, questions, index and dated reviews.
- `notes/`: separately owned personal notes; synthesis never replaces them.

Capture, delivery, processing, reading and agreement are distinct. A delivered
ledger row or a canonical `.journaled` brief is intake evidence. Previews,
feedback and unmarked briefs are excluded. The brief date is recovered from its
canonical path separately from publication-marker time and import time. Each
sync replays history idempotently, so a failed post-publication sync loses no
permanent intake event. It never writes back to the reading ledger.

HTML extraction removes scripts and navigation, preserves restricted-page
abstracts when present, and reports unavailable content. Text PDFs use the local
`pdftotext` executable (Poppler); missing tooling, extraction errors and scanned
PDFs are explicit failures. OCR is not enabled. Matching evidence-bearing archive
bodies may be reused on fetch failure; title-only discovery stubs are excluded.
File changes are detected by size/mtime; public sources are rechecked after seven
days or on `--refresh`. Public downloads have a 12 MiB limit, timeouts, redirect
limits, per-hop address validation and a DNS-pinned connection. The explicit
loopback transport seam is available only to tests.

Writers serialize through SQLite `BEGIN IMMEDIATE`. Acquisition fails promptly
when another writer is active. Process death releases the lock. Source snapshots
are durable before catalog registration; unreferenced immutable snapshots are
harmless after interruption. A private page journal restores uncommitted
generated files against the committed catalog on the next writer. Recovery and
replacement compare hashes and stop on personal edits. This is a cooperative
local-filesystem contract, not protection against a hostile same-user writer.
Ask/search/status use a read-only catalog and do not initialize missing vaults.

Each sync fetches at most ten sources and has a fifteen-minute batch deadline.
Failed items rotate behind unattempted work and remain retryable. Compilation
uses at most ten source versions, 65,000 evidence characters, bounded passages
and bounded existing pages. A source's topic correction takes precedence over
automatic classification. The model proposes structured claims and links;
deterministic validation rejects uncited material claims, invented versions,
nonmatching quotes, cross-source claims citing only one source, invalid paths,
markup and unresolved links. Citation validation proves evidence exists; it does
not prove an interpretation. An unchanged sync makes no model call or page edit.

Standalone synthesis uses Core's provider order and model resolution. Claude is
invoked with no tools, MCP, skills, hooks or session persistence. Codex uses an
ephemeral read-only session, reads only the configured top-level model identifier
while retaining its authenticated account, ignores other user/rule configuration,
and disables shell execution, apps, plugins, web search,
image generation and delegation. The installed Codex CLI must support those
flags; older versions fail closed. Custom request/response adapters (including
other providers) use `HARNESSY_WIKI_EXECUTOR` and optional JSON argv in
`HARNESSY_WIKI_EXECUTOR_ARGS`. They receive the complete request as JSON on stdin
and must return the synthesis JSON on stdout, with no tools or side effects.
Model processes have a two-minute timeout and bounded output. A failed provider
does not mark evidence compiled.

Search uses bounded token expansion, SQLite FTS5, page citations and topic
relationships. Answers use original passages and explicitly identify evidence
gaps. Queries never fetch new sources. Current-session responses should use
`--context` so the caller's configured agent can answer without another process.

OpenWiki is pinned to 0.5.1 and invoked only through `visualize`. Its graph uses
Markdown links and frontmatter directly. The viewer binds loopback and currently
loads browser libraries from a CDN; editor/Obsidian reading is offline-capable.
No OpenWiki model account, ingestion, scheduling or coding-agent integration is
configured. The compatibility fixture validates generated pages with OpenWiki's
own OKF validator and graph builder and starts its public viewer command.

Daily CLI publication success triggers a bounded sync; any wiki failure remains
retryable and cannot turn publication success into failure. Weekly CLI success
generates a dated review and a local companion link beside the plan. The library
does not publish another journal entry or change Anytype publication. Reviews
record their source and included-source counts; their bounded evidence is not a
claim of exhaustive weekly coverage.

Automation is implemented but this branch does not activate it. The deployment
profile still marks operational cutover unauthorized. Stage reviewed tarballs,
then follow `docs/migrations/v1-to-v2-canonical-cutover.md`: verified initial
backup and restore, one-writer stop/rebind, final backup, bounded smoke,
duplicate-write checks, tested rollback and separately authorized roll-forward.
Do not rebind existing schedulers directly to this worktree.

Verification commands:

```sh
node --test qa/tests/personal-knowledge.api.test.mjs
npm run check
npm run qa:check
npm run test:local-host-fixture
node packages/harnessy-local-host/scripts/wiki-viewer-fixture.mjs <installed-openwiki-0.5.1-directory>
```

Use the repository-supported Node version. The machine's default Node may differ
from the Node executable pinned in a V2 installation. No live source or credential
is required by the deterministic fixtures; the model test boundary is a real
local subprocess returning fixture responses.

A live standalone evaluation using the configured Codex model answered two
synthetic benchmark questions with validated exact passage citations. It
distinguished a throughput increase from a latency increase across different
hardware, and declined to infer lower energy consumption when neither source
measured energy. These checks demonstrate adapter execution and grounded answers,
not general semantic verification of model output.
