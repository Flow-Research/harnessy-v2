import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const coreRoot = join(repoRoot, "packages", "harnessy-core");
const sdkRoot = join(repoRoot, "packages", "harnessy-sdk");
const fixtureRoot = mkdtempSync(join(realpathSync(tmpdir()), "harnessy-local-host-fixture-"));
const tarballRoot = join(fixtureRoot, "tarballs");
const consumerRoot = join(fixtureRoot, "consumer");
const protectedRoot = join(fixtureRoot, "read-only-inputs");
const cacheRoot = join(fixtureRoot, "npm-cache");

const assert = (condition, message) => {
	if (!condition) throw new Error(message);
};

const makePrivateDirectory = (path) => {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(path, 0o700);
};

const withTemporaryMode = (path, mode, operation) => {
	const originalMode = statSync(path).mode & 0o7777;
	chmodSync(path, mode);
	try {
		const before = treeSnapshot(protectedRoot);
		const result = operation();
		assert(
			JSON.stringify(treeSnapshot(protectedRoot)) === JSON.stringify(before),
			"Rejected input changed protected source/config/state bytes or metadata",
		);
		return result;
	} finally {
		chmodSync(path, originalMode);
	}
};

const run = (command, args, cwd, expectedStatus = 0) => {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			HARNESSY_FIXTURE_SECRET_CANARY: "must-not-leak",
			NODE_NO_WARNINGS: "1",
			npm_config_update_notifier: "false",
		},
	});
	assert(result.status === expectedStatus, `${command} exited ${String(result.status)}: ${result.stderr}`);
	assert(!result.stdout.includes("must-not-leak"), `${command} leaked an environment secret to stdout`);
	assert(!result.stderr.includes("must-not-leak"), `${command} leaked an environment secret to stderr`);
	return result;
};

const pack = (root) => {
	const result = run(
		"npm",
		["pack", "--ignore-scripts", "--json", "--pack-destination", tarballRoot, "--cache", cacheRoot],
		root,
	);
	const parsed = JSON.parse(result.stdout);
	const packed = parsed[0];
	assert(packed !== undefined && typeof packed.filename === "string", `npm pack returned no artifact for ${root}`);
	return { ...packed, tarball: join(tarballRoot, packed.filename) };
};

const extract = (tarball, target) => {
	makePrivateDirectory(target);
	run("tar", ["-xzf", tarball, "--strip-components=1", "-C", target], fixtureRoot);
	if (process.platform !== "win32") chmodSync(target, 0o700);
};

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const copiedRuntimePackages = new Set();
const copyRuntimePackage = (name) => {
	if (copiedRuntimePackages.has(name)) return;
	copiedRuntimePackages.add(name);
	const source = join(repoRoot, "node_modules", ...name.split("/"));
	const target = join(consumerRoot, "node_modules", ...name.split("/"));
	assert(existsSync(source), `Installed runtime package is missing: ${name}`);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(source, target, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
		if (existsSync(join(repoRoot, "node_modules", ...dependency.split("/")))) copyRuntimePackage(dependency);
	}
};

const treeSnapshot = (root) => {
	const entries = [];
	const visit = (path) => {
		let stat = lstatSync(path, { bigint: true });
		const relativePath = relative(root, path) || ".";
		const metadata = () =>
			`${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.birthtimeNs}:${stat.dev}:${stat.ino}:${stat.nlink}`;
		if (stat.isDirectory()) {
			const names = readdirSync(path).sort();
			stat = lstatSync(path, { bigint: true });
			entries.push([relativePath, `directory:${metadata()}`]);
			for (const name of names) visit(join(path, name));
			return;
		}
		const digest = sha256(path);
		stat = lstatSync(path, { bigint: true });
		entries.push([relativePath, `file:${metadata()}:${digest}`]);
	};
	visit(root);
	return entries;
};

const parseSingleJson = (result, command) => {
	assert(result.stderr === "", `${command} wrote unexpected stderr: ${result.stderr}`);
	const lines = result.stdout.trimEnd().split("\n");
	assert(lines.length === 1 && lines[0] !== "", `${command} did not emit exactly one JSON document`);
	return JSON.parse(lines[0]);
};

const assertRejectedInput = (result, command) => {
	assert(result.stdout === "", `${command} wrote stdout for a rejected input`);
	const error = parseSingleJson({ ...result, stdout: result.stderr, stderr: "" }, command);
	assert(error.error === "local_host_command_failed", `${command} did not emit the bounded CLI error`);
	assert(error.code === "unsafe_input", `${command} did not report the content-free unsafe-input code`);
};

