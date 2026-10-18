import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isCommunityCompatibilityWriterCommand } from "../../harnessy-core/src/jarvis/community-briefing/operational-runtime.ts";
import { isMeetingPublicationV1WriterCommand } from "../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import {
	identityProofMatches,
	meetingReviewOpenProfile,
	resolvePlatformOpener,
	sweepStaleReviewFiles,
} from "../src/review-open.ts";
import { reviewOpenHarness, reviewOpenToken as token } from "./support/review-open-fixture.ts";

const harness = reviewOpenHarness(meetingReviewOpenProfile, "meeting");
const { listen, fixture } = harness;
afterEach(harness.cleanup);

const pagePattern = /^meeting-review-open-[0-9a-f]{32}\.html$/u;

const waitFor = async (condition: () => boolean) => {
	const deadline = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await new Promise((done) => setTimeout(done, 25));
	}
};

describe("harnessy-meeting-review-open", () => {
	it("gives the opener only an owner-only page path that carries a single-use code", async () => {
		const port = await listen();
		const f = fixture(port);
		const result = await f.run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const opened = f.record();
		expect(opened.argv).toHaveLength(1);
		const page = opened.argv[0] ?? "";
		expect(page.startsWith(`${f.state}/`)).toBe(true);
		expect(page.slice(f.state.length + 1)).toMatch(pagePattern);
		expect(opened.argv.join(" ")).not.toContain(token);
		expect(opened.argv.join(" ")).not.toContain("?code=");
		expect(opened.body).not.toContain(token);
		expect(opened.body).toContain(
			`<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${port}/exchange?code=${opened.code}">`,
		);
		expect(opened.body).toContain('<meta name="referrer" content="no-referrer">');
		expect(opened.pageMode).toBe(0o600);
		expect(opened.exchangeMode).toBe(0o600);
		expect(opened.exchangeSize).toBe(0);
		// The page is removed once the code is redeemed.
		expect(f.leftovers()).toEqual([]);
	});

	it("keeps both the launcher argv and the opener argv outside the one-writer guards", async () => {
		const f = fixture(await listen());
		expect((await f.run()).status).toBe(0);
		const page = f.record().argv[0] ?? "";
		const host = "/opt/harnessy/service/node_modules/@harnessy/local-host/dist";
		const commands = [
			`/opt/harnessy/bin/harnessy-meeting-review-open --state-path ${f.state}`,
			`/opt/harnessy/bin/node ${host}/meeting-review-open-cli.js --state-path ${f.state}`,
			`/bin/sh /opt/harnessy/bin/harnessy-meeting-review-open --state-path ${f.state}`,
			`/usr/bin/open ${page}`,
			`/usr/bin/xdg-open ${page}`,
			[f.opener, page].join(" "),
		];
		for (const command of commands) {
			expect(isCommunityCompatibilityWriterCommand(command), command).toBe(false);
			expect(isMeetingPublicationV1WriterCommand(command), command).toBe(false);
		}
		// Control: the same predicates catch the V1 commands, so the assertions are not vacuous.
		expect(isMeetingPublicationV1WriterCommand("/opt/jarvis/bin/jarvis meeting publish review serve")).toBe(true);
		expect(
			isCommunityCompatibilityWriterCommand("/opt/jarvis/bin/jarvis community briefing review open --port 8872"),
		).toBe(true);
	});

	it("refuses a listener that cannot prove it holds the review token", async () => {
		await fixture(await listen({ proofToken: "someone-else-entirely-0123456789-abcdefghij" })).expectRefused();
	});

	it("refuses a relay that answers with the real review's proof for another port", async () => {
		await fixture(await listen({ portShift: 1 })).expectRefused();
	});

	it("refuses a non-ASCII proof of the expected length without crashing", async () => {
		await fixture(await listen({ answer: "é".repeat(64) })).expectRefused();
	});

	it("refuses when nothing is listening on the rendezvous port", async () => {
		const port = await listen();
		await harness.stopListening();
		await fixture(port).expectRefused();
	});

	it("removes the page and the unredeemed code when the opener fails", async () => {
		const f = fixture(await listen());
		const result = await f.run(undefined, { stub: "fail" });
		expect(result.status).toBe(1);
		expect(result.stderr).toBe('{"error":"meeting_review_open_failed"}\n');
		expect(existsSync(f.opened)).toBe(true);
		expect(f.leftovers()).toEqual([]);
	});

	it("revokes an unredeemed code after the bounded wait", async () => {
		const f = fixture(await listen());
		const result = await f.run(undefined, { stub: "keep", waitMs: 300 });
		expect(result.status).toBe(0);
		expect(f.record().argv).toHaveLength(1);
		expect(f.leftovers()).toEqual([]);
	});

	it.each([
		["SIGTERM", 143],
		["SIGINT", 130],
		["SIGHUP", 129],
	] as const)("removes the page and the code on %s", async (signal, status) => {
		const f = fixture(await listen());
		const { child, done } = f.start(undefined, { stub: "keep" });
		await waitFor(() => existsSync(f.opened));
		expect(f.leftovers()).toHaveLength(2);
		child.kill(signal);
		const result = await done;
		expect(result.status).toBe(status);
		expect(result.stdout).toBe("");
		expect(f.leftovers()).toEqual([]);
	});

	it("prunes only stale launcher files and keeps everything else", async () => {
		const f = fixture(await listen());
		const old = new Date(Date.now() - 10 * 60_000);
		const stalePage = join(f.state, `meeting-review-open-${"a".repeat(32)}.html`);
		const staleExchange = join(f.state, `meeting-review-exchange-${"b".repeat(64)}`);
		const freshExchange = join(f.state, `meeting-review-exchange-${"c".repeat(64)}`);
		const unrelated = join(f.state, `review-exchange-${"d".repeat(64)}`);
		for (const path of [stalePage, staleExchange, freshExchange, unrelated]) writeFileSync(path, "", { mode: 0o600 });
		for (const path of [stalePage, staleExchange, unrelated]) utimesSync(path, old, old);
		expect((await f.run()).status).toBe(0);
		expect(existsSync(stalePage)).toBe(false);
		expect(existsSync(staleExchange)).toBe(false);
		expect(existsSync(freshExchange)).toBe(true);
		expect(existsSync(unrelated)).toBe(true);
	});

	it("rejects malformed arguments without reading state", async () => {
		const f = fixture(await listen());
		for (const args of [
			[],
			["--state-path"],
			["--state-path", "state"],
			["--state-path", `${f.state}/`],
			["--state-path", f.state, "extra"],
			["--token", token],
		])
			await f.expectRefused(args);
	});

	it("requires an owner-only state root and owner-only, single-link, non-symlink files", async () => {
		const f = fixture(await listen());
		chmodSync(f.state, 0o755);
		await f.expectRefused();
		chmodSync(f.state, 0o700);
		chmodSync(f.tokenPath, 0o644);
		await f.expectRefused();
		chmodSync(f.tokenPath, 0o600);
		linkSync(f.tokenPath, join(f.root, "token-hardlink"));
		await f.expectRefused();
		rmSync(join(f.root, "token-hardlink"));
		chmodSync(f.rendezvousPath, 0o640);
		await f.expectRefused();
		rmSync(f.rendezvousPath);
		await f.expectRefused();
		writeFileSync(join(f.root, "elsewhere.json"), "{}", { mode: 0o600 });
		symlinkSync(join(f.root, "elsewhere.json"), f.rendezvousPath);
		await f.expectRefused();
		rmSync(f.rendezvousPath);
		writeFileSync(f.rendezvousPath, "not json", { mode: 0o600 });
		await f.expectRefused();
	});

	it("rejects a token file outside the state root and a symlinked token", async () => {
		const f = fixture(await listen());
		writeFileSync(join(f.root, "other.token"), `${token}\n`, { mode: 0o600 });
		f.rendezvous({ tokenPath: join(f.root, "other.token") });
		await f.expectRefused();
		f.rendezvous();
		rmSync(f.tokenPath);
		symlinkSync(join(f.root, "other.token"), f.tokenPath);
		await f.expectRefused();
	});

	it("rejects non-loopback, mismatched or non-origin listeners", async () => {
		const port = await listen();
		const f = fixture(port);
		for (const value of [
			{ origin: `http://attacker.example:${port}` },
			{ origin: `https://127.0.0.1:${port}` },
			{ origin: `http://localhost:${port}` },
			{ origin: `http://127.0.0.1:${port + 1}` },
			{ origin: `http://127.0.0.1:${port}/review` },
			{ origin: `http://user@127.0.0.1:${port}` },
			{ port: 0, origin: "http://127.0.0.1:0" },
			{ kind: "harnessy.community.review-rendezvous.v1" },
		]) {
			f.rendezvous(value);
			await f.expectRefused();
		}
	});

	it("wires the installed CLI to the shared launcher and refuses bad arguments content-free", async () => {
		const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
			const child = spawn(
				process.execPath,
				["--import", "tsx", join(import.meta.dirname, "../src/meeting-review-open-cli.ts")],
				{
					cwd: join(import.meta.dirname, ".."),
					env: { ...process.env, NODE_NO_WARNINGS: "1", PATH: "/nonexistent" },
				},
			);
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
		expect(result).toEqual({ status: 1, stdout: "", stderr: '{"error":"meeting_review_open_failed"}\n' });
	});
});

