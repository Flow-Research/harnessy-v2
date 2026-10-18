import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "../src/community-review-open-cli.ts");
const token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** An isolated state root plus a fake platform opener that records its argv. */
const fixture = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "community-review-open-")));
	roots.push(root);
	const state = join(root, "state");
	const bin = join(root, "bin");
	mkdirSync(state, { mode: 0o700 });
	mkdirSync(bin, { mode: 0o700 });
	const opened = join(root, "opened.json");
	for (const name of ["open", "xdg-open"])
		writeFileSync(
			join(bin, name),
			`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(opened)}, JSON.stringify(process.argv.slice(2)));\n`,
			{ mode: 0o700 },
		);
	writeFileSync(join(state, "review.token"), `${token}\n`, { mode: 0o600 });
	const rendezvous = (value: Record<string, unknown> = {}) =>
		writeFileSync(
			join(state, "community-review.rendezvous.json"),
			JSON.stringify({
				kind: "harnessy.community.review-rendezvous.v1",
				origin: "http://127.0.0.1:8872",
				port: 8872,
				tokenPath: join(state, "review.token"),
				...value,
			}),
			{ mode: 0o600 },
		);
	rendezvous();
	const run = (args: string[] = ["--state-path", state]) =>
		spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
			cwd: join(import.meta.dirname, ".."),
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, NODE_NO_WARNINGS: "1" },
			encoding: "utf8",
			timeout: 10_000,
		});
	return { root, state, opened, rendezvous, run };
};

const expectRefused = (result: ReturnType<ReturnType<typeof fixture>["run"]>, opened: string) => {
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe('{"error":"community_review_open_failed"}\n');
	expect(existsSync(opened)).toBe(false);
};

describe("harnessy-community-review-open", () => {
	it("opens the token link through the platform opener and never prints it", () => {
		const f = fixture();
		const result = f.run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
		expect(JSON.parse(readFileSync(f.opened, "utf8"))).toEqual([`http://127.0.0.1:8872/?token=${token}`]);
	});

	it("rejects malformed arguments without reading state", () => {
		const f = fixture();
		for (const args of [
			[],
			["--state-path"],
			["--state-path", "state"],
			["--state-path", `${f.state}/`],
			["--state-path", f.state, "extra"],
		])
			expectRefused(f.run(args), f.opened);
	});

	it("requires owner-only, single-link, non-symlink token and rendezvous files", () => {
		const f = fixture();
		chmodSync(join(f.state, "review.token"), 0o644);
		expectRefused(f.run(), f.opened);
		chmodSync(join(f.state, "review.token"), 0o600);
		linkSync(join(f.state, "review.token"), join(f.root, "token-hardlink"));
		expectRefused(f.run(), f.opened);
		rmSync(join(f.root, "token-hardlink"));
		chmodSync(join(f.state, "community-review.rendezvous.json"), 0o640);
		expectRefused(f.run(), f.opened);
		rmSync(join(f.state, "community-review.rendezvous.json"));
		expectRefused(f.run(), f.opened);
		writeFileSync(join(f.root, "elsewhere.json"), "{}", { mode: 0o600 });
		symlinkSync(join(f.root, "elsewhere.json"), join(f.state, "community-review.rendezvous.json"));
		expectRefused(f.run(), f.opened);
	});

	it("rejects a token file outside the state root and a symlinked token", () => {
		const f = fixture();
		writeFileSync(join(f.root, "other.token"), `${token}\n`, { mode: 0o600 });
		f.rendezvous({ tokenPath: join(f.root, "other.token") });
		expectRefused(f.run(), f.opened);
		f.rendezvous();
		rmSync(join(f.state, "review.token"));
		symlinkSync(join(f.root, "other.token"), join(f.state, "review.token"));
		expectRefused(f.run(), f.opened);
	});

	it("rejects non-loopback, mismatched or non-origin listeners", () => {
		const f = fixture();
		for (const value of [
			{ origin: "http://attacker.example:8872" },
			{ origin: "https://127.0.0.1:8872" },
			{ origin: "http://localhost:8872" },
			{ origin: "http://127.0.0.1:8873" },
			{ origin: "http://127.0.0.1:8872/briefing" },
			{ origin: "http://user@127.0.0.1:8872" },
			{ port: 0, origin: "http://127.0.0.1:0" },
			{ kind: "harnessy.meeting-publication.review-rendezvous.v1" },
		]) {
			f.rendezvous(value);
			expectRefused(f.run(), f.opened);
		}
	});
});
