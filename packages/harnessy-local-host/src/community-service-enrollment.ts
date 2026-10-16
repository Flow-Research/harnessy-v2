import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	encodeCommunityServiceEnrollmentRequest,
	prepareCommunityPublicationService,
	provisionCommunityPublicationService,
} from "@harnessy/core/community-briefing";
import {
	meetingPublicationDirectoryChain,
	readStableMeetingPublicationSmokeFile,
} from "@harnessy/core/meeting-publication";
import { Effect } from "effect";
import { isSafeAbsoluteMeetingCommandPath } from "./meeting-command-input.ts";
import { signOwnerServiceRequest } from "./owner-service-signing.ts";

export const setupCommunityService = (args: ReadonlyArray<string>) => {
	const uid = process.geteuid?.();
	if (
		args.length !== 2 ||
		args[0] !== "--input" ||
		!args[1] ||
		!isSafeAbsoluteMeetingCommandPath(args[1]) ||
		uid === undefined
	)
		throw new Error("invalid_arguments");
	const file = readStableMeetingPublicationSmokeFile(args[1], BigInt(uid), "private", 16_384);
	return provisionCommunityPublicationService(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)),
	);
};

const writePrivate = (path: string, text: string) => {
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
};

/** Prepare new unsigned files, preserving all operational state and existing output. */
export const prepareCommunityService = (
	args: ReadonlyArray<string>,
	anchors: Parameters<typeof prepareCommunityPublicationService>[1],
) => {
	if (
		args.length !== 4 ||
		args[0] !== "--input" ||
		args[2] !== "--output-directory" ||
		!args[1] ||
		!args[3] ||
		!isSafeAbsoluteMeetingCommandPath(args[1]) ||
		!isSafeAbsoluteMeetingCommandPath(args[3])
	)
		throw new Error("invalid_arguments");
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("unsupported_platform");
	const output = args[3];
	meetingPublicationDirectoryChain(output, BigInt(uid));
	const stat = lstatSync(output);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700 || readdirSync(output).length !== 0)
		throw new Error("unsafe_output");
	const input = readStableMeetingPublicationSmokeFile(args[1], BigInt(uid), "private");
	return prepareCommunityPublicationService(
		JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes)),
		anchors,
		output,
	).pipe(
		Effect.flatMap((prepared) =>
			Effect.try(() => {
				writePrivate(join(output, "request.json"), prepared.request);
				writePrivate(
					join(output, "service.json"),
					`${JSON.stringify({
						kind: "harnessy.community.briefing.service-config.v1",
						authorizationPath: join(output, "enrollment.json"),
						trustedKeyring: prepared.trustedKeyring,
					})}\n`,
				);
				return {
					kind: "harnessy.community.briefing.service-request-prepared",
					activated: false,
					requestSha256: createHash("sha256").update(prepared.request).digest("hex"),
				} as const;
			}),
		),
	);
};

/** Sign one reviewed service request offline. No provider, scheduler or state acquisition. */
export const enrollCommunityService = (args: ReadonlyArray<string>) => {
	const names = ["--request", "--request-sha256", "--owner-key", "--public-key-sha256", "--output"];
	const values = new Map<string, string>();
	if (args.length !== names.length * 2) throw new Error("invalid_arguments");
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index],
			value = args[index + 1];
		if (!name || !names.includes(name) || values.has(name) || !value) throw new Error("invalid_arguments");
		values.set(name, value);
	}
	const requestPath = values.get("--request")!,
		keyPath = values.get("--owner-key")!,
		outputPath = values.get("--output")!;
	if (
		![requestPath, keyPath, outputPath].every(isSafeAbsoluteMeetingCommandPath) ||
		new Set([requestPath, keyPath, outputPath]).size !== 3 ||
		![values.get("--request-sha256")!, values.get("--public-key-sha256")!].every((value) =>
			/^[a-f0-9]{64}$/u.test(value),
		)
	)
		throw new Error("invalid_arguments");
	const uid = process.geteuid?.();
	if (uid === undefined) throw new Error("unsupported_platform");
	const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const request = readStableMeetingPublicationSmokeFile(requestPath, BigInt(uid), "private");
	if (hash(request.bytes) !== values.get("--request-sha256")) throw new Error("request_changed");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
	const encoded = encodeCommunityServiceEnrollmentRequest(JSON.parse(text));
	if (`${encoded.canonical}\n` !== text || encoded.payload.operational.runtime.uid !== String(uid))
		throw new Error("invalid_request");
	const pinnedJson = (binding: { path: string; sha256: string }) => {
		const file = readStableMeetingPublicationSmokeFile(binding.path, BigInt(uid), "private", 32 * 1024 * 1024);
		if (hash(file.bytes) !== binding.sha256) throw new Error("binding_changed");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_binding");
		return value as Record<string, unknown>;
	};
	const inventory = pinnedJson(encoded.payload.operational.artifactManifest);
	const config = pinnedJson(encoded.payload.operational.config);
	for (const directory of [
		inventory.root,
		config.sourcePath,
		config.draftPath,
		encoded.payload.statePath,
		encoded.payload.providerScope.credentialDirectory,
		dirname(encoded.payload.providerScope.engineStatePath),
		dirname(encoded.payload.queuePath),
	]) {
		if (typeof directory !== "string" || !isSafeAbsoluteMeetingCommandPath(directory))
			throw new Error("invalid_binding");
		const path = relative(directory, keyPath);
		if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)))
			throw new Error("key_inside_runtime");
	}
	const parent = dirname(outputPath);
	meetingPublicationDirectoryChain(parent, BigInt(uid));
	const parentStat = lstatSync(parent);
	if (parentStat.uid !== uid || (parentStat.mode & 0o7777) !== 0o700) throw new Error("unsafe_output");
	const signature = signOwnerServiceRequest(
		keyPath,
		values.get("--public-key-sha256")!,
		encoded.signingBytes,
	).toString("base64");
	writePrivate(outputPath, encoded.envelope(signature));
	return { kind: "harnessy.community.briefing.service-enrollment-created", activated: false } as const;
};
