import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	applyCalendarPlan,
	type CalendarProvider,
	inspectCalendarRecovery,
	inspectLegacyCalendarRecovery,
	reconcileCalendarPlan,
	resolveCalendarRecovery,
	retireLegacyCalendarRecovery,
} from "../src/jarvis/calendar/apply.ts";
import { inspectCalendarPlan } from "../src/jarvis/calendar/plan.ts";

const suppliedCli = process.env.HARNESSY_CALENDAR_TEST_CLI;
if (suppliedCli !== undefined && (!isAbsolute(suppliedCli) || !statSync(suppliedCli).isFile()))
	throw new Error("HARNESSY_CALENDAR_TEST_CLI must be an existing absolute CLI file");

let root: string;
let path: string;
let hash: string;
let calls: Array<string>;
let provider: CalendarProvider;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "harnessy-calendar-apply-")));
	path = join(root, "plan-1.json");
	const start = new Date(Date.now() + 86_400_000).toISOString();
	const end = new Date(Date.now() + 88_200_000).toISOString();
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			plan_id: "plan-1",
			backend: "anytype",
			space_id: "space",
			blocks: ["first", "second"].map((id) => ({
				block_id: id,
				task_id: id,
				task_title: id,
				start,
				end,
				estimated_minutes: 30,
				reason: "approved",
			})),
		}),
		{ mode: 0o600 },
	);
	hash = inspectCalendarPlan(path).sha256;
	calls = [];
	provider = {
		binding: "synthetic-calendar",
		verifyIdentity: async () => {},
		createEvent: async (block, id) => {
			calls.push(block.block_id);
			return id;
		},
	};
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const receipts = () => {
	const db = new DatabaseSync(join(root, ".calendar-v2", "receipts.sqlite3"), { readOnly: true });
	try {
		return db.prepare("SELECT * FROM receipts ORDER BY block_id").all();
	} finally {
		db.close();
	}
};

const useThreeBlockPlan = () => {
	const start = new Date(Date.now() + 86_400_000).toISOString();
	const end = new Date(Date.now() + 88_200_000).toISOString();
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			plan_id: "plan-1",
			backend: "anytype",
			space_id: "space",
			blocks: ["first", "second", "third"].map((id) => ({
				block_id: id,
				task_id: id,
				task_title: id,
				start,
				end,
				estimated_minutes: 30,
				reason: "approved",
			})),
		}),
		{ mode: 0o600 },
	);
	hash = inspectCalendarPlan(path).sha256;
};

it("persists each receipt and makes a repeated completed apply read-only", async () => {
	const result = await applyCalendarPlan(path, hash, provider);
	expect(result.applied).toBe(2);
	expect(receipts().map((row) => row.status)).toEqual(["confirmed", "confirmed"]);
	expect((await applyCalendarPlan(path, hash, provider)).alreadyApplied).toBe(2);
	expect(calls).toEqual(["first", "second"]);
});

it("checkpoints before dispatch and preserves partial receipts without retry", async () => {
	const failing: CalendarProvider = {
		...provider,
		createEvent: async (block, id) => {
			calls.push(block.block_id);
			expect(receipts().find((row) => row.block_id === block.block_id)?.status).toBe("started");
			if (block.block_id === "second") throw new Error("PRIVATE_PROVIDER_ERROR");
			return id;
		},
	};
	await expect(applyCalendarPlan(path, hash, failing)).rejects.toThrow("uncertain");
	expect(receipts().map((row) => row.status)).toEqual(["confirmed", "started"]);
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("reconciliation required");
	expect(calls).toEqual(["first", "second"]);
});

it("rejects concurrent apply while an admitted provider operation is pending", async () => {
	let release: () => void = () => {};
	let admitted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		admitted = resolve;
	});
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const first = applyCalendarPlan(path, hash, {
		...provider,
		createEvent: async (_block, id) => {
			admitted();
			await wait;
			return id;
		},
	});
	await started;
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("reconciliation required");
	release();
	await first;
	expect(calls).toEqual([]);
});

it("rejects changed approval and legacy receipts before provider calls", async () => {
	await expect(applyCalendarPlan(path, "0".repeat(64), provider)).rejects.toThrow("approval");
	writeFileSync(join(root, "plan-1.apply.json"), "preserved legacy report");
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("legacy");
	expect(calls).toEqual([]);
});

