/**
 * `harnessy attest`: the TEST signing key, certificate issuance from
 * WorkStream contributions, and certificate verification. Private state lives
 * under `$XDG_STATE_HOME/harnessy/attest` (default `~/.local/state/harnessy/attest`).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as Result from "effect/Result";
import { field, isTaskId, parseJson } from "../work/logic.ts";
import type { Run } from "../work/run.ts";
import { certificateText, parseContributions, TEST_NOTICE, type Verdict, verifyCertificate } from "./certificate.ts";
import { addressOf, isValidSecretKey, parseHex, toHex } from "./eas.ts";

export interface AttestDeps {
	readonly run: Run;
	/** Private attest state directory holding the key and the default certificate folders. */
	readonly stateRoot: string;
	readonly platform: string;
	readonly randomSecretKey: () => Uint8Array;
}

export interface Outcome {
	readonly exitCode: number;
	readonly report: Readonly<Record<string, unknown>>;
}

export const KEY_FILE = "test-signer.key";
export const KEY_LABEL =
	"TEST signing key for Harnessy test certificates only. Not a Flow production key. Never share this file.";
const WORKSTREAM_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * `$XDG_STATE_HOME/harnessy/attest`, defaulting to `~/.local/state/harnessy/attest`.
 * An empty or relative `XDG_STATE_HOME` is ignored, as the XDG spec requires, so
 * the key never lands under the current directory.
 */
export const defaultAttestRoot = (): string => {
	const xdg = process.env.XDG_STATE_HOME;
	return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state"), "harnessy", "attest");
};

export const liveAttestDeps = (run: Run): AttestDeps => ({
	run,
	stateRoot: defaultAttestRoot(),
	platform: process.platform,
	randomSecretKey: () => secp256k1.utils.randomSecretKey(),
});

export const keyPath = (deps: AttestDeps): string => join(deps.stateRoot, KEY_FILE);

const errnoCode = (error: unknown): unknown => (error as NodeJS.ErrnoException).code;

const privateRoot = (deps: AttestDeps) => {
	mkdirSync(deps.stateRoot, { recursive: true, mode: 0o700 });
	chmodSync(deps.stateRoot, 0o700);
};

/**
 * Create `path` with `data` (mode 0600) only if nothing is there. The data is
 * written to a temporary file first and hard-linked into place, which is atomic
 * and never replaces an existing file, so a crash or a concurrent run cannot
 * leave a partial or overwritten file.
 */
export const writeNew = (path: string, data: string): "created" | "exists" => {
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
	chmodSync(temporary, 0o600);
	const linked = Result.try(() => linkSync(temporary, path));
	unlinkSync(temporary);
	if (Result.isSuccess(linked)) return "created";
	if (errnoCode(linked.failure) === "EEXIST") return "exists";
	throw linked.failure;
};

/** `harnessy attest key init`: create the TEST key once. Only the signer address is reported. */
export const initKey = (deps: AttestDeps): Outcome => {
	privateRoot(deps);
	const path = keyPath(deps);
	// Generate a secret only when no key is there; `writeNew` still refuses one created meanwhile.
	if (Result.isFailure(Result.try(() => lstatSync(path)))) {
		const secretKey = deps.randomSecretKey();
		const address = addressOf(secretKey);
		const body = { label: KEY_LABEL, test: true, address, secretKey: toHex(secretKey) };
		if (writeNew(path, `${JSON.stringify(body, null, 2)}\n`) === "created")
			return { exitCode: 0, report: { status: "created", test: true, path, address, label: KEY_LABEL } };
	}
	const existing = loadKey(deps);
	const known = Result.isSuccess(existing) ? ` Its signer address is ${existing.success.address}.` : "";
	return {
		exitCode: 1,
		report: {
			status: "exists",
			test: true,
			path,
			message: `A test signing key already exists; not replaced.${known}`,
		},
	};
};

export interface SigningKey {
	readonly secretKey: Uint8Array;
	readonly address: string;
}

