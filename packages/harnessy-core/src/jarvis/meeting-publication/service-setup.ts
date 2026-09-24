import { createPublicKey, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
	canonicalMeetingPublicationSmokeJson,
	MEETING_PUBLICATION_SERVICE_AUDIENCE,
	meetingPublicationDirectoryChain,
	prepareMeetingPublicationServiceTrustAdoption,
	readStableMeetingPublicationSmokeFile,
	sha256MeetingPublicationSmokeBytes,
} from "./operational-input.ts";
import { MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL } from "./operational-runtime.ts";
import { MEETING_PUBLICATION_STORE_SCHEMA_SQL } from "./store-schema.ts";

/** First installation only. Never resets existing queue, trust, leases or replay history. */
export const provisionMeetingPublicationService = (value: unknown) => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_input");
	const input = value as Record<string, unknown>;
	if (
		input.kind === "harnessy.meeting-publication.service-adoption.v1" ||
		input.kind === "harnessy.meeting-publication.service-remount-adoption.v2"
	) {
		const prepared = prepareMeetingPublicationServiceTrustAdoption(input);
		return writeServiceTrust(prepared.controlDirectory, prepared.trust);
	}
	const fields = ["kind", "stateDirectory", "controlDirectory", "publicKeyPath", "publicKeySha256", "issuer", "keyId"];
	if (Object.keys(input).length !== fields.length || fields.some((key) => typeof input[key] !== "string"))
		throw new Error("invalid_input");
	if (input.kind !== "harnessy.meeting-publication.service-setup.v1") throw new Error("invalid_input");
	const state = input.stateDirectory as string;
	const control = input.controlDirectory as string;
	const publicKeyPath = input.publicKeyPath as string;
	const fingerprint = input.publicKeySha256 as string;
	for (const key of [input.issuer as string, input.keyId as string])
		if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(key)) throw new Error("invalid_input");
	if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("invalid_input");
	const uid = process.geteuid?.();
	if (uid === undefined || !["darwin", "linux"].includes(process.platform)) throw new Error("unsupported_platform");
	for (const directory of [state, control]) {
		if (!isAbsolute(directory) || resolve(directory) !== directory || realpathSync(directory) !== directory)
			throw new Error("unsafe_directory");
		meetingPublicationDirectoryChain(directory, BigInt(uid));
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700 || readdirSync(directory).length)
			throw new Error("directory_not_empty_or_private");
	}
	for (const [parent, child] of [
		[state, control],
		[control, state],
	] as const) {
		const path = relative(parent, child);
		if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)))
			throw new Error("overlapping_directories");
	}
	const file = readStableMeetingPublicationSmokeFile(publicKeyPath, BigInt(uid), "private", 16_384);
	const pem = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
	if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(pem))
		throw new Error("public_key_required");
	const publicKey = createPublicKey(pem);
	if (
		publicKey.asymmetricKeyType !== "ed25519" ||
		sha256MeetingPublicationSmokeBytes(publicKey.export({ type: "spki", format: "der" })) !== fingerprint
	)
		throw new Error("key_mismatch");
	const instanceId = randomBytes(32).toString("hex");
	const replayPath = join(control, "service-replay.sqlite3");
	const queuePath = join(state, "meeting-publication.sqlite3");
	// Reserve before SQLite opens. Failures intentionally preserve partial state;
	// the next invocation must not guess whether it is safe to reset or reuse it.
	for (const path of [queuePath, replayPath]) {
		const fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		closeSync(fd);
		const db = new DatabaseSync(path, { allowExtension: false });
		try {
			db.exec(
				path === queuePath ? MEETING_PUBLICATION_STORE_SCHEMA_SQL : MEETING_PUBLICATION_SMOKE_REPLAY_SCHEMA_SQL,
			);
			if (path === replayPath) db.prepare("INSERT INTO runtime_metadata VALUES (1,?,0)").run(instanceId);
		} finally {
			db.close();
		}
	}
	const replay = lstatSync(replayPath, { bigint: true });
	const trust = {
		kind: "harnessy.meeting-publication.service-trust",
		schemaVersion: 1,
		audience: MEETING_PUBLICATION_SERVICE_AUDIENCE,
		keys: [{ issuer: input.issuer, keyId: input.keyId, publicKeyPem: pem, publicKeySha256: fingerprint }],
		replay: { path: replayPath, device: replay.dev.toString(), inode: replay.ino.toString(), instanceId },
	};
	return writeServiceTrust(control, trust, [state, control]);
};

const writeServiceTrust = (control: string, trust: unknown, directories: readonly string[] = [control]) => {
	const trustPath = join(control, "service-trust.json");
	const bytes = `${canonicalMeetingPublicationSmokeJson(trust)}\n`;
	const fd = openSync(
		trustPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	for (const directory of directories) {
		const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	}
	const pinned = lstatSync(trustPath, { bigint: true });
	return {
		kind: "harnessy.meeting-publication.service-provisioned",
		activated: false,
		trustedKeyring: {
			path: trustPath,
			device: pinned.dev.toString(),
			inode: pinned.ino.toString(),
			sha256: sha256MeetingPublicationSmokeBytes(bytes),
		},
	} as const;
};
