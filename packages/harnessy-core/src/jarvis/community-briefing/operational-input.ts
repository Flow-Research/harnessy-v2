import { createPublicKey, verify } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Schema } from "effect";
import {
	ArtifactManifest,
	canonicalMeetingPublicationSmokeJson,
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
	kind: Schema.Literal("harnessy.community.briefing.operation.v1"),
	keyId: Text,
	issuedAt: Text,
	notBefore: Text,
	runtime: Schema.Struct({
		platform: Schema.Literals(["darwin", "linux"]),
		architecture: Text,
		hostname: Text,
		uid: Text,
		bootId: Text,
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
const Envelope = Schema.Struct({
	issuer: Text,
	grantId: Hash,
	queuePath: Text,
	statePath: Text,
	briefingId: Text,
	sourceHash: Hash,
	expiresAt: Text,
	providerScope: Schema.Unknown,
	operational: CommunityOperationalBinding,
	signature: Text,
});
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
	Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

const readJson = (path: string, uid: bigint, maximum = 1_000_000) => {
	const file = readStableMeetingPublicationSmokeFile(path, uid, "private", maximum);
	const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
	const value: unknown = JSON.parse(text);
	if (`${canonicalMeetingPublicationSmokeJson(value)}\n` !== text) throw new Error("noncanonical_input");
	return { ...file, value };
};

/** Source-private verification; used only by the scoped operational consumer. */
export const readCommunityOperation = (
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
	const key = keyring.keys.find((entry) => entry.issuer === envelope.issuer && entry.keyId === binding.keyId);
	const signature = Buffer.from(envelope.signature, "base64");
	if (
		!key ||
		signature.length !== 64 ||
		signature.toString("base64") !== envelope.signature ||
		!verify(null, Buffer.from(communityBriefingGrantPayload(envelope)), createPublicKey(key.publicKeyPem), signature)
	)
		throw new Error("invalid_signature");
	const instant = (value: string) => {
		const result = Date.parse(value);
		if (!Number.isFinite(result) || new Date(result).toISOString() !== value) throw new Error("invalid_time");
		return result;
	};
	const issued = instant(binding.issuedAt),
		start = instant(binding.notBefore),
		expiry = instant(envelope.expiresAt);
	if (
		issued > start ||
		start >= expiry ||
		expiry - issued > 900_000 ||
		observation.now < start ||
		observation.now >= expiry
	)
		throw new Error("invalid_lifetime");
	for (const [name, value] of Object.entries(binding.runtime)) {
		if (name === "executableSha256") continue;
		if (String(observation[name as keyof MeetingPublicationSmokeRuntimeObservation]) !== value)
			throw new Error("runtime_mismatch");
	}
	if (!/^[a-f0-9]{24}$/u.test(envelope.briefingId)) throw new Error("invalid_item");
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
	checkFile({ path: envelope.queuePath, ...binding.queue });
	checkFile({ path: scope.engineStatePath, ...binding.engine });
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
	assertMutable(true);
	const assertLedger = () => {
		meetingPublicationDirectoryChain(dirname(binding.ledger.path), observation.uid);
		const stat = lstatSync(binding.ledger.path, { bigint: true });
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1n ||
			stat.uid !== observation.uid ||
			(stat.mode & 0o7777n) !== 0o600n ||
			stat.dev.toString() !== binding.ledger.device ||
			stat.ino.toString() !== binding.ledger.inode
		)
			throw new Error("ledger_changed");
		for (const suffix of ["-wal", "-shm", "-journal"])
			if (lstatSync(`${binding.ledger.path}${suffix}`, { throwIfNoEntry: false })) throw new Error("ledger_sidecar");
	};
	assertLedger();
	return {
		envelope,
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
