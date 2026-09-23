import {
	chmodSync,
	existsSync,
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
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	prepareMeetingPublicationServiceRequest,
	sha256MeetingPublicationSmokeBytes,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../src/jarvis/meeting-publication/store-schema.ts";
import { createMeetingPublicationFullReviewAuthorizationFixture } from "./support/meeting-full-review-runtime-fixture.ts";

describe("inert service request preparation", () => {
	let root: string;
	let value: Record<string, unknown>;
	let replayPath: string;
	const installationRoot = realpathSync(join(import.meta.dirname, "../src/jarvis/meeting-publication"));
	const anchors = {
		core: join(installationRoot, "operational-input.ts"),
		host: join(installationRoot, "operational-runtime.ts"),
		sdk: join(installationRoot, "service.ts"),
		dependencies: join(installationRoot, "authority.ts"),
	};
	beforeEach(() => {
		root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-service-preparation-"));
		for (const name of ["notes", "state", "credentials", "private", "output"])
			mkdirSync(join(root, name), { mode: 0o700 });
		const state = new DatabaseSync(join(root, "state/meeting-publication.sqlite3"));
		state.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
		state.close();
		chmodSync(join(root, "state/meeting-publication.sqlite3"), 0o600);
		writeFileSync(join(root, "engine.db"), "existing engine sentinel", { mode: 0o600 });
		const config = new JarvisMeetingPublicationConfig({
			enabled: true,
			project: "fixture",
			sourcePath: join(root, "notes"),
			statePath: join(root, "state"),
			backfillDays: 30,
			cutoverDate: null,
			maxFileBytes: 32000,
			maxFiles: 100,
			leaseSeconds: 60,
			reminderSeconds: 3600,
			reviewHost: "127.0.0.1",
			reviewPort: 18783,
			reviewSessionSeconds: 900,
			reviewMaxSessions: 64,
			reviewMaxBodyBytes: 32000,
			googleOwnerEmail: "owner@example.test",
			googleDriveFolder: "Meetings",
			discordChannelId: "123456",
		});
		const fixture = createMeetingPublicationFullReviewAuthorizationFixture({
			privateRoot: join(root, "private"),
			config,
			credentialDirectory: join(root, "credentials"),
			engineStatePath: join(root, "engine.db"),
			installationRoot,
			artifactAnchors: anchors,
		});
		const service = fixture.createServiceInput({ fresh: true });
		replayPath = fixture.replayPath;
		value = {
			kind: "harnessy.meeting-publication.service-preparation.v1",
			issuer: fixture.payload.issuer,
			keyId: fixture.payload.keyId,
			config,
			subject: fixture.payload.subject,
			google: { ...fixture.payload.google, authTemplate: "google-drive-file" },
			discord: fixture.payload.discord,
			notifier: fixture.payload.notifier,
			maxItems: 1,
			credentialDirectory: join(root, "credentials"),
			engineStatePath: join(root, "engine.db"),
			installationRoot,
			trustedKeyring: service.trustedKeyring,
			cutoverEvidencePath: null,
			rollbackPlanPath: null,
		};
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const prepare = () => prepareMeetingPublicationServiceRequest(value, join(root, "output"), anchors);

	it("generates unsigned bindings while preserving queue, credentials and replay bytes", () => {
		const paths = [replayPath, join(root, "engine.db"), join(root, "state/meeting-publication.sqlite3")];
		const before = paths.map((path) => readFileSync(path));
		const prepared = prepare();
		const payload = JSON.parse(prepared.request);
		expect(payload).toMatchObject({
			kind: "harnessy.meeting-publication.service-enrollment",
			runtimeMode: "service",
			expiresAt: null,
			transport: { mode: "production" },
			revocationSequence: 0,
			runtime: { bootId: null },
			cutoverEvidence: null,
			rollbackPlan: null,
		});
		expect(payload).not.toHaveProperty("signature");
		expect(payload.artifactManifest.sha256).toBe(sha256MeetingPublicationSmokeBytes(prepared.manifest));
		expect(payload.stateDatabase.sha256).toBe(sha256MeetingPublicationSmokeBytes(before[2]!));
		expect(JSON.parse(prepared.manifest).anchors.map((entry: { role: string }) => entry.role)).toEqual([
			"core",
			"host",
			"sdk",
			"dependencies",
		]);
		expect(paths.map((path) => readFileSync(path))).toEqual(before);
		expect(readdirSync(join(root, "output"))).toEqual([]);
	});

	it("retains the current revocation sequence rather than resetting history", () => {
		const db = new DatabaseSync(replayPath);
		db.exec(
			"INSERT INTO revocations VALUES (1,'authorization','retired','2026-09-21T00:00:00.000Z'); UPDATE runtime_metadata SET revocation_sequence=1;",
		);
		db.close();
		const before = readFileSync(replayPath);
		expect(JSON.parse(prepare().request).revocationSequence).toBe(1);
		expect(readFileSync(replayPath)).toEqual(before);
	});

	it.each([
		"active lease",
		"existing queue",
		"unclean SQLite",
		"trust drift",
		"unknown input",
		"nonempty output",
		"destination mismatch",
	])("rejects %s without creating or resetting state", (failure) => {
		if (failure === "active lease") {
			const db = new DatabaseSync(replayPath);
			db.exec(
				"INSERT INTO active_lease VALUES (1,'lease','auth','nonce','digest','key','0',123,'boot','service',0,'0',0)",
			);
			db.close();
		}
		if (failure === "existing queue") {
			const db = new DatabaseSync(join(root, "state/meeting-publication.sqlite3"));
			db.exec(
				"INSERT INTO publication_items(item_id,note_path,meeting_date,project,source_hash,status,created_at,updated_at) VALUES ('existing','note.md','2026-09-21','fixture','hash','pending_review','now','now')",
			);
			db.close();
		}
		if (failure === "unclean SQLite") {
			const db = new DatabaseSync(join(root, "state/meeting-publication.sqlite3"));
			db.exec("PRAGMA journal_mode=WAL");
			db.close();
		}
		if (failure === "trust drift")
			value.trustedKeyring = { ...(value.trustedKeyring as object), sha256: "0".repeat(64) };
		if (failure === "unknown input") value.secret = "CANARY";
		if (failure === "nonempty output") writeFileSync(join(root, "output/sentinel"), "preserved", { mode: 0o600 });
		if (failure === "destination mismatch") value.discord = { ...(value.discord as object), channelId: "987654" };
		const before = readFileSync(replayPath);
		expect(prepare).toThrow();
		expect(readFileSync(replayPath)).toEqual(before);
		expect(readdirSync(join(root, "output"))).toEqual(failure === "nonempty output" ? ["sentinel"] : []);
		for (const suffix of ["-wal", "-shm", "-journal"])
			expect(existsSync(`${join(root, "state/meeting-publication.sqlite3")}${suffix}`)).toBe(false);
	});
});
