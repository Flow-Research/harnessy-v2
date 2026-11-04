/**
 * The `harnessy-portal` process glue: a missing browser opener is reported,
 * not an uncaught crash, and shutdown runs once however many signals arrive.
 * The opener is a real child process; signals come from a real EventEmitter.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { launchOpener, stopOnSignals, systemOpener } from "../src/portal/process.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("portal browser opener", () => {
	it("picks open on macOS and xdg-open elsewhere", () => {
		expect(systemOpener("darwin")).toBe("/usr/bin/open");
		expect(systemOpener("linux")).toBe("xdg-open");
	});

	it("reports an opener that cannot start instead of crashing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portal-opener-"));
		dirs.push(dir);
		const missing = join(dir, "no-such-opener");
		const failed = await new Promise<boolean>((done) => {
			const timer = setTimeout(() => done(false), 5_000);
			launchOpener(missing, "http://127.0.0.1:8790/#code=x", () => {
				clearTimeout(timer);
				done(true);
			});
		});
		expect(failed).toBe(true);
	});

	it("starts a working opener with the URL as one argument and no failure", async () => {
		const dir = mkdtempSync(join(tmpdir(), "portal-opener-"));
		dirs.push(dir);
		const opener = join(dir, "opener.sh");
		const out = join(dir, "args.txt");
		writeFileSync(opener, `#!/bin/sh\nprintf '%s|' "$@" > '${out}'\n`, { mode: 0o755 });
		let failures = 0;
		launchOpener(opener, "http://127.0.0.1:8790/#code=a b", () => {
			failures += 1;
		});
		for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((wait) => setTimeout(wait, 20));
		await new Promise((wait) => setTimeout(wait, 50));
		expect(readFileSync(out, "utf8")).toBe("http://127.0.0.1:8790/#code=a b|");
		expect(failures).toBe(0);
	});
});

describe("portal shutdown on signals", () => {
	const signals = () => {
		const emitter = new EventEmitter();
		const exits: number[] = [];
		return {
			emitter,
			exits,
			io: {
				once: (signal: "SIGTERM" | "SIGINT", listener: () => void) => emitter.once(signal, listener),
				exit: (code: number) => exits.push(code),
			},
		};
	};

	it("closes once and exits 0 when SIGTERM and SIGINT both arrive", async () => {
		const { emitter, exits, io } = signals();
		let closes = 0;
		stopOnSignals(async () => {
			closes += 1;
			if (closes > 1) throw new Error("server not running");
		}, io);
		emitter.emit("SIGTERM");
		emitter.emit("SIGINT");
		await new Promise((wait) => setTimeout(wait, 0));
		expect(closes).toBe(1);
		expect(exits).toEqual([0]);
	});

	it("exits 1 when closing fails", async () => {
		const { emitter, exits, io } = signals();
		stopOnSignals(() => Promise.reject(new Error("close failed")), io);
		emitter.emit("SIGINT");
		await new Promise((wait) => setTimeout(wait, 0));
		expect(exits).toEqual([1]);
	});
});
