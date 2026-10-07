import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Optional viewer gate: install OpenWiki separately with npm --ignore-scripts.
const installed = resolve(process.argv[2] ?? "");
assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version, "0.5.1");
const root = mkdtempSync(join(realpathSync(tmpdir()), "wiki-viewer-fixture-"));
const probe = createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const wiki = join(root, "wiki"); mkdirSync(wiki);
const source = join(root, "source.md"); writeFileSync(source, "The measured cache throughput increased in the controlled experiment.");
const model = join(root, "model.cjs");
writeFileSync(model, `let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const r=JSON.parse(s),e=r.evidence[0],c={versionId:e.version.id,locator:e.version.passages[0].locator,quote:e.version.passages[0].text};process.stdout.write(JSON.stringify({pages:[{path:"topics/cache.md",title:"Cache",topics:["Cache"],claims:[{kind:"finding",text:"The experiment reports greater cache throughput.",citations:[c]}],links:[]},{path:"questions.md",title:"Questions",topics:[],claims:[{kind:"question",text:"Does the result generalize?",citations:[]}],links:["topics/cache.md"]}]}));});`);
const host = createRequire(import.meta.url).resolve("@harnessy/local-host/wiki-cli");
const invoke = args => new Promise((resolve, reject) => {
	const child = spawn(process.execPath, [host, ...args, "--vault", join(root, "vault"), "--home-root", root], { env: { ...process.env, HARNESSY_WIKI_EXECUTOR: process.execPath, HARNESSY_WIKI_EXECUTOR_ARGS: JSON.stringify([model]), HARNESSY_AI_PROVIDER: "codex" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", errors = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => errors += c);
	child.on("error", reject); child.on("close", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
});
let child;
try {
	await invoke(["ingest", source, "--topic", "Cache"]);
	const result = await invoke(["sync"]); assert.deepEqual(result.result.failures, []);
	const verify = join(root, "verify.mjs");
	writeFileSync(verify, `import assert from "node:assert/strict";import {readFile} from "node:fs/promises";import {join} from "node:path";
import {buildGraph} from ${JSON.stringify(pathToFileURL(join(installed, "dist/visualize/graph.js")).href)};
import {validateOkfFrontmatter} from ${JSON.stringify(pathToFileURL(join(installed, "dist/okf/frontmatter.js")).href)};
const root=${JSON.stringify(join(root, "vault/wiki"))};const graph=await buildGraph(root);
assert(graph.edges.length>=3);assert(graph.nodes.some(n=>n.id==="topics/cache"));
for(const n of graph.nodes){const text=await readFile(join(root,n.id+".md"),"utf8");assert.deepEqual(validateOkfFrontmatter(text),{valid:true});}
console.log(JSON.stringify({nodes:graph.nodes.length,edges:graph.edges.length,okf:"0.2"}));`);
	await new Promise((resolve, reject) => { const verifier = spawn(process.execPath, [verify], { stdio: "inherit" }); verifier.on("error", reject); verifier.on("close", code => code === 0 ? resolve() : reject(new Error("Viewer graph validation failed"))); });
	child = spawn(process.execPath, [join(installed, "dist/cli/cli.js"), "visualize", join(root, "vault/wiki"), "--no-open", "--port", String(port)], { env: { ...process.env, OPENWIKI_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
	let graph;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (child.exitCode !== null) throw new Error(output);
		try { const response = await fetch(`http://127.0.0.1:${port}/api/graph`); if (response.ok) { graph = await response.json(); break; } } catch { /* Poll only the loopback fixture. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert(graph?.nodes.some(node => node.id === "topics/cache"), output);
	const page = await fetch(`http://127.0.0.1:${port}/`); assert.equal(page.status, 200); assert((await page.text()).includes("client.js"));
	console.log("OpenWiki 0.5.1 public visualize command, graph, OKF frontmatter and reader assets passed.");
} finally { if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once("close", resolve)); const timer = setTimeout(() => child.kill("SIGKILL"), 5000); child.kill("SIGINT"); await closed; clearTimeout(timer); } rmSync(root, { recursive: true, force: true }); }
