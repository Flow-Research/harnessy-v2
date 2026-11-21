import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENGINEERING_PILOT, type EngineeringJob, engineeringJobDigest } from "../src/engineering/contracts.ts";
import { EngineeringStore, engineeringGrant } from "../src/engineering/store.ts";

const roots: string[] = [];
const stores: EngineeringStore[] = [];
const now = 1_000_000;
const fixture = () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-store-")));
	roots.push(root);
	const path = join(root, "state.sqlite");
	const store = new EngineeringStore(path);
	stores.push(store);
	return { root, path, store };
};
const job = (lane: EngineeringJob["lane"] = "native", objective = randomUUID()): EngineeringJob => ({
	schema: "harnessy.engineering.job.v1",
	id: randomUUID(),
	objective,
	taskId: randomUUID(),
	taskRevision: "f".repeat(64),
	workspace: "julian",
	repository: "harnessy-v2",
	lane,
	sourceRevision: "a".repeat(40),
	evaluatorDigest: "b".repeat(64),
	workloadDigest: "c".repeat(64),
});
const approve = (store: EngineeringStore, value = job(), at = now, expires = at + 10 * ENGINEERING_PILOT.windowMs) => {
	const grant = engineeringGrant(value, at, expires);
	store.approve(value, grant, at);
	return { job: value, grant };
};
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("engineering controller durable ledger", () => {
	it("binds approval to exact canonical job content and refuses worker approval flags", () => {
		const { store } = fixture();
		const value = job();
		const grant = engineeringGrant(value, now, now + 1000);
		expect(() => store.approve({ ...value, approved: true }, grant, now)).toThrow();
		expect(() => store.approve({ ...value, taskRevision: "e".repeat(64) }, grant, now)).toThrow(/bind/);
		store.approve(value, grant, now);
		const reordered = Object.fromEntries(Object.entries(value).reverse());
		expect(engineeringJobDigest(reordered)).toBe(engineeringJobDigest(value));
		expect(() => store.reserve(value.id, randomUUID(), "x", now)).toThrow(/authority/);
	});
	it("reserves once across handles and returns the same run after a lost acknowledgment", () => {
		const { store, path } = fixture();
		const second = new EngineeringStore(path);
		stores.push(second);
		const { job: value, grant } = approve(store);
		const first = store.reserve(value.id, grant.id, "stable-launch", now);
		expect(second.reserve(value.id, grant.id, "stable-launch", now + 1)).toEqual(first);
		expect(() => second.reserve(value.id, grant.id, "new-launch", now + 2)).toThrow(/capacity/);
		const other = approve(store, job(), now + 3);
		expect(() => store.reserve(other.job.id, other.grant.id, "stable-launch", now + 4)).toThrow(/conflict/);
		expect(store.events()).toHaveLength(1);
	});
	it("arbitrates simultaneous independent operating-system processes with SQLite", async () => {
		const { store, path } = fixture();
		const { job: value, grant } = approve(store);
		const module = new URL("../src/engineering/store.ts", import.meta.url).href;
		const run = (identity: string) =>
			new Promise<number>((resolve, reject) => {
				const script = `import { EngineeringStore } from ${JSON.stringify(module)};
const s=new EngineeringStore(process.argv[1]);
try { s.reserve(process.argv[2],process.argv[3],process.argv[4],${now}); process.exitCode=0; }
catch(e) { if(!String(e).includes('capacity')) throw e; process.exitCode=2; }
finally { s.close(); }`;
				const child = spawn(
					process.execPath,
					["--input-type=module", "-e", script, path, value.id, grant.id, identity],
					{ cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", "ignore", "pipe"] },
				);
				let error = "";
				child.stderr.on("data", (data: Buffer) => {
					error += data.toString();
				});
				child.on("error", reject);
				child.on("close", (code) => (code === 0 || code === 2 ? resolve(code) : reject(new Error(error))));
			});
		expect((await Promise.all([run("child-a"), run("child-b")])).sort()).toEqual([0, 2]);
		expect(store.events()).toHaveLength(1);
	});
	it("keeps capacity on restart and expiry until actual process reconciliation", () => {
		const { store, path } = fixture();
		const { job: value, grant } = approve(store);
		store.reserve(value.id, grant.id, "restart", now);
		store.start("restart", now);
		store.bindProcess("restart", "herdr:pane-1:generation-1", now);
		const reopened = new EngineeringStore(path);
		stores.push(reopened);
		expect(reopened.active()?.processIdentity).toBe("herdr:pane-1:generation-1");
		reopened.markUncertain("restart", "Transport timed out, process state unknown", now + 1);
		expect(() => reopened.reserve(value.id, grant.id, "retry", now + ENGINEERING_PILOT.windowMs)).toThrow(/capacity/);
		expect(() => reopened.assertAuthority("restart", now + ENGINEERING_PILOT.windowMs)).toThrow(/privileged/);
	});
	it("persists lane fairness independently of the rolling attempt window", () => {
		const { store } = fixture();
		const lanes: EngineeringJob["lane"][] = ["native", "security", "native", "maintenance", "native"];
		for (const [index, lane] of lanes.entries()) {
			const at = now + index * ENGINEERING_PILOT.windowMs;
			const { job: value, grant } = approve(store, job(lane), at);
			store.reserve(value.id, grant.id, `slot-${index}`, at);
			store.settle(`slot-${index}`, "failed", "Owned worker never created", at);
		}
		const at = now + lanes.length * ENGINEERING_PILOT.windowMs;
		// After native, native, maintenance, native, the next slot belongs to the native lane.
		const due = approve(store, job("native"), at);
		const wrong = approve(store, job("maintenance"), at);
		expect(() => store.reserve(wrong.job.id, wrong.grant.id, "wrong", at)).toThrow(/slot/);
		store.reserve(due.job.id, due.grant.id, "due", at);
		store.settle("due", "failed", "Owned worker never created", at);
	});
	it("yields a slot when its lane has no approved work, and keeps that lane's turn", () => {
		const { store } = fixture();
		// The first slot belongs to the native lane, and nothing native is approved.
		const first = approve(store, job("maintenance"));
		store.reserve(first.job.id, first.grant.id, "yielded", now);
		expect(store.events().at(-1)?.detail).toContain("native slot yielded, no approved native work");
		store.settle("yielded", "failed", "Owned worker never created", now);
		// The yielded slot did not advance: native work that arrives takes priority again.
		const native = approve(store, job("native"), now + 1);
		const maintenance = approve(store, job("maintenance"), now + 1);
		expect(() => store.reserve(maintenance.job.id, maintenance.grant.id, "blocked", now + 1)).toThrow(/slot/);
		store.reserve(native.job.id, native.grant.id, "native-first", now + 1);
	});
	it("counts every reservation against the daily cap and three objective failures", () => {
		const { store } = fixture();
		for (let index = 0; index < 6; index++) {
			const { job: value, grant } = approve(store, job("correctness"));
			store.reserve(value.id, grant.id, `daily-${index}`, now);
			store.settle(`daily-${index}`, "failed", "Verified not started", now);
		}
		const next = approve(store, job("correctness"));
		expect(() => store.reserve(next.job.id, next.grant.id, "seventh", now)).toThrow(/Daily/);
		const at = now + ENGINEERING_PILOT.windowMs;
		const objective = randomUUID();
		for (let index = 0; index < 3; index++) {
			const { job: value, grant } = approve(store, job("correctness", objective), at);
			store.reserve(value.id, grant.id, `objective-${index}`, at);
			store.settle(`objective-${index}`, "cancelled", "Termination confirmed", at);
		}
		const paused = approve(store, job("correctness", objective), at);
		expect(() => store.reserve(paused.job.id, paused.grant.id, "fourth", at)).toThrow(/three/);
	});
	it("records cancellation receipt separately from confirmed termination", () => {
		const { store } = fixture();
		const { job: value, grant } = approve(store);
		store.reserve(value.id, grant.id, "cancel", now);
		store.start("cancel", now);
		expect(store.requestCancellation("cancel", now).state).toBe("cancel_requested");
		expect(store.requestCancellation("cancel", now).state).toBe("cancel_requested");
		expect(store.active()?.id).toBe("cancel");
		expect(() => store.settle("cancel", "succeeded", "Forged", now)).toThrow(/verification/);
		store.settle("cancel", "cancelled", "Host confirmed termination", now);
		expect(store.active()).toBeUndefined();
		expect(store.events().map((event) => event.state)).toEqual([
			"reserved",
			"running",
			"cancel_requested",
			"cancelled",
		]);
		expect(store.events(2).map((event) => event.sequence)).toEqual([3, 4]);
	});
	it("refuses expiry, revocation, clock rollback and terminal rewrites", () => {
		const { store } = fixture();
		const { job: value, grant } = approve(store, job(), now, now + 100);
		store.reserve(value.id, grant.id, "revoked", now);
		store.start("revoked", now);
		store.revoke(grant.id, now + 1);
		expect(() => store.assertAuthority("revoked", now + 1)).toThrow(/revoked/);
		expect(() => store.approve(value, grant, now + 1)).toThrow(/reissued/);
		expect(() => store.beginVerification("revoked", now + 1)).toThrow(/revoked/);
		expect(() => store.requestCancellation("revoked", now)).toThrow(/clock/);
		store.settle("revoked", "failed", "No new effects", now + 1);
		expect(() => store.settle("revoked", "cancelled", "Changed", now + 1)).toThrow(/conflict/);
		const expired = approve(store, job(), now + 2, now + 3);
		expect(() => store.reserve(expired.job.id, expired.grant.id, "expired", now + 3)).toThrow(/expired/);
	});
	it("requires current verification for success and keeps monotonic event identity", () => {
		const { store } = fixture();
		const { job: value, grant } = approve(store);
		store.reserve(value.id, grant.id, "success", now);
		store.start("success", now);
		expect(() => store.settle("success", "succeeded", "Worker says passed", now)).toThrow(/verification/);
		store.beginVerification("success", now);
		store.settle("success", "succeeded", "Controller-issued evidence", now);
		expect(store.events().map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
		expect(() => store.events(-1)).toThrow(/cursor/);
	});
	it("rejects shared state directories and linked databases", () => {
		const { root, path } = fixture();
		symlinkSync(path, join(root, "linked.sqlite"));
		expect(() => new EngineeringStore(join(root, "linked.sqlite"))).toThrow();
		chmodSync(root, 0o755);
		expect(() => new EngineeringStore(path)).toThrow(/private/);
	});
});
