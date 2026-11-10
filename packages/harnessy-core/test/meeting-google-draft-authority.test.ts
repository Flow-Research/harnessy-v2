import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { MeetingPublicationWriteBinding } from "../src/jarvis/meeting-publication/authority.ts";
import {
	MEETING_PUBLICATION_REVIEW_OPERATIONS,
	MEETING_PUBLICATION_SMOKE_OPERATIONS,
	MEETING_PUBLICATION_WORKER_OPERATIONS,
	verifyMeetingPublicationFullReviewInput,
	verifyMeetingPublicationWorkerInput,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import {
	MeetingPublicationSmokeRuntimeSystemReference,
	MeetingRuntimeSession,
} from "../src/jarvis/meeting-publication/operational-runtime.ts";
import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "../src/jarvis/meeting-publication/store-schema.ts";
import { createMeetingPublicationFullReviewAuthorizationFixture } from "./support/meeting-full-review-runtime-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = (kind: "full_review" | "worker" = "full_review") => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "meeting-doc-authority-"));
	roots.push(root);
	for (const name of ["notes", "state", "credentials", "private", "artifact"])
		mkdirSync(join(root, name), { mode: 0o700 });
	const config = new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath: join(root, "state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 60,
		reviewMaxSessions: 4,
		reviewMaxBodyBytes: 8_192,
		googleOwnerEmail: "owner@example.test",
		googleDriveFolder: "fixture-folder",
		discordChannelId: "123456789012345678",
	});
	const notePath = join(root, "notes", "meeting.md");
	const markdown = "# Meeting\n\n## Executive Summary\nReviewed note.\n";
	writeFileSync(notePath, markdown, { mode: 0o600 });
	const item = { itemId: "a".repeat(24), sourceHash: createHash("sha256").update(markdown).digest("hex") };
	const dbPath = join(root, "state", "meeting-publication.sqlite3");
	const db = new DatabaseSync(dbPath);
	db.exec(MEETING_PUBLICATION_STORE_SCHEMA_SQL);
	db.prepare(
		"INSERT INTO publication_items (item_id,note_path,meeting_date,project,source_hash,status,created_at,updated_at) VALUES (?,?,?,?,?,'pending_review',?,?)",
	).run(
		item.itemId,
		notePath,
		"2026-09-04",
		"alpha",
		item.sourceHash,
		new Date().toISOString(),
		new Date().toISOString(),
	);
	db.close();
	chmodSync(dbPath, 0o600);
	const engineStatePath = join(root, "engine.sqlite3");
	const engine = new DatabaseSync(engineStatePath);
	engine.exec("CREATE TABLE fixture_connection (name TEXT PRIMARY KEY) STRICT");
	engine.close();
	chmodSync(engineStatePath, 0o600);
	const installationRoot = realpathSync(
		join(dirname(fileURLToPath(import.meta.url)), "../src/jarvis/meeting-publication"),
	);
	const artifactAnchors = {
		core: join(installationRoot, "operational-input.ts"),
		host: join(installationRoot, "operational-runtime.ts"),
		sdk: join(installationRoot, "service.ts"),
		dependencies: join(installationRoot, "authority.ts"),
	};
	const authorization = createMeetingPublicationFullReviewAuthorizationFixture({
		privateRoot: join(root, "private"),
		config,
		credentialDirectory: join(root, "credentials"),
		engineStatePath,
		installationRoot,
		artifactAnchors,
	});
	const system = Effect.runSync(authorization.withSystem(MeetingPublicationSmokeRuntimeSystemReference));
	const verified =
		kind === "worker"
			? verifyMeetingPublicationWorkerInput(authorization.createCompetingWorkerInput(), system.observe())
			: verifyMeetingPublicationFullReviewInput(authorization.input, system.observe());
	const session = new MeetingRuntimeSession(verified, system);
	const binding = new MeetingPublicationWriteBinding({
		sourcePath: config.sourcePath!,
		statePath: config.statePath!,
		item,
	});
	const mutate = (sql: string) => {
		const database = new DatabaseSync(dbPath);
		try {
			database.exec(sql);
		} finally {
			database.close();
		}
	};
	const begin = () =>
		mutate(
			`INSERT INTO google_doc_drafts (item_id,source_hash,state) VALUES ('${item.itemId}','${item.sourceHash}','generating')`,
		);
	return { session, binding, mutate, begin, notePath, root };
};

describe("Google document generation authority", () => {
	it("permits an exact unapproved note with its durable generation request", async () => {
		const fixture = setup();
		try {
			expect(
				await Effect.runPromise(fixture.session.validator.validate("store_google_draft", fixture.binding)),
			).toBe(true);
			fixture.begin();
			expect(
				await Effect.runPromise(fixture.session.validator.validate("provider_google_draft", fixture.binding)),
			).toBe(true);
			expect(
				await Effect.runPromise(fixture.session.validator.validate("store_google_draft", fixture.binding)),
			).toBe(true);
		} finally {
			fixture.session.close();
		}
	});

	it.each([
		["missing generation marker", "DELETE FROM google_doc_drafts"],
		["approved note", "UPDATE publication_items SET status='approved',approved_hash=source_hash"],
		["pending note with retained approval", "UPDATE publication_items SET approved_hash=source_hash"],
		["rejected note", "UPDATE publication_items SET status='rejected'"],
		["different stored revision", `UPDATE publication_items SET source_hash='${"b".repeat(64)}'`],
		["different draft revision", `UPDATE google_doc_drafts SET source_hash='${"b".repeat(64)}'`],
		["completed draft", "UPDATE google_doc_drafts SET state='ready'"],
		["uncertain draft", "UPDATE google_doc_drafts SET state='uncertain'"],
	])("refuses provider writes for %s", async (_label, sql) => {
		const fixture = setup();
		try {
			fixture.begin();
			fixture.mutate(sql);
			expect(
				await Effect.runPromise(fixture.session.validator.validate("provider_google_draft", fixture.binding)),
			).toBe(false);
		} finally {
			fixture.session.close();
		}
	});

	it("revalidates the exact saved note bytes before each provider write", async () => {
		const fixture = setup();
		try {
			fixture.begin();
			expect(
				await Effect.runPromise(fixture.session.validator.validate("provider_google_draft", fixture.binding)),
			).toBe(true);
			writeFileSync(fixture.notePath, "Changed after the request\n");
			expect(
				await Effect.runPromise(fixture.session.validator.validate("provider_google_draft", fixture.binding)),
			).toBe(false);
		} finally {
			fixture.session.close();
		}
	});

	it("does not grant these operations to worker, smoke or review-only authorities", async () => {
		for (const operations of [
			MEETING_PUBLICATION_WORKER_OPERATIONS,
			MEETING_PUBLICATION_SMOKE_OPERATIONS,
			MEETING_PUBLICATION_REVIEW_OPERATIONS,
		]) {
			expect(operations).not.toContain("provider_google_draft");
			expect(operations).not.toContain("store_google_draft");
		}
		const fixture = setup("worker");
		try {
			fixture.begin();
			for (const operation of ["provider_google_draft", "store_google_draft"] as const)
				expect(await Effect.runPromise(fixture.session.validator.validate(operation, fixture.binding))).toBe(false);
		} finally {
			fixture.session.close();
		}
	});
});
