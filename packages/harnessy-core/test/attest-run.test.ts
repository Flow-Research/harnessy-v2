import type * as fs from "node:fs";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import * as Result from "effect/Result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressOf, keccak, toHex } from "../src/attest/eas.ts";
import {
	type AttestDeps,
	defaultAttestRoot,
	initKey,
	KEY_FILE,
	keyPath,
	liveAttestDeps,
	loadKey,
	runAttest,
	verifyFile,
	writeNew,
} from "../src/attest/run.ts";
import type { Run, RunResult } from "../src/work/run.ts";

/** Lets one test make `linkSync` fail with an error other than EEXIST. */
const linkFailure = vi.hoisted(() => ({ code: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: (from: fs.PathLike, to: fs.PathLike) => {
			if (linkFailure.code !== undefined)
				throw Object.assign(new Error(`link failed: ${linkFailure.code}`), { code: linkFailure.code });
			return actual.linkSync(from, to);
		},
	};
});

const SECRET = keccak(utf8ToBytes("harnessy attest test vector key"));
const ADDRESS = addressOf(SECRET);
const PROJECT = "01a1601c-db5d-7559-9824-953db93ddcf7";
const WS = ["ws-agent"];

const item = (id: string, awards: unknown[] = []) => ({
	contribution_id: id,
	project_id: PROJECT,
	task_id: "01a16020-7f3f-78e2-96ce-2029226d3a1b",
	contributor_id: "01a1601b-bbe7-760b-91bf-b3b3f355e8c6",
	contributor_display_name: "Private Name",
	contribution_type: "accepted_submission",
	artifact_hash: "sha256:e02ac6d75e020e591a7626dc84533d17b5289be9e2ce2c061d8d0675810a6786",
	contribution_policy_version_id: "01a1601d-9bf4-7602-8867-b180b4d02d07",
	recorded_at: "2026-10-21T20:25:09.156547Z",
	accepted_at: "2026-10-21T20:25:09.062294Z",
	awards,
});
const ID_A = "01a16023-9d1f-74cf-9e14-fd2c50ea82b6";
const ID_B = "01a16240-b924-7823-b2ff-7462a1dd0983";
const FLOW = { instrument: "project_points", unit: "FLOW", quantity: "10" };

let root: string;
let calls: string[][];

const respond =
	(result: Partial<RunResult>): Run =>
	async (argv) => {
		calls.push([...argv]);
		return { exitCode: 0, stdout: "", stderr: "", ...result };
	};
const listing = (...items: unknown[]) => respond({ stdout: JSON.stringify({ exported_at: "now", items }) });

const depsWith = (run: Run, overrides: Partial<AttestDeps> = {}): AttestDeps => ({
	run,
	stateRoot: join(root, "attest"),
	platform: "darwin",
	randomSecretKey: () => SECRET,
	...overrides,
});

const mode = (path: string) => statSync(path).mode & 0o777;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hsy-attest-"));
	calls = [];
});
afterEach(() => {
	linkFailure.code = undefined;
	chmodSync(root, 0o700);
	for (const entry of readdirSync(root)) chmodSync(join(root, entry), 0o700);
	rmSync(root, { recursive: true, force: true });
});

