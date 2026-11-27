# Social cockpit

The local Executor serves the social inbox at `/social`. One operator can review messages from one X user and one WhatsApp Business number. A separate agent credential can read selected accounts, change local labels and prepare drafts. It cannot approve a draft. The fixture profile needs no provider account.

## Run the fixture

From the repository root, use the Bun version pinned in `executor/package.json`. Install and build the local Executor once:

```sh
(cd executor && bun install --frozen-lockfile --ignore-scripts && bun run prepare:native-test-deps)
npm ci --ignore-scripts
npm run build:executor-runtime
```

Run `npm run social:demo` in a private terminal. Open the one-time sign-in URL it prints, select Social inbox, and enter the separate operator code. Press Enter for another link if it expires. The review session expires after ten minutes. The demo always uses fixture mode and its own workspace in the ignored `.social-demo/` directory. Stop it with Ctrl+C.

The inbox initially shows an X mention, a private X message and a WhatsApp message. Select Feed for the separate X timeline. Select an item and prepare a draft. Review its audience, recipient and text before pressing **Approve and send**. A fixture receipt records an accepted send. The fixture never contacts X or Meta. Editing requires a new version. An unknown send outcome requires investigation. A retry of the same approval cannot dispatch another message.

Restart the command to retain the inbox and approval record. For a fresh demo, stop the host and move `.social-demo/` to a private backup before starting it again.

## Agent access

Load `agent.ts` as a Harnessy coding-agent extension with `hsy -e /absolute/path/to/social-cockpit/agent.ts`. The manifest describes the capability and its grants. The extension registers tools for account discovery, channel checks, inbox and thread reads, source-linked summaries, local triage, drafts and draft edits.

Give the agent only `HARNESSY_SOCIAL_AGENT_TOKEN` and `HARNESSY_SOCIAL_ORIGIN`, for example `http://127.0.0.1:4788`. Configure the account allowlist on the host. Use a separate OS user or sandbox that cannot read the host environment, data directory, browser profile or operator terminal. Do not give this agent a signed-in browser or a general Executor bearer. In live mode the host requires `HARNESSY_SOCIAL_AGENT_LIVE_ACCESS=true` before it serves any message data to an agent. Enable it only for an approved processor and workspace.

## Connect real providers

Use the regular `harnessy-executor daemon run --foreground` command with a fixed, owner-only workspace in `EXECUTOR_SCOPE_DIR`, an owner-only data directory, a separate random `HARNESSY_SOCIAL_OPERATOR_CODE` of at least 32 characters and `HARNESSY_SOCIAL_MODE=live`. Open the signed-in cockpit with `harnessy-executor open`. Live and fixture records use separate SQLite files. The host reads secrets from its environment. Enable approved operations with `HARNESSY_SOCIAL_LIVE_READS=true` and, separately, `HARNESSY_SOCIAL_LIVE_WRITES=true`. The latter permits a human-approved send. It grants no agent sending rights.

- For X, configure `X_CLIENT_ID`, `X_USER_ID`, the registered `X_REDIRECT_URI` (the cockpit origin plus `/api/social/v1/x/callback`) and `X_CLIENT_SECRET` for a confidential app. Connect as the intended user from Social. The host checks the user identity after OAuth authorization with PKCE. Tokens live in memory. Reconnect after a restart. Enable `X_OFFLINE_ACCESS=true` only if refresh is needed. Verify the paid endpoint entitlements and set a console spending cap. [X authentication](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
- For WhatsApp, provide `WA_BUSINESS_ACCOUNT_ID`, `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` and the supported `WA_GRAPH_VERSION`. Start with Meta's test number. Subscribe the official business account to the messages webhook. Publish only `/api/social/v1/webhooks/whatsapp` through HTTPS. The rest of the cockpit stays on loopback. The inbox starts with events received after subscription. Keep live reads enabled when sending so the host can process incoming opt-outs and receipts. [Meta Cloud API](https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform)
- For an approved utility template, supply `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANGUAGE`, `WA_TEMPLATE_BODY` and the consented recipients in `WA_TEMPLATE_CONSENT_RECIPIENTS`. Record opt-outs in `WA_OPT_OUT_RECIPIENTS`. Review the exact rendered text, category and consent before dispatch. An expired service window blocks a free-form draft. Select and approve a new template draft to send outside the window. [WhatsApp messaging policy](https://business.whatsapp.com/policy/)
- Agree on spending limits, deletion ownership, backups and message processing before enabling production access. Cloud approval, network configuration, billing and a delivery to a real recipient require separate operator verification.
