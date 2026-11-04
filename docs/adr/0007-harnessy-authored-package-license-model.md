# ADR-0007: Harnessy-authored package license model

- Status: accepted policy; release/legal evidence follow-up remains
- Date: 2026-09-05

## Context

Harnessy V2 is a mixed-provenance monorepo. The root `LICENSE` is the inherited
Pi MIT notice, not an established license for Harnessy-authored code. The four
inherited Pi packages intended for publication carry that notice; a fifth,
Pi Orchestrator, is intentionally unpublished. The vendored Executor wrapper
and platform packages carry Executor's separate MIT notice. Those release
boundaries are already deterministic and are not part of V2D-002, although
authority to license Harnessy overlay contributions under MIT still needs an
explicit answer.

The Harnessy-authored packages are inconsistent:

| Package | Publication state | Current declaration | Package `LICENSE` |
|---|---|---|---|
| `@harnessy/core` | intended public | `AGPL-3.0-only` | present |
| `@harnessy/engine` | intended public | `AGPL-3.0-only` | present |
| `@harnessy/capability-harnessy-v1-full` | intended public | `AGPL-3.0-only` | present |
| `@harnessy/capability-org-knowledge` | intended public | `AGPL-3.0-only` | present |
| `@harnessy/sdk` | private | `AGPL-3.0-only` | present |
| `@harnessy/local-host` | private, never published | `AGPL-3.0-only` | present |

The embedded V1 source inside the compatibility pack explicitly declares
`AGPL-3.0-only`. That nested license applies to the embedded source and does
not, by itself, license the outer package. Engine and SDK bundles also require
an approved release policy for third-party notices and corresponding source for
the MIT Executor code and other bundled components; the required contents are
an unresolved legal/evidence question.

No repository evidence establishes a CLA, DCO, copyright assignment, or other
relicensing grant covering every Harnessy contribution. This ADR therefore
cannot be accepted through implementation inference.

## Proposed decision

The owner approved the following policy on 2026-09-07:

- License these six packages under `AGPL-3.0-only`: `@harnessy/core`,
  `@harnessy/engine`, `@harnessy/sdk`, `@harnessy/local-host`,
  `@harnessy/capability-harnessy-v1-full`, and
  `@harnessy/capability-org-knowledge`.
- Preserve the exact existing MIT release boundaries for inherited Pi,
  `@harnessy/executor` and its platform variants, and the Claude bridge,
  subject to explicit confirmation that Harnessy overlay contributions may be
  distributed under MIT. Third-party code remains under its own terms and is
  not described as relicensed.
- Treat the root as a license map for a mixed-provenance monorepo instead of
  presenting the inherited Pi MIT notice as a repository-wide license.
- Add the matching package-root license artifact to each Harnessy-authored
  package, including private packages for consistency, and add complete
  third-party notices to bundles.
- Record that selecting `AGPL-3.0-only` now does not purport to withdraw rights
  already granted by any earlier `AGPL-3.0-or-later` declaration.

This is the narrowest uniform model aligned with the preserved V1 source and
the current private package declarations. The approval selects the repository
policy; it is not legal advice or evidence that every contributor right,
third-party notice, or corresponding-source obligation has been confirmed.

## Options considered

### Uniform `AGPL-3.0-only`

This matches V1 and the current private SDK/local-host declarations and gives
Harnessy-authored packages one policy. It still requires confirmation of
copyright authority and the effect of earlier `-or-later` declarations.

### Uniform `AGPL-3.0-or-later`

This matches current Core and capability metadata but broadens the explicitly
`-only` V1/private-package position. The embedded V1 source would still need a
separate, accurate designation.

### Mixed AGPL policy by package

This may be possible, but it permanently complicates package messaging,
Garden consumption analysis, and supply-chain enforcement without a product
boundary that currently justifies the distinction.

### MIT for new Harnessy packages with V1 retained under AGPL

This creates a split model and first requires a derivation and contributor-
authority review. The embedded V1 source cannot be made MIT by changing the
outer package metadata.

### MIT everywhere, proprietary licensing, or dual licensing

Current repository evidence does not establish the contributor grants needed
for these choices.

## Approval questions

The following release/legal follow-up remains before publication:

1. Do all relevant Harnessy copyright holders authorize the selected license?
2. How are earlier `AGPL-3.0-or-later` declarations recorded without implying
   retroactive withdrawal?
3. Is the outer V1 compatibility pack an aggregate or a derivative/combined
   work for licensing purposes?
4. What source-offer, linking, modification, and network-use obligations apply
   when Garden consumes Harnessy packages while remaining a separately owned
   hosted product?
5. Which notices and corresponding-source materials are required for Engine,
   SDK, compiled Executor sidecars, and their bundled third-party components?
6. Which terms apply path by path to Harnessy-authored root scripts and docs,
   prompts, templates, context, other capability content, and imported V1
   resources, and is ownership or third-party permission established for each?
7. May Harnessy-authored Executor wrapper/overlay contributions and any
   Claude-bridge overlay contributions be distributed under their retained MIT
   boundaries?

## Implementation and remaining evidence

The approved mechanical change has been applied:

1. Aligns license fields and adds package-root `LICENSE` files for Core,
   Engine, SDK, local host, and both capability packages.
2. Engine/SDK third-party notice and corresponding-source materials remain to
   be completed as release evidence.
3. Replaces the ambiguous root presentation with a mixed-provenance license
   map while retaining the canonical Pi and Executor notices.
4. Makes release and supply-chain contracts require the exact approved SPDX
   identifier and exact canonical license bytes for Harnessy-authored
   artifacts.
5. Updates packed fixtures, local release validation, CI evidence, migration
   documentation, and V2D-002 status.

Publication would remain separately blocked by V2D-006, hosted evidence, and
explicit publication approval.

## Consequences after policy approval

- V2D-002 remains open for third-party notices, corresponding-source
  materials, and release evidence; the policy decision itself is no longer
  pending.
- No Harnessy-authored public artifact may be published.
- Existing Pi, Executor, and Claude-bridge MIT evidence remains unchanged.
- Garden remains a separate product boundary; this proposal neither migrates
  Garden nor decides its compliance obligations.