it("classifies and explicitly retires a preserved legacy apply report without trusting it as native", async () => {
	useThreeBlockPlan();
	writeFileSync(
		join(root, "plan-1.apply.json"),
		JSON.stringify({
			version: 1,
			plan_id: "plan-1",
			applied_at: new Date().toISOString(),
			results: [
				{ block_id: "first", task_id: "first", status: "applied", event_id: "legacy-event" },
				{ block_id: "second", task_id: "second", status: "failed", error: "withheld" },
			],
		}),
		{ mode: 0o600 },
	);
	const recovery = inspectLegacyCalendarRecovery(path, hash);
	expect(recovery.blocks.map((block) => block.state)).toEqual([
		"legacy_reported_applied",
		"legacy_reported_failed",
		"never_reported",
	]);
	expect(recovery.retryAllowed).toBe(false);
	await expect(Promise.resolve().then(() => retireLegacyCalendarRecovery(path, hash, "0".repeat(64)))).rejects.toThrow(
		"does not match",
	);
	const result = retireLegacyCalendarRecovery(path, hash, recovery.recoverySha256);
	expect(result.action).toBe("legacy-retire");
	const db = new DatabaseSync(join(root, ".calendar-v2", "receipts.sqlite3"), { readOnly: true });
	try {
		expect(db.prepare("SELECT status, binding FROM plans WHERE id='plan-1'").get()).toMatchObject({
			status: "retired",
			binding: `legacy-report:${recovery.reportSha256}`,
		});
	} finally {
		db.close();
	}
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("legacy");
});

it("rejects changed provider binding after successful delivery", async () => {
	await applyCalendarPlan(path, hash, provider);
	await expect(applyCalendarPlan(path, hash, { ...provider, binding: "different" })).rejects.toThrow("changed");
	expect(calls).toHaveLength(2);
});

it("does not admit writes when identity validation fails", async () => {
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			verifyIdentity: async () => {
				throw new Error("wrong owner");
			},
		}),
	).rejects.toThrow("wrong owner");
	expect(receipts()).toEqual([]);
	expect(calls).toEqual([]);
});

it("does not report completion from an inconsistent receipt ledger", async () => {
	await applyCalendarPlan(path, hash, provider);
	const db = new DatabaseSync(join(root, ".calendar-v2", "receipts.sqlite3"));
	db.prepare("DELETE FROM receipts WHERE block_id='second'").run();
	db.close();
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("inconsistent");
	expect(calls).toHaveLength(2);
});

it("leaves unattempted events blocked without mutating receipts", async () => {
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			createEvent: async () => {
				throw new Error("uncertain");
			},
		}),
	).rejects.toThrow("uncertain");
	const before = receipts();
	const lookups: Array<string> = [];
	const result = await reconcileCalendarPlan(path, hash, {
		...provider,
		verifyEvent: async (block) => {
			lookups.push(block.block_id);
			return true;
		},
	});
	expect(result.reconciled).toBe(false);
	expect(result.retryAllowed).toBe(false);
	expect(lookups).toEqual(["first"]);
	expect(receipts()).toEqual(before);
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("reconciliation required");
});

it.each([
	{ failedBlock: "first", receiptStates: ["started"], neverAttempted: ["second", "third"] },
	{ failedBlock: "second", receiptStates: ["confirmed", "started"], neverAttempted: ["third"] },
])(
	"classifies failure at $failedBlock without treating later blocks as attempted",
	async ({ failedBlock, receiptStates, neverAttempted }) => {
		useThreeBlockPlan();
		await expect(
			applyCalendarPlan(path, hash, {
				...provider,
				createEvent: async (block, id) => {
					if (block.block_id === failedBlock) throw new Error("provider result unknown");
					return id;
				},
			}),
		).rejects.toThrow("uncertain");
		expect(receipts().map((row) => row.status)).toEqual(receiptStates);
		const recovery = await inspectCalendarRecovery(path, hash, {
			...provider,
			verifyEvent: async () => false,
		});
		expect(
			recovery.blocks.filter((block) => block.state === "never_attempted").map((block) => block.blockId),
		).toEqual(neverAttempted);
		expect(recovery.retryAllowed).toBe(false);
	},
);

it.each([
	{ remotelyPresent: true, expected: "uncertain_present" },
	{ remotelyPresent: false, expected: "uncertain_absent" },
])("binds remotely $expected uncertainty into the recovery approval", async ({ remotelyPresent, expected }) => {
	useThreeBlockPlan();
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			createEvent: async (block, id) => {
				if (block.block_id === "second") throw new Error("provider result unknown");
				return id;
			},
		}),
	).rejects.toThrow("uncertain");
	const recovery = await inspectCalendarRecovery(path, hash, {
		...provider,
		verifyEvent: async (block) => block.block_id === "second" && remotelyPresent,
	});
	expect(recovery.blocks.map((block) => block.state)).toEqual(["confirmed", expected, "never_attempted"]);
	const changed = await inspectCalendarRecovery(path, hash, {
		...provider,
		verifyEvent: async () => !remotelyPresent,
	});
	expect(changed.recoverySha256).not.toBe(recovery.recoverySha256);
});

