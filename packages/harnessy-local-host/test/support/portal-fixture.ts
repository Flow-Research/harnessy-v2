/**
 * A populated, isolated home directory for portal tests. Every database is
 * built with the real writer code (meeting store, Life ledger, wiki store,
 * Fathom file store) or, for the Python-owned community queue, its exact schema.
 * Canary token files are planted where other services keep their secrets.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
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
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JarvisMeetingPublicationConfig } from "../../../harnessy-core/src/jarvis/config-model.ts";
import { FathomFileStore } from "../../../harnessy-core/src/jarvis/fathom/file-store.ts";
import { canonicalLifeBriefPath } from "../../../harnessy-core/src/jarvis/life-orchestrator/history.ts";
import { LifeReadingLedger } from "../../../harnessy-core/src/jarvis/life-orchestrator/store.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../../../harnessy-core/src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationNote } from "../../../harnessy-core/src/jarvis/meeting-publication/models.ts";
import { meetingPublicationReviewRendezvousFileName } from "../../../harnessy-core/src/jarvis/meeting-publication/review.ts";
import { MeetingPublicationStore } from "../../../harnessy-core/src/jarvis/meeting-publication/store.ts";
import { WikiStore } from "../../src/wiki/store.ts";

const temporaryRoot = realpathSync(tmpdir());
const roots: string[] = [];

/** Fail a test whose path leaves the temporary directory. */
export const assertInsideTemp = (...paths: ReadonlyArray<string>): void => {
	for (const path of paths) {
		const fromTemp = relative(temporaryRoot, resolve(path));
		if (fromTemp === "" || fromTemp.startsWith("..") || resolve(path) === fromTemp)
			throw new Error(`test path left the temporary directory: ${path}`);
	}
};

/** A fresh, symlink-free directory under the temporary directory, mode 0700. */
export const tempDir = (prefix: string): string => {
	const root = realpathSync(mkdtempSync(join(temporaryRoot, `harnessy-portal-${prefix}-`)));
	chmodSync(root, 0o700);
	roots.push(root);
	assertInsideTemp(root);
	return root;
};

export const cleanupPortalFixtures = (): void => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export const FIXTURE_NOW = new Date("2026-10-17T08:00:00.000Z");
export const MEETING_OWNER = "owner@example.test";
/** Text that must never appear in a portal response, log or opened-file record. */
export const CANARY = "PORTAL-CANARY-7f3a";

const COMMUNITY_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS community_briefings (
    briefing_id TEXT PRIMARY KEY, week_start TEXT NOT NULL UNIQUE, week_end TEXT NOT NULL,
    artifact_dir TEXT NOT NULL, briefing_path TEXT NOT NULL, discord_path TEXT NOT NULL,
    provenance_path TEXT NOT NULL, draft_hash TEXT NOT NULL, approved_hash TEXT, status TEXT NOT NULL,
    provider TEXT, google_doc_id TEXT, google_doc_url TEXT, discord_channel_id TEXT, discord_message_id TEXT,
    error_stage TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
    last_notified_at TEXT, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    approved_at TEXT, published_at TEXT, rejected_at TEXT
);
CREATE INDEX IF NOT EXISTS community_briefing_status_idx ON community_briefings(status, next_attempt_at, week_start);
`;

export interface PortalHome {
	readonly home: string;
	readonly configPath: string;
	readonly databases: {
		readonly meeting: string;
		readonly community: string;
		readonly life: string;
		readonly wiki: string;
	};
	/** Secret files that belong to other services. The portal must never open them. */
	readonly canaries: ReadonlyArray<string>;
}

const meetingConfig = (home: string) =>
	new JarvisMeetingPublicationConfig({
		enabled: true,
		project: "alpha",
		sourcePath: join(home, "notes"),
		statePath: join(home, "meeting-state"),
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 60,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 8770,
		reviewSessionSeconds: 900,
		reviewMaxSessions: 64,
		reviewMaxBodyBytes: 4_096,
		googleOwnerEmail: MEETING_OWNER,
		googleDriveFolder: "folder-id",
		discordChannelId: "channel-id",
	});

const note = (home: string, name: string, meetingDate: string) =>
	new MeetingPublicationNote({
		itemId: createHash("sha256").update(`alpha:${name}`).digest("hex").slice(0, 24),
		path: join(home, "notes", `${name}.md`),
		relativePath: `${name}.md`,
		title: `${name} ${CANARY}`,
		meetingDate,
		project: "alpha",
		sourceHash: createHash("sha256").update(name).digest("hex"),
		summary: `summary ${CANARY}`,
		markdown: `# ${name}\n${CANARY}\n`,
	});

