import { createHash } from "node:crypto";
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
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import {
	MEETING_PUBLICATION_REVIEW_OPERATIONS,
	type MeetingPublicationSmokeRuntimeErrorCode,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import { runAuthorizedMeetingPublicationReview } from "../src/jarvis/meeting-publication/operational-runtime.ts";
import { createMeetingPublicationReviewAuthorizationFixture } from "./support/meeting-review-runtime-fixture.ts";

const roots: Array<string> = [];
const activeFibers: Array<Fiber.Fiber<void, unknown>> = [];
const fixedNow = Date.parse("2026-09-05T12:00:00.000Z");
const v2ReviewTokenFileName = "meeting-publication-v2-review.token";

const markdown = (fingerprint: string, summary: string) => `# Weekly Sync

## Metadata
- Project: alpha
- Date: 2026-09-04
- Fingerprint: ${fingerprint}

## Executive Summary
${summary}

## Meeting Purpose
Prepare a separately reviewed V2 publication item while V1 remains live.
`;

afterEach(async () => {
	for (const fiber of activeFibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const makeConfig = (root: string, statePath = join(root, "state")) =>
	new JarvisMeetingPublicationConfig({
		enabled: false,
		project: "alpha",
		sourcePath: join(root, "notes"),
		statePath,
		backfillDays: 365,
		cutoverDate: "2026-01-01",
		maxFileBytes: 32_000,
		maxFiles: 100,
		leaseSeconds: 300,
		reminderSeconds: 3_600,
		reviewHost: "127.0.0.1",
		reviewPort: 0,
		reviewSessionSeconds: 60,
		reviewMaxSessions: 4,
		reviewMaxBodyBytes: 4_096,
		googleOwnerEmail: null,
		googleDriveFolder: null,
		discordChannelId: null,
	});

const installation = () => {
	const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../src/jarvis/meeting-publication"));
	return {
		root,
		anchors: {
			core: join(root, "operational-input.ts"),
			host: join(root, "operational-runtime.ts"),
			dependencies: join(root, "authority.ts"),
		},
	};
};

const createSentinelDatabase = (path: string, kind: string) => {
	const database = new DatabaseSync(path, { allowExtension: false });
	try {
		database.exec("CREATE TABLE owner_history (kind TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");
		database.prepare("INSERT INTO owner_history (kind,value) VALUES (?,?)").run(kind, "V1 remains authoritative");
	} finally {
		database.close();
	}
	chmodSync(path, 0o600);
};

const stableFileSnapshot = (path: string) => {
	const stat = lstatSync(path, { bigint: true });
	return {
		bytes: readFileSync(path),
		device: stat.dev,
		inode: stat.ino,
		uid: stat.uid,
		gid: stat.gid,
		mode: stat.mode,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	};
};

const setup = (name = "meeting.md", options: { readonly sharedV1State?: boolean } = {}) => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-review-runtime-"));
	roots.push(root);
	chmodSync(root, 0o700);
	for (const directory of ["notes", "state", "private", ...(options.sharedV1State ? [] : ["v1-state"])]) {
		mkdirSync(join(root, directory), { mode: 0o700 });
		chmodSync(join(root, directory), 0o700);
	}
	const notePath = join(root, "notes", name);
	writeFileSync(notePath, markdown(name.replace(/\.md$/u, ""), `Review ${name} without publishing.`), { mode: 0o600 });
	const v1StatePath = options.sharedV1State ? join(root, "state") : join(root, "v1-state");
	const v1StateFiles = options.sharedV1State
		? [
				join(v1StatePath, "queue.sqlite3"),
				join(v1StatePath, "weekly-briefings.sqlite3"),
				join(v1StatePath, "review.token"),
				join(v1StatePath, "review.log"),
			]
		: [join(v1StatePath, "owner-state.sqlite3")];
	if (options.sharedV1State) {
		createSentinelDatabase(v1StateFiles[0] as string, "meeting-publication");
		createSentinelDatabase(v1StateFiles[1] as string, "weekly-briefings");
		writeFileSync(v1StateFiles[2] as string, `${"v".repeat(43)}\n`, { mode: 0o600 });
		writeFileSync(v1StateFiles[3] as string, "V1 review history remains authoritative.\n", { mode: 0o600 });
	} else {
		writeFileSync(v1StateFiles[0] as string, "V1 remains authoritative.\n", { mode: 0o600 });
	}
	for (const path of v1StateFiles) chmodSync(path, 0o600);
	const v1SentinelPath = v1StateFiles[0] as string;
	const config = makeConfig(root, options.sharedV1State ? v1StatePath : undefined);
	const installed = installation();
	const authorization = createMeetingPublicationReviewAuthorizationFixture({
		privateRoot: join(root, "private"),
		config,
		v1StatePath,
		installationRoot: installed.root,
		artifactAnchors: installed.anchors,
		now: fixedNow,
	});
	return { root, config, notePath, v1StatePath, v1StateFiles, v1SentinelPath, authorization };
};

interface HttpResult {
	readonly status: number;
	readonly headers: Record<string, string | ReadonlyArray<string> | undefined>;
	readonly body: string;
}

const call = (
	origin: string,
	path: string,
	options: { readonly method?: string; readonly cookie?: string; readonly body?: string } = {},
) =>
	new Promise<HttpResult>((resolveRequest, rejectRequest) => {
		const target = new URL(origin);
		const headers: Record<string, string> = { Host: target.host };
		if (options.cookie !== undefined) headers.Cookie = options.cookie;
		if (options.body !== undefined) {
			headers.Origin = origin;
			headers["Content-Type"] = "application/x-www-form-urlencoded";
			headers["Content-Length"] = String(Buffer.byteLength(options.body));
		}
		const outgoing = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				method: options.method ?? "GET",
				headers,
			},
			(response) => {
				const chunks: Array<Buffer> = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () =>
					resolveRequest({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		outgoing.setTimeout(3_000, () => outgoing.destroy(new Error("request timeout")));
		outgoing.on("error", rejectRequest);
		outgoing.end(options.body);
	});

const cookieFrom = (response: HttpResult) => {
	const header = response.headers["set-cookie"];
	const first = Array.isArray(header) ? header[0] : header;
	if (first === undefined) throw new Error("missing review cookie");
	return first.split(";", 1)[0] as string;
};

const csrfFrom = (body: string) => {
	const value = /name="csrf" value="([A-Za-z0-9_-]{43})"/u.exec(body)?.[1];
	if (value === undefined) throw new Error("missing review csrf");
	return value;
};

const encode = (value: Record<string, string>) => new URLSearchParams(value).toString();

const post = (origin: string, cookie: string, path: string, body: string) =>
	call(origin, path, { method: "POST", cookie, body });

const stateDatabasePath = (fixture: ReturnType<typeof setup>) =>
	join(fixture.config.statePath as string, "meeting-publication.sqlite3");

const pendingItem = (fixture: ReturnType<typeof setup>) => {
	const database = new DatabaseSync(stateDatabasePath(fixture), { readOnly: true, allowExtension: false });
	try {
		return database
			.prepare(
				"SELECT item_id,source_hash FROM publication_items WHERE status='pending_review' ORDER BY item_id LIMIT 1",
			)
			.get() as { item_id: string; source_hash: string };
	} finally {
		database.close();
	}
};

const itemState = (fixture: ReturnType<typeof setup>, itemId: string) => {
	const database = new DatabaseSync(stateDatabasePath(fixture), { readOnly: true, allowExtension: false });
	try {
		return database.prepare("SELECT * FROM publication_items WHERE item_id=?").get(itemId);
	} finally {
		database.close();
	}
};

const replayState = (path: string) => {
	const database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
	try {
		return {
			consumed: Number(database.prepare("SELECT COUNT(*) AS count FROM consumed_authorizations").get()?.count),
			leases: Number(database.prepare("SELECT COUNT(*) AS count FROM active_lease").get()?.count),
		};
	} finally {
		database.close();
	}
};

const startupState = (fixture: ReturnType<typeof setup>) => {
	const databasePath = stateDatabasePath(fixture);
	if (!existsSync(databasePath)) return { database: false, token: false };
	const database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false });
	try {
		return {
			database: true,
			token: existsSync(join(fixture.config.statePath as string, v2ReviewTokenFileName)),
			items: Number(database.prepare("SELECT COUNT(*) AS count FROM publication_items").get()?.count),
		};
	} finally {
		database.close();
	}
};

const startReview = async (fixture: ReturnType<typeof setup>) => {
	let publishAddress: ((address: { readonly origin: string }) => void) | undefined;
	const address = new Promise<{ readonly origin: string }>((resolveAddress) => {
		publishAddress = resolveAddress;
	});
	const fiber = Effect.runFork(
		fixture.authorization.withSystem(
			runAuthorizedMeetingPublicationReview(fixture.authorization.input, {
				artifactAnchors: fixture.authorization.artifactAnchors,
				onReady: (ready) => Effect.sync(() => publishAddress?.(ready)).pipe(Effect.andThen(Effect.never)),
			}),
		),
	);
	activeFibers.push(fiber);
	const ready = await Promise.race([
		address,
		Effect.runPromise(Fiber.await(fiber)).then((exit) => {
			throw new Error(
				`review runtime exited before ready: ${JSON.stringify(exit)} ${JSON.stringify(replayState(fixture.authorization.replayPath))} ${JSON.stringify(startupState(fixture))}`,
			);
		}),
	]);
	return { fiber, address: ready };
};

const exchange = async (fixture: ReturnType<typeof setup>, origin: string) => {
	const token = readFileSync(join(fixture.config.statePath as string, v2ReviewTokenFileName), "utf8").trim();
	const response = await call(origin, `/exchange?token=${encodeURIComponent(token)}`);
	return { response, cookie: cookieFrom(response) };
};

const approvePending = async (fixture: ReturnType<typeof setup>, origin: string) => {
	const item = pendingItem(fixture);
	const session = await exchange(fixture, origin);
	const page = await call(origin, `/item/${item.item_id}`, { cookie: session.cookie });
	const csrf = csrfFrom(page.body);
	const update = await post(
		origin,
		session.cookie,
		`/update-note/${item.item_id}`,
		encode({
			csrf,
			item_id: item.item_id,
			source_hash: item.source_hash,
			meeting_markdown: "MUST_NOT_WRITE",
		}),
	);
	const restore = await post(
		origin,
		session.cookie,
		`/restore/${item.item_id}`,
		encode({ csrf, item_id: item.item_id, source_hash: item.source_hash }),
	);
	const approval = await post(
		origin,
		session.cookie,
		`/approve/${item.item_id}`,
		encode({ csrf, item_id: item.item_id, source_hash: item.source_hash, purpose: "Reviewed for V2 queue only" }),
	);
	return { item, page, update, restore, approval };
};

const interrupt = (fiber: Fiber.Fiber<void, unknown>) => Effect.runPromise(Fiber.interrupt(fiber));

const expectFailure = async (fixture: ReturnType<typeof setup>, expected: MeetingPublicationSmokeRuntimeErrorCode) => {
	let ready = 0;
	const result = await Effect.runPromise(
		fixture.authorization
			.withSystem(
				runAuthorizedMeetingPublicationReview(fixture.authorization.input, {
					artifactAnchors: fixture.authorization.artifactAnchors,
					onReady: () =>
						Effect.sync(() => {
							ready += 1;
						}).pipe(Effect.andThen(Effect.fail("unexpected_ready"))),
				}),
			)
			.pipe(Effect.result),
	);
	expect(result._tag).toBe("Failure");
	if (result._tag === "Failure") expect(result.failure.code).toBe(expected);
	expect(ready).toBe(0);
	return result;
};

describe("meeting publication authorized review runtime", () => {
	it("scans once and approves an exact item without source, V1, update, or provider effects", async () => {
		const fixture = setup();
		const sourceBefore = digest(fixture.notePath);
		const v1Before = digest(fixture.v1SentinelPath);
		expect(fixture.authorization.payload.operations).toEqual([...MEETING_PUBLICATION_REVIEW_OPERATIONS]);
		expect(fixture.authorization.payload.operations).not.toEqual(
			expect.arrayContaining(["source_update", "store_restore", "provider_google", "provider_discord"]),
		);
		const running = await startReview(fixture);
		const result = await approvePending(fixture, running.address.origin);

		expect(result.page.status).toBe(200);
		expect(result.page.body).not.toContain("/update-note/");
		expect(result.update.status).toBe(404);
		expect(result.restore.status).toBe(404);
		expect(result.approval).toMatchObject({ status: 303, body: "" });
		const current = itemState(fixture, result.item.item_id) as Record<string, unknown>;
		expect(current).toMatchObject({
			status: "approved",
			approved_hash: result.item.source_hash,
			google_doc_id: null,
			google_doc_url: null,
			discord_channel_id: null,
			discord_message_id: null,
			attempts: 0,
		});
		expect(digest(fixture.notePath)).toBe(sourceBefore);
		expect(digest(fixture.v1SentinelPath)).toBe(v1Before);
		expect(fixture.authorization.getWriterProofs()).toBe(0);

		await interrupt(running.fiber);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		await expectFailure(fixture, "state_drift");
		// Preserve identity/nonce but bind the now-existing state, isolating replay rejection.
		fixture.authorization.rebindStateDatabaseAndResign();
		await expectFailure(fixture, "replayed");
	});

	it("reviews only the V2 queue when V1 and V2 state share one signed directory", async () => {
		const fixture = setup("shared-state.md", { sharedV1State: true });
		const v1Before = new Map(fixture.v1StateFiles.map((path) => [path, stableFileSnapshot(path)]));
		expect(fixture.authorization.payload.config.statePath).toBe(fixture.authorization.payload.v1StatePath);
		expect(fixture.authorization.payload.config.reviewHost).toBe("127.0.0.1");
		expect(fixture.authorization.payload.config.reviewPort).toBe(0);

		const running = await startReview(fixture);
		const address = new URL(running.address.origin);
		expect(address.hostname).toBe("127.0.0.1");
		expect(Number(address.port)).toBeGreaterThan(0);
		const v1Token = readFileSync(join(fixture.v1StatePath, "review.token"), "utf8").trim();
		const denied = await call(running.address.origin, `/exchange?token=${encodeURIComponent(v1Token)}`);
		expect(denied.status).toBe(401);
		expect(denied.headers["set-cookie"]).toBeUndefined();
		expect(denied.body).not.toContain(v1Token);

		const result = await approvePending(fixture, running.address.origin);
		expect(result.approval).toMatchObject({ status: 303, body: "" });
		expect(itemState(fixture, result.item.item_id)).toMatchObject({
			status: "approved",
			approved_hash: result.item.source_hash,
			google_doc_id: null,
			discord_message_id: null,
		});
		const v2Token = readFileSync(join(fixture.v1StatePath, v2ReviewTokenFileName), "utf8").trim();
		expect(v2Token).not.toBe(v1Token);
		expect(fixture.authorization.getWriterProofs()).toBe(0);

		await interrupt(running.fiber);
		for (const [path, before] of v1Before) expect(stableFileSnapshot(path), path).toEqual(before);
		expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
	});

	it.each([false, true] as const)(
		"accepts an exactly signed existing V2 database and adds a later source item (shared V1 state: %s)",
		async (sharedV1State) => {
			const first = setup("first.md", { sharedV1State });
			const v1Before = new Map(first.v1StateFiles.map((path) => [path, stableFileSnapshot(path)]));
			const runningFirst = await startReview(first);
			const firstApproval = await approvePending(first, runningFirst.address.origin);
			await interrupt(runningFirst.fiber);
			expect(itemState(first, firstApproval.item.item_id)).toMatchObject({ status: "approved" });

			const secondNotePath = join(first.root, "notes", "second.md");
			writeFileSync(secondNotePath, markdown("second", "A later item is prepared in the existing V2 queue."), {
				mode: 0o600,
			});
			mkdirSync(join(first.root, "private-existing"), { mode: 0o700 });
			const installed = installation();
			const authorization = createMeetingPublicationReviewAuthorizationFixture({
				privateRoot: join(first.root, "private-existing"),
				config: first.config,
				v1StatePath: first.v1StatePath,
				installationRoot: installed.root,
				artifactAnchors: installed.anchors,
				now: fixedNow,
			});
			const second = { ...first, notePath: secondNotePath, authorization };
			expect(second.authorization.payload.stateDatabase.kind).toBe("existing");
			const runningSecond = await startReview(second);
			const secondApproval = await approvePending(second, runningSecond.address.origin);
			await interrupt(runningSecond.fiber);

			expect(itemState(second, secondApproval.item.item_id)).toMatchObject({ status: "approved" });
			expect(itemState(second, firstApproval.item.item_id)).toMatchObject({ status: "approved" });
			expect(second.authorization.getWriterProofs()).toBe(0);
			expect(replayState(second.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			for (const [path, before] of v1Before) expect(stableFileSnapshot(path), path).toEqual(before);
		},
	);

	it.each(["expiration", "revocation"] as const)(
		"denies every later review request after %s and clears the scoped lease",
		async (loss) => {
			const fixture = setup();
			const running = await startReview(fixture);
			const session = await exchange(fixture, running.address.origin);
			if (loss === "expiration") fixture.authorization.advanceTimeBy(5 * 60_000 + 1);
			else fixture.authorization.revoke();
			const denied = await call(running.address.origin, "/", { cookie: session.cookie });

			expect(denied.status).toBe(503);
			expect(denied.body).not.toContain(fixture.authorization.payload.authorizationId);
			expect(fixture.authorization.getWriterProofs()).toBe(0);
			await interrupt(running.fiber);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
		},
	);

	it("rejects bad signatures, cross-domain authority, path overlap, and signed-state drift before serving", async () => {
		const invalidSignature = setup();
		invalidSignature.authorization.corruptSignature();
		await expectFailure(invalidSignature, "invalid_signature");

		const crossDomain = setup();
		crossDomain.authorization.writeCrossDomainAuthorization();
		await expectFailure(crossDomain, "invalid_input");

		const v1Descendant = setup();
		v1Descendant.authorization.resign((payload) => {
			payload.v1StatePath = join(payload.config.statePath, "strict-descendant");
		});
		await expectFailure(v1Descendant, "binding_mismatch");

		const v1Ancestor = setup();
		const nestedStatePath = join(v1Ancestor.root, "v1-state", "strict-descendant");
		mkdirSync(nestedStatePath, { mode: 0o700 });
		const nestedState = lstatSync(nestedStatePath, { bigint: true });
		v1Ancestor.authorization.resign((payload) => {
			payload.config.statePath = realpathSync(nestedStatePath);
			payload.stateDirectory = {
				path: realpathSync(nestedStatePath),
				device: nestedState.dev.toString(),
				inode: nestedState.ino.toString(),
			};
			payload.stateDatabase = {
				kind: "absent",
				path: join(realpathSync(nestedStatePath), "meeting-publication.sqlite3"),
			};
		});
		await expectFailure(v1Ancestor, "binding_mismatch");

		const sourceOverlap = setup();
		sourceOverlap.authorization.resign((payload) => {
			payload.v1StatePath = payload.config.sourcePath;
		});
		await expectFailure(sourceOverlap, "binding_mismatch");

		const sourceReplacement = setup();
		renameSync(join(sourceReplacement.root, "notes"), join(sourceReplacement.root, "notes-signed"));
		mkdirSync(join(sourceReplacement.root, "notes"), { mode: 0o700 });
		await expectFailure(sourceReplacement, "state_drift");

		const artifactTamper = setup();
		writeFileSync(artifactTamper.authorization.artifactManifestPath, "{}\n", { mode: 0o600 });
		await expectFailure(artifactTamper, "artifact_drift");

		for (const fixture of [
			invalidSignature,
			crossDomain,
			v1Descendant,
			v1Ancestor,
			sourceOverlap,
			sourceReplacement,
			artifactTamper,
		]) {
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
			expect(fixture.authorization.getWriterProofs()).toBe(0);
			expect(() => readFileSync(stateDatabasePath(fixture))).toThrow();
		}
	});

	it("rejects a source root without owner read and search before creating review state", async () => {
		const fixture = setup();
		const sourcePath = fixture.config.sourcePath as string;
		chmodSync(sourcePath, 0o300);
		try {
			await expectFailure(fixture, "unsafe_input");
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 0, leases: 0 });
			expect(() => readFileSync(stateDatabasePath(fixture))).toThrow();
		} finally {
			chmodSync(sourcePath, 0o700);
		}
	});

	it.each(["expiration", "revocation"] as const)(
		"closes idle review after %s even when onReady never returns",
		async (loss) => {
			const fixture = setup();
			const running = await startReview(fixture);
			if (loss === "expiration") fixture.authorization.advanceTimeBy(5 * 60_000 + 1);
			else fixture.authorization.revoke();
			const exit = await Effect.runPromise(Fiber.await(running.fiber).pipe(Effect.timeout(3000)));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) expect(Cause.hasFails(exit.cause)).toBe(true);
			expect(replayState(fixture.authorization.replayPath)).toEqual({ consumed: 1, leases: 0 });
			await expect(call(running.address.origin, "/")).rejects.toThrow();
		},
	);
});
