import { createHash, generateKeyPairSync, verify } from "node:crypto";
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

import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JarvisMeetingPublicationConfig } from "../../harnessy-core/src/jarvis/config-model.ts";
import {
	canonicalMeetingPublicationSmokeJson,
	MEETING_PUBLICATION_SERVICE_AUDIENCE,
} from "../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import { createMeetingPublicationFullReviewAuthorizationFixture } from "../../harnessy-core/test/support/meeting-full-review-runtime-fixture.ts";
import { runMeetingFullReviewCommand } from "../src/meeting-full-review-command.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("offline service enrollment command", () => {
	let root: string;
	let args: string[];
	let request: Record<string, unknown>;
	let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "service-enrollment-command-"));
		for (const name of ["state", "notes", "credentials", "artifact", "control"])
			mkdirSync(join(root, name), { mode: 0o700 });
		for (const name of ["core", "host", "sdk", "dependencies"]) writeFileSync(join(root, "artifact", name), name);
		writeFileSync(join(root, "state", "meeting-publication.sqlite3"), "untouched queue sentinel", { mode: 0o600 });
		writeFileSync(join(root, "engine.db"), "untouched credentials sentinel", { mode: 0o600 });
		const config = new JarvisMeetingPublicationConfig({
			enabled: true,
			project: "fixture",
			sourcePath: join(root, "notes"),
			statePath: join(root, "state"),
			backfillDays: 365,
			cutoverDate: "2026-01-01",
			maxFileBytes: 32_000,
			maxFiles: 100,
			leaseSeconds: 60,
			reminderSeconds: 3600,
			reviewHost: "127.0.0.1",
			reviewPort: 18783,
			reviewSessionSeconds: 900,
			reviewMaxSessions: 64,
			reviewMaxBodyBytes: 32_000,
			googleOwnerEmail: "owner@example.test",
			googleDriveFolder: "Meetings",
			discordChannelId: "123456",
		});
		const fixture = createMeetingPublicationFullReviewAuthorizationFixture({
			privateRoot: join(root, "control"),
			config,
			credentialDirectory: join(root, "credentials"),
			engineStatePath: join(root, "engine.db"),
			installationRoot: join(root, "artifact"),
			artifactAnchors: {
				core: join(root, "artifact/core"),
				host: join(root, "artifact/host"),
				sdk: join(root, "artifact/sdk"),
				dependencies: join(root, "artifact/dependencies"),
			},
		});
		request = JSON.parse(readFileSync(fixture.createServiceInput({ fresh: true }).authorizationPath, "utf8")).payload;
		const keys = generateKeyPairSync("ed25519");
		publicKey = keys.publicKey;
		writeFileSync(join(root, "owner.pem"), keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
		const bytes = `${canonicalMeetingPublicationSmokeJson(request)}\n`;
		writeFileSync(join(root, "request.json"), bytes, { mode: 0o600 });
		args = [
			"--enroll-service",
			"--request",
			join(root, "request.json"),
			"--request-sha256",
			hash(bytes),
			"--owner-key",
			join(root, "owner.pem"),
			"--public-key-sha256",
			hash(publicKey.export({ type: "spki", format: "der" })),
			"--output",
			join(root, "enrollment.json"),
		];
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const run = () =>
		Effect.runPromise(runMeetingFullReviewCommand(args, () => Effect.die("Enrollment must not start review.")));

	it("signs only the reviewed request, with independent key pin and no activation", async () => {
		const keyBefore = readFileSync(join(root, "owner.pem"));
		const queueBefore = readFileSync(join(root, "state/meeting-publication.sqlite3"));
		const engineBefore = readFileSync(join(root, "engine.db"));
		expect(await run()).toEqual({
			exitCode: 0,
			value: { kind: "harnessy.meeting-publication.service-enrollment-created", activated: false },
		});
		const text = readFileSync(join(root, "enrollment.json"), "utf8");
		const envelope = JSON.parse(text);
		expect(envelope.payload).toEqual(request);
		expect(text).toBe(`${canonicalMeetingPublicationSmokeJson(envelope)}\n`);
		expect(
			verify(
				null,
				Buffer.from(`${MEETING_PUBLICATION_SERVICE_AUDIENCE}\0${canonicalMeetingPublicationSmokeJson(request)}`),
				publicKey,
				Buffer.from(envelope.signature, "base64url"),
			),
		).toBe(true);
		expect(lstatSync(join(root, "enrollment.json")).mode & 0o777).toBe(0o600);
		expect(readFileSync(join(root, "owner.pem"))).toEqual(keyBefore);
		expect(readFileSync(join(root, "state/meeting-publication.sqlite3"))).toEqual(queueBefore);
		expect(readFileSync(join(root, "engine.db"))).toEqual(engineBefore);
	});

	it.each([
		"request drift",
		"key mismatch",
		"public key file",
		"public request",
		"duplicate flag",
		"finite authority",
		"extra operation",
		"mixed evidence",
		"key in state",
		"key in artifact",
	])("rejects %s without output or secret disclosure", async (failure) => {
		if (failure === "request drift") args[4] = "0".repeat(64);
		if (failure === "key mismatch") args[8] = "0".repeat(64);
		if (failure === "public key file") chmodSync(join(root, "owner.pem"), 0o644);
		if (failure === "public request") chmodSync(join(root, "request.json"), 0o644);
		if (failure === "duplicate flag") args[7] = "--request-sha256";
		if (failure === "key in state" || failure === "key in artifact") {
			const path = join(root, failure === "key in state" ? "state" : "artifact", "owner.pem");
			writeFileSync(path, readFileSync(join(root, "owner.pem")), { mode: 0o600 });
			args[6] = path;
		}
		if (["finite authority", "extra operation", "mixed evidence"].includes(failure)) {
			if (failure === "finite authority") request.kind = "harnessy.meeting-publication.full-review-authorization";
			if (failure === "extra operation") request.operations = ["arbitrary_operation"];
			if (failure === "mixed evidence")
				request.rollbackPlan = { path: join(root, "CANARY"), sha256: "0".repeat(64) };
			const text = `${canonicalMeetingPublicationSmokeJson(request)}\n`;
			writeFileSync(join(root, "request.json"), text);
			args[4] = hash(text);
		}
		expect(await run()).toEqual({
			exitCode: 1,
			value: { error: "meeting_full_review_failed", code: "invalid_input" },
		});
		expect(existsSync(join(root, "enrollment.json"))).toBe(false);
	});

	it("never overwrites existing enrollment", async () => {
		writeFileSync(join(root, "enrollment.json"), "existing enrollment", { mode: 0o600 });
		expect((await run()).exitCode).toBe(1);
		expect(readFileSync(join(root, "enrollment.json"), "utf8")).toBe("existing enrollment");
	});

	it("provisions first-run state without signing, activation or replacing existing state", async () => {
		const state = join(root, "fresh-state");
		const control = join(root, "fresh-control");
		mkdirSync(state, { mode: 0o700 });
		mkdirSync(control, { mode: 0o700 });
		const publicKeyPath = join(root, "owner.pub");
		writeFileSync(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
		const path = join(root, "setup.json");
		writeFileSync(
			path,
			JSON.stringify({
				kind: "harnessy.meeting-publication.service-setup.v1",
				stateDirectory: state,
				controlDirectory: control,
				publicKeyPath,
				publicKeySha256: hash(publicKey.export({ type: "spki", format: "der" })),
				issuer: "fixture",
				keyId: "existing-key",
			}),
			{ mode: 0o600 },
		);
		args = ["--setup-service", "--input", path];
		const keyBefore = readFileSync(join(root, "owner.pem"));
		expect(await run()).toMatchObject({
			exitCode: 0,
			value: { kind: "harnessy.meeting-publication.service-provisioned", activated: false },
		});
		expect(readdirSync(state)).toEqual(["meeting-publication.sqlite3"]);
		expect(readdirSync(control).sort()).toEqual(["service-replay.sqlite3", "service-trust.json"]);
		const trustBefore = readFileSync(join(control, "service-trust.json"));
		expect((await run()).exitCode).toBe(1);
		expect(readFileSync(join(control, "service-trust.json"))).toEqual(trustBefore);
		expect(readFileSync(join(root, "owner.pem"))).toEqual(keyBefore);
		expect(readFileSync(join(root, "state/meeting-publication.sqlite3"), "utf8")).toBe("untouched queue sentinel");

		const finitePath = join(root, "finite-trust.json");
		const finiteTrust = {
			...JSON.parse(trustBefore.toString()),
			kind: "harnessy.meeting-publication.full-review-trust",
			audience: "harnessy.meeting-publication.full-review.v1",
		};
		writeFileSync(finitePath, `${canonicalMeetingPublicationSmokeJson(finiteTrust)}\n`, { mode: 0o600 });
		const pinned = lstatSync(finitePath, { bigint: true });
		const adoptionControl = join(root, "adopted-control");
		mkdirSync(adoptionControl, { mode: 0o700 });
		const adoptionInput = join(root, "adoption.json");
		writeFileSync(
			adoptionInput,
			JSON.stringify({
				kind: "harnessy.meeting-publication.service-adoption.v1",
				controlDirectory: adoptionControl,
				trustedKeyring: {
					path: finitePath,
					device: pinned.dev.toString(),
					inode: pinned.ino.toString(),
					sha256: hash(readFileSync(finitePath)),
				},
			}),
			{ mode: 0o600 },
		);
		const replayBefore = readFileSync(finiteTrust.replay.path);
		args = ["--setup-service", "--input", adoptionInput];
		expect(await run()).toMatchObject({ exitCode: 0, value: { activated: false } });
		expect(readdirSync(adoptionControl)).toEqual(["service-trust.json"]);
		expect(readFileSync(join(adoptionControl, "service-trust.json"))).toEqual(trustBefore);
		expect(readFileSync(finiteTrust.replay.path)).toEqual(replayBefore);
		expect(readFileSync(join(root, "owner.pem"))).toEqual(keyBefore);
	});

	it.each(["malformed JSON", "public input", "relative output", "duplicate flag", "unknown schema"])(
		"rejects preparation with %s without activation or input disclosure",
		async (failure) => {
			const input = join(root, "preparation.json");
			const output = join(root, "prepared");
			mkdirSync(output, { mode: 0o700 });
			writeFileSync(input, failure === "malformed JSON" ? "CANARY" : JSON.stringify({ secret: "CANARY" }), {
				mode: 0o600,
			});
			args = ["--prepare-service", "--input", input, "--output-directory", output];
			if (failure === "public input") chmodSync(input, 0o644);
			if (failure === "relative output") args[4] = "relative-output";
			if (failure === "duplicate flag") args[3] = "--input";
			const before = readFileSync(input);
			expect(await run()).toEqual({
				exitCode: 1,
				value: { error: "meeting_full_review_failed", code: "invalid_input" },
			});
			expect(readFileSync(input)).toEqual(before);
			expect(readdirSync(output)).toEqual([]);
		},
	);
});
