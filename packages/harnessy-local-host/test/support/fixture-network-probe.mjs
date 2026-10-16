import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

const isDenied = (error) => error?.code === "FIXTURE_EGRESS_DENIED";
if (process.argv[2] === "grandchild") {
	await assert.rejects(fetch("https://discord.com/api/v10/channels/fixture/messages", { method: "POST", body: "DUMMY" }), isDenied);
	process.stdout.write("denied");
} else {
	await assert.rejects(fetch("https://discord.com/api/v10/channels/fixture/messages", { method: "POST", body: "DUMMY" }), isDenied);
	await assert.rejects(fetch("https://docs.googleapis.com/v1/documents", { method: "POST", body: "DUMMY" }), isDenied);
	assert.throws(() => connect({ host: "discord.com", port: 443 }), isDenied);
	assert.throws(() => tlsConnect({ host: "discord.com", port: 443 }), isDenied);
	for (const [send, url] of [[request, "http://discord.com/api/v10"], [httpsRequest, "https://discord.com/api/v10"]]) {
		await assert.rejects(new Promise((resolve, reject) => {
			const outgoing = send(url, resolve);
			outgoing.once("error", reject);
			outgoing.end();
		}), isDenied);
	}
	const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "grandchild"], { env: process.env, encoding: "utf8", timeout: 5_000 });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout, "denied");
	let requests = 0;
	const server = createServer((_request, response) => { requests += 1; response.end("local"); });
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	try {
		const response = await fetch(`http://127.0.0.1:${server.address().port}`);
		assert.equal(await response.text(), "local");
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	process.stdout.write(JSON.stringify({ loopbackRequests: requests, externalDenied: 6, childDenied: true }));
}