it("retires attempted blocks and creates a separately reviewable residual plan", async () => {
	useThreeBlockPlan();
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			createEvent: async (block, id) => {
				if (block.block_id === "second") throw new Error("provider result unknown");
				return id;
			},
		}),
	).rejects.toThrow("uncertain");
	const reader = { ...provider, verifyEvent: async () => false };
	const recovery = await inspectCalendarRecovery(path, hash, reader);
	const residualPath = join(root, "plan-1-residual.json");
	const result = await resolveCalendarRecovery(path, hash, recovery.recoverySha256, reader, {
		action: "residual",
		residualPlanPath: residualPath,
	});
	expect(result.attemptedBlocksRetired).toBe(2);
	expect(result.residualPlan?.blocks).toBe(1);
	const residual = inspectCalendarPlan(residualPath);
	expect(residual.plan.blocks.map((block) => block.block_id)).toEqual(["third"]);
	expect(residual.sha256).toBe(result.residualPlan?.sha256);
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("reconciliation required");
});

it("admits only one concurrent recovery resolution and never overwrites an output", async () => {
	useThreeBlockPlan();
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			createEvent: async () => {
				throw new Error("provider result unknown");
			},
		}),
	).rejects.toThrow("uncertain");
	const reader = { ...provider, verifyEvent: async () => false };
	const recovery = await inspectCalendarRecovery(path, hash, reader);
	const ledgerBefore = readRecoveryLedger();
	const protectedOutput = join(root, "protected.json");
	writeFileSync(protectedOutput, "owner content", { mode: 0o600 });
	await expect(
		resolveCalendarRecovery(path, hash, recovery.recoverySha256, reader, {
			action: "residual",
			residualPlanPath: protectedOutput,
		}),
	).rejects.toThrow("does not match the approved bytes");
	expect(readFileSync(protectedOutput, "utf8")).toBe("owner content");
	expect(readRecoveryLedger()).toEqual(ledgerBefore);
	expect((await inspectCalendarRecovery(path, hash, reader)).recoverySha256).toBe(recovery.recoverySha256);
	const outputs = [join(root, "residual-a.json"), join(root, "residual-b.json")];
	const results = await Promise.allSettled(
		outputs.map((residualPlanPath) =>
			resolveCalendarRecovery(path, hash, recovery.recoverySha256, reader, {
				action: "residual",
				residualPlanPath,
			}),
		),
	);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(outputs.filter((output) => existsSync(output))).toHaveLength(1);
});

const readRecoveryLedger = () => {
	const db = new DatabaseSync(join(root, ".calendar-v2", "receipts.sqlite3"), { readOnly: true });
	try {
		return {
			plan: db.prepare("SELECT * FROM plans WHERE id='plan-1'").get(),
			resolutions: db.prepare("SELECT * FROM resolutions ORDER BY recovery_sha256").all(),
		};
	} finally {
		db.close();
	}
};

const prepareResidualRecovery = async () => {
	useThreeBlockPlan();
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			createEvent: async (block, id) => {
				if (block.block_id === "second") throw new Error("provider result unknown");
				return id;
			},
		}),
	).rejects.toThrow("uncertain");
	const reader = { ...provider, verifyEvent: async () => false };
	const recovery = await inspectCalendarRecovery(path, hash, reader);
	const residualPath = join(root, "plan-1-residual.json");
	const plan = inspectCalendarPlan(path).plan;
	const bytes = Buffer.from(
		`${JSON.stringify({ ...plan, plan_id: "plan-1-residual", blocks: [plan.blocks[2]] }, null, 2)}\n`,
	);
	return {
		reader,
		recovery,
		residualPath,
		pendingPath: `${residualPath}.pending-${recovery.recoverySha256}`,
		bytes,
	};
};

