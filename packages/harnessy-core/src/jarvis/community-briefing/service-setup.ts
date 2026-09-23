import { createPublicKey } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
	canonicalMeetingPublicationSmokeJson,
	meetingPublicationDirectoryChain,
	readStableMeetingPublicationSmokeFile,
	sha256MeetingPublicationSmokeBytes,
} from "../meeting-publication/operational-input.ts";
import { COMMUNITY_BRIEFING_GRANT_SCHEMA_SQL } from "./grant-host.ts";

/** First authority setup only. Queue creation belongs to the existing draft/review store. */
export const provisionCommunityPublicationService = (value: unknown) => {
	const input = Schema.decodeUnknownSync(
		Schema.Struct({
			kind: Schema.Literal("harnessy.community.briefing.service-setup.v1"),
			stateDirectory: Schema.String,
			controlDirectory: Schema.String,
			publicKeyPath: Schema.String,
			publicKeySha256: Schema.String,
			issuer: Schema.String,
			keyId: Schema.String,
		}),
		{ onExcessProperty: "error" },
	)(value);
	const uid = process.geteuid?.();
	if (uid === undefined || !["darwin", "linux"].includes(process.platform)) throw new Error("unsupported_platform");
	const owner = BigInt(uid);
	for (const name of [input.issuer, input.keyId])
		if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(name)) throw new Error("invalid_input");
	if (!/^[a-f0-9]{64}$/u.test(input.publicKeySha256)) throw new Error("invalid_input");
	for (const directory of [input.stateDirectory, input.controlDirectory]) {
		if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error("unsafe_directory");
		meetingPublicationDirectoryChain(directory, owner);
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700)
			throw new Error("unsafe_directory");
	}
	if (readdirSync(input.controlDirectory).length !== 0) throw new Error("existing_control_state");
	for (const [parent, child] of [
		[input.stateDirectory, input.controlDirectory],
		[input.controlDirectory, input.stateDirectory],
	]) {
		const rel = relative(parent!, child!);
		if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)))
			throw new Error("overlapping_directories");
	}
	const ledgerPath = join(input.stateDirectory, "community-grants.sqlite3");
	for (const suffix of ["", "-wal", "-shm", "-journal"])
		if (lstatSync(`${ledgerPath}${suffix}`, { throwIfNoEntry: false })) throw new Error("existing_authority_state");
	const publicFile = readStableMeetingPublicationSmokeFile(input.publicKeyPath, owner, "private", 16_384);
	const pem = new TextDecoder("utf-8", { fatal: true }).decode(publicFile.bytes);
	if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\s*$/u.test(pem))
		throw new Error("public_key_required");
	const publicKey = createPublicKey(pem);
	if (
		publicKey.asymmetricKeyType !== "ed25519" ||
		sha256MeetingPublicationSmokeBytes(publicKey.export({ type: "spki", format: "der" })) !== input.publicKeySha256
	)
		throw new Error("key_mismatch");
	// Reserve exclusively. Any partial failure remains for inspection, never reset or retried.
	const reserved = openSync(
		ledgerPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	closeSync(reserved);
	const database = new DatabaseSync(ledgerPath, { allowExtension: false });
	try {
		database.exec(COMMUNITY_BRIEFING_GRANT_SCHEMA_SQL);
	} finally {
		database.close();
	}
	const trustPath = join(input.controlDirectory, "community-trust.json");
	const trustBytes = `${canonicalMeetingPublicationSmokeJson({
		kind: "harnessy.community.briefing.trust.v1",
		keys: [{ issuer: input.issuer, keyId: input.keyId, publicKeyPem: pem, publicKeySha256: input.publicKeySha256 }],
	})}\n`;
	const fd = openSync(
		trustPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, trustBytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	for (const directory of [input.stateDirectory, input.controlDirectory]) {
		const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	const trust = lstatSync(trustPath, { bigint: true });
	return {
		kind: "harnessy.community.briefing.service-provisioned",
		activated: false,
		trustedKeyring: {
			path: trustPath,
			device: String(trust.dev),
			inode: String(trust.ino),
			sha256: sha256MeetingPublicationSmokeBytes(trustBytes),
		},
	} as const;
};