describe("review-open helpers", () => {
	it("compares identity proofs by bytes and never throws on non-ASCII input", () => {
		const expected = "a".repeat(64);
		expect(identityProofMatches(expected, expected)).toBe(true);
		expect(identityProofMatches("b".repeat(64), expected)).toBe(false);
		expect(identityProofMatches("é".repeat(64), expected)).toBe(false);
		expect(identityProofMatches("é".repeat(32), expected)).toBe(false);
		expect(identityProofMatches("", expected)).toBe(false);
	});

	it("tolerates a stale-sweep entry that disappears between listing and lstat", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "review-open-sweep-")));
		try {
			const ghost = `meeting-review-exchange-${"e".repeat(64)}`;
			expect(() =>
				sweepStaleReviewFiles(root, meetingReviewOpenProfile, Date.now(), (path) => [...readdirSync(path), ghost]),
			).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses an absolute opener and never consults PATH", () => {
		expect(resolvePlatformOpener("darwin")).toEqual({ path: "/usr/bin/open" });
		for (const platform of ["win32", "freebsd", "aix"] as const)
			expect(resolvePlatformOpener(platform)).toEqual({ reason: "unsupported_platform" });
		expect(resolvePlatformOpener("linux", [])).toEqual({ reason: "opener_unavailable" });
		expect(resolvePlatformOpener("linux", ["xdg-open"])).toEqual({ reason: "opener_unavailable" });
		// A root-owned executable under root-owned directories is accepted by its real path.
		const accepted = resolvePlatformOpener("linux", ["/missing/xdg-open", "/bin/sh"]);
		expect(accepted).toEqual({ path: realpathSync("/bin/sh") });
	});

	it("rejects a Linux opener that the owner, rather than root, could replace", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "review-open-opener-")));
		try {
			const candidate = join(root, "xdg-open");
			writeFileSync(candidate, "#!/bin/sh\n", { mode: 0o755 });
			// Owned by the test user, not root.
			expect(resolvePlatformOpener("linux", [candidate])).toEqual({ reason: "opener_unavailable" });
			// Even with the test user as the trusted owner, ancestors it does not own disqualify the path,
			// and so does a group-writable file.
			const uid = process.geteuid?.() ?? -1;
			expect(resolvePlatformOpener("linux", [candidate], uid)).toEqual({ reason: "opener_unavailable" });
			chmodSync(candidate, 0o775);
			expect(resolvePlatformOpener("linux", [candidate], uid)).toEqual({ reason: "opener_unavailable" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
