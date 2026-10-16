import "../../harnessy-local-host/test/support/fixture-network-guard.mjs";

import { type ChildProcess, fork } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runCommunityDraftProcess } from "../../harnessy-core/src/jarvis/community-briefing/draft-process.ts";
import {
	CommunityBriefingGrantHost,
	communityBriefingGrantPayload,
} from "../../harnessy-core/src/jarvis/community-briefing/grant-host.ts";
import { readCommunityOperation } from "../../harnessy-core/src/jarvis/community-briefing/operational-input.ts";
import {
	CommunityOperationSystemReference,
	runAuthorizedCommunityBriefing,
} from "../../harnessy-core/src/jarvis/community-briefing/operational-runtime.ts";
import { runCommunityReviewProcess } from "../../harnessy-core/src/jarvis/community-briefing/review-process.ts";
import { canonicalMeetingPublicationSmokeJson } from "../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import { MeetingPublicationSmokeRuntimeSystemReference } from "../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { runCommunityPublicationCommand } from "../../harnessy-local-host/src/community-publication-command.ts";
import { prepareCommunityService } from "../../harnessy-local-host/src/community-service-enrollment.ts";
import { runNativeCommunityBriefing } from "../src/community-briefing/runtime.ts";
import { makeCommunityRuntimeFixture } from "./support/community-runtime-fixture.ts";

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => `${canonicalMeetingPublicationSmokeJson(value)}\n`;
const file = (path: string) => {
	const stat = lstatSync(path, { bigint: true });
	return { path, device: stat.dev.toString(), inode: stat.ino.toString(), sha256: digest(readFileSync(path)) };
};
const fixture = async (reviewPython?: string, service = false) => {
	const source = await makeCommunityRuntimeFixture();
	if (reviewPython) {
		const drafts = join(source.root, "drafts");
		mkdirSync(drafts, { mode: 0o700 });
		mkdirSync(join(source.root, "sources"), { mode: 0o700 });
		const queuePath = join(source.statePath, "weekly-briefings.sqlite3");
		const draft = await runCommunityDraftProcess({
			pythonPath: reviewPython,
			action: "generate",
			runId: "review-publication-quiet-week",
			week_start: "2026-09-14",
			config: {
				source_path: join(source.root, "sources"),
				draft_path: drafts,
				state_path: source.statePath,
				timezone: "Africa/Lagos",
			},
			timeoutMs: 5000,
			signal: new AbortController().signal,
			generate: async () => {
				throw new Error("Quiet week requires no AI");
			},
		});
		source.queuePath = queuePath;
		source.briefingId = draft.briefing_id;
		source.sourceHash = draft.draft_hash;
		const queue = new DatabaseSync(queuePath, { readOnly: true });
		try {
			const row = queue
				.prepare("SELECT briefing_path,discord_path FROM community_briefings WHERE briefing_id=?")
				.get(draft.briefing_id)!;
			source.markdownPath = String(row.briefing_path);
			source.discordPath = String(row.discord_path);
		} finally {
			queue.close();
		}
	}
	// The operational authorization binds a quiesced main-file snapshot, not
	// the fixture's persisted libSQL WAL mode. Checkpoint through SQLite itself.
	const snapshot = new DatabaseSync(source.engineStatePath);
	try {
		snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE);");
	} finally {
		snapshot.close();
	}
	const root = source.root;
	const keys = generateKeyPairSync("ed25519");
	const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
	const seed = new CommunityBriefingGrantHost(
		source.statePath,
		new Map([["fixture", pem]]),
		source.queuePath,
		source.statePath,
		source.providerScope,
	);
	seed.close();
	const artifactRoot = join(root, "artifact");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const anchors = ["core", "host", "sdk", "dependencies"].map((role) => {
		const path = join(artifactRoot, role);
		writeFileSync(path, `synthetic ${role} artifact`, { mode: 0o600 });
		return { role, path };
	});
	const paths = Object.fromEntries(anchors.map((entry) => [entry.role, entry.path]));
	const privateFile = (name: string, value: unknown) => {
		const path = join(root, `${name}.json`);
		writeFileSync(path, canonical(value), { mode: 0o600 });
		return file(path);
	};
	const manifest = privateFile("manifest", {
		kind: "harnessy.runtime-artifact-manifest",
		schemaVersion: 1,
		root: artifactRoot,
		anchors,
		files: anchors.map((entry) => file(entry.path)).sort((a, b) => a.path.localeCompare(b.path)),
	});
	const trust = privateFile("trust", {
		kind: "harnessy.community.briefing.trust.v1",
		keys: [
			{
				issuer: "fixture",
				keyId: "fixture-key",
				publicKeyPem: pem,
				publicKeySha256: digest(keys.publicKey.export({ type: "spki", format: "der" })),
			},
		],
	});
	const now = Date.now();
	const observation = {
		now,
		monotonic: 1000n,
		platform: "darwin" as const,
		architecture: process.arch,
		hostname: "fixture",
		uid: BigInt(process.geteuid?.() ?? 0),
		bootId: "fixture-boot",
		executablePath: paths.core,
	};
	const payload = {
		issuer: "fixture",
		grantId: "a".repeat(64),
		queuePath: source.queuePath,
		statePath: source.statePath,
		briefingId: service ? null : source.briefingId,
		sourceHash: service ? null : source.sourceHash,
		expiresAt: service ? null : new Date(now + 600_000).toISOString(),
		providerScope: source.providerScope,
		operational: {
			kind: service
				? ("harnessy.community.briefing.service.v1" as const)
				: ("harnessy.community.briefing.operation.v1" as const),
			keyId: "fixture-key",
			issuedAt: new Date(now).toISOString(),
			notBefore: new Date(now).toISOString(),
			runtime: {
				platform: observation.platform,
				architecture: observation.architecture,
				hostname: observation.hostname,
				uid: observation.uid.toString(),
				bootId: service ? null : observation.bootId,
				executablePath: paths.core,
				executableSha256: file(paths.core).sha256,
			},
			ledger: {
				path: join(source.statePath, "community-grants.sqlite3"),
				device: file(join(source.statePath, "community-grants.sqlite3")).device,
				inode: file(join(source.statePath, "community-grants.sqlite3")).inode,
			},
			queue: {
				device: file(source.queuePath).device,
				inode: file(source.queuePath).inode,
				sha256: file(source.queuePath).sha256,
			},
			engine: {
				device: file(source.engineStatePath).device,
				inode: file(source.engineStatePath).inode,
				sha256: file(source.engineStatePath).sha256,
			},
			config: privateFile("config", {
				providerScope: source.providerScope,
				sourcePath: join(root, "sources"),
				draftPath: join(root, "drafts"),
			}),
			artifactManifest: manifest,
			cutoverEvidence: privateFile("cutover", { fixtureOnly: true }),
			rollbackPlan: privateFile("rollback", { fixtureOnly: true }),
		},
	};
	const authorizationPath = join(root, "authorization.json");
	const writeAuthorization = () =>
		writeFileSync(
			authorizationPath,
			canonical({
				...payload,
				signature: sign(null, Buffer.from(communityBriefingGrantPayload(payload)), keys.privateKey).toString(
					"base64",
				),
			}),
			{ mode: 0o600 },
		);
	writeAuthorization();
	const input = { authorizationPath, trustedKeyring: trust };
	let compatibilityPresent = false;
	let onProof: (() => void) | undefined;
	const run = (enrollOnly = false) =>
		runAuthorizedCommunityBriefing(input, {
			artifactAnchors: { host: paths.host, sdk: paths.sdk, dependencies: paths.dependencies },
			...(enrollOnly ? { enrollOnly: true as const } : { publish: runNativeCommunityBriefing }),
		}).pipe(
			Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
				observe: () => observation,
				proveNoKnownV1Writers: () => {
					throw new Error("wrong workflow proof");
				},
			}),
			Effect.provideService(CommunityOperationSystemReference, {
				coreAnchor: paths.core,
				proveCompatibilityAbsent: () => {
					onProof?.();
					if (compatibilityPresent) throw new Error("writer");
				},
			}),
		);
	const rows = (sql: string) => {
		const db = new DatabaseSync(payload.operational.ledger.path, { readOnly: true });
		try {
			return db.prepare(sql).all();
		} finally {
			db.close();
		}
	};
	return {
		...source,
		ownerPrivateKey: keys.privateKey,
		ownerPublicKeyFingerprint: digest(keys.publicKey.export({ type: "spki", format: "der" })),
		control: (action: "status" | "revoke") => {
			const path = join(root, "service.json");
			writeFileSync(path, JSON.stringify({ kind: "harnessy.community.briefing.service-config.v1", ...input }), {
				mode: 0o600,
			});
			return runCommunityPublicationCommand([
				action === "status" ? "--service-status" : "--revoke-service",
				"--service-config",
				path,
			]).pipe(
				Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
					observe: () => observation,
					proveNoKnownV1Writers: () => {
						throw new Error("Control must not inspect other workflows");
					},
				}),
			);
		},
		input,
		payload,
		observation,
		paths,
		run,
		rows,
		writeAuthorization,
		distinctInput: () => {
			const second = { ...payload, grantId: "b".repeat(64) };
			const path = join(root, "second-authorization.json");
			writeFileSync(
				path,
				canonical({
					...second,
					signature: sign(null, Buffer.from(communityBriefingGrantPayload(second)), keys.privateKey).toString(
						"base64",
					),
				}),
				{ mode: 0o600 },
			);
			return { ...input, authorizationPath: path };
		},
		setCompatibilityPresent: () => {
			compatibilityPresent = true;
		},
		setOnProof: (callback: () => void) => {
			onProof = callback;
		},
	};
};

