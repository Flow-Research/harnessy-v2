import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { InboxListData } from "@harnessy/core/read-model";
import { afterEach, expect, it } from "vitest";
import { type PortalCommandIo, runPortalCommand } from "../src/portal/command.ts";
import { inboxRevision } from "../src/portal/inbox-revision.ts";
import type { PortalServer } from "../src/portal/server.ts";
import { buildPortalHome, cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { rawRequest } from "./support/portal-http.ts";

const servers: PortalServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	cleanupPortalFixtures();
});
const harness = (home: string, env: NodeJS.ProcessEnv = {}) => {
	const output: string[] = [];
	const io: PortalCommandIo = {
		homeDir: home,
		env,
		version: "test",
		nodePath: "/opt/node",
		cliPath: "/opt/portal.js",
		probe: () => "unsupported",
		openUrl: () => {
			throw new Error("Unexpected browser launch");
		},
		write: (line) => output.push(line),
	};
	return { io, output };
};
const listen = async () => {
	const server = createServer((_request, response) => response.end("owner"));
	await new Promise<void>((ready) => server.listen({ host: "127.0.0.1", port: 0 }, ready));
	return server;
};

it("rejects missing and malformed sign-in IDs before contacting a portal", async () => {
	const { io } = harness(tempDir("invalid-signin"));
	for (const args of [["signin"], ["signin", "--request", "invalid/id"]])
		await expect(runPortalCommand(args, io)).rejects.toMatchObject({ code: "invalid_signin_request" });
});

it("serve starts its remote listener and closes both listeners together", async () => {
	const reservation = await listen();
	const remotePort = (reservation.address() as { port: number }).port;
	await new Promise<void>((done) => reservation.close(() => done()));
	const home = tempDir("remote-command");
	const { io } = harness(home, {
		HARNESSY_PORTAL_REMOTE_ORIGIN: "https://fixture.example",
		HARNESSY_PORTAL_REMOTE_PORT: String(remotePort),
	});
	const result = await runPortalCommand(
		["serve", "--port", "0", "--state-dir", join(tempDir("state"), "portal"), "--workspace-root", home],
		io,
	);
	if (result.kind !== "serving") throw new Error("expected serving");
	servers.push(result.server);
	expect((await rawRequest(result.server.port, { path: "/v1/healthz" })).status).toBe(200);
	expect(
		(
			await rawRequest(remotePort, {
				path: "/v1/terminal/sessions",
				headers: { Host: "fixture.example", Origin: "https://fixture.example" },
			})
		).status,
	).toBe(401);
	await result.server.close();
	servers.pop();
	await expect(rawRequest(result.server.port, { path: "/v1/healthz" })).rejects.toThrow();
	await expect(rawRequest(remotePort, { path: "/v1/healthz" })).rejects.toThrow();
});

it("serve releases its local listener when the remote port is occupied", async () => {
	const occupied = await listen();
	const remotePort = (occupied.address() as { port: number }).port;
	const { io, output } = harness(tempDir("remote-failure"), {
		HARNESSY_PORTAL_REMOTE_ORIGIN: "https://fixture.example",
		HARNESSY_PORTAL_REMOTE_PORT: String(remotePort),
	});
	try {
		await expect(
			runPortalCommand(["serve", "--port", "0", "--state-dir", join(tempDir("state"), "portal")], io),
		).rejects.toThrow();
		const ready = output.map((line) => JSON.parse(line)).find((entry) => entry.kind === "ready");
		expect(ready).toBeDefined();
		await expect(rawRequest(ready.port, { path: "/v1/healthz" })).rejects.toThrow();
		expect((await rawRequest(remotePort, { path: "/" })).text).toBe("owner");
	} finally {
		await new Promise<void>((done) => occupied.close(() => done()));
	}
});

it("serve wires weekly inspection, closure and durable inbox controls to the selected home", async () => {
	const fixture = await buildPortalHome("command-weekly");
	const stateDir = join(tempDir("state"), "portal");
	const { io, output } = harness(fixture.home);
	const result = await runPortalCommand(["serve", "--port", "0", "--state-dir", stateDir], io);
	if (result.kind !== "serving") throw new Error("expected serving");
	servers.push(result.server);
	const server = result.server;
	await runPortalCommand(["open", "--port", String(server.port), "--state-dir", stateDir, "--print"], io);
	const code = output.at(-1)!.trim().split("#code=")[1];
	const grant = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/session/exchange",
		headers: { Origin: server.origin, "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	const headers = {
		Authorization: `Bearer ${(grant.json as { token: string }).token}`,
		Origin: server.origin,
		"Content-Type": "application/json",
	};
	const hash = createHash("sha256").update("2026-W42").digest("hex");
	const status = await rawRequest(server.port, { path: `/v1/life/weekly/${hash}/status`, headers });
	expect(status.status).toBe(200);
	expect(status.text).toContain("drafted");
	const inbox = await rawRequest(server.port, { path: "/v1/inbox", headers });
	const data = inbox.json as { tiles: { inbox: { data: InboxListData } } };
	const selected = data.tiles.inbox.data.items.find((item) => item.key.startsWith("life-weekly:"))!;
	expect(selected).toBeDefined();
	const archived = await rawRequest(server.port, {
		method: "POST",
		path: "/v1/inbox/action",
		headers,
		body: JSON.stringify({ action: "archive", items: [{ key: selected.key, revision: inboxRevision(selected) }] }),
	});
	expect(archived.status).toBe(200);
	expect(readFileSync(join(stateDir, "inbox-archive.json"), "utf8")).toContain(selected.key);
	const closed = await rawRequest(server.port, {
		method: "POST",
		path: `/v1/life/weekly/${hash}/close`,
		headers,
		body: JSON.stringify({ reason: "Completed review; replace this draft." }),
	});
	expect(closed.status).toBe(200);
	expect(
		JSON.parse(
			readFileSync(
				join(fixture.home, ".harnessy/jarvis/life/reviews", `weekly-2026-W42-${hash}`, "reconciliation.json"),
				"utf8",
			),
		),
	).toMatchObject({ decision: "superseded" });
});