it("recovers a durable pending residual before retiring its source plan", async () => {
	const prepared = await prepareResidualRecovery();
	writeFileSync(prepared.pendingPath, prepared.bytes, { mode: 0o600 });
	const result = await resolveCalendarRecovery(path, hash, prepared.recovery.recoverySha256, prepared.reader, {
		action: "residual",
		residualPlanPath: prepared.residualPath,
	});
	expect(result.residualPlan?.blocks).toBe(1);
	expect(readFileSync(prepared.residualPath)).toEqual(prepared.bytes);
	expect(existsSync(prepared.pendingPath)).toBe(false);
	expect(readRecoveryLedger().plan).toMatchObject({ status: "retired" });
});

it("recovers an already-published residual before retiring its source plan", async () => {
	const prepared = await prepareResidualRecovery();
	writeFileSync(prepared.pendingPath, prepared.bytes, { mode: 0o600 });
	writeFileSync(prepared.residualPath, prepared.bytes, { mode: 0o600 });
	const result = await resolveCalendarRecovery(path, hash, prepared.recovery.recoverySha256, prepared.reader, {
		action: "residual",
		residualPlanPath: prepared.residualPath,
	});
	expect(result.residualPlan?.blocks).toBe(1);
	expect(readFileSync(prepared.residualPath)).toEqual(prepared.bytes);
	expect(existsSync(prepared.pendingPath)).toBe(false);
	expect(readRecoveryLedger().plan).toMatchObject({ status: "retired" });
});

it("requires a fresh recovery approval when remote uncertainty changes", async () => {
	useThreeBlockPlan();
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			createEvent: async () => {
				throw new Error("provider result unknown");
			},
		}),
	).rejects.toThrow("uncertain");
	const absent = { ...provider, verifyEvent: async () => false };
	const recovery = await inspectCalendarRecovery(path, hash, absent);
	await expect(
		resolveCalendarRecovery(
			path,
			hash,
			recovery.recoverySha256,
			{ ...provider, verifyEvent: async () => true },
			{
				action: "retire",
			},
		),
	).rejects.toThrow("approval does not match");
	expect(readFileSync(path, "utf8")).toContain('"plan_id":"plan-1"');
});

it("permits explicit retirement after blocks elapse but never makes them retryable", async () => {
	useThreeBlockPlan();
	await expect(
		applyCalendarPlan(path, hash, {
			...provider,
			createEvent: async () => {
				throw new Error("provider result unknown");
			},
		}),
	).rejects.toThrow("uncertain");
	vi.useFakeTimers();
	try {
		vi.setSystemTime(Date.now() + 172_800_000);
		const reader = { ...provider, verifyEvent: async () => false };
		const recovery = await inspectCalendarRecovery(path, hash, reader);
		expect(recovery.blocks.every((block) => block.elapsed)).toBe(true);
		const result = await resolveCalendarRecovery(path, hash, recovery.recoverySha256, reader, { action: "retire" });
		expect(result.residualPlan).toBeNull();
		await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("reconciliation required");
	} finally {
		vi.useRealTimers();
	}
});

it("refuses changed state during receipt verification", async () => {
	await applyCalendarPlan(path, hash, provider);
	await expect(
		reconcileCalendarPlan(path, hash, {
			...provider,
			verifyEvent: async () => {
				const db = new DatabaseSync(join(root, ".calendar-v2", "receipts.sqlite3"));
				db.prepare("UPDATE plans SET status='uncertain'").run();
				db.close();
				return true;
			},
		}),
	).rejects.toThrow("state changed");
	await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("reconciliation required");
});

it.runIf(process.platform !== "win32")(
	"recovers accepted events after a real process crash without resending",
	async () => {
		const childPath = join(root, "crash.mjs");
		const external = join(root, "external.json");
		writeFileSync(
			childPath,
			`import { writeFileSync } from 'node:fs';
import { applyCalendarPlan } from ${JSON.stringify(new URL("../src/jarvis/calendar/apply.ts", import.meta.url).href)};
const events = [];
await applyCalendarPlan(${JSON.stringify(path)}, ${JSON.stringify(hash)}, {
 binding: 'synthetic-calendar', verifyIdentity: async () => {},
 createEvent: async (block, id) => {
  events.push({ blockId: block.block_id, id });
  writeFileSync(${JSON.stringify(external)}, JSON.stringify(events));
  if (block.block_id === 'second') process.kill(process.pid, 'SIGKILL');
  return id;
 }
});`,
			{ mode: 0o600 },
		);
		const guard = fileURLToPath(
			new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url),
		);
		const child = spawnSync(process.execPath, ["--experimental-strip-types", childPath], {
			cwd: root,
			env: { HOME: root, NODE_OPTIONS: `--import=${guard}` },
			timeout: 15000,
			encoding: "utf8",
		});
		expect(child.signal).toBe("SIGKILL");
		expect(receipts().map((row) => row.status)).toEqual(["confirmed", "started"]);
		const events: Array<{ blockId: string; id: string }> = JSON.parse(readFileSync(external, "utf8"));
		expect(events).toHaveLength(2);
		await expect(applyCalendarPlan(path, hash, provider)).rejects.toThrow("reconciliation required");
		const result = await reconcileCalendarPlan(path, hash, {
			...provider,
			verifyEvent: async (block, id) => events.some((event) => event.blockId === block.block_id && event.id === id),
		});
		expect(result.reconciled).toBe(true);
		expect(receipts().map((row) => row.status)).toEqual(["confirmed", "confirmed"]);
		expect((await applyCalendarPlan(path, hash, provider)).alreadyApplied).toBe(2);
		expect(calls).toEqual([]);
		expect(JSON.parse(readFileSync(external, "utf8"))).toEqual(events);
	},
);

