import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { Effect, Exit } from "effect";
import { Command } from "effect/unstable/cli";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { addressOf, keccak, toHex } from "../src/attest/eas.ts";
import type { AttestDeps } from "../src/attest/run.ts";
import { attestCommand, makeAttestCommand } from "../src/cli/attest.ts";
import type { Run } from "../src/work/run.ts";

const SECRET = keccak(utf8ToBytes("harnessy attest test vector key"));
const ADDRESS = addressOf(SECRET);
const PROJECT = "01a1601c-db5d-7559-9824-953db93ddcf7";
const ID = "01a16023-9d1f-74cf-9e14-fd2c50ea82b6";
const ITEM = {
	contribution_id: ID,
	project_id: PROJECT,
	task_id: "01a16020-7f3f-78e2-96ce-2029226d3a1b",
	contributor_id: "01a1601b-bbe7-760b-91bf-b3b3f355e8c6",
	contribution_type: "accepted_submission",
	artifact_hash: "sha256:e02ac6d75e020e591a7626dc84533d17b5289be9e2ce2c061d8d0675810a6786",
	contribution_policy_version_id: "01a1601d-9bf4-7602-8867-b180b4d02d07",
	recorded_at: "2026-10-21T20:25:09.156547Z",
	accepted_at: "2026-10-21T20:25:09.062294Z",
	awards: [],
};

let root: string;
let argvs: string[][];
let log: MockInstance<typeof console.log>;

const listing: Run = async (argv) => {
	argvs.push([...argv]);
	return { exitCode: 0, stdout: JSON.stringify({ items: [ITEM] }), stderr: "" };
};
const deps = (run: Run = listing): AttestDeps => ({
	run,
	stateRoot: join(root, "attest"),
	platform: "darwin",
	randomSecretKey: () => SECRET,
});

const cli = (args: ReadonlyArray<string>, run?: Run) =>
	Effect.runPromiseExit(
		Command.runWith(
			makeAttestCommand(() => deps(run)),
			{ version: "test" },
		)(args).pipe(Effect.provide(NodeServices.layer)),
	);
const output = () => log.mock.calls.map((call) => String(call[0])).join("\n");
const lastJson = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));
const certificate = () => join(root, "attest", PROJECT, `${ID}.json`);

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hsy-attest-cli-"));
	argvs = [];
	log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	rmSync(root, { recursive: true, force: true });
});

describe("harnessy attest CLI", () => {
	it("key init prints the TEST label and signer address but never the secret", async () => {
		expect(Exit.isSuccess(await cli(["key", "init"]))).toBe(true);
		expect(output()).toContain("Created a TEST signing key (test certificates only).");
		expect(output()).toContain(`Signer address: ${ADDRESS}`);
		expect(output()).not.toContain(toHex(SECRET).slice(2));
		expect(process.exitCode).toBeUndefined();
	});

	it("key init refuses to overwrite and exits 1, in text and JSON", async () => {
		await cli(["key", "init"]);
		await cli(["key", "init"]);
		expect(output()).toContain(`A test signing key already exists; not replaced. Its signer address is ${ADDRESS}.`);
		expect(process.exitCode).toBe(1);
		await cli(["key", "init", "--json"]);
		expect(lastJson()).toMatchObject({ status: "exists", test: true });
		expect(output()).not.toContain(toHex(SECRET).slice(2));
	});

	it("run splits --workstream-cli, signs, and is idempotent", async () => {
		await cli(["key", "init"]);
		const first = await cli(["run", "--project", PROJECT, "--workstream-cli", " ws-as  agent-claude ", "--json"]);
		expect(Exit.isSuccess(first)).toBe(true);
		expect(argvs).toEqual([["ws-as", "agent-claude", "contributions", "--project", PROJECT, "-o", "json"]]);
		expect(lastJson()).toMatchObject({ status: "ok", created: [certificate()], signer: ADDRESS });
		await cli(["run", "--project", PROJECT]);
		expect(output()).toContain("0 new, 1 already present, 0 conflicting, of 1 contributions.");
		expect(output()).toMatch(/^TEST certificate/m);
		expect(process.exitCode).toBeUndefined();
	});

	it("run prints created and conflicting files and exits 1 on a conflict", async () => {
		await cli(["key", "init"]);
		const out = join(root, "out");
		await cli(["run", "--project", PROJECT, "--out", out]);
		expect(output()).toContain(`created  ${join(out, `${ID}.json`)}`);
		writeFileSync(join(out, `${ID}.json`), "{}\n");
		await cli(["run", "--project", PROJECT, "--out", out]);
		expect(output()).toContain(
			`CONFLICT ${join(out, `${ID}.json`)} (differs from what this key signs now; not replaced)`,
		);
		expect(process.exitCode).toBe(1);
	});

	it("run fails on an empty --workstream-cli, a missing key and a WorkStream failure", async () => {
		expect(Exit.isFailure(await cli(["run", "--project", PROJECT, "--workstream-cli", " "]))).toBe(true);
		expect(Exit.isFailure(await cli(["run", "--project", PROJECT]))).toBe(true);
		await cli(["key", "init"]);
		const failing: Run = async () => ({ exitCode: 1, stdout: "", stderr: "boom" });
		const exit = await cli(["run", "--project", PROJECT], failing);
		expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(
			"WorkStream contributions failed (exit 1): boom",
		);
	});

	it("run surfaces an unexpected runner error", async () => {
		await cli(["key", "init"]);
		const exit = await cli(["run", "--project", PROJECT], async () => {
			throw new Error("spawn exploded");
		});
		expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("spawn exploded");
	});

	it("verify prints a plain verdict and exits 1 when invalid", async () => {
		await cli(["key", "init"]);
		await cli(["run", "--project", PROJECT]);
		await cli(["verify", certificate()]);
		expect(output()).toContain(`VALID test certificate for contribution ${ID}, signed by ${ADDRESS}`);
		expect(process.exitCode).toBeUndefined();
		await cli(["verify", certificate(), "--json"]);
		expect(lastJson()).toMatchObject({ file: certificate(), valid: true, signer: ADDRESS });

		const tampered = JSON.parse(readFileSync(certificate(), "utf8"));
		tampered.contribution.contributorId = "01a1601b-0000-7000-8000-000000000000";
		const path = join(root, "tampered.json");
		writeFileSync(path, JSON.stringify(tampered));
		await cli(["verify", path, "--attester", ADDRESS]);
		expect(output()).toContain("INVALID: the readable contribution differs from the signed data");
		expect(process.exitCode).toBe(1);
	});

	it("verify fails without an attester or a local key, and on an unreadable file", async () => {
		expect(Exit.isFailure(await cli(["verify", join(root, "x.json")]))).toBe(true);
		expect(Exit.isFailure(await cli(["verify", join(root, "x.json"), "--attester", ADDRESS]))).toBe(true);
	});

	it("the live command wires real dependencies", async () => {
		const exit = await Effect.runPromiseExit(
			Command.runWith(attestCommand, { version: "test" })([
				"verify",
				join(root, "x.json"),
				"--attester",
				ADDRESS,
			]).pipe(Effect.provide(NodeServices.layer)),
		);
		expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain(`Cannot read ${join(root, "x.json")}`);
	});
});
