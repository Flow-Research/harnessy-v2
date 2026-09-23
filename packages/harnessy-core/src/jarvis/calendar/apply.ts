import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import { type CalendarBlock, inspectCalendarPlan } from "./plan.ts";

export interface CalendarProvider {
	readonly binding: string;
	verifyIdentity(): Promise<void>;
	createEvent(block: CalendarBlock, requestId: string): Promise<string>;
}

export interface CalendarReceiptReader {
	readonly binding: string;
	verifyIdentity(): Promise<void>;
	verifyEvent(block: CalendarBlock, requestId: string): Promise<boolean>;
}

const requestIdentity = (planId: string, hash: string, blockId: string, binding: string) =>
	createHash("sha256")
		.update(JSON.stringify([planId, hash, blockId, binding]))
		.digest("hex");

const recoveryIdentity = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const openReceipts = (planPath: string, create: boolean) => {
	const root = join(dirname(resolve(planPath)), ".calendar-v2");
	if (create && !existsSync(root)) mkdirSync(root, { mode: 0o700 });
	const directory = lstatSync(root);
	if (
		realpathSync(root) !== root ||
		!directory.isDirectory() ||
		(directory.mode & 0o077) !== 0 ||
		(process.geteuid !== undefined && directory.uid !== process.geteuid())
	)
		throw new Error("Unsafe calendar state directory");
	const databasePath = join(root, "receipts.sqlite3");
	if (create && !existsSync(databasePath)) {
		closeSync(openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
	}
	const file = lstatSync(databasePath);
	if (
		!file.isFile() ||
		file.nlink !== 1 ||
		(file.mode & 0o077) !== 0 ||
		(process.geteuid !== undefined && file.uid !== process.geteuid())
	)
		throw new Error("Unsafe calendar receipt database");
	return new DatabaseSync(databasePath);
};

const initializeReceipts = (db: DatabaseSync) =>
	db.exec(`PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, binding TEXT NOT NULL, status TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS receipts (plan_id TEXT NOT NULL, block_id TEXT NOT NULL, request_id TEXT NOT NULL,
 status TEXT NOT NULL, event_id TEXT, PRIMARY KEY(plan_id, block_id)) STRICT;
CREATE TABLE IF NOT EXISTS resolutions (plan_id TEXT PRIMARY KEY, recovery_sha256 TEXT NOT NULL, action TEXT NOT NULL,
 residual_plan_id TEXT, residual_path TEXT, residual_sha256 TEXT) STRICT;`);

const readLedger = (db: DatabaseSync, planId: string) => ({
	plan: db.prepare("SELECT * FROM plans WHERE id=?").get(planId),
	receipts: db.prepare("SELECT * FROM receipts WHERE plan_id=? ORDER BY block_id").all(planId),
});

const validateLedger = (
	plan: ReturnType<typeof inspectCalendarPlan>["plan"],
	approvedSha256: string,
	binding: string,
	ledger: ReturnType<typeof readLedger>,
) => {
	if (
		!ledger.plan ||
		ledger.plan.sha256 !== approvedSha256 ||
		ledger.plan.binding !== binding ||
		!["active", "uncertain", "complete", "retired"].includes(String(ledger.plan.status))
	)
		throw new Error("Calendar plan or provider changed; recovery refused");
	for (const receipt of ledger.receipts) {
		const block = plan.blocks.find((candidate) => candidate.block_id === receipt.block_id);
		if (
			!block ||
			receipt.request_id !== requestIdentity(plan.plan_id, approvedSha256, block.block_id, binding) ||
			!["started", "confirmed"].includes(String(receipt.status)) ||
			(receipt.status === "started" ? receipt.event_id !== null : receipt.event_id !== receipt.request_id)
		)
			throw new Error("Calendar receipts inconsistent; recovery refused");
	}
};

/** One explicitly approved invocation; no scheduler, automatic retry or lease expiry. */
export const applyCalendarPlan = async (planPath: string, approvedSha256: string, provider: CalendarProvider) => {
	const inspected = inspectCalendarPlan(planPath);
	if (!/^[a-f0-9]{64}$/.test(approvedSha256) || inspected.sha256 !== approvedSha256)
		throw new Error("Calendar plan approval does not match the current bytes");
	if (inspected.legacyApplyReportPresent)
		throw new Error("Reconcile the legacy calendar apply report before native delivery");
	if (!provider.binding || provider.binding.length > 10_000) throw new Error("Missing calendar provider binding");
	const binding = provider.binding;
	const { plan } = inspected;
	const db = openReceipts(planPath, true);
	try {
		initializeReceipts(db);
		const prior = db.prepare("SELECT * FROM plans WHERE id=?").get(plan.plan_id);
		if (prior) {
			if (prior.sha256 !== approvedSha256 || prior.binding !== binding)
				throw new Error("Calendar plan or provider changed; reconciliation required");
			if (prior.status !== "complete")
				throw new Error("Calendar delivery active or uncertain; reconciliation required");
			const receipts = db.prepare("SELECT * FROM receipts WHERE plan_id=?").all(plan.plan_id);
			if (
				receipts.length !== plan.blocks.length ||
				plan.blocks.some(
					(block) =>
						!receipts.some(
							(receipt) =>
								receipt.block_id === block.block_id &&
								receipt.status === "confirmed" &&
								receipt.request_id === requestIdentity(plan.plan_id, approvedSha256, block.block_id, binding) &&
								receipt.event_id === receipt.request_id,
						),
				)
			)
				throw new Error("Calendar receipts inconsistent; reconciliation required");
			return {
				applied: 0,
				alreadyApplied: plan.blocks.length,
				receipts,
			};
		}
		if (plan.blocks.some((block) => Date.parse(block.start) <= Date.now()))
			throw new Error("Calendar plan contains elapsed blocks; review a fresh plan");
		await provider.verifyIdentity();
		if (provider.binding !== binding) throw new Error("Calendar provider binding changed");
		// The unique insertion is the durable owner claim. A concurrent caller or
		// crashed owner never becomes eligible through timeout or blind retry.
		db.prepare("INSERT INTO plans VALUES(?,?,?,?)").run(plan.plan_id, approvedSha256, binding, "active");
		for (const block of plan.blocks) {
			const requestId = requestIdentity(plan.plan_id, approvedSha256, block.block_id, binding);
			db.prepare("INSERT INTO receipts VALUES(?,?,?,?,NULL)").run(
				plan.plan_id,
				block.block_id,
				requestId,
				"started",
			);
			await Effect.runPromise(
				Effect.tryPromise({
					try: async () => {
						if (provider.binding !== binding || Date.parse(block.start) <= Date.now())
							throw new Error("Eligibility changed");
						const eventId = await provider.createEvent(block, requestId);
						if (eventId !== requestId) throw new Error("Invalid calendar receipt");
						db.prepare("UPDATE receipts SET status='confirmed', event_id=? WHERE plan_id=? AND block_id=?").run(
							eventId,
							plan.plan_id,
							block.block_id,
						);
					},
					catch: () => {
						db.prepare("UPDATE plans SET status='uncertain' WHERE id=?").run(plan.plan_id);
						return new Error("Calendar delivery uncertain; reconcile receipts before another apply");
					},
				}),
			);
		}
		db.prepare("UPDATE plans SET status='complete' WHERE id=?").run(plan.plan_id);
		return {
			applied: plan.blocks.length,
			alreadyApplied: 0,
			receipts: db.prepare("SELECT * FROM receipts WHERE plan_id=?").all(plan.plan_id),
		};
	} finally {
		db.close();
	}
};

/** Inspect an incomplete delivery and bind its local and remote state to an operator-reviewable digest. */
export const inspectCalendarRecovery = async (
	planPath: string,
	approvedSha256: string,
	provider: CalendarReceiptReader,
) => {
	const inspected = inspectCalendarPlan(planPath);
	if (inspected.sha256 !== approvedSha256 || inspected.legacyApplyReportPresent)
		throw new Error("Calendar recovery requires the unchanged native plan");
	const binding = provider.binding;
	if (!binding || binding.length > 10_000) throw new Error("Missing calendar provider binding");
	const db = openReceipts(planPath, false);
	try {
		initializeReceipts(db);
		const ledger = readLedger(db, inspected.plan.plan_id);
		validateLedger(inspected.plan, approvedSha256, binding, ledger);
		const ledgerPlan = ledger.plan;
		if (!ledgerPlan) throw new Error("Calendar recovery ledger disappeared");
		if (ledgerPlan.status === "retired") throw new Error("Calendar plan is already retired");
		await provider.verifyIdentity();
		const blocks: Array<{
			blockId: string;
			state: "confirmed" | "uncertain_present" | "uncertain_absent" | "never_attempted";
			elapsed: boolean;
		}> = [];
		for (const block of inspected.plan.blocks) {
			if (provider.binding !== binding) throw new Error("Calendar provider changed");
			const receipt = ledger.receipts.find((candidate) => candidate.block_id === block.block_id);
			let state: (typeof blocks)[number]["state"];
			if (receipt?.status === "confirmed") state = "confirmed";
			else if (receipt?.status === "started")
				state = (await provider.verifyEvent(block, String(receipt.request_id)))
					? "uncertain_present"
					: "uncertain_absent";
			else state = "never_attempted";
			blocks.push({ blockId: block.block_id, state, elapsed: Date.parse(block.start) <= Date.now() });
		}
		if (provider.binding !== binding || inspectCalendarPlan(planPath).sha256 !== approvedSha256)
			throw new Error("Calendar recovery inputs changed");
		const snapshot = {
			kind: "harnessy.calendar.recovery-inspection" as const,
			planId: inspected.plan.plan_id,
			planSha256: approvedSha256,
			binding,
			ledgerStatus: String(ledgerPlan.status),
			ledgerSha256: recoveryIdentity(ledger),
			blocks,
		};
		return { ...snapshot, recoverySha256: recoveryIdentity(snapshot), retryAllowed: false as const };
	} finally {
		db.close();
	}
};

export interface CalendarRecoveryResolution {
	readonly action: "retire" | "residual";
	readonly residualPlanPath?: string;
}

/** Inspect a preserved V1 apply report without trusting it as a native delivery receipt. */
export const inspectLegacyCalendarRecovery = (planPath: string, approvedSha256: string) => {
	const inspected = inspectCalendarPlan(planPath);
	if (inspected.sha256 !== approvedSha256 || !inspected.legacyApplyReportPresent)
		throw new Error("Legacy calendar recovery requires the unchanged plan and apply report");
	const reportPath = join(dirname(resolve(planPath)), `${inspected.plan.plan_id}.apply.json`);
	const fd = openSync(reportPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let bytes: Buffer;
	try {
		const before = fstatSync(fd, { bigint: true });
		if (
			!before.isFile() ||
			before.nlink !== 1n ||
			before.size > 1_048_576n ||
			(before.mode & 0o022n) !== 0n ||
			(process.geteuid !== undefined && before.uid !== BigInt(process.geteuid()))
		)
			throw new Error("Unsafe legacy calendar apply report");
		bytes = readFileSync(fd);
		const after = fstatSync(fd, { bigint: true });
		if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
			throw new Error("Legacy calendar apply report changed while reading");
	} finally {
		closeSync(fd);
	}
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (
		!record(value) ||
		value.version !== 1 ||
		value.plan_id !== inspected.plan.plan_id ||
		!Array.isArray(value.results)
	)
		throw new Error("Invalid legacy calendar apply report");
	const results = new Map<string, Record<string, unknown>>();
	for (const result of value.results) {
		if (
			!record(result) ||
			typeof result.block_id !== "string" ||
			results.has(result.block_id) ||
			!inspected.plan.blocks.some((block) => block.block_id === result.block_id && block.task_id === result.task_id)
		)
			throw new Error("Invalid legacy calendar apply result");
		results.set(result.block_id, result);
	}
	const blocks = inspected.plan.blocks.map((block) => {
		const result = results.get(block.block_id);
		const status = result?.status;
		return {
			blockId: block.block_id,
			state:
				result === undefined
					? ("never_reported" as const)
					: status === "applied" || status === "already_applied"
						? ("legacy_reported_applied" as const)
						: status === "failed"
							? ("legacy_reported_failed" as const)
							: ("legacy_reported_unknown" as const),
		};
	});
	const snapshot = {
		kind: "harnessy.calendar.legacy-recovery-inspection" as const,
		planId: inspected.plan.plan_id,
		planSha256: approvedSha256,
		reportSha256: createHash("sha256").update(bytes).digest("hex"),
		blocks,
	};
	return { ...snapshot, recoverySha256: recoveryIdentity(snapshot), retryAllowed: false as const };
};

/** Durably retire a V1 apply report. The report remains preserved and can never authorize a native replay. */
export const retireLegacyCalendarRecovery = (
	planPath: string,
	approvedSha256: string,
	approvedRecoverySha256: string,
) => {
	if (!/^[a-f0-9]{64}$/.test(approvedRecoverySha256)) throw new Error("Invalid legacy recovery approval");
	const recovery = inspectLegacyCalendarRecovery(planPath, approvedSha256);
	if (recovery.recoverySha256 !== approvedRecoverySha256)
		throw new Error("Legacy calendar recovery approval does not match current state");
	const db = openReceipts(planPath, true);
	let committed = false;
	try {
		initializeReceipts(db);
		db.exec("BEGIN IMMEDIATE");
		try {
			const prior = db.prepare("SELECT * FROM plans WHERE id=?").get(recovery.planId);
			if (prior) throw new Error("Calendar plan already has native state; legacy retirement refused");
			db.prepare("INSERT INTO plans VALUES(?,?,?,?)").run(
				recovery.planId,
				approvedSha256,
				`legacy-report:${recovery.reportSha256}`,
				"retired",
			);
			db.prepare("INSERT INTO resolutions VALUES(?,?,?,?,?,?)").run(
				recovery.planId,
				approvedRecoverySha256,
				"legacy-retire",
				null,
				null,
				null,
			);
			db.exec("COMMIT");
			committed = true;
		} finally {
			if (!committed) db.exec("ROLLBACK");
		}
		return {
			resolved: true as const,
			action: "legacy-retire" as const,
			retiredPlanId: recovery.planId,
			preservedReportSha256: recovery.reportSha256,
			retryAllowed: false as const,
		};
	} finally {
		db.close();
	}
};

/** Resolve an operator-approved recovery snapshot without ever replaying an attempted event. */
export const resolveCalendarRecovery = async (
	planPath: string,
	approvedSha256: string,
	approvedRecoverySha256: string,
	provider: CalendarReceiptReader,
	resolution: CalendarRecoveryResolution,
) => {
	if (!/^[a-f0-9]{64}$/.test(approvedRecoverySha256)) throw new Error("Invalid calendar recovery approval");
	const recovery = await inspectCalendarRecovery(planPath, approvedSha256, provider);
	if (recovery.recoverySha256 !== approvedRecoverySha256)
		throw new Error("Calendar recovery approval does not match current state");
	const inspected = inspectCalendarPlan(planPath);
	const neverAttempted = inspected.plan.blocks.filter(
		(block) => recovery.blocks.find((candidate) => candidate.blockId === block.block_id)?.state === "never_attempted",
	);
	if (resolution.action === "residual" && neverAttempted.length === 0)
		throw new Error("Calendar recovery has no never-attempted blocks for a residual plan");
	if (resolution.action === "retire" && resolution.residualPlanPath !== undefined)
		throw new Error("A retired calendar recovery cannot specify a residual plan");

	let residual: { path: string; temporaryPath: string; bytes: Buffer; planId: string; sha256: string } | undefined;
	if (resolution.action === "residual") {
		if (!resolution.residualPlanPath) throw new Error("Residual calendar recovery requires an output path");
		const output = resolve(resolution.residualPlanPath);
		if (existsSync(output) || realpathSync(dirname(output)) !== dirname(output))
			throw new Error("Residual calendar plan output must be a new file in a canonical directory");
		const planId = basename(output, ".json");
		if (basename(output) !== `${planId}.json` || !/^[A-Za-z0-9_-]{1,128}$/.test(planId))
			throw new Error("Residual calendar plan requires a safe .json plan ID");
		const value = { ...inspected.plan, plan_id: planId, blocks: neverAttempted };
		const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
		residual = {
			path: output,
			temporaryPath: `${output}.pending-${approvedRecoverySha256}`,
			bytes,
			planId,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	}

	const db = openReceipts(planPath, false);
	let committed = false;
	try {
		initializeReceipts(db);
		db.exec("BEGIN IMMEDIATE");
		try {
			const ledger = readLedger(db, inspected.plan.plan_id);
			validateLedger(inspected.plan, approvedSha256, provider.binding, ledger);
			const ledgerPlan = ledger.plan;
			if (!ledgerPlan) throw new Error("Calendar recovery ledger disappeared");
			if (ledgerPlan.status === "retired") throw new Error("Calendar plan is already retired");
			if (
				recoveryIdentity({
					kind: recovery.kind,
					planId: recovery.planId,
					planSha256: recovery.planSha256,
					binding: recovery.binding,
					ledgerStatus: String(ledgerPlan.status),
					ledgerSha256: recoveryIdentity(ledger),
					blocks: recovery.blocks,
				}) !== approvedRecoverySha256
			)
				throw new Error("Calendar recovery state changed; inspect again");
			if (residual) {
				const fd = openSync(
					residual.temporaryPath,
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
					0o600,
				);
				try {
					writeFileSync(fd, residual.bytes);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
			}
			db.prepare("INSERT INTO resolutions VALUES(?,?,?,?,?,?)").run(
				inspected.plan.plan_id,
				approvedRecoverySha256,
				resolution.action,
				residual?.planId ?? null,
				residual?.path ?? null,
				residual?.sha256 ?? null,
			);
			db.prepare("UPDATE plans SET status='retired' WHERE id=?").run(inspected.plan.plan_id);
			db.exec("COMMIT");
			committed = true;
		} finally {
			if (!committed) {
				db.exec("ROLLBACK");
				if (residual && existsSync(residual.temporaryPath)) unlinkSync(residual.temporaryPath);
			}
		}
		if (residual) {
			linkSync(residual.temporaryPath, residual.path);
			unlinkSync(residual.temporaryPath);
		}
		return {
			resolved: true as const,
			action: resolution.action,
			retiredPlanId: inspected.plan.plan_id,
			attemptedBlocksRetired: recovery.blocks.filter((block) => block.state !== "never_attempted").length,
			residualPlan: residual
				? { path: residual.path, planId: residual.planId, sha256: residual.sha256, blocks: neverAttempted.length }
				: null,
		};
	} finally {
		db.close();
	}
};

/** Recover receipts only. Never clears an owner claim or sends/retries an event. */
export const reconcileCalendarPlan = async (
	planPath: string,
	approvedSha256: string,
	provider: CalendarReceiptReader,
) => {
	const inspected = inspectCalendarPlan(planPath);
	if (inspected.sha256 !== approvedSha256 || inspected.legacyApplyReportPresent)
		throw new Error("Calendar reconciliation requires the unchanged native plan");
	const { plan } = inspected;
	const binding = provider.binding;
	const db = openReceipts(planPath, false);
	try {
		initializeReceipts(db);
		const snapshot = () => readLedger(db, plan.plan_id);
		const before = snapshot();
		if (
			!before.plan ||
			before.plan.sha256 !== approvedSha256 ||
			before.plan.binding !== binding ||
			!["active", "uncertain", "complete"].includes(String(before.plan.status))
		)
			throw new Error("Calendar plan or provider changed; reconciliation refused");
		for (const receipt of before.receipts) {
			const block = plan.blocks.find((candidate) => candidate.block_id === receipt.block_id);
			if (
				!block ||
				receipt.request_id !== requestIdentity(plan.plan_id, approvedSha256, block.block_id, binding) ||
				!["started", "confirmed"].includes(String(receipt.status)) ||
				(receipt.status === "started" ? receipt.event_id !== null : receipt.event_id !== receipt.request_id)
			)
				throw new Error("Calendar receipts inconsistent; reconciliation refused");
		}
		await provider.verifyIdentity();
		const blocks: Array<{ blockId: string; verified: boolean }> = [];
		for (const block of plan.blocks) {
			if (provider.binding !== binding) throw new Error("Calendar provider changed");
			const receipt = before.receipts.find((candidate) => candidate.block_id === block.block_id);
			const verified = receipt !== undefined && (await provider.verifyEvent(block, String(receipt.request_id)));
			blocks.push({ blockId: block.block_id, verified: verified === true });
		}
		if (provider.binding !== binding || inspectCalendarPlan(planPath).sha256 !== approvedSha256)
			throw new Error("Calendar reconciliation inputs changed");
		if (blocks.some((block) => !block.verified)) return { reconciled: false, retryAllowed: false, blocks };
		// A live writer may finish during the reads. Commit only the exact snapshot
		// inspected, and only after every planned event is externally confirmed.
		db.exec("BEGIN IMMEDIATE");
		let committed = false;
		try {
			if (JSON.stringify(snapshot()) !== JSON.stringify(before))
				throw new Error("Calendar state changed; inspect again");
			db.prepare("UPDATE receipts SET status='confirmed', event_id=request_id WHERE plan_id=?").run(plan.plan_id);
			db.prepare("UPDATE plans SET status='complete' WHERE id=?").run(plan.plan_id);
			db.exec("COMMIT");
			committed = true;
		} finally {
			if (!committed) db.exec("ROLLBACK");
		}
		return { reconciled: true, retryAllowed: false, blocks };
	} finally {
		db.close();
	}
};
