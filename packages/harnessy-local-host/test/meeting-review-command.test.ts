import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MeetingPublicationSmokeRuntimeSystemReference } from "../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { runMeetingFullReviewCommand } from "../src/meeting-full-review-command.ts";
import { runMeetingReviewCommand } from "../src/meeting-review-command.ts";
import type { LocalHostMeetingReviewReady } from "../src/meeting-review-runtime.ts";

type CommandResult = Effect.Success<
	ReturnType<typeof runMeetingReviewCommand> | ReturnType<typeof runMeetingFullReviewCommand>
>;
const commands: ReadonlyArray<{
	readonly name: "review" | "full-review";
	readonly error: "meeting_review_failed" | "meeting_full_review_failed";
	readonly run: (args: ReadonlyArray<string>, onReady: LocalHostMeetingReviewReady) => Effect.Effect<CommandResult>;
}> = [
	{ name: "review", error: "meeting_review_failed", run: runMeetingReviewCommand },
	{ name: "full-review", error: "meeting_full_review_failed", run: runMeetingFullReviewCommand },
];

describe.each(commands)("bounded $name command", ({ name, error, run }) => {
	let root: string;
	let args: Array<string>;
	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-command-"));
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
		["extra", (values: Array<string>) => [...values, "--serve", "true"]],
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
	] as const)("rejects %s argv before runtime observation or readiness", async (_name, change) => {
		let observed = false;
		let ready = false;
		const result = await Effect.runPromise(
			run(change(args), () => {
				ready = true;
				return Effect.void;
			}).pipe(
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
		expect(ready).toBe(false);
		expect(result).toEqual({
			exitCode: 1,
			value: { error, code: "invalid_arguments" },
		});
		expect(readdirSync(root)).toEqual([]);
	});

	it("preserves private inputs and reduces runtime failure to a content-free code", async () => {
		const authorizationPath = args[1] as string;
		const trustPath = args[3] as string;
		writeFileSync(authorizationPath, "AUTHORIZATION_SECRET_CANARY", { mode: 0o600 });
		writeFileSync(trustPath, "TRUST_SECRET_CANARY", { mode: 0o600 });
		const stat = lstatSync(trustPath, { bigint: true });
		args[5] = stat.dev.toString();
		args[7] = stat.ino.toString();
		args[9] = createHash("sha256").update(readFileSync(trustPath)).digest("hex");
		let ready = false;
		const result = await Effect.runPromise(
			run(args, () => {
				ready = true;
				return Effect.void;
			}).pipe(
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
			value: { error, code: "invalid_input" },
		});
		expect(ready).toBe(false);
		expect(JSON.stringify(result)).not.toMatch(/AUTHORIZATION_SECRET_CANARY|TRUST_SECRET_CANARY/u);
		expect(readFileSync(authorizationPath, "utf8")).toBe("AUTHORIZATION_SECRET_CANARY");
		expect(readFileSync(trustPath, "utf8")).toBe("TRUST_SECRET_CANARY");
	});

	it("runs the separate command process with no planning-command fallback or input disclosure", () => {
		const packageRoot = join(import.meta.dirname, "..");
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", join(packageRoot, "src", `meeting-${name}-cli.ts`), "--receipt", "SECRET_CANARY"],
			{ cwd: packageRoot, encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(`${JSON.stringify({ error, code: "invalid_arguments" })}\n`);
		expect(result.stderr).not.toContain("SECRET_CANARY");
		expect(readdirSync(root)).toEqual([]);
	});

	it("keeps the review runtime independent of the SDK-backed smoke composition", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "src", "meeting-review-runtime.ts"), "utf8");
		expect(source).toContain("runAuthorizedMeetingPublicationReview");
		expect(source).not.toMatch(/@harnessy\/sdk|meeting-runtime\.ts/u);
	});
});
