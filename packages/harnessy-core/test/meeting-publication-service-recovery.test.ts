import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	canonicalMeetingPublicationSmokeJson,
	MEETING_PUBLICATION_SERVICE_AUDIENCE,
	sha256MeetingPublicationSmokeBytes,
	verifyMeetingPublicationFullReviewInput,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import {
	inspectMeetingPublicationService,
	MeetingPublicationSmokeRuntimeSystemReference,
	MeetingRuntimeSession,
} from "../src/jarvis/meeting-publication/operational-runtime.ts";
import { recoverMeetingPublicationService } from "../src/jarvis/meeting-publication/service-recovery.ts";
import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../src/jarvis/meeting-publication/store-schema.ts";
import { createMeetingPublicationFullReviewAuthorizationFixture } from "./support/meeting-full-review-runtime-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = async () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "service-restart-"));
	roots.push(root);
	chmodSync(root, 0o700);
	for (const name of ["notes", "state", "credentials", "private"]) mkdirSync(join(root, name), { mode: 0o700 });
	const listener = createServer();
	await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
	const port = (listener.address() as { port: number }).port;
	await new Promise<void>((done) => listener.close(() => done()));
	const config = new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "fixture",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3600,
		reviewHost: "127.0.0.1",
		reviewPort: port,
		reviewSessionSeconds: 60,
		reviewMaxSessions: 4,
		reviewMaxBodyBytes: 8192,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "fixture-folder",
		discordChannelId: "123456789012345678",
	});
	const statePath = join(root, "state/meeting-publication.sqlite3");
	const state = new DatabaseSync(statePath);
	state.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
	state.close();
	chmodSync(statePath, 0o600);
	const engineStatePath = join(root, "engine.sqlite3");
	const engine = new DatabaseSync(engineStatePath);
	engine.exec("CREATE TABLE fixture (value TEXT);");
	engine.close();
	chmodSync(engineStatePath, 0o600);
	const installationRoot = realpathSync(
		join(dirname(fileURLToPath(import.meta.url)), "../src/jarvis/meeting-publication"),
	);
	const authorization = createMeetingPublicationFullReviewAuthorizationFixture({
		privateRoot: join(root, "private"),
		config,
		credentialDirectory: join(root, "credentials"),
		engineStatePath,
		installationRoot,
		artifactAnchors: {
			core: join(installationRoot, "operational-input.ts"),
			host: join(installationRoot, "operational-runtime.ts"),
			sdk: join(installationRoot, "service.ts"),
			dependencies: join(installationRoot, "authority.ts"),
		},
	});
	const input = authorization.createServiceInput({ durable: true });
	const enrollment = JSON.parse(readFileSync(input.authorizationPath, "utf8")) as { payload: Record<string, unknown> };
	const digest = sha256MeetingPublicationSmokeBytes(
		`${MEETING_PUBLICATION_SERVICE_AUDIENCE}\0${canonicalMeetingPublicationSmokeJson(enrollment.payload)}`,
	);
	const seed = (lease = false, bootId = authorization.payload.runtime.bootId, pid = process.pid) => {
		const database = new DatabaseSync(authorization.replayPath);
		database
			.prepare("INSERT INTO consumed_authorizations VALUES (?,?,?,?,?,'reviewing')")
			.run(
				authorization.payload.authorizationId,
				authorization.payload.nonce,
				digest,
				authorization.payload.keyId,
				new Date().toISOString(),
			);
		if (lease)
			database
				.prepare("INSERT INTO active_lease VALUES (1,?,?,?,?,?,?,?,?,?,?,?,0)")
				.run(
					"lease-fixture",
					authorization.payload.authorizationId,
					authorization.payload.nonce,
					digest,
					authorization.payload.keyId,
					String(process.geteuid?.()),
					pid,
					bootId,
					"service",
					Date.now(),
					process.hrtime.bigint().toString(),
				);
		database.close();
	};
	const snapshot = () => {
		const database = new DatabaseSync(authorization.replayPath, { readOnly: true });
		try {
			return {
				leases: Number(database.prepare("SELECT COUNT(*) AS n FROM active_lease").get()?.n),
				outcome: database.prepare("SELECT outcome FROM consumed_authorizations").get()?.outcome,
			};
		} finally {
			database.close();
		}
	};
	return { root, config, statePath, authorization, input, digest, seed, snapshot };
};

