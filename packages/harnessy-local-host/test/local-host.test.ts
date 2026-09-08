import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../../harnessy-core/src/jarvis/meeting-publication/store-schema.ts";
import {
	exportLocalHostPlan,
	inspectLocalHost,
	preflightLocalHostOffline,
	readLocalHostStatus,
	scanLocalHostDry,
} from "../src/application.ts";
import { readAndVerifyPlanEnvelope, readLocalHostConfig } from "../src/input.ts";
import {
	canonicalJson,
	formatPlanEnvelope,
	LocalHostReceiptError,
	sha256,
	V1_REVIEW_SCHEDULER_ID,
	V1_WORKER_SCHEDULER_ID,
	V2_REVIEW_SCHEDULER_ID,
	V2_WORKER_SCHEDULER_ID,
	verifyPlanEnvelope,
} from "../src/schema.ts";

const roots: Array<string> = [];
const makeRoot = () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-local-host-"));
	roots.push(root);
	mkdirSync(join(root, "notes"));
	return root;
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const note = `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-03
- Fingerprint: weekly-sync

## Executive Summary
Keep the local-host inspection boundary read only.

## Meeting Purpose
V1 remains the sole writer.
`;

const configValue = (root: string) => ({
	enabled: true,
	project: "alpha",
	sourcePath: join(root, "notes"),
	statePath: join(root, "state"),
	backfillDays: 365,
	cutoverDate: "2026-01-01",
	maxFileBytes: 32_000,
	maxFiles: 100,
	leaseSeconds: 60,
	reminderSeconds: 3_600,
	reviewHost: "127.0.0.1",
	reviewPort: 0,
	reviewSessionSeconds: 900,
	reviewMaxSessions: 64,
	reviewMaxBodyBytes: 4_096,
	googleOwnerEmail: "owner@example.test",
	googleDriveFolder: "folder-id",
	discordChannelId: "channel-id",
});

