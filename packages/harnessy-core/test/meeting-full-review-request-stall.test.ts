/**
 * #139: the review owner's first GET / after ready must not hold its event loop.
 *
 * The full-review owner runs in-process over the real signed fixture with an inert
 * OS observer (no writer probes are spawned). Every request takes a write grant,
 * and every grant revalidates the signed runtime: the immutable files (the Node
 * executable, the trusted keyring, the authorization and the artifact manifest)
 * and the complete artifact inventory. This test measures the longest synchronous
 * slice of the owner's thread while one GET / is served, and records the bytes
 * read synchronously per file, so a regression names the file that stalled it.
 */
import { createHash } from "node:crypto";
import fs, { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";

import { JarvisMeetingPublicationConfig } from "../src/jarvis/config-model.ts";
import { validateMeetingPublicationWriteGrant } from "../src/jarvis/meeting-publication/authority.ts";
import { meetingPublicationTestWriteAuthorityLayer } from "../src/jarvis/meeting-publication/authority-test-fixture.ts";
import { MeetingPublicationProviderError } from "../src/jarvis/meeting-publication/models.ts";
import { MeetingPublicationSource } from "../src/jarvis/meeting-publication/notes.ts";
import {
	type ArtifactManifest,
	artifactInventorySteps,
	MEETING_PUBLICATION_HASH_CHUNK_BYTES,
} from "../src/jarvis/meeting-publication/operational-input.ts";
import {
	type MeetingPublicationWorkerProviderFactory,
	runAuthorizedMeetingPublicationFullReview,
} from "../src/jarvis/meeting-publication/operational-runtime.ts";
import {
	MeetingPublicationDiscord,
	MeetingPublicationDiscordCheckpoint,
	MeetingPublicationGoogle,
	MeetingPublicationGoogleCheckpoint,
	MeetingPublicationNotifier,
} from "../src/jarvis/meeting-publication/service.ts";
import { MeetingPublicationStore } from "../src/jarvis/meeting-publication/store.ts";
import { createMeetingPublicationFullReviewAuthorizationFixture } from "./support/meeting-full-review-runtime-fixture.ts";

const roots: Array<string> = [];
const fibers: Array<Fiber.Fiber<unknown, unknown>> = [];

afterEach(async () => {
	for (const fiber of fibers.splice(0)) await Effect.runPromise(Fiber.interrupt(fiber));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeConfig = (root: string) =>
	new JarvisMeetingPublicationConfig({
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

/** One pending meeting and a signed full-review authorization over this source tree. */
const setup = async () => {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-full-review-stall-"));
	roots.push(root);
	chmodSync(root, 0o700);
	for (const directory of ["notes", "credentials", "private"]) mkdirSync(join(root, directory), { mode: 0o700 });
	const notePath = join(root, "notes", "meeting.md");
	writeFileSync(
		notePath,
		"# Weekly Sync\n\n## Metadata\n- Project: alpha\n- Date: 2026-09-04\n- Fingerprint: stall\n\n## Executive Summary\nReview this.\n\n## Meeting Purpose\nBound the request.\n",
		{ mode: 0o600 },
	);
	const config = makeConfig(root);
	const authority = meetingPublicationTestWriteAuthorityLayer(config);
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const source = yield* MeetingPublicationSource;
				const store = yield* MeetingPublicationStore;
				yield* store.upsert(yield* source.read(notePath), new Date().toISOString());
			}).pipe(
				Effect.provide(
					Layer.merge(
						MeetingPublicationSource.layer(config).pipe(Layer.provide(authority)),
						MeetingPublicationStore.layer(config).pipe(Layer.provide(authority)),
					),
				),
			),
		),
	);
	const engineStatePath = join(root, "engine.sqlite3");
	const engine = new DatabaseSync(engineStatePath, { allowExtension: false });
	engine.exec("CREATE TABLE fixture_connection (name TEXT PRIMARY KEY) STRICT;");
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
	return { config, authorization };
};

/** Providers that validate their grants and publish nothing; GET / never calls them. */
const inertProviders = (
	anchors: MeetingPublicationWorkerProviderFactory["artifactAnchors"],
): MeetingPublicationWorkerProviderFactory => {
	const refused = (stage: "google" | "discord" | "notification") =>
		new MeetingPublicationProviderError({
			stage,
			code: "authorization_revoked",
			retryable: false,
			retryAfterSeconds: null,
		});
	return {
		artifactAnchors: anchors,
		make: () =>
			Effect.succeed(
				Layer.mergeAll(
					Layer.succeed(
						MeetingPublicationGoogle,
						MeetingPublicationGoogle.of({
							preflight: Effect.succeed(true),
							upsert: (_request, grant) =>
								validateMeetingPublicationWriteGrant(grant, "provider_google").pipe(
									Effect.mapError(() => refused("google")),
									Effect.as(
										new MeetingPublicationGoogleCheckpoint({
											docId: "doc",
											docUrl: "https://docs.example.test/doc",
										}),
									),
								),
							close: Effect.void,
						}),
					),
					Layer.succeed(
						MeetingPublicationDiscord,
						MeetingPublicationDiscord.of({
							preflight: Effect.succeed(true),
							upsert: (_request, grant) =>
								validateMeetingPublicationWriteGrant(grant, "provider_discord").pipe(
									Effect.mapError(() => refused("discord")),
									Effect.as(new MeetingPublicationDiscordCheckpoint({ channelId: "1", messageId: "1" })),
								),
							close: Effect.void,
						}),
					),
					Layer.succeed(
						MeetingPublicationNotifier,
						MeetingPublicationNotifier.of({
							notify: (_kind, _count, grant) =>
								validateMeetingPublicationWriteGrant(grant, "provider_notification").pipe(
									Effect.mapError(() => refused("notification")),
									Effect.as(false),
								),
							close: Effect.void,
						}),
					),
				),
			),
	};
};

const get = (origin: string, path: string, cookie?: string) =>
	new Promise<{ status: number; cookie: string | undefined; body: string }>((resolve, reject) => {
		const target = new URL(origin);
		const outgoing = request(
			{
				hostname: target.hostname,
				port: target.port,
				path,
				headers: { Host: target.host, ...(cookie === undefined ? {} : { Cookie: cookie }) },
			},
			(response) => {
				const chunks: Array<Buffer> = [];
				response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
				response.on("end", () => {
					const header = response.headers["set-cookie"]?.[0];
					resolve({
						status: response.statusCode ?? 0,
						cookie: header?.split(";", 1)[0],
						body: Buffer.concat(chunks).toString("utf8"),
					});
				});
			},
		);
		outgoing.setTimeout(60_000, () => outgoing.destroy(new Error("request timeout")));
		outgoing.on("error", reject);
		outgoing.end();
	});

/**
 * Synchronous file reads, by path, and the longest synchronous slice of this
 * thread while `run` is pending. A `setImmediate` chain runs once per event-loop
 * turn, so the gap between two of its callbacks is one turn's synchronous work.
 */
const measureSlices = async <A>(run: () => Promise<A>) => {
	const paths = new Map<number, string>();
	const bytes = new Map<string, number>();
	const originalOpen = fs.openSync;
	const originalRead = fs.readSync;
	fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
		const descriptor = originalOpen(...args);
		paths.set(descriptor, String(args[0]));
		return descriptor;
	}) as typeof fs.openSync;
	fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
		const count = (originalRead as (...values: Parameters<typeof fs.readSync>) => number)(...args);
		const path = paths.get(args[0]) ?? `fd:${args[0]}`;
		bytes.set(path, (bytes.get(path) ?? 0) + count);
		return count;
	}) as typeof fs.readSync;
	syncBuiltinESMExports();
	let longestMs = 0;
	let previous = performance.now();
	let running = true;
	const tick = () => {
		const now = performance.now();
		longestMs = Math.max(longestMs, now - previous);
		previous = now;
		if (running) setImmediate(tick);
	};
	setImmediate(tick);
	try {
		const value = await run();
		return { value, longestMs, bytes };
	} finally {
		running = false;
		fs.openSync = originalOpen;
		fs.readSync = originalRead;
		syncBuiltinESMExports();
	}
};

