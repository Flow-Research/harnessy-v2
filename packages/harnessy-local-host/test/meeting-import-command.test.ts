import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMeetingImportCommand } from "../src/meeting-import-command.ts";

const pythonStore = readFileSync(
	new URL(
		"../../capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/store.py",
		import.meta.url,
	),
	"utf8",
);
const pythonSchema = /\n_SCHEMA = """\n([\s\S]*?)\n"""/u.exec(pythonStore)?.[1];
if (pythonSchema === undefined) throw new Error("Preserved Python schema not found");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("bounded offline import command", () => {
	let root: string;
	let args: Array<string>;
	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-import-command-"));
		args = [
			"--backup",
			join(root, "backup.sqlite3"),
			"--backup-sha256",
			"0".repeat(64),
			"--source-snapshot",
			join(root, "source-snapshot"),
			"--v1-source",
			join(root, "attested-v1-source"),
			"--project",
			"alpha",
			"--v1-state",
			join(root, "attested-v1-state"),
			"--output-directory",
			join(root, "output"),
		];
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each([
		["missing", (values: Array<string>) => values.slice(0, -2)],
		["extra", (values: Array<string>) => [...values, "--activate", "true"]],
		["unknown", (values: Array<string>) => ["--receipt", ...values.slice(1)]],
		["duplicate", (values: Array<string>) => ["--backup", ...values.slice(1, 2), "--backup", ...values.slice(3)]],
		["empty", (values: Array<string>) => [values[0] as string, "", ...values.slice(2)]],
		["flag-as-value", (values: Array<string>) => [values[0] as string, "--secret", ...values.slice(2)]],
		["relative-backup", (values: Array<string>) => [values[0] as string, "backup.sqlite3", ...values.slice(2)]],
		["root-source", (values: Array<string>) => [...values.slice(0, 5), "/", ...values.slice(6)]],
		["noncanonical-output", (values: Array<string>) => [...values.slice(0, 13), "/tmp/../output"]],
		[
			"control-path",
			(values: Array<string>) => [...values.slice(0, 11), "/private/tmp/state\nsecret", ...values.slice(12)],
		],
		["oversize-path", (values: Array<string>) => [...values.slice(0, 7), `/${"x".repeat(4096)}`, ...values.slice(8)]],
		["invalid-hash", (values: Array<string>) => [...values.slice(0, 3), "SECRET_CANARY", ...values.slice(4)]],
		["empty-project", (values: Array<string>) => [...values.slice(0, 9), "", ...values.slice(10)]],
		["uppercase-project", (values: Array<string>) => [...values.slice(0, 9), "Alpha", ...values.slice(10)]],
		["untrimmed-project", (values: Array<string>) => [...values.slice(0, 9), " alpha", ...values.slice(10)]],
		["control-project", (values: Array<string>) => [...values.slice(0, 9), "alpha\nsecret", ...values.slice(10)]],
		["oversize-project", (values: Array<string>) => [...values.slice(0, 9), "x".repeat(257), ...values.slice(10)]],
	] as const)("rejects %s argv without creating an output or reading a default", async (_name, change) => {
		const result = await Effect.runPromise(runMeetingImportCommand(change(args)));
		expect(result).toEqual({
			exitCode: 1,
			stream: "stderr",
			value: { error: "meeting_import_failed", code: "invalid_arguments" },
		});
		expect(JSON.stringify(result)).not.toContain("SECRET_CANARY");
		expect(readdirSync(root)).toEqual([]);
	});

	it("reduces a Core input failure to a content-free code without inventing output", async () => {
		mkdirSync(args[13] as string, { mode: 0o700 });
		const result = await Effect.runPromise(runMeetingImportCommand(args));
		expect(result.exitCode).toBe(1);
		if (result.exitCode === 1) {
			expect(result.stream).toBe("stderr");
			expect(result.value.error).toBe("meeting_import_failed");
			expect(typeof result.value.code).toBe("string");
			expect(JSON.stringify(result.value)).not.toContain(root);
		}
		expect(readdirSync(root)).toEqual(["output"]);
		expect(readdirSync(args[13] as string)).toEqual([]);
	});

	it("prepares one exact empty candidate through the production command success path", async () => {
		const backupRoot = join(root, "backup");
		const sourceSnapshotPath = join(root, "source-snapshot");
		const outputDirectory = join(root, "output");
		for (const path of [backupRoot, sourceSnapshotPath, outputDirectory]) {
			mkdirSync(path, { mode: 0o700 });
			chmodSync(path, 0o700);
		}
		const backupPath = join(backupRoot, "queue.sqlite3");
		const database = new DatabaseSync(backupPath, { allowExtension: false });
		try {
			database.exec(pythonSchema);
		} finally {
			database.close();
		}
		chmodSync(backupPath, 0o400);
		const result = await Effect.runPromise(
			runMeetingImportCommand([
				"--backup",
				backupPath,
				"--backup-sha256",
				sha256(backupPath),
				"--source-snapshot",
				sourceSnapshotPath,
				"--v1-source",
				join(root, "attested-v1-source"),
				"--project",
				"alpha",
				"--v1-state",
				join(root, "attested-v1-state"),
				"--output-directory",
				outputDirectory,
			]),
		);
		const candidatePath = join(outputDirectory, "meeting-publication.sqlite3");
		expect(result).toEqual({
			exitCode: 0,
			stream: "stdout",
			value: {
				kind: "harnessy.meeting-publication.import-prepared",
				items: 0,
				sha256: sha256(candidatePath),
				operationalEvidence: false,
			},
		});
		expect(readdirSync(outputDirectory)).toEqual(["meeting-publication.sqlite3"]);
		const candidate = new DatabaseSync(candidatePath, { readOnly: true, allowExtension: false });
		try {
			expect(candidate.prepare("SELECT COUNT(*) AS count FROM publication_items").get()?.count).toBe(0);
		} finally {
			candidate.close();
		}
	});

	it("runs a separate process and exposes neither planning fallback nor supplied values", () => {
		const packageRoot = join(import.meta.dirname, "..");
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", join(packageRoot, "src", "meeting-import-cli.ts"), "--backup", "SECRET_CANARY"],
			{ cwd: packageRoot, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe('{"error":"meeting_import_failed","code":"invalid_arguments"}\n');
		expect(result.stderr).not.toContain("SECRET_CANARY");
		expect(readdirSync(root)).toEqual([]);
	});

	it("keeps the offline import wrapper independent of SDK, review, smoke, and scheduler composition", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "src", "meeting-import-runtime.ts"), "utf8");
		expect(source).toContain("prepareMeetingPublicationImport");
		expect(source).not.toMatch(/@harnessy\/sdk|meeting-runtime|meeting-review|scheduler/u);
	});
});
