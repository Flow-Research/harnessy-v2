import { expect, it } from "vitest";
import { startPortalServer } from "../src/portal/server.ts";
import { createPortalSources } from "../src/portal/sources.ts";
import { PortalTerminal } from "../src/portal/terminal.ts";
import { newPortalSecret } from "../src/portal/token-store.ts";
import { cleanupPortalFixtures, tempDir } from "./support/portal-fixture.ts";
import { installProof, rawRequest } from "./support/portal-http.ts";

it("runs a real PTY with resize, interactive input, interrupt, bounded replay and cleanup", async () => {
	const manager = new PortalTerminal("/tmp", { PATH: "/usr/bin:/bin", HOME: "/tmp" }, "/bin/sh");
	try {
		const { id } = manager.action({ action: "create" }) as { id: string };
		const input = (data: string) => manager.action({ action: "input", id, data });
		let output = "";
		let cursor = 0;
		const waitFor = async (text: string) => {
			await expect
				.poll(
					() => {
						const result = manager.read(id, cursor);
						output += Buffer.from(result.data, "base64").toString();
						cursor = result.cursor;
						return output;
					},
					{ timeout: 10000 },
				)
				.toContain(text);
		};
		manager.action({ action: "resize", id, cols: 93, rows: 31 });
		input("test -t 0 && printf 'PTY_%s\\n' yes; stty size\n");
		await waitFor("PTY_yes");
		await waitFor("31 93");
		input("printf 'SHELL_PID=%s\\n' $$\n");
		await waitFor("SHELL_PID=");
		await expect
			.poll(() => {
				const result = manager.read(id, cursor);
				output += Buffer.from(result.data, "base64").toString();
				cursor = result.cursor;
				return /SHELL_PID=(\d+)/u.test(output);
			})
			.toBe(true);
		const shellPid = Number(/SHELL_PID=(\d+)/u.exec(output)![1]);
		input("/usr/bin/python3 -q\n");
		await waitFor(">>>");
		input("print('INTERACTIVE_' + str(6 * 7))\n");
		await waitFor("INTERACTIVE_42");
		input("exit()\n");
		input("sleep 20\n");
		await new Promise((resolve) => setTimeout(resolve, 200));
		input("\u0003");
		input("printf 'AFTER_%s\\n' interrupt\n");
		await waitFor("AFTER_interrupt");
		expect(Buffer.from(manager.read(id, 0).data, "base64").toString()).toContain("INTERACTIVE_42");
		input("/usr/bin/python3 -c \"print('x'*1100000)\"\n");
		await expect.poll(() => manager.read(id, 0).truncated).toBe(true);
		expect(manager.read(id, 0).data.length).toBeLessThan(90000);
		manager.action({ action: "close", id });
		await expect
			.poll(() => {
				try {
					process.kill(shellPid, 0);
					return true;
				} catch {
					return false;
				}
			})
			.toBe(false);
		expect(manager.list().sessions).toEqual([]);
		expect(() => manager.read(id, 0)).toThrow("terminal_not_found");
	} finally {
		manager.close();
	}
}, 20000);

it("requires page auth and exact Origin for actions; reads never create a shell", async () => {
	const terminal = new PortalTerminal("/tmp", { PATH: "/usr/bin:/bin", HOME: "/tmp" }, "/bin/sh");
	const token = newPortalSecret();
	const server = await startPortalServer({
		installToken: token,
		version: "test",
		port: 0,
		terminal,
		sources: createPortalSources({
			homeRoot: tempDir("terminal"),
			// harnessy-test-env: configuration, not a child process environment
			env: {},
			probe: () => "unsupported",
			timeoutMs: 250,
			clock: () => new Date(),
			probePort: async () => false,
		}),
	});
	try {
		const path = "/v1/terminal/action";
		const request = (headers: Record<string, string>, body = '{"action":"create"}') =>
			rawRequest(server.port, { path, method: "POST", headers, body });
		expect((await request({})).status).toBe(401);
		expect((await request(await installProof(server.port, token, "POST", path))).status).toBe(401);
		const code = await rawRequest(server.port, {
			path: "/v1/session/code",
			method: "POST",
			headers: await installProof(server.port, token, "POST", "/v1/session/code"),
		});
		const exchange = await rawRequest(server.port, {
			path: "/v1/session/exchange",
			method: "POST",
			headers: { Origin: server.origin, "Content-Type": "application/json" },
			body: JSON.stringify({ code: (code.json as { code: string }).code }),
		});
		const headers = {
			Authorization: `Bearer ${(exchange.json as { token: string }).token}`,
			Origin: server.origin,
			"Content-Type": "application/json",
		};
		expect((await request({ ...headers, Origin: "http://127.0.0.1:1" })).status).toBe(403);
		expect((await request({ Authorization: headers.Authorization, "Content-Type": "application/json" })).status).toBe(
			403,
		);
		expect((await request(headers, '{"action":"create","command":"arbitrary"}')).status).toBe(400);
		expect((await rawRequest(server.port, { path: "/v1/terminal/sessions", headers })).json).toMatchObject({
			sessions: [],
		});
		expect(terminal.list().sessions).toEqual([]);
		for (let i = 0; i < 4; i++) expect((await request(headers)).status).toBe(200);
		expect((await request(headers)).status).toBe(400);
		const id = terminal.list().sessions[0]!.id;
		expect((await request(headers, JSON.stringify({ action: "resize", id, cols: 0, rows: 24 }))).status).toBe(400);
		expect((await request(headers, JSON.stringify({ action: "input", id, data: "a".repeat(257) }))).status).toBe(400);
	} finally {
		await server.close();
		cleanupPortalFixtures();
	}
	expect(terminal.list().sessions).toEqual([]);
});
