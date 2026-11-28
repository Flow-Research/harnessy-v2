import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { updateMeetingCaptureState } from "../src/jarvis/fathom/capture-state.ts";
import { FathomFileStore } from "../src/jarvis/fathom/file-store.ts";
import { readLockOwner, tryProcessLock } from "../src/jarvis/fathom/process-lock.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
	const root = mkdtempSync(join(tmpdir(), "harnessy-process-lock-"));
	roots.push(root);
	return root;
};
const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
/** The process id of a child that has already exited. */
const exitedPid = (): number => {
	const child = spawnSync(process.execPath, ["-e", ""]);
	if (child.pid === undefined) throw new Error("no child pid");
	return child.pid;
};
const writeOwner = (path: string, pid: number, token: string, host = hostname()) =>
	writeFileSync(path, `${JSON.stringify({ pid, host, token, takenAt: longAgo.toISOString() })}\n`);

describe("process-owned lock", () => {
	it("never takes over a lock of a live process, however old it is", () => {
		const lock = join(scratch(), "poll.lock");
		const release = tryProcessLock(lock);
		expect(release).not.toBeNull();
		// A paused holder: the file is a day old, and its process is still running.
		utimesSync(lock, longAgo, longAgo);
		expect(tryProcessLock(lock)).toBeNull();
		release!();
		expect(existsSync(lock)).toBe(false);
	});

	it("takes over the lock of an exited process", () => {
		const lock = join(scratch(), "poll.lock");
		writeOwner(lock, exitedPid(), "dead-owner");
		const release = tryProcessLock(lock);
		expect(release).not.toBeNull();
		expect(readLockOwner(lock)).toMatchObject({ pid: process.pid });
		release!();
	});

	it("never takes over a lock from another host", () => {
		const lock = join(scratch(), "poll.lock");
		writeOwner(lock, exitedPid(), "remote-owner", "another-host.invalid");
		expect(tryProcessLock(lock)).toBeNull();
	});

	it("lets an old holder's release leave a newer lock in place", () => {
		const lock = join(scratch(), "poll.lock");
		const oldRelease = tryProcessLock(lock);
		expect(oldRelease).not.toBeNull();
		// Another process replaced the lock (as if it judged the old holder exited).
		writeOwner(lock, process.pid, "newer-owner");
		oldRelease!();
		expect(readLockOwner(lock)?.token).toBe("newer-owner");
	});

	it("treats an unreadable lock as busy while it is new and as left over when it is old", () => {
		const lock = join(scratch(), "poll.lock");
		writeFileSync(lock, "");
		expect(tryProcessLock(lock)).toBeNull();
		utimesSync(lock, longAgo, longAgo);
		const release = tryProcessLock(lock);
		expect(release).not.toBeNull();
		release!();
	});

	it("serialises the Fathom account lock and the capture state lock by process", async () => {
		const root = scratch();
		const store = new FathomFileStore({ inboxRoot: join(root, "inbox"), stateRoot: root });
		const release = await store.lockAccount("research");
		await expect(store.lockAccount("research")).rejects.toThrow("already running");
		release();
		(await store.lockAccount("research"))();

		const state = join(root, "meeting-capture-state-v1.json");
		writeOwner(`${state}.lock`, process.pid, "paused-holder");
		utimesSync(`${state}.lock`, longAgo, longAgo);
		expect(() => updateMeetingCaptureState(state, {}, new Date())).toThrow("capture_state_busy");
		writeOwner(`${state}.lock`, exitedPid(), "exited-holder");
		expect(updateMeetingCaptureState(state, {}, new Date()).notes).toEqual({});
		expect(existsSync(`${state}.lock`)).toBe(false);
	});
});
