import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

/** Reuse the normal daemon, signed-in Chromium page and disposable profile from the sign-in check. */
export async function checkSocialInbox({ origin, session, until, agentToken, operatorCode }) {
  const { evaluate, page, violations } = session;
  const seenViolations = violations().length;
  const agent = async (path, method = "GET", body) => {
    const response = await fetch(`${origin}/api/social/v1/${path}`, {
      method,
      headers: {authorization: "Bearer " + agentToken, "content-type": "application/json"},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `agent request ${method} ${path} returned HTTP ${response.status}`);
    return response.json();
  };
  const waitFor = (name, expr) => until(name, () => evaluate(expr).catch(() => false));
  const click = async (selector, text) => {
    const expression = text === undefined ?
      `document.querySelector(${JSON.stringify(selector)})` :
      `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => el.textContent.includes(${JSON.stringify(text)}))`;
    await waitFor("click " + (text || selector), `(() => {const el = ${expression}; if (!el || el.disabled || !el.checkVisibility()) return false; el.click(); return true;})()`);
  };
  await page("Emulation.setDeviceMetricsOverride", {width: 1200, height: 850, deviceScaleFactor: 1, mobile: false});
  await click('a[href="/social"]').catch(async error => {
    throw new Error(error.message + ": " + await evaluate("document.body.innerText.slice(0,220)"));
  });
  await waitFor("locked social inbox", 'location.pathname === "/social" && document.getElementById("login")?.checkVisibility()');
  // Credentials here are random for this isolated fixture daemon and never enter user state.
  await evaluate(`document.getElementById("code").value = ${JSON.stringify(operatorCode)}; document.getElementById("login").requestSubmit()`);
  await waitFor("authenticated fixture inbox", 'document.getElementById("mode")?.innerText === "Fixture mode" && document.querySelectorAll("#entries .entry").length === 3');
  await click('[data-view="feed"]');
  await waitFor("feed apart from inbox", 'document.querySelector("#entries")?.textContent.includes("The new workshop schedule is ready.") && document.querySelectorAll("#entries .entry").length === 1');

  // Create a draft as a scoped agent. No human session cookie is copied to this caller.
  const {stdout} = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("./social-cockpit-agent-proof.mjs", import.meta.url)),
    origin,
  ], {env: {HARNESSY_SOCIAL_AGENT_TOKEN: agentToken}});
  const {draft} = JSON.parse(stdout);
  assert.equal(draft.attemptId, null);

  await click('[data-view="drafts"]');
  await click("#entries button", draft.text);
  await click("#detail button", "Edit draft");
  const finalText = "Your place is reserved. <b>This is plain text.</b>";
  await evaluate(`document.querySelector("#detail textarea").value = ${JSON.stringify(finalText)}`);
  await click("#detail button", "Save changes");
  await waitFor("edited draft", `document.querySelector("#detail .message")?.textContent === ${JSON.stringify(finalText)}`);
  await click("#detail button", "Review send");
  await waitFor("confirmation shows exact reviewed text", `document.querySelector("dialog").open && document.querySelector("#envelope .message").textContent === ${JSON.stringify(finalText)} && !document.querySelector("#envelope .message b") && document.querySelector("#envelope").textContent.includes("private")`);
  assert.equal((await agent("drafts/" + draft.id)).attemptId, null);
  await click("#cancel");
  assert.equal((await agent("drafts/" + draft.id)).attemptId, null);
  await click("#detail button", "Review send");
  await evaluate('document.getElementById("send").click();document.getElementById("send").click()');
  await waitFor("provider receipt", 'document.querySelector("#detail")?.textContent.includes("Provider accepted the message.")');
  const approved = await agent("drafts/" + draft.id);
  assert.equal(approved.version, draft.version + 1);
  const attempt = await agent("attempts/" + approved.attemptId);
  assert.equal(attempt.status, "accepted");
  assert.match(attempt.providerId, /^fixture-/);

  await page("Page.reload");
  await waitFor("durable session after reload", 'document.querySelector("#desk")?.checkVisibility() && document.querySelectorAll("#entries .entry").length === 3');
  await click('[data-view="drafts"]');
  await click("#entries button", finalText);
  await waitFor("same receipt after reload", `document.querySelector("#detail")?.textContent.includes(${JSON.stringify(attempt.providerId)}) && !Array.from(document.querySelectorAll("#detail button")).some(b=>b.textContent.includes("Review send"))`);
  // WhatsApp charges depend on category and recipient market. Its rendered text
  // and substitutions must be visible together before approving the template.
  await click('[data-view="inbox"]');
  await click("#entries button", "Please confirm my appointment.");
  await waitFor("incoming attachment metadata", 'document.querySelector("#detail")?.textContent.includes("image/jpeg")');
  await click("#detail button", "Use template");
  await evaluate('document.querySelector("#detail input").value = "Tomorrow at 10:00."');
  await click("#detail button", "Save draft");
  await waitFor("template draft is pending", 'document.querySelector("#detail .message")?.textContent === "Your service update: Tomorrow at 10:00."');
  await click("#detail button", "Review send");
  await waitFor("template review details", '["service_update","en_US","UTILITY","Tomorrow at 10:00.","private"].every(text => document.querySelector("#envelope")?.textContent.includes(text))');
  await click("#send");
  await waitFor("accepted fixture template", 'document.querySelector("#detail")?.textContent.includes("Provider accepted the message.")');

  await click("#post");
  await evaluate('document.querySelector("#detail textarea").value = "The public workshop starts at ten."');
  await click("#detail button", "Save draft");
  await waitFor("public post waiting for approval", 'document.querySelector("#detail .message")?.textContent === "The public workshop starts at ten."');
  await click("#detail button", "Review send");
  await waitFor("public audience and identity", '["public","Workshop on X","The public workshop starts at ten."].every(text => document.querySelector("#envelope")?.textContent.includes(text))');
  await click("#send");
  await waitFor("accepted fixture post", 'document.querySelector("#detail")?.textContent.includes("Provider accepted the message.")');
  assert.deepEqual(violations().slice(seenViolations), []);
  console.log("Social inbox browser check passed. The scoped agent drafted a private reply. The operator edited and approved it. The same fixture receipt survived reload. The operator also approved a WhatsApp template and a public X post.");
}
