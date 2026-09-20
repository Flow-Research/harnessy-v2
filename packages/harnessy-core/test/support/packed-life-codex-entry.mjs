import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { canonicalLifeBriefPath, createCodexLifeDraftProvider, generateLifeDraft, LifeDraftGrantHost, lifeDraftGrantPayload, LifeReadingLedger, resolveLifeOrchestratorSettings, runLifeDaily, runLifeWeekly } from "@harnessy/core/life-orchestrator";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandRunner } from "./node_modules/@harnessy/core/dist/runtime/command-runner.js";

const consumer = realpathSync(process.argv[2]);
const modulePaths = ["@harnessy/core/life-orchestrator", "@earendil-works/pi-ai/providers/openai-codex", "@earendil-works/pi-ai/api/openai-codex-responses"].map((name) => {
	const path = fileURLToPath(import.meta.resolve(name));
	assert(path.startsWith(`${consumer}/node_modules/`));
	assert.equal(realpathSync(path), path);
	assert(path.endsWith(".js") && !path.includes("/src/"));
	return { name, path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
});
await assert.rejects(fetch("https://fixture-egress.invalid/"), /Fixture external network access denied/);
const guardedFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (url, init) => {
	// Assert actual installed pi fetch policy before the inherited network
	// guard can enforce manual redirects and mask a missing production option.
	assert.equal(init?.redirect, "error");
	fetchCalls++;
	return guardedFetch(url, init);
};
const root = join(consumer, "synthetic-inputs");
mkdirSync(root, { mode: 0o700 });
const state = join(root, "state");
const expires = Date.now() + 600_000;
const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1_000), "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.synthetic`;
const credentials = { "openai-codex": { type: "oauth", access: token, refresh: "synthetic-unused", expires, accountId: "fixture-account" } };
const authPath = join(root, "auth.json");
writeFileSync(authPath, JSON.stringify(credentials), { mode: 0o600 });
const authBefore = readFileSync(authPath);
const authStat = statSync(authPath);
const keys = generateKeyPairSync("ed25519");
const host = new LifeDraftGrantHost(state, new Map([["fixture", keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]));
let mode = "success";
let received = 0;
let redirected = 0;
let body;
const sse = (value) => `data: ${JSON.stringify(value)}\n\n`;
const server = createServer(async (request, response) => {
	if (request.url === "/redirect-target") { redirected++; response.end("unexpected"); return; }
	const chunks = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const compressed = Buffer.concat(chunks);
	body = JSON.parse((request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(compressed) : compressed).toString("utf8"));
	received++;
	assert.equal(request.headers.authorization, `Bearer ${token}`);
	assert.equal(request.headers["chatgpt-account-id"], "fixture-account");
	if (mode === "redirect") { response.writeHead(307, { Location: "/redirect-target" }); response.end(); return; }
	response.setHeader("Content-Type", "text/event-stream");
	if (mode === "tool") {
		response.end(sse({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "apply_patch", arguments: "{}" } }) + sse({ type: "response.completed", response: { id: "resp_tool", status: "completed" } }));
		return;
	}
	const item = { type: "message", id: "msg_fixture", role: "assistant", content: [{ type: "output_text", text: mode === "weekly" ? "# Installed weekly\n\nA revolutionary fixture.\n" : mode === "daily" ? "# Installed daily\n\nA revolutionary fixture.\n\n## Worth Reading\n\n- [Invented](https://invalid.test/invented)\n" : "# Installed review draft", annotations: [] }] };
	response.end(sse({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }) + sse({ type: "response.output_item.done", output_index: 0, item }) + sse({ type: "response.completed", response: { id: "resp_installed", status: "completed" } }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const actual = openaiCodexProvider();
// Sole test injection: endpoint on the installed provider's exact catalog.
// stream(), serializers, transport and Life authorization run installed bytes.
const provider = { ...actual, getModels: () => actual.getModels().map((model) => ({ ...model, baseUrl: `http://127.0.0.1:${address.port}` })) };
const adapter = createCodexLifeDraftProvider({ authPath, timeoutMs: 2_000, maximumOutputBytes: 4096 }, provider);
const request = { runId: "installed-life", kind: "daily", provider: "codex", model: "gpt-5.5", prompt: "Synthetic review-only context." };
let success;
try {
	for (const scenario of ["success", "tool", "redirect"]) {
		mode = scenario;
		const authority = { grantId: `fixture-${scenario}`, operation: "life.draft", ...request, promptHash: createHash("sha256").update(request.prompt).digest("hex"), expiresAt: new Date(expires).toISOString(), maximumOutputBytes: 4096 };
		delete authority.prompt;
		const signed = { issuer: "fixture", authority, signature: sign(null, Buffer.from(lifeDraftGrantPayload("fixture", authority)), keys.privateKey).toString("base64") };
		const generate = () => generateLifeDraft(request, authority, { ...host.bind(signed), provider: adapter, signal: new AbortController().signal });
		if (scenario === "success") {
			success = await generate();
			assert.equal(success.markdown, "# Installed review draft");
			assert.equal(success.receipt.providerReceiptId, "resp_installed");
			assert.equal(success.receipt.status, "needs_review");
			assert.equal(success.receipt.model, request.model);
			assert.equal(success.receipt.draftHash, createHash("sha256").update(success.markdown).digest("hex"));
		} else await assert.rejects(generate(), scenario === "tool" ? /forbidden tool call/ : /generation failed/);
		assert.equal(body.model, request.model);
		assert.deepEqual(body.tools, []);
		assert.equal(body.tool_choice, "none");
		assert.equal(body.parallel_tool_calls, false);
		assert.equal(body.input[0].content[0].text, request.prompt);
		assert.equal(body.store, false);
		const previous = received;
		await assert.rejects(generate(), /consumed or revoked/);
		assert.equal(received, previous);
	}
	assert.equal(received, 3);
	assert.equal(fetchCalls, 3);
	assert.equal(redirected, 0);
	assert.deepEqual(readFileSync(authPath), authBefore);
	const after = statSync(authPath);
	assert.deepEqual([after.ino, after.mode, after.mtimeMs, after.size], [authStat.ino, authStat.mode, authStat.mtimeMs, authStat.size]);
	// Default exported composition (no provider injection) must reject expired
	// saved auth before attempting production traffic or refresh.
	const expiredPath = join(root, "expired.json");
	writeFileSync(expiredPath, JSON.stringify({ "openai-codex": { ...credentials["openai-codex"], expires: 0 } }), { mode: 0o600 });
	const expiredBefore = readFileSync(expiredPath);
	await assert.rejects(createCodexLifeDraftProvider({ authPath: expiredPath, timeoutMs: 2_000, maximumOutputBytes: 4096 }).generate(request, new AbortController().signal), /no refresh or fallback/);
	assert.deepEqual(readFileSync(expiredPath), expiredBefore);
	assert.equal(fetchCalls, 3);
	assert.deepEqual(readdirSync(root).sort(), ["auth.json", "expired.json", "state"]);
	// Real installed daily service + live process runner. Only the AI endpoint
	// is injected; Python runs the extracted package CLI under OS isolation.
	const dailyRoot = join(root, "daily");
	const bin = join(dailyRoot, "bin");
	mkdirSync(bin, { recursive: true, mode: 0o700 });
	const pythonSource = join(realpathSync(process.argv[3]), "resources/jarvis-cli/src");
	const python = process.argv[4];
	assert(existsSync(python));
	const hygieneModule = join(pythonSource, "jarvis/text_hygiene.py");
	const hygieneHash = createHash("sha256").update(readFileSync(hygieneModule)).digest("hex");
	const profile = join(dailyRoot, "python.sb");
	writeFileSync(profile, `(version 1) (allow default) (deny network*) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(dailyRoot)}) (literal "/dev/null"))`, { mode: 0o600 });
	const pythonEntry = join(dailyRoot, "hygiene-entry.py");
	writeFileSync(pythonEntry, `import hashlib, importlib.util, json, pathlib, runpy, socket, sys\n\nsys.path.insert(0, ${JSON.stringify(pythonSource)})\ntry:\n    socket.socket().connect(("127.0.0.1", ${address.port}))\nexcept PermissionError:\n    pass\nelse:\n    raise AssertionError("Python network sandbox inactive")\nmodule = pathlib.Path(importlib.util.find_spec("jarvis.text_hygiene").origin).resolve()\nassert str(module) == ${JSON.stringify(hygieneModule)}\nassert hashlib.sha256(module.read_bytes()).hexdigest() == ${JSON.stringify(hygieneHash)}\npathlib.Path(${JSON.stringify(join(dailyRoot, "python-evidence.json"))}).write_text(json.dumps({"module": str(module), "sha256": hashlib.sha256(module.read_bytes()).hexdigest(), "argv": sys.argv[1:], "networkDenied": True, "executable": sys.executable}))\nrunpy.run_module("jarvis", run_name="__main__")\n`, { mode: 0o600 });
	const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(join(bin, "jarvis"), `#!/bin/sh\nexec /usr/bin/sandbox-exec -f ${quote(profile)} ${quote(python)} -I -B ${quote(pythonEntry)} "$@"\n`, { mode: 0o700 });
	process.env.PATH = `${bin}:/usr/bin:/bin`;
	process.env.HOME = dailyRoot;
	const now = new Date();
	const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
	const settings = resolveLifeOrchestratorSettings({ projectRoot: dailyRoot, homeRoot: dailyRoot, user: "fixture", compatibilityRoot: join(dailyRoot, "unused") });
	const dailyRequest = { ...request, runId: `daily:${date}:installed` };
	const authority = { grantId: "fixture-daily", operation: "life.draft", runId: dailyRequest.runId, kind: dailyRequest.kind, provider: dailyRequest.provider, model: dailyRequest.model, promptHash: createHash("sha256").update(dailyRequest.prompt).digest("hex"), expiresAt: new Date(expires).toISOString(), maximumOutputBytes: 4096 };
	const signed = { issuer: "fixture", authority, signature: sign(null, Buffer.from(lifeDraftGrantPayload("fixture", authority)), keys.privateKey).toString("base64") };
	const nativePreview = { requestPath: join(dailyRoot, "request.json"), grantPath: join(dailyRoot, "grant.json"), trustedPublicKeyPath: join(dailyRoot, "trust.pem") };
	writeFileSync(nativePreview.requestPath, JSON.stringify(dailyRequest), { mode: 0o600 });
	writeFileSync(nativePreview.grantPath, JSON.stringify(signed), { mode: 0o600 });
	writeFileSync(nativePreview.trustedPublicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
	const ledger = await Effect.runPromise(LifeReadingLedger.open(settings.paths.databasePath));
	await Effect.runPromise(ledger.upsertCandidates([{ url: "https://example.test/unseen", title: "Unseen", topic: "Systems", publishedAt: null, sourceName: "fixture", sourceKind: "rss", sourceId: null }], now.toISOString()));
	ledger.close();
	mode = "daily";
	const dailyEffect = runLifeDaily(settings, { now, publish: false, nativePreview, draftProvider: adapter }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));
	const daily = await Effect.runPromise(dailyEffect);
	assert.equal(body.model, dailyRequest.model);
	assert.deepEqual(body.tools, []);
	assert.equal(body.tool_choice, "none");
	assert.equal(body.parallel_tool_calls, false);
	assert.equal(body.input[0].content[0].text, dailyRequest.prompt);
	assert.equal(daily.published, false);
	assert.equal(daily.selected, 1);
	const markdown = readFileSync(daily.briefPath, "utf8");
	assert(markdown.includes("A fixture."));
	assert(!markdown.includes("revolutionary") && !markdown.includes("invalid.test"));
	assert(markdown.includes("https://example.test/unseen"));
	const review = JSON.parse(readFileSync(`${daily.briefPath}.review.json`, "utf8"));
	assert.equal(review.status, "needs_review");
	assert.equal(review.markdown, markdown);
	assert.equal(review.artifactHash, createHash("sha256").update(markdown).digest("hex"));
	assert.notEqual(review.artifactHash, review.receipt.draftHash);
	assert.equal(review.receipt.providerReceiptId, "resp_installed");
	const rawReview = JSON.parse(readFileSync(`${daily.briefPath}.generated.md.json`, "utf8"));
	assert(rawReview.markdown.includes("revolutionary") && rawReview.markdown.includes("invalid.test"));
	assert.equal(rawReview.artifactHash, review.receipt.draftHash);
	assert.equal(rawReview.artifactHash, createHash("sha256").update(rawReview.markdown).digest("hex"));
	assert(!existsSync(canonicalLifeBriefPath(settings.paths.lifeDirectory, now)));
	assert(!existsSync(`${canonicalLifeBriefPath(settings.paths.lifeDirectory, now)}.journaled`));
	const reopened = await Effect.runPromise(LifeReadingLedger.open(settings.paths.databasePath));
	const counts = await Effect.runPromise(reopened.counts());
	assert.equal(counts.available, 1);
	assert.equal(counts.reserved, 0);
	assert.equal(counts.delivered, 0);
	reopened.close();
	await assert.rejects(Effect.runPromise(dailyEffect), /consumed grant/);
	assert.equal(received, 4);
	assert.equal(fetchCalls, 4);
	assert.deepEqual(readFileSync(authPath), authBefore);
	const finalAuthStat = statSync(authPath);
	assert.deepEqual([finalAuthStat.ino, finalAuthStat.mode, finalAuthStat.mtimeMs, finalAuthStat.size], [authStat.ino, authStat.mode, authStat.mtimeMs, authStat.size]);
	const hygiene = JSON.parse(readFileSync(join(dailyRoot, "python-evidence.json"), "utf8"));
	assert.deepEqual(hygiene.argv, ["text-hygiene", "clean", `${daily.briefPath}.generated.md`, "--report"]);
	assert.equal(createHash("sha256").update(readFileSync(hygieneModule)).digest("hex"), hygieneHash);
	// Weekly uses the same installed provider, real Python hygiene, and signed
	// authority. Fixed planning time is independent of the real grant expiry.
	mode = "weekly";
	const weeklyRequest = { ...request, kind: "weekly", runId: "weekly:2031-W01:installed" };
	const weeklyAuthority = { ...authority, grantId: "fixture-weekly", kind: "weekly", runId: weeklyRequest.runId };
	const weeklySigned = { issuer: "fixture", authority: weeklyAuthority, signature: sign(null, Buffer.from(lifeDraftGrantPayload("fixture", weeklyAuthority)), keys.privateKey).toString("base64") };
	const weeklyInputs = { ...nativePreview, requestPath: join(dailyRoot, "weekly-request.json"), grantPath: join(dailyRoot, "weekly-grant.json") };
	writeFileSync(weeklyInputs.requestPath, JSON.stringify(weeklyRequest), { mode: 0o600 });
	writeFileSync(weeklyInputs.grantPath, JSON.stringify(weeklySigned), { mode: 0o600 });
	const weeklyEffect = runLifeWeekly(settings, { now: new Date("2030-12-29T12:00:00Z"), publish: false, nativePreview: weeklyInputs, draftProvider: adapter }).pipe(Effect.provide(CommandRunner.layer), Effect.provide(NodeServices.layer));
	const weekly = await Effect.runPromise(weeklyEffect);
	assert(weekly && weekly.published === false);
	assert.equal(body.input[0].content[0].text, weeklyRequest.prompt);
	assert.deepEqual(body.tools, []);
	const weeklyRaw = JSON.parse(readFileSync(`${weekly.briefPath}.generated.md.json`, "utf8"));
	const weeklyReview = JSON.parse(readFileSync(`${weekly.briefPath}.review.json`, "utf8"));
	assert.equal(weeklyReview.markdown, readFileSync(weekly.briefPath, "utf8"));
	assert.equal(weeklyReview.artifactHash, createHash("sha256").update(weeklyReview.markdown).digest("hex"));
	assert.equal(weeklyRaw.artifactHash, createHash("sha256").update(weeklyRaw.markdown).digest("hex"));
	assert.deepEqual(weeklyReview.receipt, weeklyRaw.receipt);
	assert.equal(weeklyReview.status, "needs_review");
	assert.equal(weeklyReview.receipt.draftHash, weeklyRaw.artifactHash);
	assert(weeklyRaw.markdown.includes("revolutionary"));
	assert(weeklyReview.markdown.includes("A fixture.") && !weeklyReview.markdown.includes("revolutionary"));
	assert.notEqual(weeklyReview.artifactHash, weeklyRaw.artifactHash);
	for (const field of ["runId", "grantId", "model", "promptHash"])
		assert.equal(weeklyReview.receipt[field], weeklyAuthority[field]);
	assert.equal(weeklyReview.receipt.kind, "weekly");
	assert.equal(weeklyReview.receipt.providerReceiptId, "resp_installed");
	const weeklyHygiene = JSON.parse(readFileSync(join(dailyRoot, "python-evidence.json"), "utf8"));
	assert.deepEqual(weeklyHygiene.argv, ["text-hygiene", "clean", `${weekly.briefPath}.generated.md`, "--report"]);
	await assert.rejects(Effect.runPromise(weeklyEffect), /Weekly run reserved/);
	assert.equal(received, 5);
	assert.equal(fetchCalls, 5);
	assert.deepEqual(readFileSync(authPath), authBefore);
	assert(!existsSync(join(settings.paths.lifeDirectory, "2030")));
	assert(!existsSync(join(settings.paths.lifeDirectory, "2031")));
	console.log(JSON.stringify({ installed: true, modulePaths, providerRequests: received, redirects: redirected, replayRejected: true, toolCallRejected: true, credentialsUnchanged: true, defaultExpiredAuthRejected: true, receiptStatus: success.receipt.status, providerReceiptId: success.receipt.providerReceiptId, model: request.model, daily: { ...daily, hygiene, counts, artifactHash: review.artifactHash, reviewStatus: review.status }, weekly: { ...weekly, hygiene: weeklyHygiene, artifactHash: weeklyReview.artifactHash, reviewStatus: weeklyReview.status } }));
} finally {
	globalThis.fetch = guardedFetch;
	host.close();
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}
