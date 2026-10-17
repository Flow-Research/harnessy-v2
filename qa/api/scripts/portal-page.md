# Harnessy V2 portal page regression specification

H-10 Phase 1, third slice: the local Today, Health and Connections page served by `harnessy-portal` at `/`. Every case runs against a real server on an ephemeral loopback port with an isolated home and state directory, or runs the page code unchanged against a recording document at the DOM boundary. Nothing is installed, and no live service, token or database is touched. Passing these scenarios shows that the page is served under the strict CSP, renders API data only as text, links only to loopback owning services, and signs in only with a one-time code. It does not show how the page looks in a particular browser.

## PRTP-001 The page files carry the strict CSP and no secret
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-page-server.test.ts, packages/harnessy-local-host/src/portal/page-assets.ts, packages/harnessy-local-host/src/portal/server.ts
Expected: `/`, `/app.css` and each page script return 200 with the exact CSP, `no-store`, `nosniff`, `no-referrer`, `DENY`, the right content type, no `Set-Cookie` and no `Access-Control-*` header; no file contains the install token, a page token, a code or any 43-character secret; a script may import only another page script; a page file refuses a non-GET method, a wrong `Host`, a foreign `Origin` and a `cross-site` or `same-site` fetch; nothing else is served; without page files the server serves only the API.

- Execute the page-file and loader cases against a real server.

## PRTP-002 The page renders API data as text and links only to loopback services
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-page.test.ts, packages/harnessy-local-host/src/portal/page/view-model.ts, packages/harnessy-local-host/src/portal/page/mount.ts
Expected: Markup, script and event-handler text in any API field stays text; the mount creates only the page's own elements and sets only `class`, `href` and `rel`; a link is kept only for `http://127.0.0.1:<port>/` or `http://localhost:<port>/` with no credentials, query or fragment, so `javascript:`, `data:`, `https:` and other hosts are withheld; the HTML has no inline script, inline style or event handler, and the page scripts never use `innerHTML`, `document.write`, `eval` or `Function`; a degraded or malformed tile shows its state and reason as text.

- Execute the view-model, mount and static-safety cases.

## PRTP-003 The page signs in with a one-time code and renders seeded data end to end
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-page-server.test.ts, packages/harnessy-local-host/test/portal-page.test.ts, packages/harnessy-local-host/test/support/portal-browser-shim.mjs, packages/harnessy-local-host/src/portal/page/app.ts
Expected: The exact scripts the server sent run in a child process against a server over a seeded home; the page removes the code from the address bar before it exchanges it, keeps the page token in session storage, sends every request with cookies omitted, and renders the seeded waiting counts, brief, readings and weekly plan on Today, every service on Health, and on Connections the meeting Google row with its link to the review page and note, the `gws-login <slug>` commands, Fathom accounts and Codex; no page shows the canary text, the account email, the install token or the code; a spent, malformed or refused code, an expired or refused session and a blocked storage leave the page signed out with the `harnessy-portal open` instruction or working from memory, and a slower older render never replaces a newer one.

- Execute the end-to-end and page-script cases.

## PRTP-004 The page adds no writer
Layer: api
Status: implemented
Test File: qa/tests/portal-page.api.test.mjs
Linked Refs: packages/harnessy-local-host/test/portal-non-writer.test.ts, packages/harnessy-local-host/test/support/portal-recorder.mjs
Expected: The real `portal-cli serve`, run under the recorder, serves every page file as well as every API route, and still starts only allow-listed `launchctl print` reads and opens no planted secret file.

- Execute the non-writer regression case.