describe("TEST signing key", () => {
	it("creates a private key file and reports only the signer address", () => {
		const deps = depsWith(listing());
		const outcome = initKey(deps);
		expect(outcome).toEqual({
			exitCode: 0,
			report: expect.objectContaining({ status: "created", test: true, address: ADDRESS, path: keyPath(deps) }),
		});
		expect(JSON.stringify(outcome)).not.toContain(toHex(SECRET).slice(2));
		expect(mode(deps.stateRoot)).toBe(0o700);
		expect(mode(keyPath(deps))).toBe(0o600);
		const body = JSON.parse(readFileSync(keyPath(deps), "utf8"));
		expect(body).toMatchObject({ test: true, address: ADDRESS, secretKey: toHex(SECRET) });
		expect(body.label).toMatch(/^TEST signing key/);
		expect(readdirSync(deps.stateRoot)).toEqual([KEY_FILE]);
		expect(loadKey(deps)).toEqual(Result.succeed({ secretKey: SECRET, address: ADDRESS }));
	});

	it("refuses to replace an existing key and keeps it", () => {
		const deps = depsWith(listing());
		initKey(deps);
		const before = readFileSync(keyPath(deps), "utf8");
		const again = initKey({ ...deps, randomSecretKey: () => keccak(utf8ToBytes("new")) });
		expect(again.exitCode).toBe(1);
		expect(again.report).toMatchObject({ status: "exists" });
		expect(String(again.report.message)).toContain(`Its signer address is ${ADDRESS}.`);
		expect(readFileSync(keyPath(deps), "utf8")).toBe(before);
		expect(readdirSync(deps.stateRoot)).toEqual([KEY_FILE]);
	});

	it("refuses to replace an unreadable existing key without guessing its address", () => {
		const deps = depsWith(listing());
		mkdirSync(deps.stateRoot, { recursive: true });
		writeFileSync(keyPath(deps), "garbage", { mode: 0o600 });
		const again = initKey(deps);
		expect(again.report.message).toBe("A test signing key already exists; not replaced.");
		expect(readFileSync(keyPath(deps), "utf8")).toBe("garbage");
	});

	it("does not generate a secret when a key exists, and loses a creation race safely", () => {
		const deps = depsWith(listing());
		initKey(deps);
		const generate = vi.fn(() => keccak(utf8ToBytes("new")));
		expect(initKey({ ...deps, randomSecretKey: generate }).report.status).toBe("exists");
		expect(generate).not.toHaveBeenCalled();
		const racing = depsWith(listing(), { stateRoot: join(root, "race") });
		linkFailure.code = "EEXIST";
		expect(initKey(racing).report).toMatchObject({ status: "exists" });
		expect(readdirSync(racing.stateRoot)).toEqual([]);
	});

	it("explains a missing key", () => {
		expect(loadKey(depsWith(listing()))).toEqual(
			Result.fail(`No test signing key at ${join(root, "attest", KEY_FILE)}. Run: harnessy attest key init`),
		);
	});

	it("refuses a key in a folder it cannot read", () => {
		const deps = depsWith(listing());
		initKey(deps);
		chmodSync(deps.stateRoot, 0o000);
		expect(loadKey(deps)).toEqual(Result.fail(`Cannot read the test signing key at ${keyPath(deps)}`));
	});

	it("refuses a symlinked or group-readable key, except on Windows", () => {
		const deps = depsWith(listing());
		initKey(deps);
		chmodSync(keyPath(deps), 0o640);
		expect(loadKey(deps)).toEqual(
			Result.fail(`The test signing key at ${keyPath(deps)} is readable by other users; run chmod 600 on it`),
		);
		expect(Result.isSuccess(loadKey({ ...deps, platform: "win32" }))).toBe(true);
		const linked = depsWith(listing(), { stateRoot: join(root, "linked") });
		mkdirSync(linked.stateRoot);
		symlinkSync(keyPath(deps), keyPath(linked));
		expect(loadKey(linked)).toEqual(Result.fail(`The test signing key at ${keyPath(linked)} is not a regular file`));
	});

	it.each([
		["not JSON", "x"],
		["not marked test", JSON.stringify({ test: false, address: ADDRESS, secretKey: toHex(SECRET) })],
		["a short key", JSON.stringify({ test: true, address: ADDRESS, secretKey: "0x01" })],
		["an invalid scalar", JSON.stringify({ test: true, address: ADDRESS, secretKey: `0x${"00".repeat(32)}` })],
	])("refuses a key file that is %s", (_name, body) => {
		const deps = depsWith(listing());
		mkdirSync(deps.stateRoot, { recursive: true });
		writeFileSync(keyPath(deps), body, { mode: 0o600 });
		expect(loadKey(deps)).toEqual(Result.fail(`The test signing key at ${keyPath(deps)} is not a valid TEST key`));
	});

	it("refuses a key whose recorded address does not match", () => {
		const deps = depsWith(listing());
		mkdirSync(deps.stateRoot, { recursive: true });
		writeFileSync(keyPath(deps), JSON.stringify({ test: true, address: "0x0", secretKey: toHex(SECRET) }), {
			mode: 0o600,
		});
		expect(loadKey(deps)).toEqual(
			Result.fail(`The test signing key at ${keyPath(deps)} does not match its recorded address`),
		);
	});
});

