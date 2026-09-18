# Life Orchestrator reading curricula

Life Orchestrator V2 can mix an ordered learning curriculum with current research in the daily `Worth Reading`
section. Curriculum links use the same permanent delivery ledger as feed and research-agent links, so a published link
is not recommended again.

Enable a curriculum in `~/.agents/life/config.json`:

```json
{
  "reading": {
    "minimum": 2,
    "curricula": [
      {
        "id": "gitcoin-funding-mechanisms",
        "enabled": true,
        "max_per_brief": 2
      }
    ]
  }
}
```

The built-in `gitcoin-funding-mechanisms` curriculum contains all 78 entries in Gitcoin's mechanism library. It is
ordered as a learning path rather than alphabetically: straightforward grants and bounties come first, followed by
evidence and impact, community allocation, recurring funding, governance, identity, and experimental mechanisms.

With `max_per_brief` set to `2`, V2 reserves up to two curriculum readings first and leaves the third reading slot for
current research. A preview does not consume the pair. The pair advances only after the reviewed daily brief is
published and its journal marker exists. At two readings per published brief, the curriculum lasts 39 days.

Unknown, disabled, and duplicate curriculum entries are ignored. Set `enabled` to `false` to pause a curriculum
without losing its place in the permanent ledger.
