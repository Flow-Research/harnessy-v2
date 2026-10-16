import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLocalHostMeetingSmoke } from "../src/meeting-runtime.ts";

describe("guarded local-host entrypoint", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-host-runtime-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("rejects absent authorization without creating runtime or credential state", async () => {
		const result = await Effect.runPromise(
			runLocalHostMeetingSmoke({
				authorizationPath: join(root, "authorization.json"),
				trustedKeyring: { path: join(root, "trust.json"), device: "0", inode: "0", sha256: "0".repeat(64) },
			}).pipe(Effect.result),
		);
		expect(Result.isFailure(result)).toBe(true);
		expect(readdirSync(root)).toEqual([]);
	});

	it("rejects malformed private inputs without disclosing or changing them", async () => {
		const authorizationPath = join(root, "authorization.json");
		const trustPath = join(root, "trust.json");
		const canary = '{"secret":"PRIVATE_RUNTIME_CANARY"}\n';
		writeFileSync(authorizationPath, canary, { mode: 0o600 });
		writeFileSync(trustPath, "not-json\n", { mode: 0o600 });
		const trustStat = lstatSync(trustPath, { bigint: true });
		const result = await Effect.runPromise(
			runLocalHostMeetingSmoke({
				authorizationPath,
				trustedKeyring: {
					path: trustPath,
					device: trustStat.dev.toString(),
					inode: trustStat.ino.toString(),
					sha256: createHash("sha256").update(readFileSync(trustPath)).digest("hex"),
				},
			}).pipe(Effect.result),
		);
		expect(Result.isFailure(result)).toBe(true);
		expect(JSON.stringify(result)).not.toContain("PRIVATE_RUNTIME_CANARY");
		expect(readFileSync(authorizationPath, "utf8")).toBe(canary);
		expect(readFileSync(trustPath, "utf8")).toBe("not-json\n");
		expect(readdirSync(root).sort()).toEqual(["authorization.json", "trust.json"]);
	});
});