/** Read the TEST key, refusing symlinks, files others can read, and corrupt or non-test keys. */
export const loadKey = (deps: AttestDeps): Result.Result<SigningKey, string> => {
	const path = keyPath(deps);
	const stat = Result.try(() => lstatSync(path));
	if (Result.isFailure(stat))
		return Result.fail(
			errnoCode(stat.failure) === "ENOENT"
				? `No test signing key at ${path}. Run: harnessy attest key init`
				: `Cannot read the test signing key at ${path}`,
		);
	if (!stat.success.isFile()) return Result.fail(`The test signing key at ${path} is not a regular file`);
	if (deps.platform !== "win32" && (stat.success.mode & 0o077) !== 0)
		return Result.fail(`The test signing key at ${path} is readable by other users; run chmod 600 on it`);
	const body = parseJson(readFileSync(path, "utf8"));
	const secretKey = parseHex(field(body, "secretKey"), 32);
	if (field(body, "test") !== true || secretKey === undefined || !isValidSecretKey(secretKey))
		return Result.fail(`The test signing key at ${path} is not a valid TEST key`);
	const address = addressOf(secretKey);
	if (field(body, "address") !== address)
		return Result.fail(`The test signing key at ${path} does not match its recorded address`);
	return Result.succeed({ secretKey, address });
};

export interface RunOptions {
	readonly project: string;
	readonly workstreamCli: ReadonlyArray<string>;
	readonly out?: string;
}

const firstLine = (text: string): string =>
	text
		.trim()
		.replace(/\n[\s\S]*$/, "")
		.slice(0, 300);

/**
 * `harnessy attest run`: sign one certificate per contribution that has none
 * yet. Certificates are deterministic, so an identical existing file is left
 * alone and a different one is reported as a conflict and never replaced.
 */
export const runAttest = async (options: RunOptions, deps: AttestDeps): Promise<Result.Result<Outcome, string>> => {
	if (!isTaskId(options.project)) return Result.fail("--project must be a WorkStream project UUID");
	const key = loadKey(deps);
	if (Result.isFailure(key)) return Result.fail(key.failure);
	const result = await deps.run(
		[...options.workstreamCli, "contributions", "--project", options.project, "-o", "json"],
		{ timeoutMs: WORKSTREAM_TIMEOUT_MS },
	);
	if (result.exitCode !== 0)
		return Result.fail(
			`WorkStream contributions failed (${result.exitCode === undefined ? (result.errorCode ?? "did not run") : `exit ${result.exitCode}`}): ${firstLine(result.stderr)}`,
		);
	const claims = parseContributions(result.stdout, options.project);
	if (Result.isFailure(claims)) return Result.fail(claims.failure);
	const out = options.out ?? join(deps.stateRoot, options.project.toLowerCase());
	if (options.out === undefined) privateRoot(deps);
	mkdirSync(out, { recursive: true, mode: 0o700 });
	const created: string[] = [];
	const unchanged: string[] = [];
	const conflicts: string[] = [];
	for (const claim of claims.success) {
		const path = join(out, `${claim.contributionId}.json`);
		const text = certificateText(claim, key.success.secretKey, key.success.address);
		if (writeNew(path, text) === "created") created.push(path);
		else if (readFileSync(path, "utf8") === text) unchanged.push(path);
		else conflicts.push(path);
	}
	return Result.succeed({
		exitCode: conflicts.length > 0 ? 1 : 0,
		report: {
			status: conflicts.length > 0 ? "conflict" : "ok",
			test: true,
			notice: TEST_NOTICE,
			project: options.project,
			signer: key.success.address,
			out,
			contributions: claims.success.length,
			created,
			unchanged,
			conflicts,
		},
	});
};

/** `harnessy attest verify`: check a certificate against `attester`, or the local TEST key's address. */
export const verifyFile = (
	path: string,
	attester: string | undefined,
	deps: AttestDeps,
): Result.Result<Verdict, string> => {
	const text = Result.try(() => readFileSync(path, "utf8"));
	if (Result.isFailure(text)) return Result.fail(`Cannot read ${path}`);
	if (attester !== undefined) return Result.succeed(verifyCertificate(text.success, attester));
	const key = loadKey(deps);
	if (Result.isFailure(key)) return Result.fail(`${key.failure}. Or pass --attester <address>.`);
	return Result.succeed(verifyCertificate(text.success, key.success.address));
};