const writeInputs = (root: string) => {
	writeFileSync(join(root, "notes", "meeting.md"), note, { mode: 0o640 });
	writeFileSync(join(root, "local-host.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
	const configPath = join(root, "local-host-config.json");
	writeFileSync(configPath, `${JSON.stringify(configValue(root), null, 2)}\n`, { mode: 0o600 });
	return { configPath, loaded: readLocalHostConfig(configPath) };
};

const createCurrentState = (root: string) => {
	const statePath = join(root, "state");
	mkdirSync(statePath, { mode: 0o700 });
	const databasePath = join(statePath, "meeting-publication.sqlite3");
	const database = new DatabaseSync(databasePath);
	database.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
	database.close();
	if (process.platform !== "win32") chmodSync(databasePath, 0o600);
};

const treeSnapshot = (root: string) => {
	const entries: Array<readonly [string, string]> = [];
	const visit = (path: string, relativePath: string) => {
		let stat = lstatSync(path, { bigint: true });
		const stableMetadata = () =>
			`${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}:${stat.dev}:${stat.ino}:${stat.nlink}`;
		if (stat.isDirectory()) {
			const names = readdirSync(path).sort();
			stat = lstatSync(path, { bigint: true });
			entries.push([relativePath, `directory:${stableMetadata()}`]);
			for (const name of names) visit(join(path, name), join(relativePath, name));
			return;
		}
		const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
		stat = lstatSync(path, { bigint: true });
		entries.push([relativePath, `file:${stableMetadata()}:${digest}`]);
	};
	visit(root, ".");
	return entries;
};

const applicationInput = (root: string, config: ReturnType<typeof readLocalHostConfig>) => ({
	nowMillis: Date.parse("2026-09-04T12:00:00.000Z"),
	sinceDays: 365,
	hostExecutable: join(root, "local-host.js"),
	configPath: config.path,
	futureActivationReceiptPath: join(root, "future-activation-receipt.json"),
	workingDirectory: root,
});

const assertNoSideEffects = (root: string) => {
	const statePath = join(root, "state");
	for (const name of [
		"meeting-publication.sqlite3-journal",
		"meeting-publication.sqlite3-wal",
		"meeting-publication.sqlite3-shm",
		"review.token",
		"review.sock",
		"scheduler.json",
	]) {
		expect(existsSync(join(statePath, name))).toBe(false);
	}
	expect(existsSync(join(root, "future-activation-receipt.json"))).toBe(false);
};

describe.each([false, true])("read-only application with current state: %s", (withState) => {
	it("keeps every source and state byte/stable-stat identical", async () => {
		const root = makeRoot();
		const { loaded } = writeInputs(root);
		if (withState) createCurrentState(root);
		const before = treeSnapshot(root);
		const input = applicationInput(root, loaded);
		const readOnlyInput = { config: loaded.config, nowMillis: input.nowMillis, sinceDays: input.sinceDays };

		const status = await readLocalHostStatus(readOnlyInput);
		expect(status.activated).toBe(false);
		expect(status.writeAllowed).toBe(false);
		expect(status.authority.state.authorized).toBe(false);
		await inspectLocalHost(readOnlyInput);
		const scan = await scanLocalHostDry(readOnlyInput);
		expect(scan.dryRun).toBe(true);
		const preflight = await preflightLocalHostOffline(readOnlyInput);
		expect(preflight.ready).toBe(false);
		const envelope = await exportLocalHostPlan(input);
		expect(envelope.receipt.activated).toBe(false);
		expect(envelope.receipt.activationReady).toBe(false);
		expect(envelope.receipt.inspection.preflight.ready).toBe(false);
		expect(envelope.receipt.reviewToken.included).toBe(false);
		expect(
			envelope.receipt.operationalGates.every((gate) => gate.status === "missing" || gate.status === "not_checked"),
		).toBe(true);
		verifyPlanEnvelope(formatPlanEnvelope(envelope));

		expect(treeSnapshot(root)).toEqual(before);
		assertNoSideEffects(root);
		expect(status.state.exists).toBe(withState);
	});
});

it("emits strict inactive scheduler data with exact distinct identities and argv arrays", async () => {
	const root = makeRoot();
	const { loaded } = writeInputs(root);
	const envelope = await exportLocalHostPlan(applicationInput(root, loaded));
	const [review, worker] = envelope.receipt.schedulers;
	expect(review?.legacySchedulerId).toBe(V1_REVIEW_SCHEDULER_ID);
	expect(review?.v2SchedulerId).toBe(V2_REVIEW_SCHEDULER_ID);
	expect(worker?.legacySchedulerId).toBe(V1_WORKER_SCHEDULER_ID);
	expect(worker?.v2SchedulerId).toBe(V2_WORKER_SCHEDULER_ID);
	expect(
		new Set([review?.legacySchedulerId, review?.v2SchedulerId, worker?.legacySchedulerId, worker?.v2SchedulerId])
			.size,
	).toBe(4);
	for (const plan of envelope.receipt.schedulers) {
		expect(plan.install).toBe(false);
		expect(plan.enabled).toBe(false);
		expect(Array.isArray(plan.argv)).toBe(true);
		expect(plan.argv).not.toContain(plan.legacySchedulerId);
		expect(plan.argv.join("\n")).not.toMatch(/token|credential|secret/u);
	}
});

it("strictly verifies only canonical, untampered, activated:false receipts", async () => {
	const root = makeRoot();
	const { loaded } = writeInputs(root);
	const envelope = await exportLocalHostPlan(applicationInput(root, loaded));
	const text = formatPlanEnvelope(envelope);
	const receiptPath = join(root, "receipt.json");
	writeFileSync(receiptPath, text, { mode: 0o600 });
	const before = treeSnapshot(root);
	expect(readAndVerifyPlanEnvelope(receiptPath).receiptSha256).toBe(envelope.receiptSha256);
	expect(treeSnapshot(root)).toEqual(before);

	const activated = text.replace('"activated":false', '"activated":true');
	expect(() => verifyPlanEnvelope(activated)).toThrow(LocalHostReceiptError);
	const nestedBinding = JSON.parse(text) as {
		receipt: { binding: { sourcePath: string; statePath: string } };
		receiptSha256: string;
	};
	nestedBinding.receipt.binding.statePath = join(nestedBinding.receipt.binding.sourcePath, "state");
	nestedBinding.receiptSha256 = sha256(canonicalJson(nestedBinding.receipt));
	expect(() => verifyPlanEnvelope(`${canonicalJson(nestedBinding)}\n`)).toThrow(LocalHostReceiptError);
	const schedulerMismatch = JSON.parse(text) as {
		receipt: { schedulers: Array<{ argv: Array<string> }> };
		receiptSha256: string;
	};
	expect(schedulerMismatch.receipt.schedulers[0]).toBeDefined();
	if (schedulerMismatch.receipt.schedulers[0] !== undefined) {
		schedulerMismatch.receipt.schedulers[0].argv[3] = join(root, "different-config.json");
	}
	schedulerMismatch.receiptSha256 = sha256(canonicalJson(schedulerMismatch.receipt));
	expect(() => verifyPlanEnvelope(`${canonicalJson(schedulerMismatch)}\n`)).toThrow(LocalHostReceiptError);
	const grant = JSON.parse(text) as Record<string, unknown>;
	grant.grant = "forbidden";
	expect(() => verifyPlanEnvelope(`${canonicalJson(grant)}\n`)).toThrow(LocalHostReceiptError);
	const duplicate = JSON.parse(text) as {
		receipt: { inspection: { preflight: { checks: Array<Record<string, unknown>> } } };
		receiptSha256: string;
	};
	const writeAuthority = duplicate.receipt.inspection.preflight.checks.find(
		(check) => check.name === "write_authority",
	);
	expect(writeAuthority).toBeDefined();
	duplicate.receipt.inspection.preflight.checks.push({ ...writeAuthority, passed: true });
	duplicate.receiptSha256 = sha256(canonicalJson(duplicate.receipt));
	expect(() => verifyPlanEnvelope(`${canonicalJson(duplicate)}\n`)).toThrow(LocalHostReceiptError);
	const optionalAuthority = JSON.parse(text) as {
		receipt: { inspection: { preflight: { checks: Array<Record<string, unknown>> } } };
		receiptSha256: string;
	};
	const authorityIndex = optionalAuthority.receipt.inspection.preflight.checks.findIndex(
		(check) => check.name === "write_authority",
	);
	expect(authorityIndex).toBeGreaterThanOrEqual(0);
	optionalAuthority.receipt.inspection.preflight.checks[authorityIndex] = {
		...optionalAuthority.receipt.inspection.preflight.checks[authorityIndex],
		required: false,
	};
	optionalAuthority.receiptSha256 = sha256(canonicalJson(optionalAuthority.receipt));
	expect(() => verifyPlanEnvelope(`${canonicalJson(optionalAuthority)}\n`)).toThrow(LocalHostReceiptError);
	const inventedCheck = JSON.parse(text) as {
		receipt: { inspection: { preflight: { checks: Array<Record<string, unknown>> } } };
		receiptSha256: string;
	};
	inventedCheck.receipt.inspection.preflight.checks[0] = {
		name: "secret_bearing_extension",
		passed: true,
		required: true,
		code: "ok",
	};
	inventedCheck.receiptSha256 = sha256(canonicalJson(inventedCheck.receipt));
	expect(() => verifyPlanEnvelope(`${canonicalJson(inventedCheck)}\n`)).toThrow(LocalHostReceiptError);
	const inventedCount = JSON.parse(text) as {
		receipt: { inspection: { state: { statusCounts: Record<string, number> } } };
		receiptSha256: string;
	};
	inventedCount.receipt.inspection.state.statusCounts.secret_bearing_extension = 1;
	inventedCount.receiptSha256 = sha256(canonicalJson(inventedCount.receipt));
	expect(() => verifyPlanEnvelope(`${canonicalJson(inventedCount)}\n`)).toThrow(LocalHostReceiptError);
	expect(() => verifyPlanEnvelope(text.replace(envelope.receiptSha256, "0".repeat(64)))).toThrow(
		LocalHostReceiptError,
	);
	expect(() => verifyPlanEnvelope(`${text}\n`)).toThrow(LocalHostReceiptError);

	writeFileSync(loaded.path, `${JSON.stringify(configValue(root))}\n`, { mode: 0o600 });
	expect(() => readAndVerifyPlanEnvelope(receiptPath)).toThrowError(
		expect.objectContaining({ code: "stale_binding" }),
	);
	writeFileSync(loaded.path, `${JSON.stringify(configValue(root), null, 2)}\n`, { mode: 0o600 });
	writeFileSync(join(root, "local-host.js"), "#!/usr/bin/env node\n// changed\n", { mode: 0o700 });
	expect(() => readAndVerifyPlanEnvelope(receiptPath)).toThrowError(
		expect.objectContaining({ code: "stale_binding" }),
	);
});

it("rejects unknown configuration fields and relative or shared source/state bindings", () => {
	const root = makeRoot();
	const configPath = join(root, "config.json");
	writeFileSync(configPath, JSON.stringify({ ...configValue(root), credential: "forbidden" }), { mode: 0o600 });
	expect(() => readLocalHostConfig(configPath)).toThrow();
	writeFileSync(configPath, JSON.stringify({ ...configValue(root), sourcePath: "notes" }), { mode: 0o600 });
	expect(() => readLocalHostConfig(configPath)).toThrow();
	writeFileSync(configPath, JSON.stringify({ ...configValue(root), sourcePath: join(root, "state") }), {
		mode: 0o600,
	});
	expect(() => readLocalHostConfig(configPath)).toThrow();
	writeFileSync(configPath, JSON.stringify({ ...configValue(root), statePath: join(root, "notes", "state") }), {
		mode: 0o600,
	});
	expect(() => readLocalHostConfig(configPath)).toThrow();
});

it("keeps the private planning surface separate from the guarded runtime export", () => {
	const packageRoot = realpathSync(join(import.meta.dirname, ".."));
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
		private?: boolean;
		dependencies?: Record<string, string>;
		bin?: Record<string, string>;
		exports?: Record<string, { import: string }>;
	};
	expect(manifest.private).toBe(true);
	expect(manifest.dependencies).toEqual({
		"@harnessy/core": "0.0.3",
		"@harnessy/sdk": "0.0.3",
		effect: "4.0.0-beta.85",
	});
	expect(manifest.bin).toEqual({
		"harnessy-local-host": "dist/cli.js",
		"harnessy-meeting-full-review": "dist/meeting-full-review-cli.js",
		"harnessy-meeting-import": "dist/meeting-import-cli.js",
		"harnessy-meeting-review": "dist/meeting-review-cli.js",
		"harnessy-meeting-review-open": "dist/meeting-review-open-cli.js",
		"harnessy-meeting-smoke": "dist/meeting-smoke-cli.js",
		"harnessy-meeting-worker": "dist/meeting-worker-cli.js",
	});
	expect(Object.keys(manifest.exports ?? {})).toEqual([
		".",
		"./meeting-runtime",
		"./meeting-review-runtime",
		"./meeting-import-runtime",
	]);
	expect(manifest.exports?.["."]?.import).toBe("./dist/index.js");
	expect(manifest.exports?.["./meeting-runtime"]?.import).toBe("./dist/meeting-runtime.js");
	expect(manifest.exports?.["./meeting-review-runtime"]?.import).toBe("./dist/meeting-review-runtime.js");
	expect(manifest.exports?.["./meeting-import-runtime"]?.import).toBe("./dist/meeting-import-runtime.js");
	const source = readdirSync(join(packageRoot, "src"))
		.filter(
			(name) =>
				name.endsWith(".ts") &&
				![
					"meeting-command-input.ts",
					"meeting-full-review-command.ts",
					"meeting-full-review-cli.ts",
					"meeting-import-runtime.ts",
					"meeting-import-command.ts",
					"meeting-import-cli.ts",
					"meeting-review-runtime.ts",
					"meeting-review-command.ts",
					"meeting-review-cli.ts",
					"meeting-review-open-cli.ts",
					"meeting-runtime.ts",
					"meeting-smoke-command.ts",
					"meeting-smoke-cli.ts",
					"meeting-worker-command.ts",
					"meeting-worker-cli.ts",
				].includes(name),
		)
		.map((name) => readFileSync(join(packageRoot, "src", name), "utf8"))
		.join("\n");
	expect(source).not.toMatch(/@harnessy\/sdk|@harnessy\/executor|child_process|node:http|node:https/u);
	expect(source).not.toMatch(/MeetingPublicationStore|MeetingPublicationReviewServer|MeetingPublicationService/u);
	expect(source).not.toMatch(/WriteGrant|authority-test-fixture|permitLayer/u);
	expect(source).not.toContain("meeting-runtime");
});

it("exposes only read-only CLI verbs and keeps export stdout-only", () => {
	const root = makeRoot();
	const { configPath } = writeInputs(root);
	const packageRoot = realpathSync(join(import.meta.dirname, ".."));
	const cliPath = join(packageRoot, "src", "cli.ts");
	const before = treeSnapshot(root);
	const runCli = (args: ReadonlyArray<string>) =>
		spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
			cwd: packageRoot,
			encoding: "utf8",
			env: { ...process.env, NODE_NO_WARNINGS: "1", HARNESSY_TEST_SECRET_CANARY: "must-not-leak" },
		});

	for (const verb of ["activate", "install", "enable", "start", "run", "worker", "serve", "publish", "approve"]) {
		const rejected = runCli([verb, "--config", configPath]);
		expect(rejected.status).toBe(1);
		expect(rejected.stdout).toBe("");
		expect(rejected.stderr).toContain('"code":"invalid_command"');
		expect(rejected.stderr).not.toContain("must-not-leak");
	}
	const flagRejected = runCli(["status", "--config", configPath, "--activate", "true"]);
	expect(flagRejected.status).toBe(1);
	expect(flagRejected.stderr).toContain('"code":"invalid_arguments"');

	const exported = runCli([
		"export",
		"--config",
		configPath,
		"--host-executable",
		cliPath,
		"--future-activation-receipt",
		join(root, "future-activation-receipt.json"),
		"--working-directory",
		root,
		"--now-ms",
		String(Date.parse("2026-09-04T12:00:00.000Z")),
	]);
	expect(exported.status).toBe(0);
	expect(exported.stderr).toBe("");
	expect(exported.stdout).not.toContain("must-not-leak");
	expect(verifyPlanEnvelope(exported.stdout).receipt.activated).toBe(false);
	expect(treeSnapshot(root)).toEqual(before);
	assertNoSideEffects(root);
});