const exactHostInventory = [
	"LICENSE",
	"README.md",
	"dist/application.d.ts",
	"dist/application.js",
	"dist/cli.d.ts",
	"dist/cli.js",
	"dist/index.d.ts",
	"dist/index.js",
	"dist/input.d.ts",
	"dist/input.js",
	"dist/meeting-command-input.d.ts",
	"dist/meeting-command-input.js",
	"dist/meeting-full-review-cli.d.ts",
	"dist/meeting-full-review-cli.js",
	"dist/meeting-full-review-command.d.ts",
	"dist/meeting-full-review-command.js",
	"dist/meeting-import-cli.d.ts",
	"dist/meeting-import-cli.js",
	"dist/meeting-import-command.d.ts",
	"dist/meeting-import-command.js",
	"dist/meeting-import-runtime.d.ts",
	"dist/meeting-import-runtime.js",
	"dist/meeting-review-cli.d.ts",
	"dist/meeting-review-cli.js",
	"dist/meeting-review-open-cli.d.ts",
	"dist/meeting-review-open-cli.js",
	"dist/meeting-review-command.d.ts",
	"dist/meeting-review-command.js",
	"dist/meeting-review-runtime.d.ts",
	"dist/meeting-review-runtime.js",
	"dist/meeting-runtime.d.ts",
	"dist/meeting-runtime.js",
	"dist/meeting-smoke-cli.d.ts",
	"dist/meeting-smoke-cli.js",
	"dist/meeting-smoke-command.d.ts",
	"dist/meeting-smoke-command.js",
	"dist/meeting-worker-cli.d.ts",
	"dist/meeting-worker-cli.js",
	"dist/meeting-worker-command.d.ts",
	"dist/meeting-worker-command.js",
	"dist/schema.d.ts",
	"dist/schema.js",
	"package.json",
].sort();