describe("community operational consumer", () => {
	it("enrolls approved work without provider calls or queue changes before dispatch", async () => {
		const f = await fixture(undefined, true);
		try {
			const before = [f.queuePath, f.engineStatePath, f.input.authorizationPath].map((path) => readFileSync(path));
			for (let attempt = 0; attempt < 2; attempt++)
				expect(await Effect.runPromise(f.run(true))).toMatchObject({ status: "enrolled" });
			expect([f.queuePath, f.engineStatePath, f.input.authorizationPath].map((path) => readFileSync(path))).toEqual(
				before,
			);
			expect(f.wire.requests).toEqual([]);
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(1);
			expect(f.rows("SELECT name FROM sqlite_master WHERE name='community_briefing_lease'")).toEqual([]);
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "published" });
		} finally {
			await f.cleanup();
		}
	});
	it.each(["one-shot", "sidecar", "artifact", "revocation", "lease", "writer"])(
		"refuses enrollment-only startup with %s without provider calls",
		async (scenario) => {
			const f = await fixture(undefined, scenario !== "one-shot");
			try {
				if (scenario === "sidecar") writeFileSync(`${f.engineStatePath}-wal`, "retained", { mode: 0o600 });
				if (scenario === "artifact") writeFileSync(f.paths.sdk, "changed");
				if (scenario === "writer") f.setCompatibilityPresent();
				if (scenario === "revocation") await Effect.runPromise(f.control("revoke"));
				if (scenario === "lease") {
					const db = new DatabaseSync(f.payload.operational.ledger.path);
					try {
						db.exec(
							"CREATE TABLE community_briefing_lease(singleton INTEGER); INSERT INTO community_briefing_lease VALUES(1)",
						);
					} finally {
						db.close();
					}
				}
				const before = f.rows("SELECT * FROM community_briefing_grants");
				expect((await Effect.runPromiseExit(f.run(true)))._tag).toBe("Failure");
				expect(f.rows("SELECT * FROM community_briefing_grants")).toEqual(before);
				expect(f.wire.requests).toEqual([]);
				if (scenario === "lease")
					expect(f.rows("SELECT * FROM community_briefing_lease")).toEqual([{ singleton: 1 }]);
				if (scenario === "sidecar") expect(readFileSync(`${f.engineStatePath}-wal`, "utf8")).toBe("retained");
			} finally {
				await f.cleanup();
			}
		},
	);
	it.each([
		"valid",
		"queue-lease",
		"authority-lease",
		"trust",
		"artifact",
		"sidecar",
		"public-output",
		"existing-output",
		"output-in-state",
		"wal-queue",
	])("prepares unsigned enrollment from existing state: %s", async (scenario) => {
		const f = await fixture(undefined, true);
		const ownerRoot = mkdtempSync(join(realpathSync(tmpdir()), "community-preparation-owner-"));
		try {
			mkdirSync(join(f.root, "sources"), { mode: 0o700 });
			mkdirSync(join(f.root, "drafts"), { mode: 0o700 });
			const output = join(scenario === "output-in-state" ? f.statePath : ownerRoot, "prepared");
			mkdirSync(output, { mode: scenario === "public-output" ? 0o755 : 0o700 });
			if (scenario === "existing-output") writeFileSync(join(output, "keep"), "preserved");
			if (scenario === "queue-lease") {
				const db = new DatabaseSync(f.queuePath);
				try {
					db.exec("UPDATE community_briefings SET lease_until='2000-01-01T00:00:00.000Z'");
				} finally {
					db.close();
				}
			}
			if (scenario === "wal-queue") {
				const db = new DatabaseSync(f.queuePath);
				try {
					db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
				} finally {
					db.close();
				}
			}
			if (scenario === "authority-lease") {
				const db = new DatabaseSync(f.payload.operational.ledger.path);
				try {
					db.exec(
						"CREATE TABLE community_briefing_lease(singleton INTEGER); INSERT INTO community_briefing_lease VALUES(1)",
					);
				} finally {
					db.close();
				}
			}
			if (scenario === "trust") f.input.trustedKeyring.sha256 = "0".repeat(64);
			if (scenario === "artifact") chmodSync(f.paths.sdk, 0o666);
			if (scenario === "sidecar") writeFileSync(`${f.queuePath}-journal`, "uncertain", { mode: 0o600 });
			const inputPath = join(ownerRoot, "input.json");
			writeFileSync(
				inputPath,
				JSON.stringify({
					issuer: f.payload.issuer,
					keyId: f.payload.operational.keyId,
					queuePath: f.queuePath,
					statePath: f.statePath,
					configPath: f.payload.operational.config.path,
					installationRoot: join(f.root, "artifact"),
					cutoverEvidencePath: f.payload.operational.cutoverEvidence.path,
					rollbackPlanPath: f.payload.operational.rollbackPlan.path,
					trustedKeyring: f.input.trustedKeyring,
				}),
				{ mode: 0o600 },
			);
			const before = [f.queuePath, f.payload.operational.ledger.path, f.engineStatePath].map((path) =>
				readFileSync(path),
			);
			const sidecars = [f.queuePath, f.payload.operational.ledger.path, f.engineStatePath].flatMap((path) =>
				["-wal", "-shm", "-journal"].map((suffix) => `${path}${suffix}`),
			);
			const sidecarsBefore = sidecars.map((path) => existsSync(path));
			const result = await Effect.runPromiseExit(
				Effect.try(() =>
					prepareCommunityService(["--input", inputPath, "--output-directory", output], {
						host: f.paths.host,
						sdk: f.paths.sdk,
						dependencies: f.paths.dependencies,
					}),
				).pipe(
					Effect.flatten,
					Effect.provideService(MeetingPublicationSmokeRuntimeSystemReference, {
						observe: () => f.observation,
						proveNoKnownV1Writers: () => {
							throw new Error("Preparation must not inspect writers");
						},
					}),
					Effect.provideService(CommunityOperationSystemReference, {
						coreAnchor: f.paths.core,
						proveCompatibilityAbsent: () => {
							throw new Error("Preparation must not inspect writers");
						},
					}),
				),
			);
			expect(
				[f.queuePath, f.payload.operational.ledger.path, f.engineStatePath].map((path) => readFileSync(path)),
			).toEqual(before);
			expect(f.wire.requests).toEqual([]);
			expect(sidecars.map((path) => existsSync(path))).toEqual(sidecarsBefore);
			if (scenario !== "valid") {
				expect(result._tag).toBe("Failure");
				expect(existsSync(join(output, "request.json"))).toBe(false);
				return;
			}
			expect(result._tag, JSON.stringify(result)).toBe("Success");
			const request = join(output, "request.json"),
				enrollment = join(output, "enrollment.json");
			const generatedManifest = JSON.parse(readFileSync(join(output, "artifact-manifest.json"), "utf8"));
			expect(generatedManifest.files.map((entry: { path: string }) => entry.path)).toEqual(
				Object.values(f.paths).sort(),
			);
			expect(lstatSync(join(output, "artifact-manifest.json")).mode & 0o777).toBe(0o600);
			const key = join(ownerRoot, "owner.pem");
			writeFileSync(key, f.ownerPrivateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
			expect(
				await Effect.runPromise(
					runCommunityPublicationCommand([
						"--enroll-service",
						"--request",
						request,
						"--request-sha256",
						digest(readFileSync(request)),
						"--owner-key",
						key,
						"--public-key-sha256",
						f.ownerPublicKeyFingerprint,
						"--output",
						enrollment,
					]),
				),
			).toMatchObject({ exitCode: 0, value: { activated: false } });
			expect(JSON.parse(readFileSync(join(output, "service.json"), "utf8"))).toMatchObject({
				authorizationPath: enrollment,
			});
			f.input.authorizationPath = enrollment;
			readCommunityOperation(f.input, f.observation);
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "published" });
		} finally {
			await f.cleanup();
			rmSync(ownerRoot, { recursive: true, force: true });
		}
	});
	it.each([
		"valid",
		"request-drift",
		"key-mismatch",
		"public-key-file",
		"key-in-state",
		"finite-mode",
		"extra-field",
		"existing-output",
	])("offline enrollment command: %s", async (scenario) => {
		const f = await fixture(undefined, true);
		const ownerRoot = mkdtempSync(join(realpathSync(tmpdir()), "community-offline-owner-"));
		try {
			const keyPath = scenario === "key-in-state" ? join(f.statePath, "owner.pem") : join(ownerRoot, "owner.pem");
			writeFileSync(keyPath, f.ownerPrivateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
			if (scenario === "public-key-file") chmodSync(keyPath, 0o644);
			if (scenario === "finite-mode") f.payload.operational.kind = "harnessy.community.briefing.operation.v1";
			const requestPath = join(ownerRoot, "request.json"),
				output = join(f.root, "enrolled.json");
			const bytes = canonical({ ...f.payload, ...(scenario === "extra-field" ? { approve: true } : {}) });
			writeFileSync(requestPath, bytes, { mode: 0o600 });
			if (scenario === "existing-output") writeFileSync(output, "preserved", { mode: 0o600 });
			const queueBefore = readFileSync(f.queuePath),
				ledgerBefore = readFileSync(f.payload.operational.ledger.path),
				keyBefore = readFileSync(keyPath);
			const result = await Effect.runPromise(
				runCommunityPublicationCommand([
					"--enroll-service",
					"--request",
					requestPath,
					"--request-sha256",
					scenario === "request-drift" ? "0".repeat(64) : digest(bytes),
					"--owner-key",
					keyPath,
					"--public-key-sha256",
					scenario === "key-mismatch" ? "0".repeat(64) : f.ownerPublicKeyFingerprint,
					"--output",
					output,
				]),
			);
			expect(readFileSync(f.queuePath)).toEqual(queueBefore);
			expect(readFileSync(f.payload.operational.ledger.path)).toEqual(ledgerBefore);
			expect(readFileSync(keyPath)).toEqual(keyBefore);
			expect(f.wire.requests).toEqual([]);
			if (scenario === "valid") {
				expect(result).toMatchObject({ exitCode: 0, value: { activated: false } });
				expect(lstatSync(output).mode & 0o777).toBe(0o600);
				f.input.authorizationPath = output;
				expect(await Effect.runPromise(f.run())).toMatchObject({ status: "published" });
			} else {
				expect(result).toMatchObject({ exitCode: 1, value: { code: "invalid_arguments" } });
				expect(existsSync(output)).toBe(scenario === "existing-output");
				if (scenario === "existing-output") expect(readFileSync(output, "utf8")).toBe("preserved");
			}
		} finally {
			await f.cleanup();
			rmSync(ownerRoot, { recursive: true, force: true });
		}
	});
	it("reports and retains an existing pre-use revocation marker", async () => {
		const f = await fixture(undefined, true);
		try {
			const ledger = new DatabaseSync(f.payload.operational.ledger.path);
			try {
				ledger
					.prepare("INSERT INTO community_briefing_grants(grant_id,payload_hash,revoked) VALUES (?,'',1)")
					.run(f.payload.grantId);
			} finally {
				ledger.close();
			}
			for (const action of ["status", "revoke"] as const)
				expect(await Effect.runPromise(f.control(action))).toMatchObject({
					exitCode: 0,
					value: { revoked: true, enrollment: "not_started" },
				});
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.wire.requests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
	it.each([false, true])("controls service enrollment without providers after publication=%s", async (publish) => {
		const f = await fixture(undefined, true);
		try {
			if (publish) await Effect.runPromise(f.run());
			const before = readFileSync(f.payload.operational.ledger.path);
			const count = f.wire.requests.length;
			// Owner stop/status must not require a healthy publication artifact.
			writeFileSync(f.paths.sdk, "damaged artifact");
			expect(await Effect.runPromise(f.control("status"))).toMatchObject({
				exitCode: 0,
				value: {
					revoked: false,
					enrollment: publish ? "enrolled" : "not_started",
					ownership: "none",
					runtimeHealth: "not_assessed",
				},
			});
			expect(readFileSync(f.payload.operational.ledger.path)).toEqual(before);
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(await Effect.runPromise(f.control("revoke"))).toMatchObject({
					exitCode: 0,
					value: { revoked: true, ownership: "none" },
				});
				expect(await Effect.runPromise(f.control("status"))).toMatchObject({
					exitCode: 0,
					value: { revoked: true },
				});
			}
			expect(f.wire.requests).toHaveLength(count);
		} finally {
			await f.cleanup();
		}
	});
	it("reports a retained lease but refuses to revoke or clear it through service control", async () => {
		const f = await fixture(undefined, true);
		try {
			f.wire.onRequest = () => {
				f.observation.now += 900000;
			};
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			const before = f.rows("SELECT * FROM community_briefing_lease");
			expect(before).toHaveLength(1);
			expect(await Effect.runPromise(f.control("status"))).toMatchObject({
				exitCode: 0,
				value: { revoked: false, ownership: "lease_recorded", runtimeHealth: "not_assessed" },
			});
			expect(await Effect.runPromise(f.control("revoke"))).toMatchObject({
				exitCode: 1,
				value: { code: "reconciliation_required" },
			});
			expect(f.rows("SELECT * FROM community_briefing_lease")).toEqual(before);
			expect(f.rows("SELECT revoked FROM community_briefing_grants")).toEqual([{ revoked: 0 }]);
		} finally {
			await f.cleanup();
		}
	});
	it.each(["one-shot", "signature", "ledger"])("refuses service control with invalid %s binding", async (scenario) => {
		const f = await fixture(undefined, scenario !== "one-shot");
		try {
			if (scenario === "signature") {
				const raw = JSON.parse(readFileSync(f.input.authorizationPath, "utf8"));
				raw.signature = "A".repeat(88);
				writeFileSync(f.input.authorizationPath, canonical(raw));
			}
			if (scenario === "ledger") {
				const path = f.payload.operational.ledger.path;
				const bytes = readFileSync(path);
				renameSync(path, `${path}.retained`);
				writeFileSync(path, bytes, { mode: 0o600 });
			}
			const before = readFileSync(f.payload.operational.ledger.path);
			for (const action of ["status", "revoke"] as const)
				expect(await Effect.runPromise(f.control(action))).toMatchObject({ exitCode: 1 });
			expect(readFileSync(f.payload.operational.ledger.path)).toEqual(before);
			expect(f.wire.requests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
	it("enrolls an idle service before later approval without requiring a new queue signature", async () => {
		const f = await fixture(undefined, true);
		try {
			const queue = new DatabaseSync(f.queuePath);
			try {
				queue.exec("UPDATE community_briefings SET status='pending_review', approved_hash=NULL");
			} finally {
				queue.close();
			}
			f.payload.operational.queue.sha256 = file(f.queuePath).sha256;
			f.writeAuthorization();
			const enrollment = readFileSync(f.input.authorizationPath);
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "idle" });
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(1);
			expect(f.wire.requests).toEqual([]);
			const approve = new DatabaseSync(f.queuePath);
			try {
				approve.exec("UPDATE community_briefings SET status='approved', approved_hash=draft_hash");
			} finally {
				approve.close();
			}
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "published" });
			expect(readFileSync(f.input.authorizationPath)).toEqual(enrollment);
		} finally {
			await f.cleanup();
		}
	});
	it.each(["item", "expiry", "boot"])("rejects a signed service with mixed one-shot %s fields", async (field) => {
		const f = await fixture(undefined, true);
		try {
			if (field === "item") f.payload.briefingId = f.briefingId;
			if (field === "expiry") f.payload.expiresAt = new Date(f.observation.now + 60000).toISOString();
			if (field === "boot") f.payload.operational.runtime.bootId = f.observation.bootId;
			f.writeAuthorization();
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.rows("SELECT * FROM community_briefing_grants")).toEqual([]);
			expect(f.wire.requests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
	it("admits one simultaneous publication under a reusable service enrollment", async () => {
		const f = await fixture(undefined, true);
		try {
			const results = await Promise.all([Effect.runPromiseExit(f.run()), Effect.runPromiseExit(f.run())]);
			expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
			expect(f.wire.messagesByNonce.size).toBe(1);
		} finally {
			await f.cleanup();
		}
	});
	it("reuses one service enrollment for separately approved items across clean restart and stops on revocation", async () => {
		const f = await fixture(undefined, true);
		try {
			const enrollment = readFileSync(f.input.authorizationPath);
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "published" });
			const queue = new DatabaseSync(f.queuePath);
			try {
				queue.exec(`INSERT INTO community_briefings
				(briefing_id,week_start,week_end,artifact_dir,briefing_path,discord_path,provenance_path,draft_hash,approved_hash,status,attempts,created_at,updated_at)
				SELECT 'abcdef0123456789abcdef01','2026-09-21','2026-09-27',artifact_dir,briefing_path,discord_path,provenance_path,draft_hash,NULL,'pending_review',0,created_at,updated_at FROM community_briefings LIMIT 1`);
			} finally {
				queue.close();
			}
			// No signature or key refresh after legitimate queue/Executor writes or a new boot.
			f.observation.now += 86_400_000;
			f.observation.bootId = "next-fixture-boot";
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "idle" });
			expect(f.wire.messagesByNonce.size).toBe(1);
			const approve = new DatabaseSync(f.queuePath);
			try {
				approve.exec(
					"UPDATE community_briefings SET status='approved',approved_hash=draft_hash WHERE status='pending_review'",
				);
			} finally {
				approve.close();
			}
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "published" });
			expect(f.wire.messagesByNonce.size).toBe(2);
			expect(readFileSync(f.input.authorizationPath)).toEqual(enrollment);
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(1);
			expect(f.rows("SELECT * FROM community_briefing_lease")).toEqual([]);
			const ledger = new DatabaseSync(f.payload.operational.ledger.path);
			try {
				ledger.exec("UPDATE community_briefing_grants SET revoked=1");
			} finally {
				ledger.close();
			}
			const count = f.wire.requests.length;
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.wire.requests).toHaveLength(count);
		} finally {
			await f.cleanup();
		}
	});
	it.each(["revocation", "clock", "artifact"])(
		"retains service ownership after uncertain %s loss",
		async (scenario) => {
			const f = await fixture(undefined, true);
			try {
				f.wire.onRequest = () => {
					if (scenario === "artifact") writeFileSync(f.paths.sdk, "changed");
					if (scenario === "clock") f.observation.now += 900_000;
					if (scenario === "revocation") {
						const db = new DatabaseSync(f.payload.operational.ledger.path);
						try {
							db.exec("UPDATE community_briefing_grants SET revoked=1");
						} finally {
							db.close();
						}
					}
				};
				expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
				expect(f.rows("SELECT * FROM community_briefing_lease")).toHaveLength(1);
				const count = f.wire.requests.length;
				expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
				expect(f.wire.requests).toHaveLength(count);
			} finally {
				await f.cleanup();
			}
		},
	);
	it("does not reinterpret a one-shot signature as a service enrollment", async () => {
		const f = await fixture();
		try {
			const raw = JSON.parse(readFileSync(f.input.authorizationPath, "utf8"));
			Object.assign(raw, { briefingId: null, sourceHash: null, expiresAt: null });
			raw.operational.kind = "harnessy.community.briefing.service.v1";
			raw.operational.runtime.bootId = null;
			writeFileSync(f.input.authorizationPath, canonical(raw));
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.rows("SELECT * FROM community_briefing_grants")).toEqual([]);
			expect(f.wire.requests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
	it("retains a service Google receipt or uncertain singleton lease when revoked before Discord", async () => {
		const f = await fixture(undefined, true);
		try {
			f.wire.onRequest = (request) => {
				if (request.method !== "POST" || !request.path.endsWith("/permissions")) return;
				const ledger = new DatabaseSync(f.payload.operational.ledger.path);
				try {
					ledger.exec("UPDATE community_briefing_grants SET revoked=1");
				} finally {
					ledger.close();
				}
			};
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			const queue = new DatabaseSync(f.queuePath, { readOnly: true });
			try {
				const row = queue
					.prepare("SELECT google_doc_id,discord_message_id,approved_hash FROM community_briefings")
					.get() as { google_doc_id: string | null; discord_message_id: string | null; approved_hash: string };
				expect(row).toMatchObject({
					discord_message_id: null,
					approved_hash: f.sourceHash,
				});
				if (row.google_doc_id === null) expect(f.wire.permissions.size).toBeGreaterThan(0);
				else expect(typeof row.google_doc_id).toBe("string");
			} finally {
				queue.close();
			}
			expect(f.rows("SELECT * FROM community_briefing_lease")).toHaveLength(1);
			expect(f.wire.messagesByNonce.size).toBe(0);
		} finally {
			await f.cleanup();
		}
	});
	it.each(["queue", "config"])("rejects a changed enrolled service %s after completed publication", async (kind) => {
		const f = await fixture(undefined, true);
		try {
			expect(await Effect.runPromise(f.run())).toMatchObject({ status: "published" });
			if (kind === "queue") {
				const bytes = readFileSync(f.queuePath);
				renameSync(f.queuePath, `${f.queuePath}.retained`);
				writeFileSync(f.queuePath, bytes, { mode: 0o600 });
			} else writeFileSync(f.payload.operational.config.path, "changed config");
			const count = f.wire.requests.length;
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.wire.requests).toHaveLength(count);
		} finally {
			await f.cleanup();
		}
	});
	it("publishes with native review open and preserves receipts against stale review actions", async () => {
		const pythonPath = process.env.HARNESSY_TEST_JARVIS_PYTHON;
		if (!pythonPath) throw new Error("Set HARNESSY_TEST_JARVIS_PYTHON to the isolated installed interpreter.");
		const f = await fixture(pythonPath);
		const controller = new AbortController();
		let ready: (url: string) => void = () => {};
		const readyPromise = new Promise<string>((resolve) => {
			ready = resolve;
		});
		let calls = 0;
		const running = runCommunityReviewProcess({
			pythonPath,
			config: {
				source_path: join(f.root, "sources"),
				draft_path: join(f.root, "drafts"),
				state_path: f.statePath,
				timezone: "Africa/Lagos",
				review_port: 0,
			},
			signal: controller.signal,
			operationTimeoutMs: 1000,
			onReady: ready,
			generate: async () => {
				calls++;
				throw new Error("Publication must not request AI");
			},
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		try {
			const url = await Promise.race([
				readyPromise,
				running.then(() => {
					throw new Error("Review exited before readiness");
				}),
			]);
			const login = await fetch(url);
			expect(login.status).toBe(200);
			const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
			await login.text();
			const base = new URL(url).origin;
			const page = await (await fetch(`${base}/briefing/${f.briefingId}`, { headers: { cookie } })).text();
			expect(page).toContain('name="csrf"');
			const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
			const approval = await fetch(`${base}/briefing/approve/${f.briefingId}`, {
				method: "POST",
				redirect: "manual",
				headers: { cookie },
				body: new URLSearchParams({
					csrf,
					briefing_markdown: readFileSync(f.markdownPath, "utf8"),
					discord_summary: readFileSync(f.discordPath, "utf8"),
				}),
			});
			expect(approval.status, (await approval.text()).replace(/<[^>]*>/g, " ").slice(-1000)).toBe(303);
			// Review initializes its schema before the owner signs the final snapshot.
			f.payload.operational.queue.sha256 = file(f.queuePath).sha256;
			f.writeAuthorization();
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Success");
			const db = new DatabaseSync(f.queuePath, { readOnly: true });
			try {
				const before = db.prepare("SELECT * FROM community_briefings").get();
				expect(before).toMatchObject({
					status: "published",
					attempts: 1,
					approved_hash: f.sourceHash,
					google_doc_id: expect.any(String),
					discord_message_id: expect.any(String),
				});
				const fields = new URLSearchParams({
					csrf,
					briefing_markdown: "Changed",
					discord_summary: "Changed",
					revise_instruction: "Change it",
					revise_provider: "codex",
				});
				for (const action of ["save", "approve", "reject", "revise"]) {
					const response = await fetch(`${base}/briefing/${action}/${f.briefingId}`, {
						method: "POST",
						redirect: "manual",
						headers: { cookie },
						body: fields,
					});
					expect(response.status, action).toBe(409);
					await response.text();
					expect(db.prepare("SELECT * FROM community_briefings").get()).toEqual(before);
				}
			} finally {
				db.close();
			}
			expect(calls).toBe(0);
			expect(f.wire.messagesByNonce.size).toBe(1);
			expect(f.rows("SELECT * FROM community_briefing_lease")).toEqual([]);
			const count = f.wire.requests.length;
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.wire.requests).toHaveLength(count);
		} finally {
			controller.abort();
			await running;
			await f.cleanup();
		}
		expect(await running).toBeUndefined();
	});
	it("excludes a distinct valid grant in another process while the singleton owner is paused", async () => {
		const f = await fixture();
		const children: ChildProcess[] = [];
		const packageRoot = join(import.meta.dirname, "..");
		const sourceConfig = ts.readConfigFile(join(packageRoot, "tsconfig.json"), ts.sys.readFile);
		if (sourceConfig.error) throw new Error("unable to read source aliases");
		const sourcePaths = sourceConfig.config.compilerOptions.paths as Record<string, string[]>;
		const childConfig = join(f.root, "child-tsconfig.json");
		writeFileSync(
			childConfig,
			JSON.stringify({
				compilerOptions: {
					paths: {
						...Object.fromEntries(
							Object.entries(sourcePaths).map(([name, paths]) => [
								name,
								paths.map((path) => join(packageRoot, path)),
							]),
						),
						effect: [join(packageRoot, "../../node_modules/effect/dist/index.js")],
						"effect/*": [
							join(packageRoot, "../../node_modules/effect/dist/*.js"),
							join(packageRoot, "../../node_modules/effect/dist/*/index.js"),
						],
					},
				},
			}),
			{ mode: 0o600 },
		);
		const start = (input: typeof f.input, name: string, pause: boolean) => {
			const configPath = join(f.root, `${name}-child.json`);
			writeFileSync(
				configPath,
				JSON.stringify({
					input,
					paths: f.paths,
					pause,
					observation: {
						...f.observation,
						uid: String(f.observation.uid),
						monotonic: String(f.observation.monotonic),
					},
				}),
				{ mode: 0o600 },
			);
			const child = fork(new URL("./support/community-operational-child.ts", import.meta.url), [configPath], {
				execArgv: ["--import", "tsx"],
				cwd: join(import.meta.dirname, ".."),
				env: { NODE_NO_WARNINGS: "1", TSX_TSCONFIG_PATH: childConfig },
				stdio: ["ignore", "ignore", "pipe", "ipc"],
			});
			children.push(child);
			const stages: string[] = [];
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});
			let owned: (() => void) | undefined;
			const owner = new Promise<void>((resolve) => {
				owned = resolve;
			});
			const completed = new Promise<boolean>((resolve, reject) => {
				let finished = false;
				const timer = setTimeout(() => {
					child.kill();
					reject(new Error("operational child timed out"));
				}, 20000);
				child.on("message", (message: unknown) => {
					if (
						typeof message !== "object" ||
						message === null ||
						!("stage" in message) ||
						typeof message.stage !== "string"
					)
						return;
					stages.push(message.stage);
					if (message.stage === "owner") owned?.();
					if (message.stage === "finished" && "success" in message) {
						finished = true;
						clearTimeout(timer);
						resolve(message.success === true);
					}
				});
				child.once("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.once("exit", () => {
					clearTimeout(timer);
					if (!finished) reject(new Error(`operational child exited: ${stderr}`));
				});
			});
			return { child, owner, completed, stages };
		};
		try {
			const secondInput = f.distinctInput();
			const first = start(f.input, "first", true);
			await Promise.race([
				first.owner,
				first.completed.then(() => {
					throw new Error("owner exited before pause");
				}),
			]);
			expect(first.stages).toEqual(["validated", "owner"]);
			expect(f.rows("SELECT grant_id,pid FROM community_briefing_lease")).toEqual([
				{ grant_id: "a".repeat(64), pid: first.child.pid },
			]);
			expect(f.wire.requests).toEqual([]);
			const second = start(secondInput, "second", false);
			expect(second.child.pid).not.toBe(first.child.pid);
			expect(await second.completed).toBe(false);
			expect(second.stages).toEqual(["validated", "finished"]);
			expect(f.rows("SELECT grant_id FROM community_briefing_grants")).toEqual([{ grant_id: "a".repeat(64) }]);
			expect(f.wire.requests).toEqual([]);
			first.child.send("resume");
			expect(await first.completed).toBe(true);
			expect(f.wire.messagesByNonce.size).toBe(1);
			expect(f.rows("SELECT * FROM community_briefing_lease")).toEqual([]);
			const db = new DatabaseSync(f.queuePath, { readOnly: true });
			try {
				expect(
					db.prepare("SELECT status,attempts,google_doc_id,discord_message_id FROM community_briefings").get(),
				).toMatchObject({
					status: "published",
					attempts: 1,
					google_doc_id: expect.any(String),
					discord_message_id: expect.any(String),
				});
			} finally {
				db.close();
			}
		} finally {
			await Promise.all(
				children.map((child) =>
					child.exitCode !== null || child.signalCode !== null
						? Promise.resolve()
						: new Promise<void>((resolve) => {
								child.once("exit", () => resolve());
								child.kill();
							}),
				),
			);
			await f.cleanup();
		}
	});
	it.each(["queue", "engine"])("retains the signed %s identity across asynchronous startup", async (kind) => {
		const f = await fixture();
		try {
			const path = kind === "queue" ? f.queuePath : f.engineStatePath;
			const before = readFileSync(path);
			let replaced = false;
			f.setOnProof(() => {
				if (replaced) return;
				replaced = true;
				queueMicrotask(() => {
					renameSync(path, `${path}.retained`);
					writeFileSync(path, before, { mode: 0o600 });
				});
			});
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(replaced).toBe(true);
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(0);
			expect(readFileSync(path)).toEqual(before);
			expect(f.wire.requests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
	it("preserves a confirmed Google receipt or uncertain lease when authority is revoked before Discord", async () => {
		const f = await fixture();
		try {
			f.wire.onRequest = (request) => {
				if (request.method !== "POST" || !request.path.endsWith("/permissions")) return;
				const db = new DatabaseSync(f.payload.operational.ledger.path);
				try {
					db.prepare("UPDATE community_briefing_grants SET revoked=1").run();
				} finally {
					db.close();
				}
			};
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			const db = new DatabaseSync(f.queuePath, { readOnly: true });
			try {
				const row = db
					.prepare("SELECT google_doc_id,discord_message_id,approved_hash FROM community_briefings")
					.get() as { google_doc_id: string | null; discord_message_id: string | null; approved_hash: string };
				expect(row).toMatchObject({
					discord_message_id: null,
					approved_hash: f.sourceHash,
				});
				if (row.google_doc_id === null) expect(f.wire.permissions.size).toBeGreaterThan(0);
				else expect(typeof row.google_doc_id).toBe("string");
			} finally {
				db.close();
			}
			expect(f.wire.messagesByNonce.size).toBe(0);
			expect(f.rows("SELECT * FROM community_briefing_lease")).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});
	it("preserves a stale lease and does not consume a fresh authorization", async () => {
		const f = await fixture();
		try {
			const database = new DatabaseSync(f.payload.operational.ledger.path);
			try {
				database.exec(
					"CREATE TABLE community_briefing_lease (singleton INTEGER PRIMARY KEY,lease_id TEXT,grant_id TEXT,pid INTEGER,boot_id TEXT,expires_at TEXT); INSERT INTO community_briefing_lease VALUES (1,'old','old',999999,'old','2000-01-01T00:00:00.000Z');",
				);
			} finally {
				database.close();
			}
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.rows("SELECT lease_id FROM community_briefing_lease")).toEqual([{ lease_id: "old" }]);
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(0);
			expect(f.wire.requests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
	it("interrupts provider work without releasing ownership or replaying uncertainty", async () => {
		const f = await fixture();
		const controller = new AbortController();
		try {
			f.wire.onRequest = () => controller.abort();
			const result = await Effect.runPromiseExit(f.run(), { signal: controller.signal });
			expect(result._tag).toBe("Failure");
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(1);
			expect(f.rows("SELECT * FROM community_briefing_lease")).toHaveLength(1);
			expect(f.wire.requests.every((request) => request.method === "GET")).toBe(true);
			const db = new DatabaseSync(f.queuePath, { readOnly: true });
			try {
				expect(db.prepare("SELECT status,approved_hash,attempts FROM community_briefings").get()).toMatchObject({
					status: "publishing",
					approved_hash: f.sourceHash,
					attempts: 1,
				});
			} finally {
				db.close();
			}
		} finally {
			await f.cleanup();
		}
	});
	it("admits at most one simultaneous signed publication", async () => {
		const f = await fixture();
		try {
			const results = await Promise.all([Effect.runPromiseExit(f.run()), Effect.runPromiseExit(f.run())]);
			expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(1);
			expect(f.wire.messagesByNonce.size).toBe(1);
		} finally {
			await f.cleanup();
		}
	});
	it("publishes through real Executor, consumes once and releases only the completed lease", async () => {
		const f = await fixture();
		try {
			const result = await Effect.runPromiseExit(f.run());
			expect(result._tag).toBe("Success");
			expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(1);
			expect(f.rows("SELECT * FROM community_briefing_lease")).toHaveLength(0);
			const count = f.wire.requests.length;
			expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
			expect(f.wire.requests).toHaveLength(count);
		} finally {
			await f.cleanup();
		}
	});
	it.each(["keyring", "signature", "expiry", "artifact", "compatibility", "missing-binding"])(
		"rejects %s before consumption/provider calls",
		async (scenario) => {
			const f = await fixture();
			try {
				if (scenario === "keyring") f.input.trustedKeyring.sha256 = "0".repeat(64);
				if (scenario === "signature") {
					f.payload.sourceHash = "0".repeat(64);
					const raw = JSON.parse(readFileSync(f.input.authorizationPath, "utf8"));
					raw.sourceHash = f.payload.sourceHash;
					writeFileSync(f.input.authorizationPath, canonical(raw));
				}
				if (scenario === "expiry") {
					f.payload.expiresAt = new Date(f.observation.now - 1).toISOString();
					f.writeAuthorization();
				}
				if (scenario === "artifact") writeFileSync(f.paths.sdk, "changed artifact");
				if (scenario === "compatibility") f.setCompatibilityPresent();
				if (scenario === "missing-binding") {
					const raw = JSON.parse(readFileSync(f.input.authorizationPath, "utf8"));
					delete raw.operational;
					writeFileSync(f.input.authorizationPath, canonical(raw));
				}
				expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
				expect(f.wire.requests).toEqual([]);
				expect(f.rows("SELECT * FROM community_briefing_grants")).toHaveLength(0);
			} finally {
				await f.cleanup();
			}
		},
	);
	it.each(["compatibility", "artifact", "clock", "revocation"])(
		"retains lease and receipts after mid-operation %s loss",
		async (scenario) => {
			const f = await fixture();
			try {
				f.wire.onRequest = () => {
					if (scenario === "compatibility") f.setCompatibilityPresent();
					if (scenario === "artifact") writeFileSync(f.paths.sdk, "changed artifact");
					if (scenario === "clock") f.observation.now--;
					if (scenario === "revocation") {
						const db = new DatabaseSync(f.payload.operational.ledger.path);
						try {
							db.prepare("UPDATE community_briefing_grants SET revoked=1").run();
						} finally {
							db.close();
						}
					}
				};
				expect((await Effect.runPromiseExit(f.run()))._tag).toBe("Failure");
				expect(f.rows("SELECT * FROM community_briefing_lease")).toHaveLength(1);
				expect(f.wire.requests.length).toBeGreaterThan(0);
				expect(f.wire.requests.every((request) => request.method === "GET")).toBe(true);
			} finally {
				await f.cleanup();
			}
		},
	);
});
