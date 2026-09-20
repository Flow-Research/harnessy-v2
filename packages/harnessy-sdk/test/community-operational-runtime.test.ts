import { type ChildProcess, fork } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
	CommunityBriefingGrantHost,
	communityBriefingGrantPayload,
} from "../../harnessy-core/src/jarvis/community-briefing/grant-host.ts";
import {
	CommunityOperationSystemReference,
	runAuthorizedCommunityBriefing,
} from "../../harnessy-core/src/jarvis/community-briefing/operational-runtime.ts";
import { canonicalMeetingPublicationSmokeJson } from "../../harnessy-core/src/jarvis/meeting-publication/operational-input.ts";
import { MeetingPublicationSmokeRuntimeSystemReference } from "../../harnessy-core/src/jarvis/meeting-publication/operational-runtime.ts";
import { runNativeCommunityBriefing } from "../src/community-briefing/runtime.ts";
import { makeCommunityRuntimeFixture } from "./support/community-runtime-fixture.ts";

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown) => `${canonicalMeetingPublicationSmokeJson(value)}\n`;
const file = (path: string) => {
	const stat = lstatSync(path, { bigint: true });
	return { path, device: stat.dev.toString(), inode: stat.ino.toString(), sha256: digest(readFileSync(path)) };
};
const fixture = async () => {
	const source = await makeCommunityRuntimeFixture();
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
		briefingId: source.briefingId,
		sourceHash: source.sourceHash,
		expiresAt: new Date(now + 600_000).toISOString(),
		providerScope: source.providerScope,
		operational: {
			kind: "harnessy.community.briefing.operation.v1" as const,
			keyId: "fixture-key",
			issuedAt: new Date(now).toISOString(),
			notBefore: new Date(now).toISOString(),
			runtime: {
				platform: observation.platform,
				architecture: observation.architecture,
				hostname: observation.hostname,
				uid: observation.uid.toString(),
				bootId: observation.bootId,
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
			config: privateFile("config", { providerScope: source.providerScope }),
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
	const run = () =>
		runAuthorizedCommunityBriefing(input, {
			artifactAnchors: { host: paths.host, sdk: paths.sdk, dependencies: paths.dependencies },
			publish: (grant) => runNativeCommunityBriefing(grant),
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

describe("one-shot community operational consumer", () => {
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
	it("preserves the Google receipt when authority is revoked before Discord", async () => {
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
				expect(
					db.prepare("SELECT google_doc_id,discord_message_id,approved_hash FROM community_briefings").get(),
				).toMatchObject({
					google_doc_id: expect.any(String),
					discord_message_id: null,
					approved_hash: f.sourceHash,
				});
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