try {
	makePrivateDirectory(tarballRoot);
	makePrivateDirectory(protectedRoot);
	makePrivateDirectory(join(protectedRoot, "notes"));
	const sourcePath = join(protectedRoot, "notes");
	const statePath = join(protectedRoot, "state");
	const configPath = join(protectedRoot, "config.json");
	const futureActivationReceiptPath = join(protectedRoot, "future-activation-receipt.json");
	writeFileSync(
		join(sourcePath, "meeting.md"),
		"# Weekly Sync\n\n## Metadata\n- Project: alpha\n- Date: 2026-09-03\n- Fingerprint: weekly-sync\n\n## Executive Summary\nRead-only packed fixture.\n\n## Meeting Purpose\nV1 remains the sole writer.\n",
		{ mode: 0o640 },
	);
	writeFileSync(
		configPath,
		`${JSON.stringify({
			enabled: true,
			project: "alpha",
			sourcePath,
			statePath,
			backfillDays: 365,
			cutoverDate: "2026-01-01",
			maxFileBytes: 32_000,
			maxFiles: 100,
			leaseSeconds: 60,
			reminderSeconds: 3_600,
			reviewHost: "127.0.0.1",
			reviewPort: 0,
			reviewSessionSeconds: 900,
			reviewMaxSessions: 64,
			reviewMaxBodyBytes: 4_096,
			googleOwnerEmail: "owner@example.test",
			googleDriveFolder: "folder-id",
			discordChannelId: "channel-id",
		})}\n`,
		{ mode: 0o600 },
	);

	const hostPack = pack(packageRoot);
	const corePack = pack(coreRoot);
	const packedPaths = hostPack.files.map((file) => file.path).sort();
	assert(
		JSON.stringify(packedPaths) === JSON.stringify(exactHostInventory),
		`Packed local-host inventory drifted: ${JSON.stringify(packedPaths)}`,
	);
	assert(!packedPaths.some((path) => path.endsWith(".map")), "Packed local-host leaked source maps");
	const packedCli = hostPack.files.find((file) => file.path === "dist/cli.js");
	assert(packedCli?.mode === 0o755, `Packed CLI mode is ${String(packedCli?.mode)}, expected 0755`);

	const installedHostRoot = join(consumerRoot, "node_modules", "@harnessy", "local-host");
	const installedCoreRoot = join(consumerRoot, "node_modules", "@harnessy", "core");
	extract(hostPack.tarball, installedHostRoot);
	extract(corePack.tarball, installedCoreRoot);
	makePrivateDirectory(join(installedHostRoot, "dist"));
	copyRuntimePackage("effect");
	copyRuntimePackage("marked");
	assert(!lstatSync(installedHostRoot).isSymbolicLink(), "Extracted local host must not resolve to workspace source");
	assert(!lstatSync(installedCoreRoot).isSymbolicLink(), "Extracted Core must not resolve to workspace source");

	const manifest = JSON.parse(readFileSync(join(installedHostRoot, "package.json"), "utf8"));
	assert(manifest.private === true, "Packed local host must remain private");
	assert(manifest.bin?.["harnessy-local-host"] === "dist/cli.js", "Packed local-host bin target drifted");
	assert(
		manifest.bin?.["harnessy-meeting-full-review"] === "dist/meeting-full-review-cli.js",
		"Packed full-review bin target drifted",
	);
	assert(manifest.bin?.["harnessy-meeting-import"] === "dist/meeting-import-cli.js", "Packed import bin target drifted");
	assert(manifest.bin?.["harnessy-meeting-smoke"] === "dist/meeting-smoke-cli.js", "Packed smoke bin target drifted");
	assert(manifest.bin?.["harnessy-meeting-worker"] === "dist/meeting-worker-cli.js", "Packed worker bin target drifted");
	assert(manifest.bin?.["harnessy-meeting-review"] === "dist/meeting-review-cli.js", "Packed review bin target drifted");
	assert(
		manifest.bin?.["harnessy-meeting-review-open"] === "dist/meeting-review-open-cli.js",
		"Packed review-open bin target drifted",
	);
	assert(
		JSON.stringify(manifest.dependencies) ===
			JSON.stringify({ "@harnessy/core": "0.0.3", "@harnessy/sdk": "0.0.3", effect: "4.0.0-beta.85" }),
		"Packed local-host runtime dependencies are not the Core/SDK/Effect cohort",
	);
	assert(
		manifest.exports?.["./meeting-runtime"]?.import === "./dist/meeting-runtime.js",
		"Guarded programmatic runtime must have its own explicit export",
	);
	assert(
		manifest.exports?.["./meeting-import-runtime"]?.import === "./dist/meeting-import-runtime.js",
		"Offline import runtime must have its own explicit export",
	);
	const cliPath = join(installedHostRoot, manifest.bin["harnessy-local-host"]);
	assert((statSync(cliPath).mode & 0o111) !== 0, "Extracted CLI is not executable");
	const effectManifest = JSON.parse(readFileSync(join(consumerRoot, "node_modules", "effect", "package.json"), "utf8"));
	assert(effectManifest.version === "4.0.0-beta.85", "Extracted fixture Effect cohort drifted");

	// Prepare one isolated backup from the preserved Python V1 schema, then exercise the actual packed
	// importer before the SDK or any provider composition is installed.
	assert(!existsSync(join(consumerRoot, "node_modules/@harnessy/sdk")), "Importer fixture must run without SDK installed");
	const importRoot = join(fixtureRoot, "offline-import");
	const importBackupRoot = join(importRoot, "backup");
	const importSnapshotRoot = join(importRoot, "source-snapshot");
	const importOutputRoot = join(importRoot, "output");
	const attestedV1SourceRoot = join(importRoot, "attested-v1-source");
	const attestedV1StatePath = join(importRoot, "attested-v1-state");
	for (const path of [importRoot, importBackupRoot, importSnapshotRoot, importOutputRoot]) {
		makePrivateDirectory(path);
	}
	const relativeNotePath = join("team", "meeting.md");
	makePrivateDirectory(join(importSnapshotRoot, "team"));
	const snapshotNotePath = join(importSnapshotRoot, relativeNotePath);
	const attestedNotePath = join(attestedV1SourceRoot, relativeNotePath);
	const importMarkdown =
		"# Import Fixture\n\n## Metadata\n- Project: alpha\n- Date: 2026-09-04\n- Fingerprint: packed-import\n\n## Executive Summary\nPrepare this offline snapshot only.\n\n## Meeting Purpose\nVerify the packed importer.\n";
	writeFileSync(snapshotNotePath, importMarkdown, { mode: 0o600 });
	const importSourceHash = createHash("sha256").update(importMarkdown).digest("hex");
	const importItemId = createHash("sha256").update("alpha:packed-import").digest("hex").slice(0, 24);
	const importBackupPath = join(importBackupRoot, "queue.sqlite3");
	const preservedV1StorePath = join(
		repoRoot,
		"packages/capability-harnessy-v1-full/resources/jarvis-cli/src/jarvis/meetings/publication/store.py",
	);
	const preservedV1Schema = /\n_SCHEMA = """\n([\s\S]*?)\n"""/u.exec(
		readFileSync(preservedV1StorePath, "utf8"),
	)?.[1];
	assert(preservedV1Schema !== undefined, "Preserved Python V1 schema is missing");
	const v1Database = new DatabaseSync(importBackupPath, { allowExtension: false });
	try {
		v1Database.exec(preservedV1Schema);
		v1Database
			.prepare(`INSERT INTO publication_items
			(item_id,note_path,title,meeting_date,project,source_hash,approved_hash,
			discord_summary_override,status,google_doc_id,google_doc_url,discord_channel_id,
			discord_message_id,error_stage,error_message,attempts,next_attempt_at,last_notified_at,
			lease_until,created_at,updated_at,approved_at,published_at,rejected_at)
			VALUES (${Array.from({ length: 24 }, () => "?").join(",")})`)
			.run(
				importItemId,
				attestedNotePath,
				"PRIVATE IMPORT TITLE",
				"2026-09-04",
				"alpha",
				importSourceHash,
				null,
				null,
				"pending_review",
				null,
				null,
				null,
				null,
				null,
				null,
				0,
				null,
				null,
				null,
				"2026-09-05T12:00:00+00:00",
				"2026-09-05T12:00:00+00:00",
				null,
				null,
				null,
			);
	} finally {
		v1Database.close();
	}
	if (process.platform !== "win32") chmodSync(importBackupPath, 0o400);
	const importInputsBefore = JSON.stringify([treeSnapshot(importBackupRoot), treeSnapshot(importSnapshotRoot)]);
	const importCliPath = join(installedHostRoot, manifest.bin["harnessy-meeting-import"]);
	assert((statSync(importCliPath).mode & 0o777) === 0o755, "Packed import CLI is not executable");
	const imported = parseSingleJson(
		run(
			process.execPath,
			[
				importCliPath,
				"--backup",
				importBackupPath,
				"--backup-sha256",
				sha256(importBackupPath),
				"--source-snapshot",
				importSnapshotRoot,
				"--v1-source",
				attestedV1SourceRoot,
				"--project",
				"alpha",
				"--v1-state",
				attestedV1StatePath,
				"--output-directory",
				importOutputRoot,
			],
			consumerRoot,
		),
		"offline-import",
	);
	assert(
		JSON.stringify(Object.keys(imported).sort()) ===
			JSON.stringify(["items", "kind", "operationalEvidence", "sha256"]),
		"Packed importer returned an expanded result",
	);
	assert(
		imported.kind === "harnessy.meeting-publication.import-prepared" &&
			imported.items === 1 &&
			imported.operationalEvidence === false,
		"Packed importer did not prepare exactly one inert item",
	);
	const importedCandidatePath = join(importOutputRoot, "meeting-publication.sqlite3");
	assert(
		JSON.stringify(readdirSync(importOutputRoot)) === JSON.stringify(["meeting-publication.sqlite3"]),
		"Packed importer created more than its single inert candidate",
	);
	assert(sha256(importedCandidatePath) === imported.sha256, "Packed importer returned the wrong candidate digest");
	assert((statSync(importedCandidatePath).mode & 0o777) === 0o600, "Prepared candidate is not private");
	const importedDatabase = new DatabaseSync(importedCandidatePath, { readOnly: true });
	try {
		const item = importedDatabase
			.prepare("SELECT item_id,note_path,project,source_hash,status FROM publication_items")
			.get();
		assert(
			item?.item_id === importItemId &&
				item.note_path === attestedNotePath &&
				item.project === "alpha" &&
				item.source_hash === importSourceHash &&
				item.status === "pending_review",
			"Packed importer did not preserve the exact V1 item/revision projection",
		);
	} finally {
		importedDatabase.close();
	}
	assert(
		!readFileSync(importedCandidatePath).toString("latin1").includes("PRIVATE IMPORT TITLE"),
		"Packed importer retained private V1 title bytes",
	);
	assert(
		JSON.stringify([treeSnapshot(importBackupRoot), treeSnapshot(importSnapshotRoot)]) === importInputsBefore,
		"Packed importer changed its offline backup or source snapshot",
	);
	assert(!existsSync(attestedV1SourceRoot), "Packed importer opened or created the attested original source root");
	assert(!existsSync(attestedV1StatePath), "Packed importer opened or created the attested V1 state root");

	const nowArgs = ["--config", configPath, "--now-ms", "1788523200000", "--since-days", "365"];
	if (process.platform !== "win32") {
		withTemporaryMode(configPath, 0o644, () =>
			assertRejectedInput(
				run(process.execPath, [cliPath, "status", ...nowArgs], consumerRoot, 1),
				"group-readable-config",
			),
		);

		withTemporaryMode(sourcePath, 0o770, () =>
			assertRejectedInput(
				run(process.execPath, [cliPath, "scan-dry", ...nowArgs], consumerRoot, 1),
				"group-writable-source",
			),
		);

		withTemporaryMode(cliPath, 0o775, () =>
			assertRejectedInput(
				run(
					process.execPath,
					[
						cliPath,
						"export",
						...nowArgs,
						"--host-executable",
						cliPath,
						"--future-activation-receipt",
						futureActivationReceiptPath,
						"--working-directory",
						protectedRoot,
					],
					consumerRoot,
					1,
				),
				"group-writable-host-artifact",
			),
		);
	}
	assert((statSync(configPath).mode & 0o777) === 0o600, "Config mode was not restored after negative checks");
	assert((statSync(sourcePath).mode & 0o777) === 0o700, "Source mode was not restored after negative checks");
	assert((statSync(cliPath).mode & 0o777) === 0o755, "Host mode was not restored after negative checks");
	assert(!existsSync(statePath), "Rejected inputs created the state directory");
	assert(!existsSync(futureActivationReceiptPath), "Rejected inputs created the future activation receipt");

	const before = treeSnapshot(protectedRoot);
	const status = parseSingleJson(run(process.execPath, [cliPath, "status", ...nowArgs], consumerRoot), "status");
	assert(status.activated === false && status.writeAllowed === false, "Built status did not fail closed");
	const inspection = parseSingleJson(
		run(process.execPath, [cliPath, "inspect", ...nowArgs], consumerRoot),
		"inspect",
	);
	assert(inspection.activated === false && inspection.validation.ready === false, "Built inspect did not fail closed");
	const scan = parseSingleJson(run(process.execPath, [cliPath, "scan-dry", ...nowArgs], consumerRoot), "scan-dry");
	assert(scan.dryRun === true && scan.created === 0 && scan.changed === 0, "Built scan-dry reported mutation");
	const preflight = parseSingleJson(
		run(process.execPath, [cliPath, "offline-preflight", ...nowArgs], consumerRoot),
		"offline-preflight",
	);
	assert(preflight.ready === false, "Built offline-preflight did not preserve V1 ownership");
	const exported = run(
		process.execPath,
		[
			cliPath,
			"export",
			...nowArgs,
			"--host-executable",
			cliPath,
			"--future-activation-receipt",
			futureActivationReceiptPath,
			"--working-directory",
			protectedRoot,
		],
		consumerRoot,
	);
	const envelope = parseSingleJson(exported, "export");
	assert(envelope.receipt.activated === false, "Built export emitted an active receipt");
	assert(envelope.receipt.binding.configPath === configPath, "Receipt config binding drifted");
	assert(envelope.receipt.binding.hostExecutablePath === cliPath, "Receipt executable binding drifted");
	assert(JSON.stringify(treeSnapshot(protectedRoot)) === JSON.stringify(before), "Read-only commands changed inputs");
	assert(!existsSync(statePath), "Read-only commands created the state directory");
	assert(!existsSync(futureActivationReceiptPath), "Export created the future activation receipt");

	const receiptPath = join(fixtureRoot, "planning-receipt.json");
	writeFileSync(receiptPath, exported.stdout, { mode: 0o600 });
	const verification = parseSingleJson(
		run(process.execPath, [cliPath, "verify", "--receipt", receiptPath], consumerRoot),
		"verify",
	);
	assert(verification.valid === true && verification.activated === false, "Built verify did not fail closed");
	if (process.platform !== "win32") {
		withTemporaryMode(receiptPath, 0o644, () =>
			assertRejectedInput(
				run(process.execPath, [cliPath, "verify", "--receipt", receiptPath], consumerRoot, 1),
				"group-readable-receipt",
			),
		);
		const restoredVerification = parseSingleJson(
			run(process.execPath, [cliPath, "verify", "--receipt", receiptPath], consumerRoot),
			"restored-receipt",
		);
		assert(
			restoredVerification.receiptSha256 === verification.receiptSha256,
			"Receipt verification changed after its private mode was restored",
		);
	}

	for (const verb of ["activate", "install", "enable", "start", "run", "worker", "serve", "review-serve", "publish"]) {
		const rejected = run(process.execPath, [cliPath, verb], consumerRoot, 1);
		assert(rejected.stdout === "", `${verb} wrote stdout`);
		const error = parseSingleJson({ ...rejected, stdout: rejected.stderr, stderr: "" }, verb);
		assert(error.code === "invalid_command", `${verb} was not rejected as an unknown command`);
	}

	// The state-only consumer also runs with no SDK or provider installation.
	const reviewCliPath = join(installedHostRoot, manifest.bin["harnessy-meeting-review"]);
	assert((statSync(reviewCliPath).mode & 0o777) === 0o755, "Packed review CLI is not executable");
	for (const args of [[], ["--receipt", "must-not-leak"], ["--authorization", "relative"]]) {
		const rejected = run(process.execPath, [reviewCliPath, ...args], consumerRoot, 1);
		assert(rejected.stdout === "" && rejected.stderr === '{"error":"meeting_review_failed","code":"invalid_arguments"}\n',
			"Review argv rejection was not content-free");
	}
	const reviewed = parseSingleJson(run(process.execPath, [
		join(packageRoot, "test/support/packed-meeting-review.mjs"),
		consumerRoot, join(fixtureRoot, "review-fixture-inputs"),
	], consumerRoot), "runtime-authorized-review");
	assert(reviewed.approved === true && reviewed.sourceUnchanged === true && reviewed.v1Unchanged === true && reviewed.sdkInstalled === false,
		"Packed state-only review did not preserve its boundary");
	assert(reviewed.cliSignal === "SIGTERM" && reviewed.exitCode === 143,
		"Packed review CLI did not verify signal cleanup");
	assert(JSON.stringify(treeSnapshot(protectedRoot)) === JSON.stringify(before), "Review changed planning inputs");

	// All planning and review commands above ran without the SDK installed. Loading the
	// operational export is explicit and still must reject absent authorization.
	const sdkPack = pack(sdkRoot);
	extract(sdkPack.tarball, join(consumerRoot, "node_modules", "@harnessy", "sdk"));
	copyRuntimePackage("@libsql/client");
	copyRuntimePackage("drizzle-orm");
	const smokeCliPath = join(installedHostRoot, manifest.bin["harnessy-meeting-smoke"]);
	assert((statSync(smokeCliPath).mode & 0o777) === 0o755, "Packed smoke CLI is not executable");
	const workerCliPath = join(installedHostRoot, manifest.bin["harnessy-meeting-worker"]);
	assert((statSync(workerCliPath).mode & 0o777) === 0o755, "Packed worker CLI is not executable");
	const fullReviewCliPath = join(installedHostRoot, manifest.bin["harnessy-meeting-full-review"]);
	const reviewOpenCliPath = join(installedHostRoot, manifest.bin["harnessy-meeting-review-open"]);
	assert((statSync(fullReviewCliPath).mode & 0o777) === 0o755, "Packed full-review CLI is not executable");
	assert((statSync(reviewOpenCliPath).mode & 0o777) === 0o755, "Packed review-open CLI is not executable");
	const reviewOpenRejected = run(process.execPath, [reviewOpenCliPath], consumerRoot, 1);
	assert(reviewOpenRejected.stdout === "" && reviewOpenRejected.stderr === '{"error":"meeting_review_open_failed"}\n', "Review-open argv rejection was not content-free");
	const smokeArgs = ["--authorization", join(protectedRoot, "missing-auth.json"), "--trusted-keyring", join(protectedRoot, "missing-trust.json"), "--trusted-keyring-device", "0", "--trusted-keyring-inode", "0", "--trusted-keyring-sha256", "0".repeat(64)];
	for (const args of [[], ["--receipt", "must-not-leak"], smokeArgs.slice(0, -2), [...smokeArgs, "--activate", "true"], [...smokeArgs.slice(0, 9), "must-not-leak"], ["--authorization", ...smokeArgs.slice(1, 2), "--authorization", ...smokeArgs.slice(3)]]) {
		const result = run(process.execPath, [smokeCliPath, ...args], consumerRoot, 1);
		assert(result.stdout === "", "Rejected smoke arguments wrote stdout");
		assert(result.stderr === '{"error":"meeting_smoke_failed","code":"invalid_arguments"}\n', "Smoke argv rejection was not content-free");
	}
	for (const args of [[], ["--receipt", "must-not-leak"], smokeArgs.slice(0, -2), [...smokeArgs, "--activate", "true"], [...smokeArgs.slice(0, 9), "must-not-leak"]]) {
		const result = run(process.execPath, [workerCliPath, ...args], consumerRoot, 1);
		assert(result.stdout === "", "Rejected worker arguments wrote stdout");
		assert(result.stderr === '{"error":"meeting_worker_failed","code":"invalid_arguments"}\n', "Worker argv rejection was not content-free");
	}
	for (const args of [[], ["--receipt", "must-not-leak"], smokeArgs.slice(0, -2), [...smokeArgs, "--activate", "true"], [...smokeArgs.slice(0, 9), "must-not-leak"]]) {
		const result = run(process.execPath, [fullReviewCliPath, ...args], consumerRoot, 1);
		assert(result.stdout === "", "Rejected full-review arguments wrote stdout");
		assert(
			result.stderr === '{"error":"meeting_full_review_failed","code":"invalid_arguments"}\n',
			"Full-review argv rejection was not content-free",
		);
	}
	const runtimeProbe = join(consumerRoot, "runtime-probe.mjs");
	writeFileSync(runtimeProbe, `
import { Effect } from "effect";
import { runLocalHostMeetingSmoke } from "@harnessy/local-host/meeting-runtime";
const result = await Effect.runPromise(Effect.result(runLocalHostMeetingSmoke({
  authorizationPath: ${JSON.stringify(join(protectedRoot, "missing-authorization.json"))},
  trustedKeyring: { path: ${JSON.stringify(join(protectedRoot, "missing-trust.json"))}, device: "0", inode: "0", sha256: "0".repeat(64) }
})));
if (result._tag !== "Failure") throw new Error("Missing authorization did not fail closed");
console.log(JSON.stringify({ denied: true }));
`, { mode: 0o600 });
	const denied = parseSingleJson(run(process.execPath, [runtimeProbe], consumerRoot), "runtime-missing-authorization");
	assert(denied.denied === true, "Packed runtime did not reject absent authorization");
	assert(JSON.stringify(treeSnapshot(protectedRoot)) === JSON.stringify(before), "Denied runtime changed inputs");
	const positive = parseSingleJson(
		run(process.execPath, [
			join(packageRoot, "test", "support", "packed-meeting-runtime-smoke.mjs"),
			consumerRoot,
			join(fixtureRoot, "authorized-fixture-inputs"),
		], consumerRoot),
		"runtime-authorized-loopback",
	);
	assert(positive.published === true && positive.providerRequests > 0, "Packed runtime did not publish through loopback providers");
	assert(
		positive.worker?.published === 1 &&
			positive.worker.remainingAfterFirst === 1 &&
			positive.worker.failed === 1 &&
			positive.worker.retryCheckpoint === true &&
			positive.worker.providerRequests > 0,
		"Packed worker did not preserve its signed batch and retry checkpoint",
	);
	assert(
		positive.fullReview?.edited === true &&
			positive.fullReview.approved === 2 &&
			positive.fullReview.published === 2 &&
			positive.fullReview.purposeBound === true &&
			positive.fullReview.boundedDispatches === 2 &&
			positive.fullReview.providerRequests > 0 &&
			positive.fullReview.leaseReleased === true,
		"Packed full review did not edit, approve, and dispatch through its installed session",
	);
	assert(JSON.stringify(treeSnapshot(protectedRoot)) === JSON.stringify(before), "Smoke runtime changed planning inputs");

	console.log(
		`Harnessy local-host packed fixture passed (${packedPaths.length} files; six read-only commands; offline import; isolated review; guarded loopback publication, bounded worker, and full review dispatch).`,
	);
} finally {
	if (process.platform !== "win32" && existsSync(fixtureRoot)) chmodSync(fixtureRoot, 0o700);
	rmSync(fixtureRoot, { recursive: true, force: true });
}
