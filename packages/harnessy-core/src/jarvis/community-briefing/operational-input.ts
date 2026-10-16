import { createPublicKey, randomBytes, verify } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
	ArtifactManifest,
	canonicalMeetingPublicationSmokeJson,
	createRuntimeArtifactManifest,
	type MeetingPublicationSmokeRuntimeInput,
	type MeetingPublicationSmokeRuntimeObservation,
	meetingPublicationDirectoryChain,
	readStableMeetingPublicationSmokeFile,
	sha256MeetingPublicationSmokeBytes,
} from "../meeting-publication/operational-input.ts";
import { snapshotCommunityBriefingProviderScope } from "./authority.ts";
import { communityBriefingGrantPayload, type SignedCommunityBriefingGrant } from "./grant-host.ts";

const Text = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter(
			(value: string) =>
				value.length >= 1 &&
				value.length <= 4096 &&
				[...value].every((character) => {
					const code = character.charCodeAt(0);
					return code > 31 && code !== 127;
				}),
		),
	),
);
const Hash = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u)));
const Identity = Schema.Struct({ path: Text, device: Text, inode: Text });
const File = Schema.Struct({ ...Identity.fields, sha256: Hash });
export const CommunityOperationalBinding = Schema.Struct({
	kind: Schema.Literals(["harnessy.community.briefing.operation.v1", "harnessy.community.briefing.service.v1"]),
	keyId: Text,
	issuedAt: Text,
	notBefore: Text,
	runtime: Schema.Struct({
		platform: Schema.Literals(["darwin", "linux"]),
		architecture: Text,
		hostname: Text,
		uid: Text,
		bootId: Schema.NullOr(Text),
		executablePath: Text,
		executableSha256: Hash,
	}),
	ledger: Identity,
	queue: Schema.Struct({ device: Text, inode: Text, sha256: Hash }),
	engine: Schema.Struct({ device: Text, inode: Text, sha256: Hash }),
	config: File,
	artifactManifest: File,
	cutoverEvidence: File,
	rollbackPlan: File,
});
export type CommunityOperationalBinding = typeof CommunityOperationalBinding.Type;

const Keyring = Schema.Struct({
	kind: Schema.Literal("harnessy.community.briefing.trust.v1"),
	keys: Schema.Array(Schema.Struct({ issuer: Text, keyId: Text, publicKeyPem: Schema.String, publicKeySha256: Hash })),
});
const UnsignedEnvelope = Schema.Struct({
	issuer: Text,
	grantId: Hash,
	queuePath: Text,
	statePath: Text,
	briefingId: Schema.NullOr(Text),
	sourceHash: Schema.NullOr(Hash),
	expiresAt: Schema.NullOr(Text),
	providerScope: Schema.Unknown,
	operational: CommunityOperationalBinding,
});
const Envelope = Schema.Struct({ ...UnsignedEnvelope.fields, signature: Text });
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
	Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const readJson = (path: string, uid: bigint, maximum = 1_000_000) => {
	const file = readStableMeetingPublicationSmokeFile(path, uid, "private", maximum);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
	const value: unknown = JSON.parse(text);
	if (`${canonicalMeetingPublicationSmokeJson(value)}\n` !== text) throw new Error("noncanonical_input");
	return { ...file, value };
};

/** Offline owner encoding; no keys, provider access or activation. */
export const encodeCommunityServiceEnrollmentRequest = (value: unknown) => {
	const raw = decode(UnsignedEnvelope, value);
	const payload = {
		...raw,
		providerScope: snapshotCommunityBriefingProviderScope(
			raw.providerScope as SignedCommunityBriefingGrant["providerScope"],
		),
	};
	if (
		payload.operational.kind !== "harnessy.community.briefing.service.v1" ||
		payload.briefingId !== null ||
		payload.sourceHash !== null ||
		payload.expiresAt !== null ||
		payload.operational.runtime.bootId !== null
	)
		throw new Error("invalid_service_request");
	const issued = Date.parse(payload.operational.issuedAt),
		start = Date.parse(payload.operational.notBefore);
	if (
		!Number.isFinite(issued) ||
		!Number.isFinite(start) ||
		issued > start ||
		new Date(issued).toISOString() !== payload.operational.issuedAt ||
		new Date(start).toISOString() !== payload.operational.notBefore
	)
		throw new Error("invalid_service_request");
	const canonical = canonicalMeetingPublicationSmokeJson(payload);
	return {
		payload,
		canonical,
		signingBytes: Buffer.from(communityBriefingGrantPayload(payload)),
		envelope: (signature: string) => `${canonicalMeetingPublicationSmokeJson({ ...payload, signature })}\n`,
	};
};

