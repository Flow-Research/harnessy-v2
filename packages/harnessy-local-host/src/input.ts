import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";

import { JarvisMeetingPublicationConfig } from "@harnessy/core/meeting-publication-inspector";
import { Schema } from "effect";

import { assertAbsolutePlanPath, planPathsOverlap, sha256, verifyPlanEnvelope } from "./schema.ts";

const MAX_INPUT_BYTES = 1_000_000;
const CONFIG_KEYS = [
	"enabled",
	"project",
	"sourcePath",
	"statePath",
	"backfillDays",
	"cutoverDate",
	"maxFileBytes",
	"maxFiles",
	"leaseSeconds",
	"reminderSeconds",
	"reviewHost",
	"reviewPort",
	"reviewSessionSeconds",
	"reviewMaxSessions",
	"reviewMaxBodyBytes",
	"googleOwnerEmail",
	"googleDriveFolder",
	"discordChannelId",
] as const;

export class LocalHostInputError extends Error {
	readonly code:
		| "platform_unsupported"
		| "unsafe_input"
		| "input_too_large"
		| "invalid_utf8"
		| "invalid_json"
		| "invalid_config"
		| "stale_binding";

	constructor(code: LocalHostInputError["code"]) {
		super("Local-host input validation failed");
		this.name = "LocalHostInputError";
		this.code = code;
	}
}

const effectiveOwner = () => {
	if (process.platform !== "linux" && process.platform !== "darwin") {
		throw new LocalHostInputError("platform_unsupported");
	}
	const uid = process.geteuid?.();
	if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
		throw new LocalHostInputError("platform_unsupported");
	}
	return BigInt(uid);
};

const sameIdentity = (left: BigIntStats, right: BigIntStats) =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.uid === right.uid &&
	left.gid === right.gid &&
	left.mode === right.mode;

const sameFile = (left: BigIntStats, right: BigIntStats) =>
	sameIdentity(left, right) &&
	left.nlink === right.nlink &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs &&
	left.ctimeNs === right.ctimeNs;

// Missing configured roots are inspection results, not permission to create them.
const directoryChain = (path: string, uid: bigint, role?: "source" | "state") => {
	const paths = [path];
	let parent = dirname(path);
	while (parent !== paths[0]) {
		paths.unshift(parent);
		parent = dirname(parent);
	}
	const entries: Array<readonly [string, BigIntStats]> = [];
	let sharedParent = false;
	for (const current of paths) {
		const stat = lstatSync(current, { bigint: true, throwIfNoEntry: false });
		if (stat === undefined) {
			if (role === undefined || sharedParent) throw new LocalHostInputError("unsafe_input");
			return { entries, missing: current };
		}
		const mode = stat.mode & 0o7777n;
		// Sticky root-owned shared directories protect an existing owner-owned child.
		const shared = current !== path && stat.uid === 0n && mode === 0o1777n;
		if (
			!stat.isDirectory() ||
			realpathSync(current) !== current ||
			(stat.uid !== uid && stat.uid !== 0n) ||
			(sharedParent && stat.uid !== uid) ||
			(!shared && (mode & 0o7022n) !== 0n)
		)
			throw new LocalHostInputError("unsafe_input");
		if (
			current === path &&
			role !== undefined &&
			(stat.uid !== uid || (mode & 0o500n) !== 0o500n || (role === "state" && mode !== 0o700n))
		)
			throw new LocalHostInputError("unsafe_input");
		entries.push([current, stat]);
		sharedParent = shared;
	}
	return { entries, missing: null };
};

const recheckDirectories = (before: ReturnType<typeof directoryChain>) => {
	for (const [path, stat] of before.entries) {
		if (!sameIdentity(stat, lstatSync(path, { bigint: true })) || realpathSync(path) !== path) {
			throw new LocalHostInputError("unsafe_input");
		}
	}
	if (before.missing !== null && lstatSync(before.missing, { bigint: true, throwIfNoEntry: false }) !== undefined) {
		throw new LocalHostInputError("unsafe_input");
	}
};

