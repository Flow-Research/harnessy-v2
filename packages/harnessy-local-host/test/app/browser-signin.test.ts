import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionClient } from "../../src/portal/app/lib/session.ts";
import { BrowserSignIn } from "../../src/portal/browser-signin.ts";
import { runPortalCommand } from "../../src/portal/command.ts";
import { startPortalServer } from "../../src/portal/server.ts";
import { createPortalSources } from "../../src/portal/sources.ts";
import { readOrCreatePortalInstallToken } from "../../src/portal/token-store.ts";

it("expires and bounds requests, separates approval from claiming, and refuses replay", () => {
	let now = 0;
	const requests = new BrowserSignIn(() => now);
	const first = requests.begin()!;
	expect(requests.claim(first.id, first.claim)).toBe("pending");
	expect(requests.approve(first.id)).toBe(true);
	expect(requests.claim(first.id, first.id)).toBe("invalid");
	expect(requests.claim(first.id, first.claim)).toBe("approved");
	expect(requests.claim(first.id, first.claim)).toBe("invalid");
	expect(requests.approve(first.id)).toBe(false);
	const expired = requests.begin()!;
	now = 60000;
	expect(requests.approve(expired.id)).toBe(false);
	expect(requests.claim(expired.id, expired.claim)).toBe("invalid");
	for (let index = 0; index < 16; index++) expect(requests.begin()).toBeDefined();
	expect(requests.begin()).toBeUndefined();
});

it("authorises only the initiating tab through the native CLI, without opening a URL or changing its route", async () => {
	const root = mkdtempSync(join(tmpdir(), "hsy-signin-"));
	const token = readOrCreatePortalInstallToken(root);
	const server = await startPortalServer({
		installToken: token,
		port: 0,
		version: "test",
		sources: createPortalSources({
			homeRoot: root,
			env: {},
			probe: () => "unsupported",
			timeoutMs: 100,
			clock: () => new Date(),
		}),
	});
	const opened: string[] = [];
	const replaced: string[] = [];
	const client = new SessionClient({
		hash: () => "#/terminal/selected-session",
		replaceUrl: (url) => replaced.push(url),
		storage: undefined,
		now: Date.now,
		fetch: (path, init) =>
			fetch(server.origin + path, { ...init, headers: { ...init.headers, Origin: server.origin } }),
	});
	try {
		const pending = await client.beginBrowserSignIn();
		expect(await client.claimBrowserSignIn(pending.id, pending.claim)).toBe(false);
		const approval = `/v1/session/browser/approve/${pending.id}`;
		expect((await fetch(server.origin + approval, { method: "POST" })).status).toBe(401);
		for (const origin of [undefined, "http://evil.test"]) {
			expect(
				(
					await fetch(`${server.origin}/v1/session/browser/start`, {
						method: "POST",
						headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
						body: "{}",
					})
				).status,
			).toBe(403);
		}
		await runPortalCommand(["signin", "--port", String(server.port), "--state-dir", root, "--request", pending.id], {
			env: {},
			homeDir: root,
			write: () => undefined,
			version: "test",
			cliPath: "/unused",
			nodePath: process.execPath,
			probe: () => "unsupported",
			openUrl: (url) => opened.push(url),
		});
		await expect(client.claimBrowserSignIn(pending.id, pending.id)).rejects.toThrow();
		expect(await client.claimBrowserSignIn(pending.id, pending.claim)).toBe(true);
		expect(client.session()).toBeDefined();
		expect(opened).toEqual([]);
		expect(replaced).toEqual([]);
		await expect(client.claimBrowserSignIn(pending.id, pending.claim)).rejects.toThrow();
	} finally {
		await server.close();
		rmSync(root, { recursive: true, force: true });
	}
});