const readCommunityAuthority = (
	input: MeetingPublicationSmokeRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
) => {
	const trust = readJson(input.trustedKeyring.path, observation.uid);
	if (
		trust.identity.device !== input.trustedKeyring.device ||
		trust.identity.inode !== input.trustedKeyring.inode ||
		sha256MeetingPublicationSmokeBytes(trust.bytes) !== input.trustedKeyring.sha256
	)
		throw new Error("untrusted_keyring");
	const keyring = decode(Keyring, trust.value);
	if (
		keyring.keys.length < 1 ||
		keyring.keys.length > 32 ||
		new Set(keyring.keys.map((key) => key.keyId)).size !== keyring.keys.length
	)
		throw new Error("invalid_keyring");
	for (const key of keyring.keys) {
		const parsed = createPublicKey(key.publicKeyPem);
		if (
			parsed.asymmetricKeyType !== "ed25519" ||
			key.publicKeyPem.length > 4096 ||
			sha256MeetingPublicationSmokeBytes(parsed.export({ type: "spki", format: "der" })) !== key.publicKeySha256
		)
			throw new Error("invalid_keyring");
	}
	const authorization = readJson(input.authorizationPath, observation.uid);
	const raw = decode(Envelope, authorization.value);
	const envelope: SignedCommunityBriefingGrant & { readonly operational: CommunityOperationalBinding } = {
		...raw,
		providerScope: snapshotCommunityBriefingProviderScope(
			raw.providerScope as SignedCommunityBriefingGrant["providerScope"],
		),
	};
	const binding = envelope.operational;
	const service = binding.kind === "harnessy.community.briefing.service.v1";
	if (
		service
			? envelope.briefingId !== null ||
				envelope.sourceHash !== null ||
				envelope.expiresAt !== null ||
				binding.runtime.bootId !== null
			: envelope.briefingId === null ||
				envelope.sourceHash === null ||
				envelope.expiresAt === null ||
				binding.runtime.bootId === null
	)
		throw new Error("invalid_authority_mode");
	const key = keyring.keys.find((entry) => entry.issuer === envelope.issuer && entry.keyId === binding.keyId);
	const signature = Buffer.from(envelope.signature, "base64");
	if (
		!key ||
		signature.length !== 64 ||
		signature.toString("base64") !== envelope.signature ||
		!verify(null, Buffer.from(communityBriefingGrantPayload(envelope)), createPublicKey(key.publicKeyPem), signature)
	)
		throw new Error("invalid_signature");
	return { authorization, envelope, key, service };
};

const assertCommunityLedger = (ledger: typeof Identity.Type, uid: bigint) => {
	meetingPublicationDirectoryChain(dirname(ledger.path), uid);
	const stat = lstatSync(ledger.path, { bigint: true });
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1n ||
		stat.uid !== uid ||
		(stat.mode & 0o7777n) !== 0o600n ||
		stat.dev.toString() !== ledger.device ||
		stat.ino.toString() !== ledger.inode
	)
		throw new Error("ledger_changed");
	for (const suffix of ["-wal", "-shm", "-journal"])
		if (lstatSync(`${ledger.path}${suffix}`, { throwIfNoEntry: false })) throw new Error("ledger_sidecar");
};