it.runIf(process.platform !== "win32")(
	"real CLI and synthetic Google executable preserve receipts and fail nonzero on uncertain delivery",
	() => {
		const config = join(root, "google");
		mkdirSync(config, { mode: 0o700 });
		const executable = join(root, "synthetic-gws");
		const log = join(root, "provider.jsonl");
		writeFileSync(
			executable,
			`#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.slice(0, 3).join(' ') === 'calendar calendars get') console.log(JSON.stringify({ id: 'owner@example.test' }));
else if (args.slice(0, 3).join(' ') === 'calendar events insert') {
 const event = JSON.parse(args[args.indexOf('--json') + 1]);
 appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
 writeFileSync(${JSON.stringify(root)} + '/' + event.id + '.json', JSON.stringify({ ...event, status: 'confirmed' }));
 if (event.summary === 'Jarvis: second' && existsSync(${JSON.stringify(join(root, "fail"))})) { console.error('PRIVATE_ERROR'); process.exit(1); }
 console.log(JSON.stringify({ id: event.id }));
} else if (args.slice(0, 3).join(' ') === 'calendar events get') {
 const params = JSON.parse(args[args.indexOf('--params') + 1]);
 console.log(readFileSync(${JSON.stringify(root)} + '/' + params.eventId + '.json', 'utf8'));
} else process.exit(2);
`,
			{ mode: 0o700 },
		);
		const cli =
			suppliedCli === undefined
				? fileURLToPath(new URL("../src/cli.ts", import.meta.url))
				: realpathSync(suppliedCli);
		const guard = fileURLToPath(
			new URL("../../harnessy-local-host/test/support/fixture-network-guard.mjs", import.meta.url),
		);
		const run = (operation = "apply") =>
			spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					cli,
					"jarvis",
					"calendar",
					operation,
					"--plan",
					path,
					"--approve-sha256",
					hash,
					"--google-executable",
					executable,
					"--google-config",
					config,
					"--google-account",
					"owner@example.test",
				],
				{
					cwd: root,
					env: { HOME: root, NODE_NO_WARNINGS: "1", NODE_OPTIONS: `--import=${guard}` },
					encoding: "utf8",
					timeout: 15000,
				},
			);
		writeFileSync(join(root, "fail"), "fail after simulated create");
		const failed = run();
		expect(failed.status).not.toBe(0);
		expect(failed.stderr).not.toContain("PRIVATE_ERROR");
		expect(receipts().map((row) => row.status)).toEqual(["confirmed", "started"]);
		const before = readFileSync(log, "utf8");
		expect(run().status).not.toBe(0);
		expect(readFileSync(log, "utf8")).toBe(before);
		const eventPath = join(root, `${receipts()[1]?.request_id}.json`);
		const original = readFileSync(eventPath, "utf8");
		writeFileSync(eventPath, JSON.stringify({ ...JSON.parse(original), summary: "changed remotely" }));
		const mismatch = run("reconcile");
		expect(mismatch.status).not.toBe(0);
		expect(JSON.parse(mismatch.stdout).reconciled).toBe(false);
		expect(receipts()[1]?.status).toBe("started");
		writeFileSync(eventPath, original);
		const recovered = run("reconcile");
		expect(recovered.status, recovered.stderr).toBe(0);
		expect(JSON.parse(recovered.stdout).reconciled).toBe(true);
		expect(receipts().map((row) => row.status)).toEqual(["confirmed", "confirmed"]);
		expect(run().status).toBe(0);
		expect(readFileSync(log, "utf8")).toBe(before);
	},
);