describe("attest run", () => {
	const ready = (run: Run, overrides: Partial<AttestDeps> = {}) => {
		const deps = depsWith(run, overrides);
		initKey(deps);
		return deps;
	};
	const outcomeOf = async (deps: AttestDeps, out?: string) => {
		const result = await runAttest({ project: PROJECT, workstreamCli: WS, ...(out ? { out } : {}) }, deps);
		if (Result.isFailure(result)) throw new Error(result.failure);
		return result.success;
	};

	it("asks WorkStream for the project's contributions as JSON", async () => {
		await outcomeOf(ready(listing()));
		expect(calls).toEqual([["ws-agent", "contributions", "--project", PROJECT, "-o", "json"]]);
	});

	it("writes one private certificate per contribution into the default folder", async () => {
		const deps = ready(listing(item(ID_A), item(ID_B, [FLOW])));
		const outcome = await outcomeOf(deps);
		const folder = join(deps.stateRoot, PROJECT);
		expect(outcome.exitCode).toBe(0);
		expect(outcome.report).toMatchObject({
			status: "ok",
			test: true,
			signer: ADDRESS,
			out: folder,
			contributions: 2,
			created: [join(folder, `${ID_A}.json`), join(folder, `${ID_B}.json`)],
			unchanged: [],
			conflicts: [],
		});
		expect(mode(folder)).toBe(0o700);
		expect(mode(join(folder, `${ID_A}.json`))).toBe(0o600);
		expect(readdirSync(folder).sort()).toEqual([`${ID_A}.json`, `${ID_B}.json`]);
		const withAward = JSON.parse(readFileSync(join(folder, `${ID_B}.json`), "utf8"));
		const without = JSON.parse(readFileSync(join(folder, `${ID_A}.json`), "utf8"));
		expect(withAward.contribution).toMatchObject({ awardUnit: "FLOW", awardQuantity: "10" });
		expect(without.contribution).toMatchObject({ awardUnit: "", awardQuantity: "0" });
		expect(readFileSync(join(folder, `${ID_A}.json`), "utf8")).not.toContain("Private Name");
		expect(verifyFile(join(folder, `${ID_B}.json`), undefined, deps)).toEqual(
			Result.succeed(expect.objectContaining({ valid: true, signer: ADDRESS })),
		);
	});

	it("is idempotent: a second run leaves identical certificates alone", async () => {
		const deps = ready(listing(item(ID_A)));
		await outcomeOf(deps);
		const path = join(deps.stateRoot, PROJECT, `${ID_A}.json`);
		const before = readFileSync(path, "utf8");
		const again = await outcomeOf({ ...deps, run: listing(item(ID_A), item(ID_B)) });
		expect(again.report).toMatchObject({
			created: [join(deps.stateRoot, PROJECT, `${ID_B}.json`)],
			unchanged: [path],
		});
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("reports and keeps a differing existing certificate", async () => {
		const out = join(root, "certs");
		const deps = ready(listing(item(ID_A), item(ID_B)));
		mkdirSync(out);
		writeFileSync(join(out, `${ID_A}.json`), "{}\n");
		const outcome = await outcomeOf(deps, out);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.report).toMatchObject({
			status: "conflict",
			out,
			created: [join(out, `${ID_B}.json`)],
			conflicts: [join(out, `${ID_A}.json`)],
		});
		expect(readFileSync(join(out, `${ID_A}.json`), "utf8")).toBe("{}\n");
		expect(readdirSync(join(root, "attest"))).toEqual([KEY_FILE]);
	});

	it("succeeds with nothing to do when there are no contributions", async () => {
		const deps = ready(listing());
		const outcome = await outcomeOf(deps);
		expect(outcome.report).toMatchObject({ status: "ok", contributions: 0, created: [] });
		expect(readdirSync(join(deps.stateRoot, PROJECT))).toEqual([]);
	});

	it("writes nothing when any contribution record is malformed", async () => {
		const deps = ready(listing(item(ID_A), { ...item(ID_B), artifact_hash: "md5:x" }));
		expect(await runAttest({ project: PROJECT, workstreamCli: WS }, deps)).toEqual(
			Result.fail(`contribution ${ID_B}: artifact_hash is not sha256:<64 hex>`),
		);
		expect(readdirSync(deps.stateRoot)).toEqual([KEY_FILE]);
	});

	it.each([
		[{ exitCode: 3, stderr: "Error: not authorized\nmore detail" }, "(exit 3): Error: not authorized"],
		[{ exitCode: undefined, errorCode: "ENOENT" }, "(ENOENT): "],
		[{ exitCode: undefined, timedOut: true }, "(did not run): "],
	])("reports a WorkStream CLI failure %o and writes nothing", async (result, message) => {
		const deps = ready(respond(result));
		expect(await runAttest({ project: PROJECT, workstreamCli: WS }, deps)).toEqual(
			Result.fail(`WorkStream contributions failed ${message}`),
		);
		expect(readdirSync(deps.stateRoot)).toEqual([KEY_FILE]);
	});

	it("checks the project and the key before calling WorkStream", async () => {
		expect(await runAttest({ project: "../etc", workstreamCli: WS }, ready(listing()))).toEqual(
			Result.fail("--project must be a WorkStream project UUID"),
		);
		const outcome = await runAttest(
			{ project: PROJECT, workstreamCli: WS },
			depsWith(listing(), { stateRoot: join(root, "none") }),
		);
		expect(Result.isFailure(outcome) && outcome.failure).toMatch(/^No test signing key/);
		expect(calls).toEqual([]);
	});
});

describe("file writes and verification", () => {
	it("creates new files without replacing existing ones and leaves no temporary files", () => {
		const path = join(root, "file.json");
		expect(writeNew(path, "one")).toBe("created");
		expect(writeNew(path, "two")).toBe("exists");
		expect(readFileSync(path, "utf8")).toBe("one");
		expect(readdirSync(root)).toEqual(["file.json"]);
	});

	it("passes on link errors other than an existing file and cleans up", () => {
		linkFailure.code = "EIO";
		expect(() => writeNew(join(root, "file.json"), "one")).toThrow("link failed: EIO");
		expect(readdirSync(root)).toEqual([]);
	});

	it("verifies against an explicit attester, the local key, or explains what is missing", async () => {
		const deps = depsWith(listing(item(ID_A)));
		initKey(deps);
		await runAttest({ project: PROJECT, workstreamCli: WS }, deps);
		const path = join(deps.stateRoot, PROJECT, `${ID_A}.json`);
		const other = addressOf(keccak(utf8ToBytes("other")));
		expect(verifyFile(path, other, deps)).toEqual(
			Result.succeed({ valid: false, reason: `signed by ${ADDRESS}, not the expected attester ${other}` }),
		);
		const noKey = depsWith(listing(), { stateRoot: join(root, "none") });
		expect(verifyFile(path, ADDRESS, noKey)).toEqual(Result.succeed(expect.objectContaining({ valid: true })));
		expect(verifyFile(path, undefined, noKey)).toEqual(
			Result.fail(
				`No test signing key at ${join(root, "none", KEY_FILE)}. Run: harnessy attest key init. Or pass --attester <address>.`,
			),
		);
		expect(verifyFile(join(root, "missing.json"), ADDRESS, deps)).toEqual(
			Result.fail(`Cannot read ${join(root, "missing.json")}`),
		);
	});

	it("defaults to the XDG state folder and a random key", () => {
		const previous = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = "/xdg";
		expect(defaultAttestRoot()).toBe("/xdg/harnessy/attest");
		for (const ignored of ["", "relative/state"]) {
			process.env.XDG_STATE_HOME = ignored;
			expect(defaultAttestRoot()).toBe(join(homedir(), ".local", "state", "harnessy", "attest"));
		}
		delete process.env.XDG_STATE_HOME;
		expect(defaultAttestRoot()).toMatch(/\.local\/state\/harnessy\/attest$/);
		if (previous !== undefined) process.env.XDG_STATE_HOME = previous;
		const live = liveAttestDeps(listing());
		expect(live.platform).toBe(process.platform);
		const a = live.randomSecretKey();
		expect(a).toHaveLength(32);
		expect(toHex(live.randomSecretKey())).not.toBe(toHex(a));
	});
});