/** Capture unsigned adoption bindings from existing, quiesced state. Never repairs or enrolls. */
export const prepareCommunityServiceRequest = (
	value: unknown,
	observation: MeetingPublicationSmokeRuntimeObservation,
	anchors: Readonly<Record<"core" | "host" | "sdk" | "dependencies", string>>,
	outputDirectory: string,
) => {
	const input = decode(
		Schema.Struct({
			issuer: Text,
			keyId: Text,
			queuePath: Text,
			statePath: Text,
			configPath: Text,
			installationRoot: Text,
			cutoverEvidencePath: Text,
			rollbackPlanPath: Text,
			trustedKeyring: File,
		}),
		value,
	);
	const owner = observation.uid;
	if (!isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory) throw new Error("invalid_path");
	meetingPublicationDirectoryChain(outputDirectory, owner);
	const outputStat = lstatSync(outputDirectory, { bigint: true });
	if (
		!outputStat.isDirectory() ||
		outputStat.uid !== owner ||
		(outputStat.mode & 0o7777n) !== 0o700n ||
		readdirSync(outputDirectory).length !== 0
	)
		throw new Error("unsafe_output");
	const snapshots: Array<typeof File.Type> = [];
	const bound = (path: string, role: "private" | "artifact" = "private") => {
		if (!isAbsolute(path) || resolve(path) !== path) throw new Error("invalid_path");
		const file = readStableMeetingPublicationSmokeFile(path, owner, role, 512 * 1024 * 1024);
		const binding = { ...file.identity, sha256: sha256MeetingPublicationSmokeBytes(file.bytes) };
		if (role === "private") snapshots.push(binding);
		return binding;
	};
	const trust = bound(input.trustedKeyring.path);
	if (canonicalMeetingPublicationSmokeJson(trust) !== canonicalMeetingPublicationSmokeJson(input.trustedKeyring))
		throw new Error("untrusted_keyring");
	const keyring = decode(Keyring, readJson(trust.path, owner).value);
	if (
		keyring.keys.length < 1 ||
		keyring.keys.length > 32 ||
		new Set(keyring.keys.map((key) => key.keyId)).size !== keyring.keys.length
	)
		throw new Error("invalid_keyring");
	for (const key of keyring.keys) {
		const parsed = createPublicKey(key.publicKeyPem);
		if (
			parsed.asymmetricKeyType !== "ed25519" ||
			key.publicKeyPem.length > 4096 ||
			sha256MeetingPublicationSmokeBytes(parsed.export({ type: "spki", format: "der" })) !== key.publicKeySha256
		)
			throw new Error("invalid_keyring");
	}
	if (!keyring.keys.some((key) => key.issuer === input.issuer && key.keyId === input.keyId))
		throw new Error("untrusted_issuer");
	const config = bound(input.configPath);
	const configuration = decode(
		Schema.Struct({ providerScope: Schema.Unknown, sourcePath: Text, draftPath: Text }),
		readJson(config.path, owner).value,
	);
	const providerScope = snapshotCommunityBriefingProviderScope(
		configuration.providerScope as SignedCommunityBriefingGrant["providerScope"],
	);
	const manifest = createRuntimeArtifactManifest(input.installationRoot, owner, anchors);
	for (const path of [
		input.statePath,
		configuration.sourcePath,
		configuration.draftPath,
		providerScope.credentialDirectory,
	]) {
		if (!isAbsolute(path) || resolve(path) !== path) throw new Error("invalid_path");
		meetingPublicationDirectoryChain(path, owner);
		const stat = lstatSync(path, { bigint: true });
		if (!stat.isDirectory() || stat.uid !== owner || (stat.mode & 0o7777n) !== 0o700n)
			throw new Error("unsafe_directory");
	}
	const ledger = bound(join(input.statePath, "community-grants.sqlite3"));
	assertCommunityLedger(ledger, owner);
	const queue = bound(input.queuePath),
		engine = bound(providerScope.engineStatePath);
	for (const database of [ledger, queue, engine]) {
		for (const suffix of ["-wal", "-shm", "-journal"])
			if (lstatSync(`${database.path}${suffix}`, { throwIfNoEntry: false }))
				throw new Error("database_not_quiescent");
		// Executor owns its schema. Opening a quiesced WAL database even read-only
		// can create sidecars; preparation only binds its stable main-file snapshot.
		if (database === engine) continue;
		const header = readStableMeetingPublicationSmokeFile(database.path, owner, "private", 512 * 1024 * 1024).bytes;
		if (header[18] !== 1 || header[19] !== 1) throw new Error("database_not_quiescent");
		const db = new DatabaseSync(database.path, { readOnly: true, allowExtension: false });
		try {
			if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get()) throw new Error("database_trigger");
			if (
				database === queue &&
				db
					.prepare(
						"SELECT 1 FROM community_briefings WHERE status='publishing' OR lease_until IS NOT NULL LIMIT 1",
					)
					.get()
			)
				throw new Error("queue_requires_reconciliation");
			if (database === ledger) {
				db.prepare("SELECT grant_id,payload_hash,consumed_at,revoked FROM community_briefing_grants LIMIT 1").get();
				if (
					db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='community_briefing_lease'").get() &&
					db.prepare("SELECT 1 FROM community_briefing_lease LIMIT 1").get()
				)
					throw new Error("lease_requires_reconciliation");
			}
		} finally {
			db.close();
		}
	}
	const cutoverEvidence = bound(input.cutoverEvidencePath),
		rollbackPlan = bound(input.rollbackPlanPath);
	const paths = snapshots.map((file) => file.path);
	if (new Set(paths).size !== paths.length) throw new Error("control_overlap");
	for (const path of [
		...paths,
		input.statePath,
		configuration.sourcePath,
		configuration.draftPath,
		providerScope.credentialDirectory,
		outputDirectory,
	]) {
		for (const [parent, child] of [
			[manifest.root, path],
			[path, manifest.root],
		]) {
			const rel = relative(parent!, child!);
			if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
				throw new Error("artifact_state_overlap");
		}
	}
	for (const root of [
		input.statePath,
		configuration.sourcePath,
		configuration.draftPath,
		providerScope.credentialDirectory,
		dirname(providerScope.engineStatePath),
		dirname(input.queuePath),
	]) {
		for (const [parent, child] of [
			[root, outputDirectory],
			[outputDirectory, root],
		]) {
			const rel = relative(parent!, child!);
			if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
				throw new Error("output_state_overlap");
		}
	}
	const manifestPath = join(outputDirectory, "artifact-manifest.json");
	const manifestFd = openSync(
		manifestPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(manifestFd, `${canonicalMeetingPublicationSmokeJson(manifest)}\n`);
		fsyncSync(manifestFd);
	} finally {
		closeSync(manifestFd);
	}
	const directoryFd = openSync(outputDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
	const artifactManifest = bound(manifestPath);
	const instant = new Date(observation.now).toISOString();
	const request = encodeCommunityServiceEnrollmentRequest({
		issuer: input.issuer,
		grantId: randomBytes(32).toString("hex"),
		queuePath: input.queuePath,
		statePath: input.statePath,
		briefingId: null,
		sourceHash: null,
		expiresAt: null,
		providerScope,
		operational: {
			kind: "harnessy.community.briefing.service.v1",
			keyId: input.keyId,
			issuedAt: instant,
			notBefore: instant,
			runtime: {
				platform: observation.platform,
				architecture: observation.architecture,
				hostname: observation.hostname,
				uid: String(owner),
				bootId: null,
				executablePath: observation.executablePath,
				executableSha256: bound(observation.executablePath, "artifact").sha256,
			},
			ledger: { path: ledger.path, device: ledger.device, inode: ledger.inode },
			queue: { device: queue.device, inode: queue.inode, sha256: queue.sha256 },
			engine: { device: engine.device, inode: engine.inode, sha256: engine.sha256 },
			config,
			artifactManifest,
			cutoverEvidence,
			rollbackPlan,
		},
	});
	// Re-read all private inputs after inspection; reject replacement or concurrent writes.
	for (const expected of snapshots) {
		const file = readStableMeetingPublicationSmokeFile(expected.path, owner, "private", 512 * 1024 * 1024);
		const actual = { ...file.identity, sha256: sha256MeetingPublicationSmokeBytes(file.bytes) };
		if (canonicalMeetingPublicationSmokeJson(expected) !== canonicalMeetingPublicationSmokeJson(actual))
			throw new Error("input_changed");
	}
	return { request: `${request.canonical}\n`, trustedKeyring: input.trustedKeyring };
};

