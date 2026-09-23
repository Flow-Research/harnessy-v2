import { createHash, generateKeyPairSync, verify } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeCommunityServiceEnrollmentRequest } from "@harnessy/core/community-briefing";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMUNITY_BRIEFING_GRANT_SCHEMA_SQL } from "../../harnessy-core/src/jarvis/community-briefing/grant-host.ts";
import { CommunityOperationSystemReference } from "../../harnessy-core/src/jarvis/community-briefing/operational-runtime.ts";
import { canonicalMeetingPublicationSmokeJson } from "../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import { MeetingPublicationSmokeRuntimeSystemReference } from "../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { enrollCommunityService, prepareCommunityService } from "../src/community-service-enrollment.ts";

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => `${canonicalMeetingPublicationSmokeJson(value)}\n`;

describe("community offline service enrollment", () => {
	let root: string;
	let ownerRoot: string;
	let runtimeRoot: string;
	let requestPath: string;
	let keyPath: string;
	let outputPath: string;
	let publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"];
	let payload: Record<string, unknown>;

	const privateJson = (name: string, value: unknown) => {
		const path = join(runtimeRoot, `${name}.json`);
		const bytes = canonical(value);
		writeFileSync(path, bytes, { mode: 0o600 });
		const stat = lstatSync(path, { bigint: true });
		return {
			path,
			device: stat.dev.toString(),
			inode: stat.ino.toString(),
			sha256: digest(bytes),
		};
	};

	const writeRequest = (value: unknown = payload, canonicalize = true) => {
		const bytes = canonicalize ? canonical(value) : `${JSON.stringify(value, null, 2)}\n`;
		writeFileSync(requestPath, bytes, { mode: 0o600 });
		return bytes;
	};

	const enroll = (overrides: { requestHash?: string; fingerprint?: string } = {}) => {
		const bytes = readFileSync(requestPath);
		return enrollCommunityService([
			"--request",
			requestPath,
			"--request-sha256",
			overrides.requestHash ?? digest(bytes),
			"--owner-key",
			keyPath,
			"--public-key-sha256",
			overrides.fingerprint ?? digest(publicKey.export({ type: "spki", format: "der" })),
			"--output",
			outputPath,
		]);
	};

	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "community-enrollment-"));
		ownerRoot = join(root, "owner");
		runtimeRoot = join(root, "runtime");
		for (const path of [ownerRoot, runtimeRoot]) mkdirSync(path, { mode: 0o700 });
		for (const name of ["artifact", "sources", "drafts", "state", "credentials", "engine", "queue"])
			mkdirSync(join(runtimeRoot, name), { mode: 0o700 });

		const keys = generateKeyPairSync("ed25519");
		publicKey = keys.publicKey;
		keyPath = join(ownerRoot, "owner.pem");
		requestPath = join(ownerRoot, "request.json");
		outputPath = join(ownerRoot, "enrollment.json");
		writeFileSync(keyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });

		const artifactManifest = privateJson("artifact-manifest", { root: join(runtimeRoot, "artifact") });
		const config = privateJson("config", {
			sourcePath: join(runtimeRoot, "sources"),
			draftPath: join(runtimeRoot, "drafts"),
		});
		const identity = (path: string) => ({ path, device: "1", inode: "1" });
		const pinned = (path: string) => ({ ...identity(path), sha256: "0".repeat(64) });
		const snapshot = () => ({ device: "1", inode: "1", sha256: "0".repeat(64) });
		const instant = "2026-09-23T00:00:00.000Z";
		payload = {
			issuer: "fixture-owner",
			grantId: "a".repeat(64),
			queuePath: join(runtimeRoot, "queue", "community.sqlite3"),
			statePath: join(runtimeRoot, "state"),
			briefingId: null,
			sourceHash: null,
			expiresAt: null,
			providerScope: {
				tenantId: "fixture-tenant",
				subjectId: "fixture-subject",
				credentialDirectory: join(runtimeRoot, "credentials"),
				engineStatePath: join(runtimeRoot, "engine", "data.db"),
				google: {
					owner: "user",
					connection: "community-google",
					authTemplate: "google-drive-file",
					ownerEmail: "owner@example.test",
					folderPath: "Published/Community",
				},
				discord: {
					owner: "user",
					connection: "community-discord",
					authTemplate: "discord-bot",
					channelId: "123456",
				},
				transport: { mode: "production" },
			},
			operational: {
				kind: "harnessy.community.briefing.service.v1",
				keyId: "fixture-key",
				issuedAt: instant,
				notBefore: instant,
				runtime: {
					platform: process.platform,
					architecture: process.arch,
					hostname: "fixture",
					uid: String(process.geteuid?.()),
					bootId: null,
					executablePath: join(runtimeRoot, "artifact", "core"),
					executableSha256: "0".repeat(64),
				},
				ledger: identity(join(runtimeRoot, "state", "community-grants.sqlite3")),
				queue: snapshot(),
				engine: snapshot(),
				config,
				artifactManifest,
				cutoverEvidence: pinned(join(runtimeRoot, "cutover.json")),
				rollbackPlan: pinned(join(runtimeRoot, "rollback.json")),
			},
		};
		writeRequest();
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("signs the exact reviewed service request without changing its inputs", () => {
		const keyBefore = readFileSync(keyPath);
		const requestBefore = readFileSync(requestPath);
		expect(enroll()).toEqual({
			kind: "harnessy.community.briefing.service-enrollment-created",
			activated: false,
		});

		const text = readFileSync(outputPath, "utf8");
		const envelope = JSON.parse(text) as { payload?: unknown; signature: string };
		const encoded = encodeCommunityServiceEnrollmentRequest(payload);
		expect(envelope).toMatchObject(payload);
		expect(text).toBe(encoded.envelope(envelope.signature));
		expect(verify(null, encoded.signingBytes, publicKey, Buffer.from(envelope.signature, "base64"))).toBe(true);
		expect(lstatSync(outputPath).mode & 0o777).toBe(0o600);
		expect(readFileSync(keyPath)).toEqual(keyBefore);
		expect(readFileSync(requestPath)).toEqual(requestBefore);
	});

	it("prepares private review files from quiescent state without mutating operational databases", async () => {
		const artifactRoot = join(runtimeRoot, "artifact");
		const anchors = Object.fromEntries(
			["core", "host", "sdk", "dependencies"].map((role) => {
				const path = join(artifactRoot, role);
				writeFileSync(path, `${role} artifact`, { mode: 0o600 });
				return [role, path];
			}),
		) as Record<"core" | "host" | "sdk" | "dependencies", string>;
		const statePath = join(runtimeRoot, "state");
		const ledgerPath = join(statePath, "community-grants.sqlite3");
		const ledger = new DatabaseSync(ledgerPath);
		ledger.exec(COMMUNITY_BRIEFING_GRANT_SCHEMA_SQL);
		ledger.close();
		chmodSync(ledgerPath, 0o600);
		const queuePath = join(runtimeRoot, "queue", "community.sqlite3");
		const queue = new DatabaseSync(queuePath);
		queue.exec("CREATE TABLE community_briefings(status TEXT NOT NULL, lease_until TEXT)");
		queue.close();
		chmodSync(queuePath, 0o600);
		const enginePath = join(runtimeRoot, "engine", "data.db");
		writeFileSync(enginePath, "quiescent engine snapshot", { mode: 0o600 });

		const trust = privateJson("trust", {
			kind: "harnessy.community.briefing.trust.v1",
			keys: [
				{
					issuer: "fixture-owner",
					keyId: "fixture-key",
					publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
					publicKeySha256: digest(publicKey.export({ type: "spki", format: "der" })),
				},
			],
		});
		const providerScope = payload.providerScope as Record<string, unknown>;
		providerScope.engineStatePath = enginePath;
		const config = privateJson("preparation-config", {
			providerScope,
			sourcePath: join(runtimeRoot, "sources"),
			draftPath: join(runtimeRoot, "drafts"),
		});
		const cutover = privateJson("cutover", { reviewed: true });
		const rollback = privateJson("rollback", { command: "restore" });
		const inputPath = join(ownerRoot, "preparation.json");
		const output = join(ownerRoot, "prepared");
		mkdirSync(output, { mode: 0o700 });
		writeFileSync(
			inputPath,
			JSON.stringify({
				issuer: "fixture-owner",
				keyId: "fixture-key",
				queuePath,
				statePath,
				configPath: config.path,
				installationRoot: artifactRoot,
				cutoverEvidencePath: cutover.path,
				rollbackPlanPath: rollback.path,
				trustedKeyring: trust,
			}),
			{ mode: 0o600 },
		);
		const databases = [ledgerPath, queuePath, enginePath];
		const before = databases.map((path) => readFileSync(path));
		const result = await Effect.runPromise(
			prepareCommunityService(["--input", inputPath, "--output-directory", output], {
				host: anchors.host,
				sdk: anchors.sdk,
				dependencies: anchors.dependencies,
			}).pipe(
				Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
					observe: () => ({
						now: Date.parse("2026-09-23T00:00:00.000Z"),
						monotonic: 1n,
						platform: process.platform as "darwin" | "linux",
						architecture: process.arch,
						hostname: "fixture",
						uid: BigInt(process.geteuid?.() ?? 0),
						bootId: "fixture-boot",
						executablePath: anchors.core,
					}),
					proveNoKnownV1Writers: () => {
						throw new Error("preparation must not inspect writers");
					},
				}),
				Effect.provideService(CommunityOperationSystemReference, {
					coreAnchor: anchors.core,
					proveCompatibilityAbsent: () => {
						throw new Error("preparation must not inspect writers");
					},
				}),
			),
		);

		expect(result).toMatchObject({
			kind: "harnessy.community.briefing.service-request-prepared",
			activated: false,
			requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		expect(databases.map((path) => readFileSync(path))).toEqual(before);
		expect(JSON.parse(readFileSync(join(output, "service.json"), "utf8"))).toMatchObject({
			kind: "harnessy.community.briefing.service-config.v1",
			authorizationPath: join(output, "enrollment.json"),
			trustedKeyring: trust,
		});
		for (const name of ["artifact-manifest.json", "request.json", "service.json"])
			expect(lstatSync(join(output, name)).mode & 0o777).toBe(0o600);
	});

	it.each([
		"request drift",
		"noncanonical request",
		"binding drift",
		"invalid binding",
		"key inside runtime",
		"unsafe output",
		"existing output",
	])("rejects %s without replacing enrollment or changing the owner key", (failure) => {
		if (failure === "noncanonical request") writeRequest(payload, false);
		if (failure === "binding drift")
			writeFileSync(join(runtimeRoot, "artifact-manifest.json"), canonical({ root: "/changed" }));
		if (failure === "invalid binding") {
			const binding = privateJson("invalid-manifest", []);
			(payload.operational as { artifactManifest: unknown }).artifactManifest = binding;
			writeRequest();
		}
		if (failure === "key inside runtime") {
			keyPath = join(runtimeRoot, "state", "owner.pem");
			writeFileSync(keyPath, readFileSync(join(ownerRoot, "owner.pem")), { mode: 0o600 });
		}
		if (failure === "unsafe output") {
			const publicOutput = join(root, "public-output");
			mkdirSync(publicOutput, { mode: 0o755 });
			outputPath = join(publicOutput, "enrollment.json");
		}
		if (failure === "existing output") writeFileSync(outputPath, "preserved", { mode: 0o600 });
		const keyBefore = readFileSync(keyPath);

		expect(() => enroll(failure === "request drift" ? { requestHash: "0".repeat(64) } : {})).toThrow();
		expect(readFileSync(keyPath)).toEqual(keyBefore);
		expect(existsSync(outputPath)).toBe(failure === "existing output");
		if (failure === "existing output") expect(readFileSync(outputPath, "utf8")).toBe("preserved");
	});
});
