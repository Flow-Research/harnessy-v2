import assert from "node:assert/strict";
import register from "../packages/harnessy-executor/social-cockpit/agent.ts";

// Run in a child with only the fixture agent grant. Exercise the same callbacks
// registered by the Harnessy extension, through the real local host.
process.env.HARNESSY_SOCIAL_ORIGIN = process.argv[2];
const tools = new Map();
register({registerTool(tool) { tools.set(tool.name,tool); }});
assert.deepEqual([...tools.keys()].sort(), ["social_accounts","social_check","social_draft","social_inbox","social_revise","social_summary","social_thread","social_triage"]);
const run = async (name, params = {}) => {
 const result = await tools.get(name).execute("fixture-tool-call",params);
 assert.equal(result.isError,false,name);
 return JSON.parse(result.content[0].text);
};
const accounts = await run("social_accounts");
assert.deepEqual(accounts.items.map(a=>a.id),["x-fixture"]);
await run("social_check",{accountId:"x-fixture"});
const denied = await tools.get("social_check").execute("denied",{accountId:"wa-fixture"});
assert.equal(denied.isError,true);
const {items} = await run("social_inbox");
assert.ok(items.every(i=>i.accountId === "x-fixture"));
const target = items.find(i=>i.stream==="dm");
assert.ok(target);
const thread = await run("social_thread",{conversationId:target.conversationId});
assert.ok(thread.items.some(i=>i.id === target.id));
const summary = await run("social_summary",{itemIds:[target.id]});
assert.deepEqual(summary.sourceIds,[target.id]);
await run("social_triage",{itemId:target.id,triage:"priority"});
const first = await run("social_draft",{accountId:target.accountId,itemId:target.id,kind:"dm",text:"Working draft"});
const draft = await run("social_revise",{draftId:first.id,expectedVersion:first.version,text:"Initial private reply"});
assert.equal(draft.attemptId,null);
process.stdout.write(JSON.stringify({draft,target}));