const populateMeetings = (home: string) => {
	const config = meetingConfig(home);
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const store = yield* MeetingPublicationStore;
				const at = FIXTURE_NOW.toISOString();
				for (const [name, date] of [
					["kickoff", "2026-10-01"],
					["retro", "2026-10-03"],
				] as const)
					yield* store.upsert(note(home, name, date), at);
				yield* store.recordProviderHealth({
					provider: "google",
					account: MEETING_OWNER,
					failure: "authentication",
					checkedAt: at,
					lastSuccessAt: "2026-10-16T12:00:00.000Z",
					incidentAt: at,
					notifiedAt: null,
					recoveryPending: true,
				});
				return store.dbPath;
			}).pipe(
				Effect.provide(
					MeetingPublicationStore.layer(config).pipe(
						Layer.provide(meetingPublicationTestWriteAuthorityLayer(config)),
					),
				),
			),
		),
	);
};

const populateCommunity = (state: string) => {
	mkdirSync(state, { recursive: true, mode: 0o700 });
	const path = join(state, "weekly-briefings.sqlite3");
	const database = new DatabaseSync(path);
	database.exec(COMMUNITY_STORE_SCHEMA);
	const insert = database.prepare(
		`INSERT INTO community_briefings (briefing_id, week_start, week_end, artifact_dir, briefing_path, discord_path,
		 provenance_path, draft_hash, status, error_message, attempts, created_at, updated_at)
		 VALUES (?, ?, ?, '/a', '/a/b.md', '/a/d.txt', '/a/p.json', 'hash', ?, ?, 0, ?, ?)`,
	);
	insert.run("b1", "2026-10-05", "2026-10-11", "pending_review", `token=${CANARY}`, "2026-10-12", "2026-10-12");
	insert.run("b2", "2026-09-28", "2026-10-04", "published", null, "2026-10-05", "2026-10-05");
	database.close();
	return path;
};

const populateLife = async (home: string) => {
	const path = join(home, ".harnessy", "jarvis", "life", "life-orchestrator.sqlite3");
	await Effect.runPromise(
		Effect.acquireUseRelease(
			LifeReadingLedger.open(path),
			(ledger) =>
				ledger.upsertCandidates(
					[0, 1, 2].map((index) => ({
						url: `https://example.test/reading-${index}`,
						title: `Reading ${index} ${CANARY}`,
						topic: "Synthetic topic",
						publishedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
						sourceName: "Synthetic feed",
						sourceKind: "rss" as const,
					})),
					FIXTURE_NOW.toISOString(),
				),
			(ledger) => Effect.sync(() => ledger.close()),
		),
	);
	const brief = canonicalLifeBriefPath(join(home, ".agents", "life"), FIXTURE_NOW);
	mkdirSync(dirname(brief), { recursive: true });
	writeFileSync(brief, `# Daily brief\n${CANARY}\n`);
	const reviews = join(home, ".harnessy", "jarvis", "life", "reviews");
	const run = join(reviews, `weekly-2026-W42-${createHash("sha256").update("2026-W42").digest("hex")}`);
	mkdirSync(run, { recursive: true });
	writeFileSync(join(run, "run.json"), JSON.stringify({ runId: "weekly:2026-W42", grantId: "g", pid: 1 }));
	writeFileSync(join(run, "draft.md"), `draft ${CANARY}`);
	writeFileSync(join(reviews, "2026-10-16-bbbb.md"), `preview ${CANARY}`);
	return path;
};

const populateWiki = async (home: string) => {
	const root = join(home, ".harnessy", "jarvis", "wiki", "learning");
	mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
	const store = new WikiStore(root);
	try {
		await store.write(async () => {
			store.capture({
				uri: "https://example.test/a",
				title: `A ${CANARY}`,
				event: "e1",
				kind: "saved",
				occurredAt: FIXTURE_NOW.toISOString(),
			});
			store.capture({
				uri: "https://example.test/b",
				title: "B",
				event: "e2",
				kind: "saved",
				occurredAt: FIXTURE_NOW.toISOString(),
			});
			store.db.prepare("UPDATE sources SET status='failed' WHERE uri='https://example.test/b'").run();
		});
	} finally {
		store.close();
	}
	return join(root, "catalog.sqlite3");
};