describe("persistent meeting service recovery", () => {
	it("leaves a new enrollment inert and preserves finite authorization replay protection", async () => {
		const f = await fixture();
		expect(await Effect.runPromise(f.authorization.withSystem(recoverMeetingPublicationService(f.input)))).toEqual({
			recovered: false,
		});
		expect(f.snapshot()).toEqual({ leases: 0, outcome: undefined });
		await expect(
			Effect.runPromise(f.authorization.withSystem(recoverMeetingPublicationService(f.authorization.input))),
		).rejects.toThrow();
	});

	it("recovers an interrupted review and allows the identical signed enrollment to acquire a fresh lease", async () => {
		const f = await fixture();
		f.seed();
		expect(await Effect.runPromise(f.authorization.withSystem(recoverMeetingPublicationService(f.input)))).toEqual({
			recovered: true,
		});
		expect(f.snapshot()).toEqual({ leases: 0, outcome: "reconciled_no_delivery" });
		expect(
			await Effect.runPromise(f.authorization.withSystem(inspectMeetingPublicationService(f.input))),
		).toMatchObject({ activation: "cleanly_stopped", revoked: false });
		await Effect.runPromise(
			f.authorization.withSystem(
				Effect.gen(function* () {
					const system = yield* MeetingPublicationSmokeRuntimeSystemReference;
					const verified = verifyMeetingPublicationFullReviewInput(f.input, system.observe());
					const session = new MeetingRuntimeSession(verified, system);
					try {
						expect(f.snapshot().leases).toBe(1);
					} finally {
						session.close();
					}
				}),
			),
		);
	});

	it("recovers an old-boot lease even when its PID has been reused by a live process", async () => {
		const f = await fixture();
		f.seed(true, "previous-boot", process.pid);
		expect(await Effect.runPromise(f.authorization.withSystem(recoverMeetingPublicationService(f.input)))).toEqual({
			recovered: true,
		});
		expect(f.snapshot()).toEqual({ leases: 0, outcome: "reconciled_no_delivery" });
	});

	it.each(["live owner", "uncertain delivery", "revocation", "writer", "tampered signature"] as const)(
		"refuses %s without clearing the replay or delivery fence",
		async (failure) => {
			const f = await fixture();
			f.seed(failure === "live owner");
			if (failure === "uncertain delivery") {
				const state = new DatabaseSync(f.statePath);
				state
					.prepare(
						"INSERT INTO publication_items(item_id,note_path,meeting_date,project,source_hash,status,attempts,created_at,updated_at,lease_until) VALUES (?,?,?,?,?,'publishing',1,?,?,?)",
					)
					.run(
						"a".repeat(24),
						"/fixture.md",
						"2026-09-04",
						"fixture",
						"b".repeat(64),
						"2026-09-04T00:00:00Z",
						"2026-09-04T00:00:00Z",
						"2026-09-04T00:01:00Z",
					);
				state.close();
			}
			if (failure === "revocation") f.authorization.revoke();
			if (failure === "writer") f.authorization.setWritersPresent(true);
			if (failure === "tampered signature") {
				const envelope = JSON.parse(readFileSync(f.input.authorizationPath, "utf8")) as { signature: string };
				envelope.signature = "a".repeat(86);
				writeFileSync(f.input.authorizationPath, JSON.stringify(envelope));
			}
			await expect(
				Effect.runPromise(f.authorization.withSystem(recoverMeetingPublicationService(f.input))),
			).rejects.toThrow();
			expect(f.snapshot()).toEqual({ leases: failure === "live owner" ? 1 : 0, outcome: "reviewing" });
		},
	);

	it("refuses a listener that already owns the configured review port", async () => {
		const f = await fixture();
		f.seed();
		const listener = createServer((socket) => socket.end());
		await new Promise<void>((done) => listener.listen(f.config.reviewPort, "127.0.0.1", done));
		try {
			await expect(
				Effect.runPromise(f.authorization.withSystem(recoverMeetingPublicationService(f.input))),
			).rejects.toThrow();
		} finally {
			await new Promise<void>((done) => listener.close(() => done()));
		}
		expect(f.snapshot()).toEqual({ leases: 0, outcome: "reviewing" });
	});
});
