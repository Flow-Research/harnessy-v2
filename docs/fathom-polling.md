# Fathom polling and note import

V2 polls only explicitly selected accounts. Configuring a credential does not
automatically include that account in scheduled polling.

In your existing Jarvis configuration, choose labels from `fathom.accounts`:

```yaml
fathom:
  poll_accounts: [research]
  accounts:
    research:
      api_key_env_var: RESEARCH_FATHOM_API_KEY
    another_account:
      api_key_env_var: OTHER_FATHOM_API_KEY
meeting_publication:
  project: example-research
  source_path: /absolute/path/to/private/meetings
```

The environment-variable names are configuration, not credentials. Supply actual
keys through your existing protected credential setup; never commit them.

Run one bounded pass:

```sh
harnessy jarvis meeting fathom poll --target /absolute/path/to/project --json
```

Repeat `--account LABEL` to override the configured polling list for that pass.
Missing, empty, unsafe or unknown selections fail before credential access or
provider requests. `default_account` is not a polling authorization, and V2 never
infers that every configured account should be polled.

The read-only status JSON reports `polling.configured`, selected accounts and
configuration issues separately from local inbox readiness (`ready`). Neither
field verifies credentials or provider connectivity. An unset polling selection
does not prevent inspecting existing inbox records or preparing an import plan.

When a meeting source directory is configured, recent verified pending envelopes
from the selected accounts are imported into its existing year/month structure.
Other account inboxes are left alone. Existing Markdown notes are not overwritten;
approval and publication remain separate. New notes use the configured meeting
project; no project label is invented when it is unset.

## Upgrading an existing installation

Before installing a candidate with explicit polling selection, record the exact
currently approved account labels in `fathom.poll_accounts`, or retain explicit
`--account` arguments in its scheduler. Review the selection against existing
configuration rather than copying example labels. Do not add excluded accounts.

The schedule interval remains five minutes. The schedule command writes a planned
or applied LaunchAgent file; OS loading is a separate operation. Account selection
does not change credentials, authorize publication or activate a scheduler.
