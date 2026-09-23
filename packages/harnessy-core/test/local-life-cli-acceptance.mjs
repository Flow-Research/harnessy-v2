import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { fixtureEnvironment } from "../../harnessy-local-host/test/support/fixture-environment.mjs";

// Explicit actual CLI + isolated installed Python; never use the owner's Jarvis.
assert.equal(process.platform, "darwin", "This acceptance uses macOS sandbox-exec for Python isolation");
assert(process.argv[2] && process.argv[3], "Supply Core CLI and isolated installed Python paths");
const cli = realpathSync(resolve(process.argv[2]));
// Preserve the venv interpreter path: resolving its symlink loses site-packages.
const python = resolve(process.argv[3]);
assert(existsSync(python));
const root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-local-life-cli-")));
const bin = join(root, "bin");
mkdirSync(bin, { mode: 0o700 });
const context = join(root, ".jarvis/context/private/fixture");
mkdirSync(context, { recursive: true, mode: 0o700 });
writeFileSync(join(context, "priorities.md"), "# Priorities\nSynthetic planning canary\n");
const sandbox = join(root, "python.sb");
writeFileSync(sandbox, `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const name of ["python3", "jarvis"]) {
	writeFileSync(join(bin, name), `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(sandbox)} ${quote(python)} -B ${name === "jarvis" ? "-m jarvis " : ""}"$@"\n`, { mode: 0o700 });
}
const expires = Date.now() + 600000;
const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000), "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.synthetic`;
const authPath = join(root, "auth.json");
writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: token, expires, accountId: "fixture-account" } }), { mode: 0o600 });
const authBefore = readFileSync(authPath);
let requests = 0;
let refreshRequests = 0;
let requestBody;
let rejectCredential = false;
const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const bytes = Buffer.concat(chunks);
	if (request.url === "/token") {
		refreshRequests++;
		const params = new URLSearchParams(bytes.toString());
		assert.equal(params.get("grant_type"), "refresh_token");
		assert.equal(params.get("refresh_token"), "synthetic-refresh");
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ access_token: token, refresh_token: "synthetic-rotated", expires_in: 3600 }));
		return;
	}
	requestBody = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
	requests++;
	assert.equal(request.headers.authorization, `Bearer ${token}`);
	if (rejectCredential) { response.writeHead(401).end("PRIVATE_PROVIDER_ERROR_SENTINEL"); return; }
	const item = { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: "# Weekly plan\n\nA revolutionary fixture.\n", annotations: [] }] };
	const sse = value => `data: ${JSON.stringify(value)}\n\n`;
	response.setHeader("Content-Type", "text/event-stream");
	response.end(sse({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }) + sse({ type: "response.output_item.done", output_index: 0, item }) + sse({ type: "response.completed", response: { id: "resp_local_cli", status: "completed" } }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const seam = join(root, "loopback.mjs");
const guard = fileURLToPath(new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url));
writeFileSync(seam, `import ${JSON.stringify(guard)};\nconst guarded = globalThis.fetch;\nglobalThis.fetch = (input, init) => { const url = new URL(input instanceof Request ? input.url : input); const refresh = url.href === 'https://auth.openai.com/oauth/token'; if (!refresh && (url.origin !== 'https://chatgpt.com' || !url.pathname.endsWith('/codex/responses'))) throw new Error('Unexpected provider destination'); if (init.redirect !== 'error') throw new Error('Missing redirect protection'); if (refresh && !init.signal) throw new Error('Missing refresh deadline'); return guarded('http://127.0.0.1:${address.port}/' + (refresh ? 'token' : 'responses'), init); };\n`);
const run = (args, kind = "weekly") => new Promise((resolve, reject) => {
	const child = spawn(process.execPath, ["--experimental-strip-types", "--import", seam, cli, "jarvis", "life", "draft", "--kind", kind, "--target", root, "--home-root", root, "--timeout-seconds", "30", "--json", ...args], {
		cwd: root, env: { ...fixtureEnvironment(), PATH: `${bin}:/usr/bin:/bin`, USER: "fixture", FLOW_USER: "fixture", HSY_CODING_AGENT_DIR: root },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "", stderr = "";
	const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
	child.stdout.on("data", chunk => { stdout += chunk; });
	child.stderr.on("data", chunk => { stderr += chunk; });
	child.once("error", error => { clearTimeout(timer); reject(error); });
	child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
});
try {
	const generated = await run([]);
	assert.equal(generated.code, 0, JSON.stringify(generated));
	const result = JSON.parse(generated.stdout);
	assert.equal(result.published, false);
	assert.equal(requests, 1);
	assert.equal(requestBody.model, "gpt-5.5");
	assert.deepEqual(requestBody.tools, []);
	assert.equal(requestBody.tool_choice, "none");
	assert(JSON.stringify(requestBody).includes("Synthetic planning canary"));
	const markdown = readFileSync(result.briefPath, "utf8");
	assert(markdown.includes("A fixture.") && !markdown.includes("revolutionary"));
	const review = JSON.parse(readFileSync(`${result.briefPath}.review.json`, "utf8"));
	assert.equal(review.status, "needs_review");
	assert.equal(review.markdown, markdown);
	assert.equal(review.artifactHash, createHash("sha256").update(markdown).digest("hex"));
	assert.equal(review.receipt.providerReceiptId, "resp_local_cli");
	const reviewRoot = dirname(dirname(result.briefPath));
	const promptDirectory = readdirSync(reviewRoot).find(name => name.startsWith("weekly-prompt-"));
	assert(promptDirectory);
	const replay = await run(["--native-request", join(reviewRoot, promptDirectory, "request.json")]);
	assert.notEqual(replay.code, 0);
	assert.equal(requests, 1, "Replay must not call the provider");
	const dailyRun = await run([], "daily");
	assert.equal(dailyRun.code, 0, JSON.stringify(dailyRun));
	const daily = JSON.parse(dailyRun.stdout);
	assert.equal(daily.published, false);
	assert.equal(requests, 2);
	const dailyReview = JSON.parse(readFileSync(`${daily.briefPath}.review.json`, "utf8"));
	assert.equal(dailyReview.status, "needs_review");
	assert.equal(dailyReview.receipt.kind, "daily");
	assert.equal(dailyReview.artifactHash, createHash("sha256").update(readFileSync(daily.briefPath)).digest("hex"));
	const beforeFailure = new Set(readdirSync(reviewRoot));
	rejectCredential = true;
	const rejected = await run([]);
	assert.notEqual(rejected.code, 0);
	assert.equal(requests, 3, "Credential rejection must not trigger generation retries");
	assert(!`${rejected.stdout}${rejected.stderr}`.includes("PRIVATE_PROVIDER_ERROR_SENTINEL"));
	assert(!`${rejected.stdout}${rejected.stderr}`.includes(token));
	const failedPrompt = readdirSync(reviewRoot).find(name => name.startsWith("weekly-prompt-") && !beforeFailure.has(name));
	assert(failedPrompt);
	const failedReplay = await run(["--native-request", join(reviewRoot, failedPrompt, "request.json")]);
	assert.notEqual(failedReplay.code, 0);
	assert.equal(requests, 3);
	assert.deepEqual(readFileSync(authPath), authBefore);
	const expired = JSON.parse(authBefore.toString());
	expired["openai-codex"].expires = 0;
	writeFileSync(authPath, JSON.stringify(expired), { mode: 0o600 });
	const expiredBefore = readFileSync(authPath);
	const expiredRun = await run([]);
	assert.notEqual(expiredRun.code, 0);
	assert.equal(requests, 3, "Expired access-only credentials cannot reach generation");
	assert.deepEqual(readFileSync(authPath), expiredBefore);
	assert.equal(refreshRequests, 0);
	expired["openai-codex"].refresh = "synthetic-refresh";
	writeFileSync(authPath, JSON.stringify(expired), { mode: 0o600 });
	rejectCredential = false;
	const renewedRun = await run([]);
	assert.equal(renewedRun.code, 0, JSON.stringify(renewedRun));
	assert.equal(requests, 4);
	assert.equal(refreshRequests, 1);
	const renewedCredential = JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"];
	assert.equal(renewedCredential.accountId, "fixture-account");
	assert.equal(renewedCredential.refresh, "synthetic-rotated");
	assert.equal(JSON.parse(renewedRun.stdout).published, false);
	assert(!existsSync(join(root, ".agents/life/crawl-state.json")));
	console.log(JSON.stringify({ passed: true, root, cli, requests, refreshRequests, weeklyArtifact: result.briefPath, dailyArtifact: daily.briefPath, replayRejected: true, credentialRejectionNoRetry: true, expiredCredentialNoCall: true, sameAccountRefresh: true, publication: false }));
} finally {
	await new Promise(resolve => server.close(resolve));
}