const plant = (path: string): string => {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${CANARY}\n`, { mode: 0o600 });
	return path;
};

/** Build a populated home under the temporary directory. */
export const buildPortalHome = async (prefix: string): Promise<PortalHome> => {
	const home = tempDir(prefix);
	mkdirSync(join(home, "notes"));
	const configPath = join(home, ".jarvis", "config.yaml");
	mkdirSync(dirname(configPath), { recursive: true });
	const communityState = join(home, "community-state");
	writeFileSync(
		configPath,
		[
			"meeting_publication:",
			"  enabled: true",
			"  project: alpha",
			`  source_path: ${join(home, "notes")}`,
			`  state_path: ${join(home, "meeting-state")}`,
			"  cutover_date: '2026-01-01'",
			"  review_host: 127.0.0.1",
			"  review_port: 8770",
			`  google_owner_email: ${MEETING_OWNER}`,
			"  google_drive_folder: folder-id",
			"  discord_channel_id: channel-id",
			"community_briefing:",
			`  source_path: ${join(home, "private")}`,
			`  draft_path: ${join(home, "drafts")}`,
			`  state_path: ${communityState}`,
			"  review_host: 127.0.0.1",
			"  review_port: 8872",
			"  discord_channel_id: '123'",
			"fathom:",
			"  default_account: personal",
			"  poll_accounts: [personal, research]",
			"  accounts:",
			"    personal:",
			"      api_key_env_var: FATHOM_PERSONAL",
			"    research:",
			"      api_key_env_var: FATHOM_RESEARCH",
			"",
		].join("\n"),
	);
	const inbox = join(home, "private", "meeting-inbox", "fathom", "personal", "pending");
	mkdirSync(inbox, { recursive: true });
	writeFileSync(join(inbox, "1.json"), JSON.stringify({ transcript: CANARY }));
	for (const [account, updatedAt] of [
		["personal", "2026-10-17T07:58:00.000Z"],
		["research", "2026-10-16T07:00:00.000Z"],
	] as const) {
		const store = new FathomFileStore({
			inboxRoot: join(home, "unused-inbox"),
			stateRoot: join(home, ".harnessy", "jarvis", "state", "fathom"),
		});
		await store.loadCheckpoint(account);
		await store.saveCheckpoint(account, { cursor: null, seen: {}, updatedAt });
	}
	const meeting = await populateMeetings(home);
	const community = populateCommunity(communityState);
	const life = await populateLife(home);
	const wiki = await populateWiki(home);
	for (const slug of ["flow", "personal"]) mkdirSync(join(home, ".config", `gws-${slug}`), { recursive: true });
	mkdirSync(join(home, ".config", "unrelated"), { recursive: true });
	// A plain file with a profile-shaped name is not a gws profile.
	writeFileSync(join(home, ".config", "gws-notaprofile"), "");
	const canaries = [
		plant(join(home, "meeting-state", "meeting-publication-v2-review.token")),
		plant(join(home, "meeting-state", meetingPublicationReviewRendezvousFileName)),
		plant(join(communityState, "review.token")),
		plant(join(home, ".executor", "server-control", "auth.json")),
		plant(join(home, ".codex", "auth.json")),
		plant(join(home, ".config", "gws-flow", "credentials.json")),
		plant(join(home, ".harnessy", "jarvis", "managed.env")),
	];
	return { home, configPath, databases: { meeting, community, life, wiki }, canaries };
};

/** SHA-256, size, modification time and inode of a file, plus which SQLite sidecars exist. */
export const fileFingerprint = (path: string) => {
	assertInsideTemp(path);
	const stat = lstatSync(path);
	return {
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		ino: stat.ino,
		sidecars: ["-journal", "-wal", "-shm"].filter((suffix) =>
			lstatSync(`${path}${suffix}`, { throwIfNoEntry: false }),
		),
	};
};

/** Every entry under `root` with its size, modification time and inode. */
export const treeListing = (root: string): ReadonlyArray<string> => {
	assertInsideTemp(root);
	const listing: string[] = [];
	const visit = (directory: string) => {
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const stat = lstatSync(path);
			listing.push(`${relative(root, path)} ${stat.isDirectory() ? "dir" : stat.size} ${stat.mtimeMs} ${stat.ino}`);
			if (stat.isDirectory()) visit(path);
		}
	};
	visit(root);
	return listing;
};
