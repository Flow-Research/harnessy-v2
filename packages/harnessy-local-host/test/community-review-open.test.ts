import { chmodSync, existsSync, linkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { communityReviewOpenProfile } from "../src/review-open.ts";
import { reviewOpenHarness, reviewOpenToken as token } from "./support/review-open-fixture.ts";

const harness = reviewOpenHarness(communityReviewOpenProfile, "community");
const { listen, fixture } = harness;
afterEach(harness.cleanup);

describe("harnessy-community-review-open", () => {
	it("gives the opener only an owner-only page path that carries a single-use code", async () => {
		const port = await listen();
		const f = fixture(port);
		const result = await f.run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		const opened = f.record();
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
		await fixture(await listen({ proofToken: "someone-else-entirely-0123456789-abcdefghij" })).expectRefused();
	});

	it("refuses a relay that answers with the real review's port binding", async () => {
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

	it("removes the page and the code on SIGTERM", async () => {
		const f = fixture(await listen());
		const { child, done } = f.start(undefined, { stub: "keep" });
		const deadline = Date.now() + 10_000;
		while (!existsSync(f.opened) && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 25));
		expect(f.leftovers()).toHaveLength(2);
		child.kill("SIGTERM");
		expect((await done).status).toBe(143);
		expect(f.leftovers()).toEqual([]);
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
			{ origin: `http://[::1]:${port}` },
			{ origin: `http://127.0.0.1:${port + 1}` },
			{ origin: `http://127.0.0.1:${port}/briefing` },
			{ origin: `http://user@127.0.0.1:${port}` },
			{ port: 0, origin: "http://127.0.0.1:0" },
			{ kind: "harnessy.meeting-publication.review-rendezvous.v1" },
		]) {
			f.rendezvous(value);
			await f.expectRefused();
		}
	});
});