export const validateLocalHostBindings = (config: JarvisMeetingPublicationConfig) => {
	const uid = effectiveOwner();
	try {
		for (const [role, path] of [
			["source", config.sourcePath],
			["state", config.statePath],
		] as const) {
			if (path !== null) {
				assertAbsolutePlanPath(path);
				recheckDirectories(directoryChain(path, uid, role));
			}
		}
		if (
			config.sourcePath !== null &&
			config.statePath !== null &&
			planPathsOverlap(config.sourcePath, config.statePath)
		) {
			throw new LocalHostInputError("invalid_config");
		}
	} catch (cause) {
		if (cause instanceof LocalHostInputError) throw cause;
		throw new LocalHostInputError("unsafe_input");
	}
};

const stableFileReadBytes = (path: string, role: "private" | "artifact") => {
	const uid = effectiveOwner();
	try {
		assertAbsolutePlanPath(path);
		const parents = directoryChain(dirname(path), uid);
		const before = lstatSync(path, { bigint: true });
		const mode = before.mode & 0o7777n;
		if (
			!before.isFile() ||
			before.nlink !== 1n ||
			before.uid !== uid ||
			realpathSync(path) !== path ||
			(mode & 0o7022n) !== 0n ||
			(mode & 0o400n) === 0n ||
			(role === "private" && mode !== 0o400n && mode !== 0o600n)
		)
			throw new LocalHostInputError("unsafe_input");
		if (before.size > BigInt(MAX_INPUT_BYTES)) throw new LocalHostInputError("input_too_large");
		// NONBLOCK prevents a raced FIFO replacement from hanging before fstat rejects it.
		const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			if (!sameFile(before, fstatSync(descriptor, { bigint: true }))) throw new LocalHostInputError("unsafe_input");
			const bytes = Buffer.alloc(Number(before.size) + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(descriptor, bytes, length, bytes.length - length, null);
				if (count === 0) break;
				length += count;
			}
			if (
				BigInt(length) !== before.size ||
				!sameFile(before, fstatSync(descriptor, { bigint: true })) ||
				!sameFile(before, lstatSync(path, { bigint: true })) ||
				realpathSync(path) !== path ||
				effectiveOwner() !== uid
			)
				throw new LocalHostInputError("unsafe_input");
			recheckDirectories(parents);
			return bytes.subarray(0, length);
		} finally {
			closeSync(descriptor);
		}
	} catch (cause) {
		if (cause instanceof LocalHostInputError) throw cause;
		throw new LocalHostInputError("unsafe_input");
	}
};

const stableFileRead = (path: string) => {
	const bytes = stableFileReadBytes(path, "private");
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new LocalHostInputError("invalid_utf8");
	}
};

const exactObjectKeys = (value: unknown, keys: ReadonlyArray<string>) => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

export const readLocalHostConfig = (path: string) => {
	const text = stableFileRead(path);
	let input: unknown;
	try {
		input = JSON.parse(text) as unknown;
	} catch {
		throw new LocalHostInputError("invalid_json");
	}
	if (!exactObjectKeys(input, CONFIG_KEYS)) throw new LocalHostInputError("invalid_config");
	let config: JarvisMeetingPublicationConfig;
	try {
		config = Schema.decodeUnknownSync(JarvisMeetingPublicationConfig)(input);
	} catch {
		throw new LocalHostInputError("invalid_config");
	}
	validateLocalHostBindings(config);
	return {
		config,
		path,
		sha256: sha256(text),
	};
};

export const readAndVerifyPlanEnvelope = (path: string) => {
	const envelope = verifyPlanEnvelope(stableFileRead(path));
	const config = readLocalHostConfig(envelope.receipt.binding.configPath);
	const executable = readLocalHostArtifactDigest(envelope.receipt.binding.hostExecutablePath);
	if (
		config.sha256 !== envelope.receipt.binding.configSha256 ||
		config.config.sourcePath !== envelope.receipt.binding.sourcePath ||
		config.config.statePath !== envelope.receipt.binding.statePath ||
		executable.sha256 !== envelope.receipt.binding.hostExecutableSha256
	) {
		throw new LocalHostInputError("stale_binding");
	}
	return envelope;
};

export const readLocalHostArtifactDigest = (path: string) => ({
	path,
	sha256: sha256(stableFileReadBytes(path, "artifact")),
});
