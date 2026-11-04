import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MeetingPublicationSmokeRuntimeSystemReference } from "../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { runMeetingSmokeCommand } from "../src/meeting-smoke-command.ts";
import { runMeetingWorkerCommand } from "../src/meeting-worker-command.ts";

type CommandResult = Effect.Success<
	ReturnType<typeof runMeetingSmokeCommand> | ReturnType<typeof runMeetingWorkerCommand>
>;
const commands: ReadonlyArray<{
	readonly kind: "smoke" | "worker";
	readonly run: (args: ReadonlyArray<string>) => Effect.Effect<CommandResult>;
}> = [
	{ kind: "smoke", run: runMeetingSmokeCommand },
	{ kind: "worker", run: runMeetingWorkerCommand },
];

describe.each(commands)("bounded $kind command", ({ kind, run }) => {
	let root: string;
	let args: Array<string>;
	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), `harnessy-${kind}-command-`));
		args = [
			"--authorization",
			join(root, "authorization.json"),
			"--trusted-keyring",
			join(root, "trust.json"),
			"--trusted-keyring-device",
			"0",
			"--trusted-keyring-inode",
			"0",
			"--trusted-keyring-sha256",
			"0".repeat(64),
		];
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each([
		["missing", (values: Array<string>) => values.slice(0, -2)],
		["extra", (values: Array<string>) => [...values, "--activate", "true"]],
		["batch-override", (values: Array<string>) => [...values, "--max-items", "100"]],
		[
			"duplicate",
			(values: Array<string>) => ["--authorization", ...values.slice(1, 2), "--authorization", ...values.slice(3)],
		],
		["unknown", (values: Array<string>) => ["--receipt", ...values.slice(1)]],
		["empty", (values: Array<string>) => [values[0] as string, "", ...values.slice(2)]],
		["flag-as-value", (values: Array<string>) => [values[0] as string, "--secret", ...values.slice(2)]],
		["relative", (values: Array<string>) => [values[0] as string, "authorization.json", ...values.slice(2)]],
		["root", (values: Array<string>) => [values[0] as string, "/", ...values.slice(2)]],
		[
			"noncanonical",
			(values: Array<string>) => [values[0] as string, "/tmp/../authorization.json", ...values.slice(2)],
		],
		["control", (values: Array<string>) => [values[0] as string, "/private/tmp/secret\nvalue", ...values.slice(2)]],
		["oversize", (values: Array<string>) => [values[0] as string, `/${"x".repeat(4096)}`, ...values.slice(2)]],
		["negative-device", (values: Array<string>) => [...values.slice(0, 5), "-1", ...values.slice(6)]],
		["noncanonical-inode", (values: Array<string>) => [...values.slice(0, 7), "01", ...values.slice(8)]],
		["oversize-inode", (values: Array<string>) => [...values.slice(0, 7), "1".repeat(33), ...values.slice(8)]],
		["invalid-hash", (values: Array<string>) => [...values.slice(0, 9), "SECRET_CANARY"]],
	] as const)("rejects %s argv before any runtime observation", async (_name, change) => {
		let observed = false;
		const result = await Effect.runPromise(
			run(change(args)).pipe(
				Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
					observe: () => {
						observed = true;
						throw new Error("observation must not run");
					},
					proveNoKnownV1Writers: () => {
						throw new Error("writer probe must not run");
					},
				}),
			),
		);
		expect(observed).toBe(false);
		expect(result).toEqual({
			exitCode: 1,
			stream: "stderr",
			value: { error: `meeting_${kind}_failed`, code: "invalid_arguments" },
		});
		expect(readdirSync(root)).toEqual([]);
	});

	it("preserves malformed private inputs and redacts runtime failures", async () => {
		const authorizationPath = args[1] as string;
		const trustPath = args[3] as string;
		writeFileSync(authorizationPath, "AUTHORIZATION_SECRET_CANARY", { mode: 0o600 });
		writeFileSync(trustPath, "TRUST_SECRET_CANARY", { mode: 0o600 });
		const stat = lstatSync(trustPath, { bigint: true });
		args[5] = stat.dev.toString();
		args[7] = stat.ino.toString();
		args[9] = createHash("sha256").update(readFileSync(trustPath)).digest("hex");
		const result = await Effect.runPromise(
			run(args).pipe(
				Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
					observe: () => ({
						now: Date.now(),
						monotonic: process.hrtime.bigint(),
						platform: "darwin",
						architecture: process.arch,
						hostname: "fixture",
						uid: BigInt(process.geteuid?.() ?? 0),
						bootId: "fixture",
						executablePath: realpathSync(process.execPath),
					}),
					proveNoKnownV1Writers: () => {
						throw new Error("writer probe must not run");
					},
				}),
			),
		);
		expect(result).toEqual({
			exitCode: 1,
			stream: "stderr",
			value: { error: `meeting_${kind}_failed`, code: "invalid_input" },
		});
		expect(readFileSync(authorizationPath, "utf8")).toBe("AUTHORIZATION_SECRET_CANARY");
		expect(readFileSync(trustPath, "utf8")).toBe("TRUST_SECRET_CANARY");
		expect(readdirSync(root).sort()).toEqual(["authorization.json", "trust.json"]);
	});

	it("runs the actual command process with a bounded nonzero error", () => {
		const packageRoot = join(import.meta.dirname, "..");
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", join(packageRoot, "src", `meeting-${kind}-cli.ts`), "--receipt", "SECRET_CANARY"],
			{ cwd: packageRoot, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(`{"error":"meeting_${kind}_failed","code":"invalid_arguments"}\n`);
		expect(readdirSync(root)).toEqual([]);
	});
});
