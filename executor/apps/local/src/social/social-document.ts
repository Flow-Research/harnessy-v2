// Static document. The client inserts inbox content only through DOM text nodes.
export const socialDocument = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Social inbox · Harnessy</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #162822;
        --quiet: #4d6057;
        --line: #cad5ce;
        --surface: #fff;
        --accent: #11644b;
        --wash: #e6efe7;
        --paper: #f5f7f2;
        font:
          16px/1.5 Inter,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        color: var(--ink);
        background: var(--paper);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
      }
      header,
      main {
        max-width: 78rem;
        margin: auto;
        padding: 1rem clamp(1rem, 4vw, 3rem);
      }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--line);
        min-height: 4rem;
      }
      header a {
        color: var(--ink);
        text-decoration: none;
      }
      h1,
      h2,
      h3,
      p {
        margin: 0;
      }
      h1 {
        font-size: clamp(2.3rem, 6vw, 4rem);
        font-weight: 550;
        letter-spacing: -0.055em;
        line-height: 1.1;
        margin: 1.25rem 0;
      }
      h2 {
        font-size: 1.3rem;
        letter-spacing: -0.025em;
      }
      h3 {
        font-size: 1.05rem;
      }
      a {
        color: var(--accent);
      }
      [hidden] {
        display: none !important;
      }
      :focus-visible {
        outline: 3px solid #176eaa;
        outline-offset: 3px;
      }
      button,
      select,
      input,
      textarea {
        font: inherit;
        color: inherit;
      }
      button,
      select,
      input {
        min-height: 2.55rem;
      }
      button {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 0.45rem;
        padding: 0.35rem 0.75rem;
        cursor: pointer;
      }
      button:hover {
        border-color: var(--accent);
      }
      button:disabled {
        cursor: wait;
        opacity: 0.6;
      }
      button.primary {
        color: white;
        background: var(--accent);
        border-color: var(--accent);
      }
      button[aria-pressed="true"] {
        background: var(--wash);
        border-color: var(--accent);
      }
      input,
      textarea,
      select {
        border: 1px solid var(--line);
        border-radius: 0.4rem;
        padding: 0.45rem 0.65rem;
        background: var(--surface);
      }
      textarea {
        width: 100%;
        min-height: 6rem;
        resize: vertical;
      }
      label {
        display: grid;
        gap: 0.3rem;
        font-weight: 550;
      }
      label input,
      label textarea,
      label select {
        font-weight: 400;
      }
      #access {
        max-width: 32rem;
        margin: 2rem 0;
      }
      form,
      .stack {
        display: grid;
        gap: 0.85rem;
      }
      .row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      .bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .box {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 0.7rem;
        padding: 1.15rem;
      }
      .muted,
      small,
      dt,
      time {
        color: var(--quiet);
      }
      .small,
      small {
        font-size: 0.85rem;
      }
      .status {
        margin: 0.6rem 0;
        white-space: pre-wrap;
      }
      .error {
        color: #9a3127;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 1.25rem;
        align-items: start;
      }
      #accounts {
        display: flex;
        gap: 0.6rem;
        flex-wrap: wrap;
      }
      .account {
        display: grid;
        gap: 0.3rem;
        min-width: 15rem;
      }
      .filters {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
        margin: 0.85rem 0;
      }
      .entries {
        display: grid;
        gap: 0.4rem;
        padding: 0;
        margin: 0;
        list-style: none;
      }
      .entry {
        display: grid;
        text-align: start;
        gap: 0.15rem;
        width: 100%;
        padding: 0.8rem;
      }
      .preview,
      .message {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        unicode-bidi: plaintext;
      }
      .preview {
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .message {
        border-left: 3px solid var(--line);
        padding-left: 0.8rem;
        margin: 0.3rem 0;
      }
      .review {
        background: var(--paper);
        padding: 1rem;
        border-radius: 0.45rem;
      }
      dl {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        gap: 0.25rem 0.8rem;
        margin: 0;
      }
      dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .section {
        margin: 1.25rem 0;
      }
      .mono {
        font-family: ui-monospace, monospace;
        font-size: 0.83rem;
      }
      .controls {
        margin-top: 0.5rem;
      }
      dialog {
        max-width: min(35rem, 95vw);
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 0.7rem;
        padding: 1.5rem;
        color: var(--ink);
        background: var(--surface);
      }
      dialog::backdrop {
        background: #12271fb3;
      }
      @media (max-width: 740px) {
        .layout {
          grid-template-columns: 1fr;
        }
        header,
        main {
          padding: 0.85rem 1rem;
        }
        .box {
          padding: 0.85rem;
        }
      }
      @media (prefers-color-scheme: dark) {
        :root {
          color-scheme: dark;
          --ink: #e5ede8;
          --quiet: #b1c1b8;
          --line: #3e5148;
          --surface: #19251f;
          --accent: #4c9c7d;
          --wash: #263c31;
          --paper: #141c18;
        }
        button.primary {
          background: #23654f;
        }
        .error {
          color: #ffa49a;
        }
      }
    </style>
  </head>
  <body>
    <header><a href="/">← Harnessy cockpit</a><span id="mode" class="small"></span></header>
    <main>
      <h1>Social inbox</h1>
      <section id="access" class="stack box">
        <h2>Operator sign-in</h2>
        <p id="access-help" class="muted">Enter your social operator code to review this inbox.</p>
        <form id="login">
          <label
            >Operator code<input id="code" type="password" autocomplete="off" required
          /></label>
          <div><button class="primary">Unlock inbox</button></div>
        </form>
      </section>
      <p role="alert" id="error" class="error status"></p>
      <section id="desk" hidden>
        <section class="section">
          <div class="bar">
            <h2>Channels</h2>
            <div class="row">
              <button id="post" type="button" hidden>Draft public post</button
              ><button id="refresh" type="button">Refresh inbox</button>
            </div>
          </div>
          <div id="accounts" class="section"></div>
        </section>
        <div class="layout">
          <section class="box">
            <h2>Messages and drafts</h2>
            <div id="filters" class="filters" aria-label="Inbox views">
              <button type="button" data-view="inbox" aria-pressed="true">Inbox</button
              ><button type="button" data-view="feed" aria-pressed="false">Feed</button
              ><button type="button" data-view="drafts" aria-pressed="false">Drafts</button>
            </div>
            <ul id="entries" class="entries"></ul>
            <button id="more" type="button" class="controls" hidden>Load more</button>
          </section>
          <section id="detail" class="box stack" aria-label="Message or draft">
            <h2>Conversation</h2>
            <p class="muted">Select a message or draft to review it.</p>
          </section>
        </div>
      </section>
      <dialog id="confirm">
        <div class="stack">
          <h2>Approve this message?</h2>
          <div id="envelope" class="stack"></div>
          <div class="row">
            <button id="send" type="button" class="primary">Approve and send</button
            ><button id="cancel" type="button">Cancel</button>
          </div>
        </div>
      </dialog>
    </main>
    <script>
      "use strict";
      const byId = (id) => document.getElementById(id);
      const urlId = encodeURIComponent;
      const state = {
        csrf: "",
        mode: "",
        accounts: [],
        view: "inbox",
        rows: [],
        cursor: null,
        selection: null,
        review: null,
      };
      let listRevision = 0;
      let detailRevision = 0;

      function el(tag, value, className) {
        const node = document.createElement(tag);
        if (value !== undefined && value !== null) node.textContent = String(value);
        if (className) node.className = className;
        return node;
      }
      function message(text) {
        return el("p", text, "message");
      }
      function actions(...children) {
        const node = el("div", null, "row");
        node.append(...children);
        return node;
      }
      function label(text, input) {
        const node = el("label", text);
        node.append(input);
        return node;
      }
      function facts(entries) {
        const node = el("dl");
        for (const [name, value] of entries) {
          if (value !== null && value !== undefined && value !== "")
            node.append(el("dt", name), el("dd", value));
        }
        return node;
      }
      function showError(error) {
        byId("error").textContent = error.message || "The request failed.";
      }
      function action(button, fn) {
        button.addEventListener("click", async () => {
          if (button.disabled) return;
          button.disabled = true;
          byId("error").textContent = "";
          try {
            await fn();
          } catch (error) {
            showError(error);
          } finally {
            button.disabled = false;
          }
        });
        return button;
      }
      function button(name, fn, style) {
        const node = el("button", name, style);
        node.type = "button";
        return action(node, fn);
      }
      function account(id) {
        return state.accounts.find((a) => a.id === id);
      }
      function providerName(a) {
        return a?.provider === "whatsapp"
          ? "WhatsApp"
          : a?.provider === "x"
            ? "X"
            : a?.provider || "Channel";
      }
      function time(value) {
        return value ? new Date(value).toLocaleString() : "No update yet";
      }
      function lock() {
        state.csrf = "";
        state.accounts = [];
        state.rows = [];
        state.review = null;
        state.selection = null;
        listRevision++;
        detailRevision++;
        byId("confirm").close();
        byId("envelope").replaceChildren();
        byId("entries").replaceChildren();
        byId("accounts").replaceChildren();
        byId("detail").replaceChildren();
        byId("mode").textContent = "";
        byId("desk").hidden = true;
        byId("access").hidden = false;
      }
      async function api(path, method = "GET", data) {
        const bearer = localStorage.getItem("executor.authToken");
        if (!bearer)
          throw new Error("Sign in to the Harnessy cockpit, then reopen the social inbox.");
        const headers = { authorization: "Bearer " + bearer };
        if (data !== undefined) headers["content-type"] = "application/json";
        if (state.csrf && method !== "GET") headers["x-social-csrf"] = state.csrf;
        const response = await fetch("/api/social/v1/" + path, {
          method,
          headers,
          body: data === undefined ? undefined : JSON.stringify(data),
          credentials: "same-origin",
          mode: "same-origin",
          redirect: "error",
          cache: "no-store",
        });
        const value = await response.json().catch(() => ({}));
        if (!response.ok) {
          const reason =
            typeof value.error === "string" ? value.error : value.error?.code || value.code;
          if (response.status === 401 || reason === "operator_session_required") lock();
          throw new Error(
            reason
              ? String(reason).replace(/_/g, " ")
              : "The request failed (" + response.status + ").",
          );
        }
        return value;
      }
      function emptyDetail() {
        state.selection = null;
        detailRevision++;
        byId("detail").replaceChildren(
          el("h2", "Conversation"),
          el("p", "Select a message or draft to review it.", "muted"),
        );
      }
      function showAccounts() {
        const container = byId("accounts");
        container.replaceChildren();
        for (const a of state.accounts) {
          const card = el("div", null, "box account");
          card.append(
            el("strong", a.label),
            el("small", providerName(a) + " · " + time(a.lastSync)),
          );
          if (a.error)
            card.append(
              el("small", typeof a.error === "string" ? a.error : "Channel update failed", "error"),
            );
          const controls = actions(
            button("Check channel", async () => {
              await api("accounts/" + urlId(a.id) + "/check", "POST", {});
              await refresh();
            }),
          );
          if (state.mode === "live" && a.provider === "x") {
            controls.append(
              button("Connect X", async () => {
                const { url } = await api("accounts/" + urlId(a.id) + "/connect", "POST", {});
                const target = new URL(url);
                if (target.origin !== "https://x.com" || target.pathname !== "/i/oauth2/authorize")
                  throw new Error("Unexpected X authorization address.");
                location.assign(target.href);
              }),
            );
          }
          if (state.mode === "live" && a.provider === "x")
            controls.append(
              button("Disconnect", async () => {
                if (!window.confirm("Disconnect " + a.label + "?")) return;
                await api("accounts/" + urlId(a.id) + "/disconnect", "POST", {});
                await refresh();
              }),
            );
          if (a.health?.length) {
            const health = el("details");
            health.append(el("summary", "Stream updates"));
            for (const stream of a.health) {
              health.append(
                el(
                  "p",
                  stream.stream +
                    " · " +
                    time(stream.last_sync) +
                    (stream.error ? " · " + stream.error : ""),
                  "small",
                ),
              );
            }
            card.append(health);
          }
          card.append(controls);
          container.append(card);
        }
        byId("post").hidden = !state.accounts.some((a) => a.provider === "x");
      }
      async function loadRows(append = false) {
        const revision = ++listRevision;
        const path = state.view === "drafts" ? "drafts" : "inbox";
        const query = new URLSearchParams({ limit: "30" });
        if (state.view === "feed") query.set("stream", "feed");
        if (append && state.cursor) query.set("cursor", state.cursor);
        const result = await api(path + "?" + query);
        if (revision !== listRevision) return;
        state.rows = append ? [...state.rows, ...result.items] : result.items;
        state.cursor = result.nextCursor || null;
        const list = byId("entries");
        list.replaceChildren();
        for (const item of state.rows) {
          const draft = state.view === "drafts",
            a = account(item.accountId);
          const row = button("", () => (draft ? openDraft(item.id) : openItem(item)), "entry");
          row.append(
            el("small", providerName(a) + " · " + a.label + " · " + item.visibility),
            el("strong", draft ? item.kind + " · " + item.state : item.sender),
            el("span", item.text, "preview"),
            el("small", draft ? "Version " + item.version : time(item.at) + " · " + item.triage),
          );
          const li = el("li");
          li.append(row);
          list.append(li);
        }
        if (!state.rows.length)
          list.append(
            el("li", state.view === "drafts" ? "No drafts." : "No messages in this view.", "muted"),
          );
        byId("more").hidden = !state.cursor;
      }
      async function refresh() {
        const { items } = await api("accounts");
        state.accounts = items;
        showAccounts();
        await loadRows();
      }
      async function switchView(view) {
        state.view = view;
        state.cursor = null;
        emptyDetail();
        document
          .querySelectorAll("[data-view]")
          .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
        await loadRows();
      }
      function statusBlock(attempt) {
        const p = el("div", null, "review stack");
        const labels = {
          unknown: "Outcome unknown. Check the provider before taking further action.",
          accepted: "Provider accepted the message.",
          delivered: "Provider confirmed delivery.",
          read: "Provider confirmed the message was read.",
          failed: "The send failed.",
        };
        p.append(
          el("strong", labels[attempt.status] || attempt.status),
          facts([
            ["Attempt", attempt.id],
            ["Provider receipt", attempt.providerId],
          ]),
        );
        return p;
      }
      function reviewBlock(draft) {
        const a = account(draft.accountId),
          node = el("div", null, "review stack");
        node.append(
          facts([
            ["From", a.label + " · " + providerName(a)],
            ["Visibility", draft.visibility],
            ["Destination", draft.recipient || "Public post"],
            ["In reply to", draft.targetId],
            ["Version", draft.version],
            ["Template", draft.template?.name],
            ["Language", draft.template?.language],
            ["Category", draft.category || (a.provider === "whatsapp" ? "Cost unknown" : null)],
          ]),
        );
        if (draft.template?.parameters?.length)
          node.append(facts(draft.template.parameters.map((p, i) => ["Parameter " + (i + 1), p])));
        node.append(message(draft.text));
        return node;
      }
      async function openDraft(id) {
        const revision = ++detailRevision;
        const draft = await api("drafts/" + urlId(id));
        if (revision !== detailRevision) return;
        state.selection = { draft: id };
        const detail = byId("detail");
        detail.replaceChildren(
          el("h2", "Review draft"),
          el("small", draft.state),
          reviewBlock(draft),
        );
        if (draft.attemptId) {
          const attempt = await api("attempts/" + urlId(draft.attemptId));
          if (revision === detailRevision) detail.append(statusBlock(attempt));
          return;
        }
        if (draft.state !== "pending") return;
        detail.append(
          actions(
            button(
              "Review send",
              () => {
                state.review = draft;
                byId("envelope").replaceChildren(reviewBlock(draft));
                byId("confirm").showModal();
                byId("cancel").focus();
              },
              "primary",
            ),
            button("Edit draft", () =>
              compose(account(draft.accountId), draft.itemId, draft.kind, draft),
            ),
            button("Reject draft", async () => {
              await api("drafts/" + urlId(id) + "/reject", "POST", {
                expectedVersion: draft.version,
              });
              await openDraft(id);
              await loadRows();
            }),
          ),
        );
        if (draft.kind === "business" && account(draft.accountId).templates?.length) {
          detail.append(
            button("Draft a template instead", () =>
              compose(account(draft.accountId), draft.itemId, "template"),
            ),
          );
        }
      }
      function compose(a, itemId, kind, draft) {
        ++detailRevision;
        const detail = byId("detail"),
          form = el("form"),
          text = el("textarea");
        text.required = true;
        text.maxLength = ["post", "reply"].includes(kind) ? 280 : 4096;
        text.value = draft?.text || "";
        detail.replaceChildren(
          el("h2", draft ? "Edit draft" : kind === "post" ? "New public post" : "Draft reply"),
          el("p", a.label + " · " + providerName(a), "muted"),
          form,
        );
        let readContent = () => ({ text: text.value });
        if (kind === "template") {
          const templates = a.templates || [];
          const select = el("select"),
            inputs = el("div", null, "stack");
          for (const [index, t] of templates.entries()) {
            const opt = el("option", t.name + " · " + t.language);
            opt.value = String(index);
            select.append(opt);
          }
          if (!templates.length) {
            form.append(el("p", "No eligible templates."));
            return;
          }
          if (draft?.template)
            select.value = String(
              Math.max(
                0,
                templates.findIndex(
                  (t) => t.name === draft.template.name && t.language === draft.template.language,
                ),
              ),
            );
          function parameters() {
            const t = templates[Number(select.value)],
              indexes = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
            const fields = [];
            inputs.replaceChildren(message(t.body), el("small", t.category || "Cost unknown"));
            const count = Math.max(0, ...indexes);
            if (!Number.isSafeInteger(count) || count > 16)
              throw new Error("Unsupported template parameters.");
            for (let i = 0; i < count; i++) {
              const p = el("input");
              p.required = true;
              p.value = draft?.template?.parameters?.[i] || "";
              fields.push(p);
              inputs.append(label("Parameter " + (i + 1), p));
            }
            readContent = () => ({
              template: {
                name: t.name,
                language: t.language,
                parameters: fields.map((p) => p.value),
              },
            });
          }
          select.addEventListener("change", parameters);
          parameters();
          form.append(label("Template", select), inputs);
        } else form.append(label("Message text", text));
        const save = el("button", draft ? "Save changes" : "Save draft", "primary");
        const cancel = button("Cancel", async () => (draft ? openDraft(draft.id) : emptyDetail()));
        form.append(actions(save, cancel));
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (save.disabled) return;
          save.disabled = true;
          try {
            const content = readContent();
            const result = draft
              ? await api("drafts/" + urlId(draft.id), "PATCH", {
                  expectedVersion: draft.version,
                  ...content,
                })
              : await api("drafts", "POST", { accountId: a.id, kind, itemId, ...content });
            await switchView("drafts");
            await openDraft(result.id);
          } catch (error) {
            showError(error);
          } finally {
            save.disabled = false;
          }
        });
      }
      async function openItem(item) {
        const revision = ++detailRevision;
        const { items } = await api(
          "conversations/" + urlId(item.conversationId) + "/items?limit=50",
        );
        if (revision !== detailRevision) return;
        const a = account(item.accountId),
          detail = byId("detail");
        state.selection = { item: item.id };
        detail.replaceChildren(
          el("h2", item.sender),
          el("small", a.label + " · " + providerName(a) + " · " + item.visibility),
        );
        for (const msg of [...items].sort((x, y) => x.at - y.at)) {
          const group = el("article");
          group.append(el("small", msg.sender + " · " + time(msg.at)), message(msg.text));
          for (const attachment of msg.attachments || [])
            group.append(
              el(
                "small",
                "Attachment · " +
                  attachment.type +
                  (attachment.size !== undefined ? " · " + attachment.size + " bytes" : ""),
              ),
            );
          detail.append(group);
        }
        const kind =
          item.stream === "dm" ? "dm" : item.stream === "business" ? "business" : "reply";
        const controls = actions(button("Draft reply", () => compose(a, item.id, kind), "primary"));
        if (a.templates?.length)
          controls.append(button("Use template", () => compose(a, item.id, "template")));
        controls.append(
          button(item.triage === "done" ? "Reopen" : "Mark done", async () => {
            const triage = item.triage === "done" ? "open" : "done";
            await api("items/" + urlId(item.id) + "/triage", "PATCH", { triage });
            await loadRows();
            await openItem({ ...item, triage });
          }),
        );
        detail.append(controls);
      }
      byId("login").addEventListener("submit", async (event) => {
        event.preventDefault();
        const input = byId("code"),
          code = input.value;
        input.value = "";
        byId("error").textContent = "";
        try {
          await enter(await api("session", "POST", { code }));
        } catch (error) {
          showError(error);
        }
      });
      async function enter(session) {
        if (typeof session.csrf !== "string" || !session.csrf)
          throw new Error("Sign in to review this inbox.");
        state.csrf = session.csrf;
        state.mode = session.mode;
        byId("mode").textContent =
          session.mode === "fixture" ? "Fixture mode" : session.mode === "live" ? "Live mode" : "";
        byId("access").hidden = true;
        byId("desk").hidden = false;
        await refresh();
      }
      for (const b of document.querySelectorAll("[data-view]"))
        action(b, () => switchView(b.dataset.view));
      action(byId("refresh"), async () => {
        emptyDetail();
        await refresh();
      });
      action(byId("more"), () => loadRows(true));
      action(byId("post"), () =>
        compose(
          state.accounts.find((a) => a.provider === "x"),
          undefined,
          "post",
        ),
      );
      byId("cancel").addEventListener("click", () => byId("confirm").close());
      action(byId("send"), async () => {
        const draft = state.review;
        if (!draft) return;
        byId("confirm").close();
        state.review = null;
        try {
          await api("drafts/" + urlId(draft.id) + "/approve-and-send", "POST", {
            expectedVersion: draft.version,
            fingerprint: draft.fingerprint,
            idempotencyKey: draft.id + "-" + draft.version,
          });
        } finally {
          if (state.csrf) {
            await openDraft(draft.id);
            await loadRows();
          }
        }
      });
      if (localStorage.getItem("executor.authToken")) {
        api("session")
          .then(enter)
          .catch((error) => {
            if (!byId("access").hidden) return;
            showError(error);
          });
      } else {
        byId("login").hidden = true;
        byId("access-help").textContent =
          "Sign in to the Harnessy cockpit. Then open Social inbox.";
      }
    </script>
  </body>
</html>
`;
