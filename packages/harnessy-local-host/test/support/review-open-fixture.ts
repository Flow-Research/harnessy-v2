import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";

import type { ReviewOpenProfile } from "../../src/review-open.ts";

export const reviewOpenToken = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const packageRoot = join(import.meta.dirname, "../..");
const entry = join(import.meta.dirname, "review-open-entry.ts");

export interface StubRecord {
	readonly argv: ReadonlyArray<string>;
	readonly body?: string;
	readonly code?: string;
	readonly pageMode?: number;
	readonly exchangeMode?: number;
	readonly exchangeSize?: number;
}

export interface RunResult {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** How the recording stub opener behaves after it records its argv. */
export type StubMode = "redeem" | "keep" | "fail";

export const reviewOpenHarness = (profile: ReviewOpenProfile, profileName: "meeting" | "community") => {
	const roots: Array<string> = [];
	const servers: Array<Server> = [];
	const cleanup = async () => {
		for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	};

	/** A listener that answers the identity challenge the way the review server does. */
	const listen = async (options: { proofToken?: string; portShift?: number; answer?: string } = {}) => {
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const port = (server.address() as AddressInfo).port + (options.portShift ?? 0);
			if (url.pathname !== "/identity") return void response.writeHead(404).end();
			response.end(
				options.answer ??
					createHmac("sha256", options.proofToken ?? reviewOpenToken)
						.update(`${profile.identityDomain}:${port}:${url.searchParams.get("nonce")}`)
						.digest("hex"),
			);
		});
		servers.push(server);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		return (server.address() as AddressInfo).port;
	};
	const stopListening = async () => {
		const server = servers.pop();
		if (server !== undefined) await new Promise((done) => server.close(done));
	};

	/** An isolated state root plus a stub opener that records what it was given. */
	const fixture = (port: number) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), `${profileName}-review-open-`)));
		roots.push(root);
		const state = join(root, "state");
		const bin = join(root, "bin");
		mkdirSync(state, { mode: 0o700 });
		mkdirSync(bin, { mode: 0o700 });
		const opened = join(root, "opened.json");
		const opener = join(bin, "recording-opener");
		// Records argv, the page body and the file modes, then (in "redeem" mode)
		// deletes the exchange file as the server's code redemption does.
		writeFileSync(
			opener,
			`#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const argv = process.argv.slice(2);
const record = { argv };
let exchange;
try {
	const page = argv[0];
	record.body = fs.readFileSync(page, "utf8");
	record.code = /\\?code=([A-Za-z0-9_-]{43})"/.exec(record.body)[1];
	exchange = path.join(path.dirname(page), ${JSON.stringify(profile.exchangePrefix)} + crypto.createHash("sha256").update(record.code).digest("hex"));
	const exchangeStat = fs.lstatSync(exchange);
	record.pageMode = fs.lstatSync(page).mode & 0o7777;
	record.exchangeMode = exchangeStat.mode & 0o7777;
	record.exchangeSize = exchangeStat.size;
} catch {}
fs.writeFileSync(${JSON.stringify(opened)}, JSON.stringify(record));
const mode = process.env.REVIEW_OPEN_STUB_MODE;
if (mode === "fail") process.exit(3);
if (mode === "redeem" && exchange !== undefined) fs.unlinkSync(exchange);
`,
			{ mode: 0o700 },
		);
		// A PATH lookup would also find only the stub, so no test can reach a real opener.
		for (const name of ["open", "xdg-open"]) writeFileSync(join(bin, name), readFileSync(opener), { mode: 0o700 });
		const tokenPath = join(state, profile.tokenFileName);
		const rendezvousPath = join(state, profile.rendezvousFileName);
		writeFileSync(tokenPath, `${reviewOpenToken}\n`, { mode: 0o600 });
		const rendezvous = (value: Record<string, unknown> = {}) =>
			writeFileSync(
				rendezvousPath,
				JSON.stringify({
					kind: profile.rendezvousKind,
					origin: `http://127.0.0.1:${port}`,
					port,
					tokenPath,
					...value,
				}),
				{ mode: 0o600 },
			);
		rendezvous();
		const start = (
			args: ReadonlyArray<string> = ["--state-path", state],
			options: { stub?: StubMode; waitMs?: number } = {},
		) => {
			const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
				cwd: packageRoot,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					NODE_NO_WARNINGS: "1",
					PI_AUTH_ENCRYPTION: "off",
					REVIEW_OPEN_TEST_PROFILE: profileName,
					REVIEW_OPEN_TEST_OPENER: opener,
					REVIEW_OPEN_TEST_WAIT_MS: String(options.waitMs ?? 30_000),
					REVIEW_OPEN_STUB_MODE: options.stub ?? "redeem",
				},
			});
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			const done = new Promise<RunResult>((resolveRun) =>
				child.on("close", (status, signal) => resolveRun({ status, signal, stdout, stderr })),
			);
			return { child: child as ChildProcess, done };
		};
		const run = (args?: ReadonlyArray<string>, options?: { stub?: StubMode; waitMs?: number }) =>
			start(args, options).done;
		const record = () => JSON.parse(readFileSync(opened, "utf8")) as StubRecord;
		const leftovers = () =>
			readdirSync(state).filter(
				(name) => name.startsWith(profile.pagePrefix) || name.startsWith(profile.exchangePrefix),
			);
		const expectRefused = async (args?: ReadonlyArray<string>) => {
			const result = await run(args);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(`{"error":"${profile.failure}"}\n`);
			expect(existsSync(opened)).toBe(false);
			expect(leftovers()).toEqual([]);
		};
		return {
			root,
			state,
			opened,
			opener,
			tokenPath,
			rendezvousPath,
			rendezvous,
			start,
			run,
			record,
			leftovers,
			expectRefused,
		};
	};
	return { cleanup, listen, stopListening, fixture };
};
