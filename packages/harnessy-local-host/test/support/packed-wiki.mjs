import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const consumer = process.argv[2];
const root = mkdtempSync(join(consumer, "wiki-fixture-"));
const host = join(consumer, "node_modules/@harnessy/local-host");
const cli = join(host, "dist/wiki-cli.js");
const model = join(root, "model.cjs");
writeFileSync(model, `let input="";
process.stdin.on("data", chunk => input+=chunk);
process.stdin.on("end", () => {
 const r=JSON.parse(input);
 const citations=r.evidence.map(e=>({versionId:e.version.id,locator:e.version.passages[0].locator,quote:e.version.passages[0].text}));
 const base={path:"concepts/cache.md",title:"Cache evidence",topics:["Cache"],links:[],claims:[{kind:citations.length>1?"disagreement":"finding",text:"Measurements differ across cache workloads.",citations}]};
 const pages=r.task==="compile"?[base,{...base,path:"topics/cache.md"},{...base,path:"questions.md"}]:[{...base,path:r.task==="review"?r.instruction.match(/reviews\\/\\d{4}-W\\d{2}\\.md/)[0]:"questions.md"}];
 process.stdout.write(JSON.stringify({pages}));
});
`, { mode: 0o600 });
const env = { ...process.env, HARNESSY_WIKI_EXECUTOR: process.execPath, HARNESSY_WIKI_EXECUTOR_ARGS: JSON.stringify([model]), HARNESSY_AI_PROVIDER: "codex", NODE_NO_WARNINGS: "1" };
function run(args, status = 0) {
	const result = spawnSync(process.execPath, [cli, ...args, "--home-root", root], { cwd: consumer, env, encoding: "utf8", timeout: 20_000, maxBuffer: 2_000_000 });
	assert.equal(result.status, status, result.stderr);
	return status === 0 ? JSON.parse(result.stdout).result : result;
}
const a = join(root, "a.md"), b = join(root, "b.txt");
writeFileSync(a, "The large cache improves throughput for repeated requests.");
writeFileSync(b, "The large cache increases latency for memory-constrained workloads.");
for (const source of [a, b]) run(["ingest", source, "--topic", "Cache", "--note", "Personal fixture note"]);
const first = run(["sync"]); assert.deepEqual(first.failures, []); assert.equal(first.processed, 2);
const second = run(["sync"]); assert.equal(second.generated, 0); assert.equal(second.fetched, 0);
assert.equal(run(["search", "cache"]).sources.length, 2);
assert.equal(run(["ask", "cache tradeoffs"]).claims[0].citations.length, 2);
assert.equal(run(["ask", "unfindablequux"]).evidenceGap, true);
const context = run(["ask", "cache", "--context"]); assert.equal(context.task, "ask");
const week = "2026-W37";
const review = run(["review", "--week", week, "--life-companion"]); assert(existsSync(review.path)); assert(existsSync(review.companion));
assert.equal(run(["review", "--week", week]).changed, false);
const vault = join(root, ".harnessy/jarvis/wiki/learning");
assert.equal(readdirSync(join(vault, "notes")).length, 2);

// Exercise the Core-to-host package resolution boundary without importing monorepo source.
const route = join(root, "route.mjs");
writeFileSync(route, `import {runWikiHost} from ${JSON.stringify(pathToFileURL(join(consumer, "node_modules/@harnessy/core/dist/cli/wiki.js")).href)};
const output=await runWikiHost(["status","--home-root",${JSON.stringify(root)}]);
if(JSON.parse(output).result.captured!==2) throw new Error("Packed route failed");
`);
const routed = spawnSync(process.execPath, [route], { cwd: consumer, env, encoding: "utf8", timeout: 10_000 }); assert.equal(routed.status, 0, routed.stderr);

// A real process dies after replacing a page but before committing SQLite.
const crash = join(root, "crash.mjs");
writeFileSync(crash, `import {WikiStore} from ${JSON.stringify(pathToFileURL(join(host, "dist/wiki/store.js")).href)};
const s=new WikiStore(${JSON.stringify(vault)});
await s.write(async()=>{s.applyPage("questions.md","Uncommitted replacement",s.pageHash("questions.md"));process.exit(9);});
`);
const before = readFileSync(join(vault, "wiki/questions.md"), "utf8");
assert.equal(spawnSync(process.execPath, [crash], { cwd: consumer, env }).status, 9);
run(["sync", "--capture-only"]);
assert.equal(readFileSync(join(vault, "wiki/questions.md"), "utf8"), before);

// A publication marker is durable even when a subsequent model attempt fails.
const life = join(root, ".agents/life/2026/Sep"); mkdirSync(life, { recursive: true });
const brief = join(life, "13-daily-brief.md"); writeFileSync(brief, "## Worth Reading\n- [Delivered](https://example.com/delivered)\n"); writeFileSync(`${brief}.journaled`, "done");
run(["sync", "--capture-only"]); run(["sync", "--capture-only"]);
assert.equal(run(["status"]).captured, 3);
assert.equal(readFileSync(`${brief}.journaled`, "utf8"), "done");
console.log(JSON.stringify({ packagedWiki: true, sources: 3, citedAnswer: true, crashRecovery: true, currentSessionContext: true }));
