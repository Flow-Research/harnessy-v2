import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "../src/community-review-open-cli.ts");
const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A listener that answers the identity challenge the way review.py does. */
const listen = async (proofToken = token, portShift = 0) => {
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const port = (server.address() as AddressInfo).port + portShift;
		if (url.pathname !== "/identity") return void response.writeHead(404).end();
		response.end(
			createHmac("sha256", proofToken)
				.update(`harnessy-community-review-identity:${port}:${url.searchParams.get("nonce")}`)
				.digest("hex"),
		);
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return (server.address() as AddressInfo).port;
};

/** An isolated state root plus a fake platform opener that records what it was given. */
const fixture = (port: number) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "community-review-open-")));
	roots.push(root);
	const state = join(root, "state");
	const bin = join(root, "bin");
	mkdirSync(state, { mode: 0o700 });
	mkdirSync(bin, { mode: 0o700 });
	const opened = join(root, "opened.json");
	// Records argv and the page body, then redeems the code as the server's GET /?code= would.
	const opener = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const page = process.argv[2];
const body = fs.readFileSync(page, "utf8");
const code = /\\?code=([A-Za-z0-9_-]{43})"/.exec(body)[1];
const exchange = path.join(path.dirname(page), "review-exchange-" + crypto.createHash("sha256").update(code).digest("hex"));
const exchangeMode = fs.statSync(exchange).mode & 0o7777;
const pageMode = fs.statSync(page).mode & 0o7777;
fs.writeFileSync(${JSON.stringify(opened)}, JSON.stringify({ argv: process.argv.slice(2), body, code, exchangeMode, pageMode }));
fs.unlinkSync(exchange);
`;
	for (const name of ["open", "xdg-open"]) writeFileSync(join(bin, name), opener, { mode: 0o700 });
	writeFileSync(join(state, "review.token"), `${token}\n`, { mode: 0o600 });
	const rendezvous = (value: Record<string, unknown> = {}) =>
		writeFileSync(
			join(state, "community-review.rendezvous.json"),
			JSON.stringify({
				kind: "harnessy.community.review-rendezvous.v1",
				origin: `http://127.0.0.1:${port}`,
				port,
				tokenPath: join(state, "review.token"),
				...value,
			}),
			{ mode: 0o600 },
		);
	rendezvous();
	const run = (args: string[] = ["--state-path", state]) =>
		new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
			const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
				cwd: join(import.meta.dirname, ".."),
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, NODE_NO_WARNINGS: "1" },
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			child.on("close", (status) => done({ status, stdout, stderr }));
		});
	const leftovers = () => readdirSync(state).filter((name) => /^review-(?:open|exchange)-/u.test(name));
	return { root, state, opened, rendezvous, run, leftovers };
};

type Fixture = ReturnType<typeof fixture>;
const expectRefused = async (f: Fixture, args?: string[]) => {
	const result = await f.run(args);
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe('{"error":"community_review_open_failed"}\n');
	expect(existsSync(f.opened)).toBe(false);
	expect(f.leftovers()).toEqual([]);
};

describe("harnessy-community-review-open", () => {
	it("gives the opener only an owner-only page path that carries a single-use code", async () => {
		const port = await listen();
		const f = fixture(port);
		const result = await f.run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const opened = JSON.parse(readFileSync(f.opened, "utf8"));
		expect(opened.argv).toHaveLength(1);
		expect(opened.argv[0]).toMatch(new RegExp(`^${f.state}/review-open-[0-9a-f]{32}\\.html$`, "u"));
		expect(opened.argv.join(" ")).not.toContain(token);
		expect(opened.body).not.toContain(token);
		expect(opened.body).toContain(
			`<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${port}/?code=${opened.code}">`,
		);
		expect(opened.body).toContain('<meta name="referrer" content="no-referrer">');
		expect(opened.pageMode).toBe(0o600);
		expect(opened.exchangeMode).toBe(0o600);
		// The page is removed once the code is redeemed.
		expect(f.leftovers()).toEqual([]);
	});

	it("refuses a listener that cannot prove it holds the review token", async () => {
		await expectRefused(fixture(await listen("someone-else-entirely-0123456789-abcdefghij")));
	});

	it("refuses a relay that answers with the real review's port binding", async () => {
		await expectRefused(fixture(await listen(token, 1)));
	});

	it("refuses when nothing is listening on the rendezvous port", async () => {
		const port = await listen();
		await new Promise((done) => servers.pop()?.close(done));
		await expectRefused(fixture(port));
	});

	it("rejects malformed arguments without reading state", async () => {
		const f = fixture(await listen());
		for (const args of [
			[],
			["--state-path"],
			["--state-path", "state"],
			["--state-path", `${f.state}/`],
			["--state-path", f.state, "extra"],
		])
			await expectRefused(f, args);
	});

	it("requires an owner-only state root and owner-only, single-link, non-symlink files", async () => {
		const f = fixture(await listen());
		chmodSync(f.state, 0o755);
		await expectRefused(f);
		chmodSync(f.state, 0o700);
		chmodSync(join(f.state, "review.token"), 0o644);
		await expectRefused(f);
		chmodSync(join(f.state, "review.token"), 0o600);
		linkSync(join(f.state, "review.token"), join(f.root, "token-hardlink"));
		await expectRefused(f);
		rmSync(join(f.root, "token-hardlink"));
		chmodSync(join(f.state, "community-review.rendezvous.json"), 0o640);
		await expectRefused(f);
		rmSync(join(f.state, "community-review.rendezvous.json"));
		await expectRefused(f);
		writeFileSync(join(f.root, "elsewhere.json"), "{}", { mode: 0o600 });
		symlinkSync(join(f.root, "elsewhere.json"), join(f.state, "community-review.rendezvous.json"));
		await expectRefused(f);
	});

	it("rejects a token file outside the state root and a symlinked token", async () => {
		const f = fixture(await listen());
		writeFileSync(join(f.root, "other.token"), `${token}\n`, { mode: 0o600 });
		f.rendezvous({ tokenPath: join(f.root, "other.token") });
		await expectRefused(f);
		f.rendezvous();
		rmSync(join(f.state, "review.token"));
		symlinkSync(join(f.root, "other.token"), join(f.state, "review.token"));
		await expectRefused(f);
	});

	it("rejects non-loopback, mismatched or non-origin listeners", async () => {
		const port = await listen();
		const f = fixture(port);
		for (const value of [
			{ origin: `http://attacker.example:${port}` },
			{ origin: `https://127.0.0.1:${port}` },
			{ origin: `http://localhost:${port}` },
			{ origin: `http://127.0.0.1:${port + 1}` },
			{ origin: `http://127.0.0.1:${port}/briefing` },
			{ origin: `http://user@127.0.0.1:${port}` },
			{ port: 0, origin: "http://127.0.0.1:0" },
			{ kind: "harnessy.meeting-publication.review-rendezvous.v1" },
		]) {
			f.rendezvous(value);
			await expectRefused(f);
		}
	});
});