/** Owner control verifies the signed identity, not publication eligibility or artifact health. */
export const readCommunityServiceEnrollment = (
	input: MeetingPublicationSmokeRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
) => {
	const { envelope, service } = readCommunityAuthority(input, observation);
	const { ledger, runtime } = envelope.operational;
	if (
		!service ||
		runtime.uid !== String(observation.uid) ||
		runtime.hostname !== observation.hostname ||
		runtime.platform !== observation.platform ||
		!isAbsolute(envelope.statePath) ||
		resolve(envelope.statePath) !== envelope.statePath ||
		ledger.path !== join(envelope.statePath, "community-grants.sqlite3")
	)
		throw new Error("invalid_service_control");
	const assertLedger = () => assertCommunityLedger(ledger, observation.uid);
	assertLedger();
	return {
		envelope,
		assertLedger,
		digest: sha256MeetingPublicationSmokeBytes(communityBriefingGrantPayload(envelope)),
	};
};

/** Source-private verification; used only by the scoped operational consumer. */
export const readCommunityOperation = (
	input: MeetingPublicationSmokeRuntimeInput,
	observation: MeetingPublicationSmokeRuntimeObservation,
) => {
	const { authorization, envelope, key, service } = readCommunityAuthority(input, observation);
	const binding = envelope.operational;
	const instant = (value: string) => {
		const result = Date.parse(value);
		if (!Number.isFinite(result) || new Date(result).toISOString() !== value) throw new Error("invalid_time");
		return result;
	};
	const issued = instant(binding.issuedAt),
		start = instant(binding.notBefore),
		expiry = service ? observation.now + 900_000 : instant(envelope.expiresAt!);
	if (
		issued > start ||
		start >= expiry ||
		(!service && expiry - issued > 900_000) ||
		observation.now < start ||
		observation.now >= expiry
	)
		throw new Error("invalid_lifetime");
	for (const [name, value] of Object.entries(binding.runtime)) {
		if (name === "executableSha256") continue;
		if (service && name === "bootId") continue;
		if (String(observation[name as keyof MeetingPublicationSmokeRuntimeObservation]) !== value)
			throw new Error("runtime_mismatch");
	}
	if (!service && !/^[a-f0-9]{24}$/u.test(envelope.briefingId!)) throw new Error("invalid_item");
	const scope = envelope.providerScope;
	if (scope.transport.mode === "production" && scope.google.authTemplate !== "google-drive-file")
		throw new Error("invalid_template");
	if (scope.transport.mode === "loopback") {
		if (scope.google.authTemplate !== "google-drive-file-test-token") throw new Error("invalid_template");
		for (const origin of [
			scope.transport.googleDriveBaseUrl,
			scope.transport.googleDocsBaseUrl,
			scope.transport.discordBaseUrl,
		]) {
			const url = new URL(origin);
			if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== origin)
				throw new Error("invalid_transport");
		}
	}
	const manifestFile = readJson(binding.artifactManifest.path, observation.uid, 32 * 1024 * 1024);
	const manifest = decode(ArtifactManifest, manifestFile.value);
	const immutable = [
		{ ...input.trustedKeyring },
		{ ...authorization.identity, sha256: sha256MeetingPublicationSmokeBytes(authorization.bytes) },
		binding.config,
		binding.artifactManifest,
		binding.cutoverEvidence,
		binding.rollbackPlan,
	];
	const paths = [
		envelope.queuePath,
		scope.engineStatePath,
		binding.ledger.path,
		...immutable.map((file) => file.path),
	];
	if (
		new Set(paths).size !== paths.length ||
		binding.ledger.path !== join(envelope.statePath, "community-grants.sqlite3")
	)
		throw new Error("control_overlap");
	const within = (root: string, path: string) => {
		const rel = relative(root, path);
		return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
	};
	for (const path of [...paths, envelope.statePath, scope.credentialDirectory]) {
		if (!isAbsolute(path) || resolve(path) !== path || within(manifest.root, path) || within(path, manifest.root))
			throw new Error("artifact_state_overlap");
	}
	const checkFile = (
		file: { readonly path: string; readonly device?: string; readonly inode?: string; readonly sha256: string },
		role: "private" | "artifact" = "private",
	) => {
		const current = readStableMeetingPublicationSmokeFile(file.path, observation.uid, role, 512 * 1024 * 1024);
		if (
			(file.device !== undefined && current.identity.device !== file.device) ||
			(file.inode !== undefined && current.identity.inode !== file.inode) ||
			sha256MeetingPublicationSmokeBytes(current.bytes) !== file.sha256
		)
			throw new Error("file_changed");
	};
	for (const file of immutable) checkFile(file);
	checkFile({ path: binding.runtime.executablePath, sha256: binding.runtime.executableSha256 }, "artifact");
	const mutableFiles = [
		{ path: envelope.queuePath, ...binding.queue },
		{ path: scope.engineStatePath, ...binding.engine },
	];
	const assertMutable = (initial = false) => {
		for (const expected of mutableFiles) {
			meetingPublicationDirectoryChain(dirname(expected.path), observation.uid);
			const stat = lstatSync(expected.path, { bigint: true });
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1n ||
				stat.uid !== observation.uid ||
				(stat.mode & 0o7777n) !== 0o600n ||
				stat.dev.toString() !== expected.device ||
				stat.ino.toString() !== expected.inode
			)
				throw new Error("database_identity_changed");
			for (const suffix of ["-wal", "-shm", "-journal"]) {
				const sidecar = lstatSync(`${expected.path}${suffix}`, { bigint: true, throwIfNoEntry: false });
				if (sidecar === undefined) continue;
				if (
					initial ||
					!sidecar.isFile() ||
					sidecar.isSymbolicLink() ||
					sidecar.nlink !== 1n ||
					sidecar.uid !== observation.uid ||
					(sidecar.mode & 0o7777n) !== 0o600n
				)
					throw new Error("unsafe_database_sidecar");
			}
		}
	};
	const assertLedger = () => assertCommunityLedger(binding.ledger, observation.uid);
	assertLedger();
	let enrolled = false;
	if (service) {
		const ledger = new DatabaseSync(binding.ledger.path, { readOnly: true, allowExtension: false });
		try {
			if (ledger.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger'").get())
				throw new Error("ledger_trigger");
			const row = ledger
				.prepare("SELECT payload_hash,consumed_at,revoked FROM community_briefing_grants WHERE grant_id=?")
				.get(envelope.grantId);
			if (row !== undefined) {
				if (
					row.revoked !== 0 ||
					typeof row.consumed_at !== "string" ||
					row.payload_hash !== sha256MeetingPublicationSmokeBytes(communityBriefingGrantPayload(envelope))
				)
					throw new Error("service_revoked_or_changed");
				enrolled = true;
			}
		} finally {
			ledger.close();
		}
	}
	if (!enrolled) {
		checkFile({ path: envelope.queuePath, ...binding.queue });
		checkFile({ path: scope.engineStatePath, ...binding.engine });
	}
	assertMutable(!enrolled);
	return {
		envelope,
		service,
		manifest,
		expiry,
		assertLedger,
		assertMutable,
		keys: new Map([[envelope.issuer, key.publicKeyPem]]),
		assertImmutable: () => {
			for (const file of immutable) checkFile(file);
			checkFile({ path: binding.runtime.executablePath, sha256: binding.runtime.executableSha256 }, "artifact");
			assertLedger();
		},
	};
};