/** The fastest of three synchronous read-and-hash passes over `path`, in milliseconds. */
const hashMs = (path: string) => {
	let fastest = Number.POSITIVE_INFINITY;
	for (let pass = 0; pass < 3; pass += 1) {
		const started = performance.now();
		createHash("sha256").update(readFileSync(path)).digest("hex");
		fastest = Math.min(fastest, performance.now() - started);
	}
	return fastest;
};

describe("full-review owner request hot path (#139)", () => {
	it("serves the first GET / after ready without a synchronous slice as long as hashing the executable", async () => {
		const fixture = await setup();
		let ready: (origin: string) => void = () => undefined;
		const origin = new Promise<string>((resolve) => {
			ready = resolve;
		});
		const fiber = Effect.runFork(
			fixture.authorization.withSystem(
				runAuthorizedMeetingPublicationFullReview(
					fixture.authorization.input,
					inertProviders(fixture.authorization.providerArtifactAnchors),
					{
						artifactAnchors: fixture.authorization.providerArtifactAnchors,
						onReady: (address) => Effect.sync(() => ready(address.origin)),
					},
				),
			),
		);
		fibers.push(fiber);
		const address = await origin;
		const token = readFileSync(
			join(fixture.config.statePath as string, "meeting-publication-v2-review.token"),
			"utf8",
		).trim();
		const exchange = await get(address, `/exchange?token=${encodeURIComponent(token)}`);
		expect(exchange.status).toBe(303);
		const executable = realpathSync(process.execPath);
		const reference = hashMs(executable);
		const passes: Array<{ longestMs: number; bytes: Map<string, number> }> = [];
		for (let pass = 0; pass < 3; pass += 1) {
			const measured = await measureSlices(() => get(address, "/", exchange.cookie));
			expect(measured.value.status).toBe(200);
			expect(measured.value.body).toContain("Weekly Sync");
			passes.push(measured);
		}
		const best = passes.reduce((left, right) => (right.longestMs < left.longestMs ? right : left));
		const report = {
			executableHashMs: Math.round(reference),
			longestSliceMs: passes.map((pass) => Math.round(pass.longestMs)),
			syncBytesByFile: Object.fromEntries([...best.bytes].sort((left, right) => right[1] - left[1]).slice(0, 6)),
		};
		console.log(JSON.stringify(report));
		expect(best.longestMs, JSON.stringify(report)).toBeLessThan(reference / 2);
	}, 120_000);

	it("hashes a large artifact in bounded steps, so one file never fills a slice of the inventory scan", () => {
		const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "harnessy-inventory-chunks-")));
		roots.push(root);
		const files: Record<string, Buffer> = {
			"core.js": Buffer.from("export const core = 1;\n"),
			"host.js": Buffer.from("export const host = 1;\n"),
			"sdk.js": Buffer.from("export const sdk = 1;\n"),
			"dependencies.js": Buffer.from("export const dependencies = 1;\n"),
			// A bundled native binary, like the 207 MB agent binary in an installed tree.
			"native.bin": Buffer.alloc(24 * MEETING_PUBLICATION_HASH_CHUNK_BYTES + 123, 7),
		};
		for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body, { mode: 0o644 });
		const bound = (name: string) => {
			const path = join(root, name);
			const stat = fs.lstatSync(path, { bigint: true });
			return {
				path,
				device: stat.dev.toString(),
				inode: stat.ino.toString(),
				sha256: createHash("sha256").update(files[name]!).digest("hex"),
			};
		};
		const manifest: ArtifactManifest = {
			kind: "harnessy.runtime-artifact-manifest",
			schemaVersion: 1,
			root,
			anchors: (["core", "host", "sdk", "dependencies"] as const).map((role) => ({
				role,
				path: join(root, `${role}.js`),
			})),
			files: Object.keys(files)
				.sort()
				.map((name) => bound(name)),
		};
		const uid = BigInt(process.geteuid?.() ?? 0);
		const scan = (expected: ArtifactManifest) => {
			let stepBytes = 0;
			let largestStep = 0;
			const originalRead = fs.readSync;
			fs.readSync = ((...args: Parameters<typeof fs.readSync>) => {
				const count = (originalRead as (...values: Parameters<typeof fs.readSync>) => number)(...args);
				stepBytes += count;
				return count;
			}) as typeof fs.readSync;
			syncBuiltinESMExports();
			try {
				for (const _step of artifactInventorySteps(expected, uid, "smoke", join(root, "core.js"))) {
					largestStep = Math.max(largestStep, stepBytes);
					stepBytes = 0;
				}
				return Math.max(largestStep, stepBytes);
			} finally {
				fs.readSync = originalRead;
				syncBuiltinESMExports();
			}
		};
		// Every byte is still read and hashed, but no step reads more than one chunk.
		expect(scan(manifest)).toBeLessThanOrEqual(MEETING_PUBLICATION_HASH_CHUNK_BYTES);
		// A changed byte in the large file is still found.
		const tampered = {
			...manifest,
			files: manifest.files.map((file) =>
				file.path.endsWith("native.bin") ? { ...file, sha256: "0".repeat(64) } : file,
			),
		};
		expect(() => scan(tampered)).toThrow(expect.objectContaining({ code: "artifact_drift" }));
	});
});
