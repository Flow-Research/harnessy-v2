import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { FathomFileStore, fathomFileStoreStateFile } from "../src/jarvis/fathom/file-store.ts";

const envelope = (account: string, id: string) => ({
	version: 1 as const,
	verified: true as const,
	account,
	source: "fathom-api" as const,
	fetchedAt: "2026-09-18T00:00:00.000Z",
	payload: { recording_id: id },
});

describe("FathomFileStore", () => {
	it("rejects stale same-account saves and retains other accounts", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-cas-"));
		const options = { inboxRoot: join(root, "inbox"), stateRoot: join(root, "state") };
		const first = new FathomFileStore(options),
			stale = new FathomFileStore(options);
		await first.loadCheckpoint("personal");
		await stale.loadCheckpoint("personal");
		const checkpoint = {
			cursor: "next",
			seen: { one: "hash" },
			updatedAt: null,
			windowCreatedAfter: "2026-09-18T00:00:00Z",
		};
		await first.saveCheckpoint("personal", checkpoint);
		await expect(stale.saveCheckpoint("personal", { cursor: null, seen: {}, updatedAt: null })).rejects.toThrow(
			"checkpoint changed",
		);
		expect(await first.loadCheckpoint("personal")).toEqual(checkpoint);
		await expect(first.saveCheckpoint("personal", { ...checkpoint, cursor: null })).rejects.toThrow(
			"invalid V2 Fathom checkpoint",
		);
	});

	it("fails closed on a crash-left checkpoint lock and malformed persisted state", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-lock-"));
		const store = new FathomFileStore({ inboxRoot: root, stateRoot: root });
		const lock = join(root, `${fathomFileStoreStateFile}.lock`);
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					'import { openSync } from "node:fs"; openSync(process.argv[1], "wx", 0o600); process.exit(0);',
					lock,
				],
				{ stdio: "ignore" },
			);
			child.on("error", reject);
			child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
		});
		await expect(store.saveCheckpoint("personal", { cursor: null, seen: {}, updatedAt: null })).rejects.toThrow();
		expect(readFileSync(lock)).toHaveLength(0);
		writeFileSync(join(root, fathomFileStoreStateFile), '{"version":1,"accounts":{"x":{"cursor":null}}}');
		await expect(store.loadCheckpoint("personal")).rejects.toThrow("invalid");
		await expect(store.putPending("../escape", "1", envelope("personal", "1"))).rejects.toThrow("account path");
	});

	it("preserves one envelope and every account across independent processes", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-process-"));
		const moduleUrl = new URL("../src/jarvis/fathom/file-store.ts", import.meta.url).href;
		const script = join(root, "writer.mjs");
		writeFileSync(
			script,
			`import { FathomFileStore } from ${JSON.stringify(moduleUrl)};
import { setTimeout } from 'node:timers/promises';
const [root, id] = process.argv.slice(2);
const store = new FathomFileStore({inboxRoot: root + '/inbox', stateRoot: root + '/state'});
await store.loadCheckpoint('account' + id);
const result = await store.putPending('shared', '1', {version:1,verified:true,account:'shared',source:'fathom-api',fetchedAt:id,payload:{recording_id:'1',writer:id}});
for(let attempt=0;;attempt++) { try { await store.saveCheckpoint('account' + id, {cursor:id,seen:{},updatedAt:null}); break; }
catch(error) { if(error.code !== 'EEXIST' || attempt >= 100) throw error; await setTimeout(5); } }
console.log(JSON.stringify({id,result}));`,
		);
		const results = await Promise.all(
			["0", "1", "2", "3"].map(
				(id) =>
					new Promise<{ id: string; result: string }>((resolve, reject) => {
						const child = spawn(process.execPath, ["--experimental-strip-types", script, root, id], {
							stdio: ["ignore", "pipe", "pipe"],
						});
						let out = "",
							error = "";
						child.stdout.on("data", (data) => {
							out += data;
						});
						child.stderr.on("data", (data) => {
							error += data;
						});
						child.on("error", reject);
						child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(error))));
					}),
			),
		);
		expect(results.filter((row) => row.result === "imported")).toHaveLength(1);
		const winner = results.find((row) => row.result === "imported")!;
		const pending = join(root, "inbox", "shared", "pending");
		const files = readdirSync(pending);
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(pending, files[0]), "utf8")).payload.writer).toBe(winner.id);
		const store = new FathomFileStore({ inboxRoot: root, stateRoot: join(root, "state") });
		for (const row of results) expect((await store.loadCheckpoint(`account${row.id}`)).cursor).toBe(row.id);
	}, 15000);

	it("writes pending envelopes atomically and deduplicates recording IDs", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-store-"));
		const store = new FathomFileStore({ inboxRoot: join(root, "inbox"), stateRoot: join(root, "state") });
		expect(await store.putPending("personal", "123", envelope("personal", "123"))).toBe("imported");
		expect(await store.putPending("personal", "123", envelope("personal", "123"))).toBe("duplicate");
		const checkpoint = { cursor: "next", seen: { "123": "hash" }, updatedAt: "2026-09-18T00:01:00.000Z" };
		await store.saveCheckpoint("personal", checkpoint);
		expect(await store.loadCheckpoint("personal")).toEqual(checkpoint);
		expect(readFileSync(join(root, "state", fathomFileStoreStateFile), "utf8")).toContain('"version": 1');
	});

	it("keeps account checkpoints isolated", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnessy-fathom-store-"));
		const store = new FathomFileStore({ inboxRoot: join(root, "inbox"), stateRoot: join(root, "state") });
		await store.saveCheckpoint("personal", { cursor: "personal", seen: {}, updatedAt: null });
		await store.saveCheckpoint("flowresearch", { cursor: "flow", seen: {}, updatedAt: null });
		expect((await store.loadCheckpoint("personal")).cursor).toBe("personal");
		expect((await store.loadCheckpoint("flowresearch")).cursor).toBe("flow");
	});
});
