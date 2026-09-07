# QA process

- Regression specs are the source of scenario intent; executable tests are the
  implementation; `qa drift` detects mismatches.
- Use canonical IDs `<PREFIX>-<NNN>`, the shared layers `api`, `browser`,
  `security`, and `manual`, and explicit `Status:` and `Test File:` fields.
- `.jarvis/context/profiles/qa.json` is the only canonical profile.
- Run `npm run qa:ids`, `npm run qa:tests`, `npm run qa:drift`, and
  `npm run qa:coverage`. The local wrapper is pinned by digest and works from a
  fresh dependency install; a global `qa` binary is compatibility evidence only.
- `qa/features.generated.yaml` is JSON-form YAML generated only by
  `npm run qa:catalog`. Semantic feature metadata lives in the profile.
- `Status: implemented` requires a matching executable test ID. Missing native
  workflows stay `not-implemented` or in the roadmap; preservation is not
  implementation.
- No result snapshot or external sink is currently configured. Do not invent
  execution results from coverage inventory.
